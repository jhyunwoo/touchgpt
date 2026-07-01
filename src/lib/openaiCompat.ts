// Generic OpenAI-compatible chat client (Groq, Cerebras) with web-search RAG.
//
// These providers expose /v1/chat/completions and don't ground themselves, so
// we search first (shared Ollama web search), feed results as context, and
// surface them as citations — same shape as the other providers.

import type { AnswerPayload } from "./protocol";
import { buildContext, resultsToCitations, webSearch } from "./search";

export interface OpenAICompatConfig {
  label: string; // for error messages, e.g. "Groq"
  baseUrl: string; // e.g. https://api.groq.com/openai/v1
  apiKey: string;
  headers?: Record<string, string>;
}

interface ChatMessage {
  content?: string;
  executed_tools?: { search_results?: { title?: string; url?: string }[] }[];
}

export async function askOpenAICompat(
  question: string,
  cfg: OpenAICompatConfig,
  model: string,
  ollamaKey: string,
  ragSearch = true,
): Promise<AnswerPayload> {
  // Skip RAG for models that search natively (e.g. Groq compound) — injecting a
  // big context both duplicates work and can blow the request-size limit.
  const results = ragSearch ? await webSearch(question, ollamaKey) : [];
  const context = buildContext(results);
  const system =
    "You are a helpful assistant. Use any provided web search results to answer " +
    "with up-to-date facts, reply in the user's language, and cite sources as [n].";
  const userContent = context ? `웹 검색 결과:\n${context}\n\n질문: ${question}` : question;

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
      ...(cfg.headers ?? {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      max_tokens: 2048,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${cfg.label} HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const msg = ((await res.json()) as { choices?: { message?: ChatMessage }[] }).choices?.[0]?.message;
  const text = msg?.content ?? "";

  // Citations: RAG results, or the model's native search results (Groq compound).
  let citations = resultsToCitations(results);
  if (citations.length === 0 && msg?.executed_tools) {
    citations = resultsToCitations(msg.executed_tools.flatMap((t) => t.search_results ?? []));
  }

  return { text: (text || "(no answer text returned)").trim(), citations };
}
