// Model selection across three providers, addressed as "provider:model" so ANY
// model the provider runs is selectable (not just a curated subset). The live
// catalog is fetched on demand: Gemini and Ollama have list APIs reachable with
// their keys; Cloudflare has no list API without a separate token, so its
// text-generation models are embedded here.

export type Provider = "gemini" | "workers-ai" | "ollama" | "groq" | "cerebras";

export interface ModelRef {
  provider: Provider;
  model: string;
}

export const DEFAULT_REF: ModelRef = { provider: "gemini", model: "gemini-3.5-flash" };

export const PROVIDER_LABEL: Record<Provider, string> = {
  gemini: "Gemini API",
  "workers-ai": "Cloudflare Workers AI",
  ollama: "Ollama Cloud",
  groq: "Groq",
  cerebras: "Cerebras",
};

const SHORT: Record<Provider, string> = {
  gemini: "gemini",
  "workers-ai": "cf",
  ollama: "ollama",
  groq: "groq",
  cerebras: "cerebras",
};

function normalizeProvider(p: string): Provider | null {
  const x = p.trim().toLowerCase();
  if (x === "gemini" || x === "google") return "gemini";
  if (x === "cf" || x === "cloudflare" || x === "workers-ai" || x === "workersai") return "workers-ai";
  if (x === "ollama") return "ollama";
  if (x === "groq") return "groq";
  if (x === "cerebras" || x === "cb") return "cerebras";
  return null;
}

function shortProvider(p: Provider): string {
  return SHORT[p];
}

/** Parse "provider:model" (model may itself contain ":", e.g. ollama:gpt-oss:120b). */
export function parseModelRef(spec: string): ModelRef | null {
  const i = spec.indexOf(":");
  if (i < 0) return null;
  const provider = normalizeProvider(spec.slice(0, i));
  const model = spec.slice(i + 1).trim();
  return provider && model ? { provider, model } : null;
}

export function formatRef(ref: ModelRef): string {
  return `${shortProvider(ref.provider)}:${ref.model}`;
}

export function refTitle(ref: ModelRef): string {
  return `${PROVIDER_LABEL[ref.provider]} · ${ref.model}`;
}

// Cloudflare Workers AI text-generation models (no list API without a token).
const CF_MODELS: string[] = [
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/zai-org/glm-5.2",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.2-1b-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
  "@cf/qwen/qwq-32b",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/ibm-granite/granite-4.0-h-micro",
  "@cf/aisingapore/gemma-sea-lion-v4-27b-it",
];

// Cloudflare models that support the built-in web_search_options tool.
const CF_WEBSEARCH = new Set<string>([
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/zai-org/glm-5.2",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
]);

export function cfSupportsWebSearch(model: string): boolean {
  return CF_WEBSEARCH.has(model);
}

// Gemini returns many non-chat models (image/tts/audio/etc.); keep text chat only.
const GEMINI_EXCLUDE =
  /tts|image|audio|lyria|robotic|computer-use|deep-research|antigravity|nano-banana|embedding|vision|guard/i;

async function listGemini(apiKey: string): Promise<string[]> {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`,
    );
    if (!r.ok) return [];
    const j = (await r.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    return (j.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => !GEMINI_EXCLUDE.test(n));
  } catch {
    return [];
  }
}

async function listOllama(apiKey: string): Promise<string[]> {
  try {
    const r = await fetch("https://ollama.com/api/tags", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) return [];
    const j = (await r.json()) as { models?: { name?: string; model?: string }[] };
    return (j.models ?? []).map((m) => m.model || m.name || "").filter(Boolean);
  } catch {
    return [];
  }
}

// OpenAI-style /models (Groq, Cerebras). Drop non-chat models (audio/tts/guard)
// and Groq's compound systems (they 413 on search-heavy queries).
const OPENAI_EXCLUDE = /whisper|tts|guard|embedding|audio|moderation|orpheus|compound/i;

async function listOpenAICompat(url: string, apiKey: string): Promise<string[]> {
  if (!apiKey) return [];
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
    if (!r.ok) return [];
    const j = (await r.json()) as { data?: { id?: string }[] };
    return (j.data ?? [])
      .map((m) => m.id ?? "")
      .filter((id) => id && !OPENAI_EXCLUDE.test(id))
      .sort();
  } catch {
    return [];
  }
}

/** Live catalog grouped by provider, with copy-pasteable "provider:model" ids
 *  (🔍 = web-search-grounded, ▶ = current). */
export async function fetchCatalog(
  env: {
    GEMINI_API_KEY: string;
    OLLAMA_API_KEY: string;
    GROQ_API_KEY: string;
    CEREBRAS_API_KEY: string;
  },
  current: ModelRef,
): Promise<string> {
  const [gemini, ollama, groq, cerebras] = await Promise.all([
    listGemini(env.GEMINI_API_KEY),
    listOllama(env.OLLAMA_API_KEY),
    listOpenAICompat("https://api.groq.com/openai/v1/models", env.GROQ_API_KEY),
    listOpenAICompat("https://api.cerebras.ai/v1/models", env.CEREBRAS_API_KEY),
  ]);
  const line = (provider: Provider, model: string, search: boolean) => {
    const cur = current.provider === provider && current.model === model;
    return `  ${cur ? "▶" : " "} ${shortProvider(provider)}:${model}${search ? "  🔍" : ""}`;
  };
  const out: string[] = [];
  out.push("[Gemini API] — 🔍 Google 검색");
  for (const m of gemini) out.push(line("gemini", m, true));
  out.push("[Cloudflare Workers AI] — 🔍 = web_search 지원 모델");
  for (const m of CF_MODELS) out.push(line("workers-ai", m, CF_WEBSEARCH.has(m)));
  out.push("[Ollama Cloud] — 🔍 모두 웹검색(RAG)");
  for (const m of ollama) out.push(line("ollama", m, true));
  out.push("[Groq] — 🔍 웹검색(RAG)");
  for (const m of groq) out.push(line("groq", m, true));
  out.push("[Cerebras] — 🔍 웹검색(RAG)");
  for (const m of cerebras) out.push(line("cerebras", m, true));
  return out.join("\n");
}
