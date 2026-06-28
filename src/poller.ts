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
import { askWorkersAI } from "./lib/workersai";
import { askOllama } from "./lib/ollama";
import {
  DEFAULT_REF,
  type ModelRef,
  cfSupportsWebSearch,
  fetchCatalog,
  formatRef,
  parseModelRef,
  refTitle,
} from "./lib/models";
import {
  SessionExpiredError,
  type TouchgymCreds,
  type TouchgymSession,
  extractMemo,
  readMemberHtml,
  touchgymLogin,
  writeMemo,
} from "./lib/touchgym";
import {
  type AnswerPayload,
  answerLine,
  appendToMemo,
  commandLine,
  pendingCommands,
  pendingQuestions,
  questionLine,
  replyLine,
} from "./lib/protocol";

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
      const sp = new URL(req.url).searchParams;
      const kind = sp.get("kind") === "c" ? "c" : "q";
      const id = await this.injectLine(kind, sp.get("q") ?? "");
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

  private async injectLine(kind: "q" | "c", text: string): Promise<string> {
    const { html, memo } = await this.readFresh();
    const id = crypto.randomUUID();
    const line = kind === "c" ? commandLine(id, text) : questionLine(id, text);
    await writeMemo(
      await this.ensureSession(),
      this.env.TOUCHGYM_SEQ,
      html,
      appendToMemo(memo, [line]),
    );
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

  private async currentRef(): Promise<ModelRef> {
    const raw = await this.state.storage.get<string>("modelref");
    if (raw) {
      try {
        const r = JSON.parse(raw) as ModelRef;
        if (r?.provider && r?.model) return r;
      } catch {
        /* fall through to default */
      }
    }
    return DEFAULT_REF;
  }

  private async answer(question: string, ref: ModelRef): Promise<AnswerPayload> {
    if (ref.provider === "workers-ai")
      return askWorkersAI(question, ref.model, this.env.AI, cfSupportsWebSearch(ref.model));
    if (ref.provider === "ollama") return askOllama(question, ref.model, this.env.OLLAMA_API_KEY);
    return askGemini(question, this.env.GEMINI_API_KEY, ref.model);
  }

  private async handleCommand(command: string): Promise<string> {
    const parts = command.trim().split(/\s+/);
    const cmd = (parts[0] ?? "").toLowerCase();
    const cur = await this.currentRef();
    if (cmd === "listmodels")
      return 'setModel("provider:model") 로 선택:\n' + (await fetchCatalog(this.env, cur));
    if (cmd === "model") return `현재 모델: ${refTitle(cur)} (${formatRef(cur)})`;
    if (cmd === "setmodel") {
      const ref = parseModelRef(parts.slice(1).join(" ").trim());
      if (!ref)
        return '❌ 형식: setModel("provider:model")\n  예) gemini:gemini-2.5-pro · cf:@cf/moonshotai/kimi-k2.6 · ollama:gpt-oss:120b';
      await this.state.storage.put("modelref", JSON.stringify(ref));
      return `✅ 모델 변경됨 → ${refTitle(ref)} (${formatRef(ref)})`;
    }
    return `알 수 없는 명령: ${command}`;
  }

  private async poll(): Promise<void> {
    const { memo } = await this.readFresh();
    const commands = pendingCommands(memo);
    const questions = pendingQuestions(memo);
    if (commands.length === 0 && questions.length === 0) return;

    const lines: string[] = [];

    // Handle commands first (e.g. model switch) so a following question in the
    // same batch already uses the new model.
    for (const { id, command } of commands) {
      try {
        lines.push(replyLine(id, await this.handleCommand(command)));
      } catch (e) {
        lines.push(replyLine(id, "⚠️ 명령 오류: " + (e instanceof Error ? e.message : String(e))));
      }
    }

    // Answer each pending question with the currently selected model. On failure,
    // store the error AS the answer so it isn't retried every 2s forever.
    const ref = await this.currentRef();
    for (const { id, question } of questions) {
      try {
        lines.push(answerLine(id, await this.answer(question, ref)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lines.push(answerLine(id, { text: "⚠️ 오류: " + msg, citations: [] }));
      }
    }

    // Fresh read-modify-write right before writing, then one form-preserving POST
    // that appends all lines and prunes the 2-day window (doc §5/§8).
    const { html, memo: fresh } = await this.readFresh();
    await writeMemo(await this.ensureSession(), this.env.TOUCHGYM_SEQ, html, appendToMemo(fresh, lines));
  }
}
