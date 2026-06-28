// TouchGPT line protocol — stored inside the Touchgym member `memo` field.
//
// Generalized from touchgym-integration.md §8. The memo is a shared free-text
// cell that humans also use, so we (a) tag our lines with a fixed prefix and
// only ever touch tagged lines, and (b) treat the memo as a volatile 2-day
// buffer (Touchgym only keeps "yesterday + today" in KST), pruning on write.
//
// Line shape (one message per line):
//   TGPT1|<id>|<kind>|<tsMs>|<payloadB64url>
//   kind = "q" (question)  payload = b64url(questionText)
//   kind = "a" (answer)    payload = b64url(JSON.stringify({ text, citations }))
//   kind = "c" (command)   payload = b64url(commandText)   e.g. "setmodel kimi-k2.6"
//   kind = "r" (reply)     payload = b64url(JSON.stringify({ text, citations }))
//
// The payload is the LAST field and base64url-encoded, so it can never contain
// the `|` separator or a newline — restore it with slice(4).join("|").

export const PREFIX = "TGPT1";

export interface Citation {
  title: string;
  url: string;
}

export interface AnswerPayload {
  text: string;
  citations: Citation[];
}

export type Kind = "q" | "a" | "c" | "r";

export interface Msg {
  id: string;
  kind: Kind;
  ts: number;
  payload: string; // still base64url-encoded
}

// --- base64url (unicode-safe, works in Workers and the browser) -------------

export function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// --- parse / serialize ------------------------------------------------------

/** Split a memo into our TGPT messages and everything else (human-written
 *  lines, which we preserve verbatim). */
export function parseMemo(memo: string): { msgs: Msg[]; others: string[] } {
  const msgs: Msg[] = [];
  const others: string[] = [];
  for (const raw of memo.split(/\r?\n/)) {
    if (!raw.startsWith(PREFIX + "|")) {
      others.push(raw);
      continue;
    }
    const parts = raw.split("|");
    if (parts.length < 5) {
      others.push(raw);
      continue;
    }
    const kind = parts[2];
    if (kind !== "q" && kind !== "a" && kind !== "c" && kind !== "r") {
      others.push(raw);
      continue;
    }
    msgs.push({
      id: parts[1] ?? "",
      kind,
      ts: Number(parts[3] ?? "0"),
      payload: parts.slice(4).join("|"),
    });
  }
  return { msgs, others };
}

function makeLine(id: string, kind: Kind, payload: string, ts: number): string {
  return `${PREFIX}|${id}|${kind}|${ts}|${payload}`;
}

/** Start of yesterday (KST) in epoch ms — the retention cutoff (doc §8). */
function retentionCutoffMs(now = Date.now()): number {
  const KST = 9 * 60 * 60 * 1000;
  const startOfTodayKst = Math.floor((now + KST) / 86_400_000) * 86_400_000 - KST;
  return startOfTodayKst - 86_400_000; // include yesterday
}

// Touchgym's memo field is a MySQL TEXT column (max 65535 bytes); a write that
// exceeds it gets truncated, silently dropping the newest line. Keep our part
// of the memo well under that so new questions always fit.
const MEMO_BUDGET = 16000;

/** Keep recent messages within the 2-day window AND a byte budget (newest
 *  first), so the memo never approaches Touchgym's field limit. Human lines
 *  are preserved untouched. */
export function pruneMemo(memo: string, now = Date.now()): string {
  const cutoff = retentionCutoffMs(now);
  const { msgs, others } = parseMemo(memo);
  const within = msgs.filter((m) => m.ts >= cutoff).sort((a, b) => b.ts - a.ts);
  const keptNewestFirst: Msg[] = [];
  let used = 0;
  for (const m of within) {
    const line = makeLine(m.id, m.kind, m.payload, m.ts);
    if (keptNewestFirst.length > 0 && used + line.length + 1 > MEMO_BUDGET) break;
    used += line.length + 1;
    keptNewestFirst.push(m);
  }
  const kept = keptNewestFirst.reverse().map((m) => makeLine(m.id, m.kind, m.payload, m.ts));
  // Preserve human lines (trimming a trailing blank line so the memo doesn't
  // accumulate empty lines over many writes).
  const humans = others.filter((l, i) => !(l === "" && i === others.length - 1));
  return [...humans, ...kept].join("\n");
}

/** Build a question line (written by the console). */
export function questionLine(id: string, question: string, now = Date.now()): string {
  return makeLine(id, "q", b64urlEncode(question), now);
}

/** Build an answer line (written by the worker/poller). */
export function answerLine(id: string, answer: AnswerPayload, now = Date.now()): string {
  return makeLine(id, "a", b64urlEncode(JSON.stringify(answer)), now);
}

/** Prune the memo, then append the given line(s). */
export function appendToMemo(memo: string, lines: string[], now = Date.now()): string {
  const base = pruneMemo(memo, now);
  return [base, ...lines].filter((l) => l.length > 0).join("\n");
}

/** Question lines (id + decoded text) that don't yet have a matching answer. */
export function pendingQuestions(memo: string): { id: string; question: string }[] {
  const { msgs } = parseMemo(memo);
  const answered = new Set(msgs.filter((m) => m.kind === "a").map((m) => m.id));
  return msgs
    .filter((m) => m.kind === "q" && !answered.has(m.id))
    .map((m) => ({ id: m.id, question: b64urlDecode(m.payload) }));
}

/** Decode the answer for a given id, or null if not answered yet. */
export function findAnswer(memo: string, id: string): AnswerPayload | null {
  const { msgs } = parseMemo(memo);
  const a = msgs.find((m) => m.kind === "a" && m.id === id);
  return a ? (JSON.parse(b64urlDecode(a.payload)) as AnswerPayload) : null;
}

// --- control channel: commands (console → worker) and replies (worker → console)

/** Build a command line (e.g. "setmodel kimi-k2.6", "listmodels"). */
export function commandLine(id: string, command: string, now = Date.now()): string {
  return makeLine(id, "c", b64urlEncode(command), now);
}

/** Build a reply line. Reuses AnswerPayload so the console decodes it uniformly. */
export function replyLine(id: string, text: string, now = Date.now()): string {
  return makeLine(id, "r", b64urlEncode(JSON.stringify({ text, citations: [] })), now);
}

/** Command lines (id + decoded text) that don't yet have a matching reply. */
export function pendingCommands(memo: string): { id: string; command: string }[] {
  const { msgs } = parseMemo(memo);
  const replied = new Set(msgs.filter((m) => m.kind === "r").map((m) => m.id));
  return msgs
    .filter((m) => m.kind === "c" && !replied.has(m.id))
    .map((m) => ({ id: m.id, command: b64urlDecode(m.payload) }));
}
