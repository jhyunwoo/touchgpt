import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Bindings } from "./env";
import { askGemini } from "./lib/gemini";
import { extractFormFields, extractMemo, readMemberHtml, withSession } from "./lib/touchgym";
import { parseMemo } from "./lib/protocol";

export { Poller } from "./poller";

const app = new Hono<{ Bindings: Bindings }>();

app.use(
  "*",
  cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type"] }),
);

// Single poller instance, pinned to Asia-Pacific so its egress (to Touchgym and
// to Gemini) comes from an APAC colo — a Gemini-supported region. The hint only
// applies when the DO is first created, so every accessor uses it.
function pollerStub(env: Bindings) {
  return env.POLLER.get(env.POLLER.idFromName("main"), { locationHint: "apac" });
}

async function kickPoller(env: Bindings): Promise<Response> {
  return pollerStub(env).fetch("https://poller/?action=kick");
}

app.get("/", (c) => c.text("TouchGPT poller is up. GET /start to arm the 2s memo poller."));

// Bootstrap: arm the poller now (otherwise it arms on the next 1-min cron tick).
app.get("/start", async (c) => {
  const res = await kickPoller(c.env);
  return c.json({ started: true, poller: await res.json().catch(() => null) });
});

// Debug (routed THROUGH the DO, i.e. from APAC): inject a question like the
// console would, and read the memo back. Token-guarded.
app.get("/debug/ask", async (c) => {
  if (c.req.query("token") !== c.env.TOUCHGPT_TOKEN) return c.json({ error: "unauthorized" }, 401);
  const q = c.req.query("q");
  if (!q) return c.json({ error: "missing q" }, 400);
  const res = await pollerStub(c.env).fetch("https://poller/?action=ask&q=" + encodeURIComponent(q));
  return c.json(await res.json());
});

app.get("/debug/memo", async (c) => {
  if (c.req.query("token") !== c.env.TOUCHGPT_TOKEN) return c.json({ error: "unauthorized" }, 401);
  const res = await pollerStub(c.env).fetch("https://poller/?action=memo");
  return c.json(await res.json());
});

// Debug: Gemini-only path (no Touchgym), token-guarded.
app.get("/ask", async (c) => {
  if (c.req.query("token") !== c.env.TOUCHGPT_TOKEN) return c.json({ error: "unauthorized" }, 401);
  const q = c.req.query("q");
  if (!q) return c.json({ error: "missing q" }, 400);
  try {
    return c.json(await askGemini(q, c.env.GEMINI_API_KEY));
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

// Debug: read-only Touchgym check (login + memo read), token-guarded.
app.get("/memo", async (c) => {
  if (c.req.query("token") !== c.env.TOUCHGPT_TOKEN) return c.json({ error: "unauthorized" }, 401);
  try {
    const creds = {
      clubId: c.env.TOUCHGYM_CLUB_ID,
      loginId: c.env.TOUCHGYM_USERID,
      password: c.env.TOUCHGYM_PASSWORD,
    };
    const result = await withSession(creds, async (s) => {
      const html = await readMemberHtml(s, c.env.TOUCHGYM_SEQ);
      const memo = extractMemo(html);
      return {
        appOrigin: s.appOrigin,
        seq: c.env.TOUCHGYM_SEQ,
        formFieldsPreserved: Object.keys(extractFormFields(html)).length,
        tgptMessages: parseMemo(memo).msgs.length,
        memo,
      };
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

export default {
  fetch: app.fetch,
  // 1-min cron heartbeat: re-arm the poller's alarm if it ever stops (doc §7).
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(kickPoller(env));
  },
};
