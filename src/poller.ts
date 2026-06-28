// Always-on poller (Durable Object).
//
// The service runs in an environment that can reach ONLY touchgym.co.kr, so the
// console can't call the worker. Instead this Durable Object lives on Cloudflare
// (which can reach touchgym) and polls the member memo every 2 seconds: when it
// finds a question line with no answer, it asks Gemini and writes the answer
// back into the memo. A 1-minute cron heartbeat re-arms the alarm if it dies
// (doc §7). Being a single DO instance, it's also the single writer for answers.

import type { Bindings } from "./env";
import { askGemini } from "./lib/gemini";
import {
  SessionExpiredError,
  type TouchgymCreds,
  type TouchgymSession,
  extractMemo,
  readMemberHtml,
  touchgymLogin,
  writeMemo,
} from "./lib/touchgym";
import { answerLine, appendToMemo, pendingQuestions, questionLine } from "./lib/protocol";

const POLL_INTERVAL_MS = 2000;

export class Poller {
  private state: DurableObjectState;
  private env: Bindings;
  private creds: TouchgymCreds;
  private session: TouchgymSession | null = null;

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
    this.creds = {
      clubId: env.TOUCHGYM_CLUB_ID,
      loginId: env.TOUCHGYM_USERID,
      password: env.TOUCHGYM_PASSWORD,
    };
  }

  // HTTP control surface (only ever called by our own worker, in-DO = serialized):
  //   ?action=kick  (default) — ensure the alarm loop is running
  //   ?action=ask&q=...       — inject a question line (debug; mimics the console)
  //   ?action=memo            — return the current memo + pending questions (debug)
  async fetch(req: Request): Promise<Response> {
    const action = new URL(req.url).searchParams.get("action") ?? "kick";
    if (action === "ask") {
      const q = new URL(req.url).searchParams.get("q") ?? "";
      const id = await this.injectQuestion(q);
      await this.armAlarm();
      return Response.json({ id });
    }
    if (action === "memo") {
      const { memo } = await this.readFresh();
      return Response.json({ memo, pending: pendingQuestions(memo) });
    }
    await this.armAlarm();
    return Response.json({ ok: true, polling: true });
  }

  private async armAlarm(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null)
      await this.state.storage.setAlarm(Date.now() + 50);
  }

  private async injectQuestion(question: string): Promise<string> {
    const { html, memo } = await this.readFresh();
    const id = crypto.randomUUID();
    const next = appendToMemo(memo, [questionLine(id, question)]);
    await writeMemo(await this.ensureSession(), this.env.TOUCHGYM_SEQ, html, next);
    return id;
  }

  async alarm(): Promise<void> {
    try {
      await this.poll();
    } catch (e) {
      console.error("[poller] error:", e instanceof Error ? e.message : e);
    } finally {
      // self-chaining: schedule the next poll only after this one finishes (doc §7)
      await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  private async ensureSession(): Promise<TouchgymSession> {
    if (!this.session) this.session = await touchgymLogin(this.creds);
    return this.session;
  }

  // Fresh GET of the member form + memo, re-logging in once on expiry (doc §10-7).
  private async readFresh(): Promise<{ html: string; memo: string }> {
    const seq = this.env.TOUCHGYM_SEQ;
    try {
      const html = await readMemberHtml(await this.ensureSession(), seq);
      return { html, memo: extractMemo(html) };
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        this.session = await touchgymLogin(this.creds);
        const html = await readMemberHtml(this.session, seq);
        return { html, memo: extractMemo(html) };
      }
      throw e;
    }
  }

  private async poll(): Promise<void> {
    const { memo } = await this.readFresh();
    const pending = pendingQuestions(memo);
    if (pending.length === 0) return;

    // Answer each pending question. On failure, store the error AS the answer so
    // it isn't retried every 2s forever and the user can see what went wrong.
    const lines: string[] = [];
    for (const { id, question } of pending) {
      try {
        lines.push(answerLine(id, await askGemini(question, this.env.GEMINI_API_KEY)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lines.push(answerLine(id, { text: "⚠️ 오류: " + msg, citations: [] }));
      }
    }

    // Fresh read-modify-write right before writing, then one form-preserving POST
    // that appends all answers and prunes the 2-day window (doc §5/§8).
    const { html, memo: fresh } = await this.readFresh();
    await writeMemo(await this.ensureSession(), this.env.TOUCHGYM_SEQ, html, appendToMemo(fresh, lines));
  }
}
