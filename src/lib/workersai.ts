// Cloudflare Workers AI with built-in web search (web_search_options).
//
// The web-search-capable models (Kimi, Nemotron, GLM) use the OpenAI-compatible
// chat shape. Passing web_search_options enables the model's built-in web search,
// the same role Google Search grounding plays for Gemini.

import type { AnswerPayload, Citation } from "./protocol";

const SYSTEM =
  "You are a helpful assistant with web search. Use up-to-date web results to " +
  "answer accurately, reply in the user's language, and include source links.";

interface ChatMessage {
  content?: string;
  annotations?: { type?: string; url?: string; uri?: string; title?: string; url_citation?: { url?: string; uri?: string; title?: string } }[];
}
interface ChatResponse {
  response?: string | { response?: string };
  choices?: { message?: ChatMessage }[];
}

export async function askWorkersAI(
  question: string,
  model: string,
  ai: Ai,
  webSearch = true,
): Promise<AnswerPayload> {
  const input: Record<string, unknown> = {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: question },
    ],
  };
  if (webSearch) input.web_search_options = {};
  // `as never` keeps TS happy across the many per-model input/output unions.
  const raw = (await ai.run(model as never, input as never)) as ChatResponse;

  const msg = raw.choices?.[0]?.message;
  let text = "";
  if (msg?.content) text = msg.content;
  else if (typeof raw.response === "string") text = raw.response;
  else if (raw.response && typeof raw.response === "object") text = raw.response.response ?? "";

  const citations: Citation[] = [];
  for (const a of msg?.annotations ?? []) {
    const uc = a.url_citation ?? a;
    const url = uc.url ?? uc.uri;
    if (url) citations.push({ title: uc.title ?? url, url });
  }

  return { text: (text || "(no answer text returned)").trim(), citations: dedupe(citations) };
}

function dedupe(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}
