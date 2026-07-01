// Shared web search (Ollama's web search API) used to ground providers that
// don't search natively (Ollama Cloud, Groq, Cerebras). Returns clean results
// we can both feed to the model as context and surface as citations.

import type { Citation } from "./protocol";

export interface SearchResult {
  title?: string;
  url?: string;
  content?: string;
}

export async function webSearch(query: string, ollamaKey: string, maxResults = 3): Promise<SearchResult[]> {
  if (!ollamaKey) return [];
  try {
    const res = await fetch("https://ollama.com/api/web_search", {
      method: "POST",
      headers: { authorization: `Bearer ${ollamaKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query, max_results: maxResults }),
    });
    if (!res.ok) return [];
    return ((await res.json()) as { results?: SearchResult[] }).results ?? [];
  } catch {
    return [];
  }
}

/** Build a numbered context block for the prompt. Each result's content is
 *  truncated so the prompt stays small (some providers cap request size /
 *  tokens-per-minute, e.g. Groq 413, Cerebras 429). */
export function buildContext(results: SearchResult[], perResultChars = 600): string {
  return results
    .map((r, i) => `[${i + 1}] ${r.title ?? ""}\n${r.url ?? ""}\n${(r.content ?? "").slice(0, perResultChars)}`)
    .join("\n\n");
}

export function resultsToCitations(results: SearchResult[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const r of results) {
    if (r.url && !seen.has(r.url)) {
      seen.add(r.url);
      out.push({ title: r.title ?? r.url, url: r.url });
    }
  }
  return out;
}
