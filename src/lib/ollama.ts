// Ollama Cloud (https://ollama.com) with web search.
//
// Ollama cloud models don't ground themselves, so we search explicitly (shared
// web search helper), feed the results into the chosen chat model as context
// (RAG), and return the search results as citations.

import type { AnswerPayload } from "./protocol";
import { buildContext, resultsToCitations, webSearch } from "./search";

const HOST = "https://ollama.com";

export async function askOllama(question: string, model: string, apiKey: string): Promise<AnswerPayload> {
  const results = await webSearch(question, apiKey);
  const context = buildContext(results);
  const system =
    "You are a helpful assistant. Use the provided web search results to answer " +
    "with up-to-date facts, reply in the user's language, and cite sources as [n].";
  const userContent = context ? `웹 검색 결과:\n${context}\n\n질문: ${question}` : question;

  const res = await fetch(`${HOST}/api/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      stream: false,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Ollama chat HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const text = data.message?.content ?? "";

  return { text: (text || "(no answer text returned)").trim(), citations: resultsToCitations(results) };
}
