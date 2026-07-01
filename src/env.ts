// Shared binding types (secrets/vars + Durable Object namespace).
export interface Bindings {
  GEMINI_API_KEY: string;
  OLLAMA_API_KEY: string;
  GROQ_API_KEY: string;
  CEREBRAS_API_KEY: string;
  TOUCHGYM_CLUB_ID: string;
  TOUCHGYM_USERID: string;
  TOUCHGYM_PASSWORD: string;
  TOUCHGYM_SEQ: string;
  TOUCHGPT_TOKEN: string;
  POLLER: DurableObjectNamespace;
  AI: Ai;
}
