// Ollama Cloud (https://ollama.com) with web search.
//
// Ollama cloud models don't ground themselves, so we do it explicitly: call
// Ollama's web search API, feed the results into the chosen chat model as
// context (RAG), and return the search results as citations.

import type { AnswerPayload, Citation } from "./protocol";

const HOST = "https://ollama.com";

interface SearchResult {
  title?: string;
  url?: string;
  content?: string;
}

export async function askOllama(question: string, model: string, apiKey: string): Promise<AnswerPayload> {
  const auth = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

  // 1) Web search (best-effort — still answer if it fails).
  let results: SearchResult[] = [];
  try {
    const sres = await fetch(`${HOST}/api/web_search`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ query: question, max_results: 5 }),
    });
    if (sres.ok) results = ((await sres.json()) as { results?: SearchResult[] }).results ?? [];
  } catch {
    /* ignore — answer without grounding */
  }

  const context = results
    .map((r, i) => `[${i + 1}] ${r.title ?? ""}\n${r.url ?? ""}\n${r.content ?? ""}`)
    .join("\n\n");
  const system =
    "You are a helpful assistant. Use the provided web search results to answer " +
    "with up-to-date facts, reply in the user's language, and cite sources as [n].";
  const userContent = context ? `웹 검색 결과:\n${context}\n\n질문: ${question}` : question;

  // 2) Chat completion with the selected cloud model.
  const cres = await fetch(`${HOST}/api/chat`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      stream: false,
    }),
  });
  if (!cres.ok) {
    const t = await cres.text().catch(() => "");
    throw new Error(`Ollama chat HTTP ${cres.status}: ${t.slice(0, 300)}`);
  }
  const data = (await cres.json()) as { message?: { content?: string } };
  const text = data.message?.content ?? "";

  const citations: Citation[] = [];
  for (const r of results) if (r.url) citations.push({ title: r.title ?? r.url, url: r.url });

  return { text: (text || "(no answer text returned)").trim(), citations: dedupe(citations) };
}

function dedupe(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}
