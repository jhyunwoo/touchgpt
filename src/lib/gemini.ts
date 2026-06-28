// Gemini 3.5 Flash with native Google Search grounding.
//
// One call both searches the web and answers, returning the text plus
// url_citation annotations — so there is no separate search API to wire up.
// Primary path is the Interactions API; if that endpoint isn't available we
// fall back to the classic generateContent endpoint with the google_search tool.

import type { AnswerPayload, Citation } from "./protocol";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export async function askGemini(
  question: string,
  apiKey: string,
  model = "gemini-3.5-flash",
): Promise<AnswerPayload> {
  // Try the Interactions API first (nicer citation shape). It rejects some
  // keys/projects, so on ANY failure fall back to the stable generateContent
  // endpoint (both use the google_search grounding tool).
  try {
    const res = await fetch(`${BASE}/interactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ model, input: question, tools: [{ type: "google_search" }] }),
    });
    if (res.ok) return parseInteraction(await res.json());
  } catch {
    /* network error — fall back */
  }
  return askGeminiGenerateContent(question, apiKey, model);
}

// --- Interactions response parsing ------------------------------------------

interface Annotation {
  type?: string;
  title?: string;
  url?: string;
  uri?: string;
}
interface ContentBlock {
  type?: string;
  text?: string;
  annotations?: Annotation[];
}
interface Step {
  type?: string;
  content?: ContentBlock[];
}
interface Interaction {
  output_text?: string;
  steps?: Step[];
}

function parseInteraction(data: Interaction): AnswerPayload {
  const modelSteps = (data.steps ?? []).filter((s) => s.type === "model_output");

  let text = typeof data.output_text === "string" ? data.output_text : "";
  if (!text) {
    text = modelSteps
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === "text" || typeof c.text === "string")
      .map((c) => c.text ?? "")
      .join("")
      .trim();
  }

  const citations: Citation[] = [];
  for (const step of modelSteps) {
    for (const block of step.content ?? []) {
      for (const a of block.annotations ?? []) {
        if (a.type && a.type !== "url_citation") continue;
        const url = a.url ?? a.uri;
        if (url) citations.push({ title: a.title ?? url, url });
      }
    }
  }

  return { text: text || "(no answer text returned)", citations: dedupe(citations) };
}

// --- Fallback: classic generateContent + google_search grounding ------------

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}
interface GenContentResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    groundingMetadata?: { groundingChunks?: GroundingChunk[] };
  }[];
}

async function askGeminiGenerateContent(
  question: string,
  apiKey: string,
  model = "gemini-3.5-flash",
): Promise<AnswerPayload> {
  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: question }] }],
      tools: [{ google_search: {} }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gemini generateContent HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
  const data = (await res.json()) as GenContentResponse;
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  const citations: Citation[] = [];
  for (const chunk of cand?.groundingMetadata?.groundingChunks ?? []) {
    const url = chunk.web?.uri;
    if (url) citations.push({ title: chunk.web?.title ?? url, url });
  }
  return { text: text || "(no answer text returned)", citations: dedupe(citations) };
}

function dedupe(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}
