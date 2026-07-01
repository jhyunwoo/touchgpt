# TouchGPT

A search-grounded LLM assistant that talks **entirely through the Touchgym member `memo` field**.

Built for an environment that can reach **only touchgym.co.kr**. You write a question into the
member memo (via a console helper), and an always-on Cloudflare Worker — which *can* reach
touchgym — **polls that memo every 2 seconds**, answers new questions with a **web-search-grounded
LLM**, and writes the answer back into the memo. Your console reads it back and prints it.

The model is selectable from the console across **three providers** — *any* model each provider runs,
addressed as `provider:model`. `models()` shows the live catalog (Gemini + Ollama fetched on demand,
Cloudflare from an embedded list), marking 🔍 = web-search-capable and ▶ = current.

| Provider (`prefix`) | Catalog | Search |
|---------------------|---------|--------|
| **Gemini API** (`gemini:`) | live `/v1beta/models` (chat models) | native Google Search grounding (all) |
| **Cloudflare Workers AI** (`cf:`) | embedded text-gen list | `web_search_options` (Kimi/Nemotron/GLM/GPT-OSS) |
| **Ollama Cloud** (`ollama:`) | live `/api/tags` (your account) | Ollama web search API + RAG (all) |
| **Groq** (`groq:`) | live `/openai/v1/models` | Ollama web search + RAG (uses `OLLAMA_API_KEY`) |
| **Cerebras** (`cerebras:`) | live `/v1/models` | Ollama web search + RAG (uses `OLLAMA_API_KEY`) |

> 🔍 means the model *can* search; weaker models may not always invoke it. For reliably grounded
> answers prefer strong models (`gemini:gemini-3.5-flash`, `ollama:gpt-oss:120b`, `cf:@cf/moonshotai/kimi-k2.6`).

See `touchgym-integration.md` for the underlying technique (memo as a message bus, multi-hop
login, form-preserving writes, single-writer rule).

## Architecture

```
[browser console]  ask("질문")
   │ writes a TGPT question line into the member memo   (form-preserving; touchgym only)
   ▼
( Touchgym member memo )  ◀── polled every 2s ──┐
   ▲                                            │
   │ writes the answer line back                │
[Cloudflare Worker — Durable Object "Poller", pinned to APAC]
   • alarm() every 2s: login (cached) → read memo → for each unanswered question:
       Gemini 3.5 Flash + google_search → write answer line (form-preserving, prune 2-day KST)
   • 1-min cron heartbeat re-arms the alarm if it ever stops (doc §7)
   • single DO instance = single writer for answers (doc §6)
   ▼
[browser console]  polls the memo (read-only) → finds the answer line → prints answer + citations
```

The console never contacts the worker; both sides communicate purely through the memo. The worker
runs autonomously, so once deployed it keeps polling 24/7.

- `src/poller.ts` — the Durable Object: 2s alarm loop, cached session, single writer; selected model in DO storage; dispatches to the provider
- `src/lib/touchgym.ts` — login, read, form-preserving write, session cache (doc §3/§4/§5/§10-7)
- `src/lib/protocol.ts` — `TGPT1|id|kind|ts|b64url(payload)` lines (`q`/`a` + `c`/`r` control channel), prune to yesterday+today KST (doc §8)
- `src/lib/models.ts` — `provider:model` addressing + live catalog (Gemini/Ollama fetched, Cloudflare embedded)
- `src/lib/gemini.ts` / `src/lib/workersai.ts` / `src/lib/ollama.ts` — the three provider clients (all web-search-grounded)
- `src/index.ts` — Hono app: `GET /start` (arm poller), `GET /debug/ask|/debug/memo|/ask|/memo` (token-guarded)
- `console/touchgpt.js` — the browser console client (`ask`, `models`, `setModel`)

## Setup

### 1. Secrets

| Key | Where | Purpose |
|-----|-------|---------|
| `GEMINI_API_KEY` | secret | Gemini models (Google AI Studio key) |
| `OLLAMA_API_KEY` | secret | Ollama Cloud models + web search for Ollama/Groq/Cerebras (ollama.com key) |
| `GROQ_API_KEY` | secret | Groq models (console.groq.com key) |
| `CEREBRAS_API_KEY` | secret | Cerebras models (cloud.cerebras.ai key) |
| `TOUCHGYM_CLUB_ID` / `TOUCHGYM_USERID` / `TOUCHGYM_PASSWORD` | secret | Touchgym admin login (field names per doc §3.2) |
| `TOUCHGYM_SEQ` | var | mailbox member `seq` that **really exists in this club/shard** (doc §10-3) |
| `TOUCHGPT_TOKEN` | secret | token guarding the debug endpoints |

Local dev: `.dev.vars` (gitignored). Production:

```sh
wrangler secret put GEMINI_API_KEY
wrangler secret put OLLAMA_API_KEY
wrangler secret put GROQ_API_KEY
wrangler secret put CEREBRAS_API_KEY
wrangler secret put TOUCHGYM_CLUB_ID
wrangler secret put TOUCHGYM_USERID
wrangler secret put TOUCHGYM_PASSWORD
wrangler secret put TOUCHGPT_TOKEN
# TOUCHGYM_SEQ is non-secret — set in wrangler.jsonc "vars"
```

> **Note:** the worker calls Touchgym (legacy TLS) and Gemini. Local `wrangler dev` (workerd) can't
> complete Touchgym's TLS handshake and isn't in a Gemini-supported region, so **test on the real
> edge** (`wrangler dev --remote` or `wrangler deploy`). The Durable Object is pinned to APAC so its
> egress is Gemini-supported.

### 2. Deploy

```sh
npm install
npm run deploy
# then arm the poller (otherwise it self-arms within ~1 min via cron):
curl "https://<your-worker>.workers.dev/start"
```

### 3. Console client

1. Edit `console/touchgpt.js` → set `SEQ` to the same member seq the worker polls (`TOUCHGYM_SEQ`).
2. Log into Touchgym, open the member page (`https://wN.touchgym.co.kr/m/member/...`).
3. Paste the whole file into the DevTools Console.
4. Ask:

```js
ask("2024 파리 올림픽 양궁 남자 단체전 금메달 국가는?")

models()                              // live catalog, grouped by provider (▶ current, 🔍 web search)
setModel("ollama:gpt-oss:120b")       // switch model — provider:model (gemini: / cf: / ollama:)
```

All three commands go through the memo channel (the console never contacts the worker). `ask` writes
the question, polls every 2s, and prints the worker's answer with citations. `models`/`setModel` send
a control line that the poller reads, applies (the selection persists in the DO), and replies to.

## Debug endpoints (token-guarded)

- `GET /ask?q=...&token=...` — Gemini-only (no Touchgym)
- `GET /memo?token=...` — login + read the mailbox memo, report preserved form-field count
- `GET /debug/ask?q=...&token=...` — inject a question through the DO (mimics the console)
- `GET /debug/memo?token=...` — dump the current memo + pending questions, via the DO

## Notes & caveats

- **Single writer (doc §6):** the DO is the only writer for answers. The console also writes
  questions (form-preserving), so for one user asking serially it's safe; the small two-writer race
  only risks losing a memo line, never member data (both preserve all form fields, doc §5.1).
- **Volatile memo (doc §8):** Touchgym keeps only "yesterday + today" (KST); old lines are pruned on
  each write. The memo is a transient channel/transcript, not durable storage.
- **Polling load:** the DO re-uses one cached session and reads every 2s; it only re-logs-in on
  expiry to avoid Touchgym login throttling.
- **Quiet hours (KST):** the poller does not touch Touchgym on weekends, or daily from 20:30 to
  05:00 — questions asked during these windows are answered once polling resumes (`isQuietHours` in
  `src/poller.ts`).
- **Security (doc §11):** the login is a gym **admin** account — keep all secrets server-side. The
  memo is plaintext to any club admin. Use only on clubs/accounts you are authorized to access.
