/**
 * Wire protocol a model speaks. Most vendors have one fixed protocol, but a
 * user-supplied endpoint can front any of them: `responses` = OpenAI Responses
 * API, `chat` = Chat Completions, `messages` = Anthropic Messages. Native Gemini
 * is not offered here — a gateway fronts `gemini-*` over Chat Completions, and
 * the native vendor (`-m i`, `-m j`) already covers direct Gemini.
 */
export type WireApi = 'responses' | 'chat' | 'messages';

export type SDKKeys = {
  openai?: string | undefined;
  anthropic?: string | undefined;
  google?: string | undefined;
  xai?: string | undefined;
  deepseek?: string | undefined;
  cerebras?: string | undefined;
  moonshotai?: string | undefined;
  openrouter?: string | undefined;
  alibaba?: string | undefined;
  zhipu?: string | undefined;
  meta?: string | undefined;
  xiaomi?: string | undefined;
  /** Generic user-supplied endpoint (`custom:<model>`). */
  custom?: string | undefined;
};

export type SDKUrls = {
  openai?: string | undefined;
  anthropic?: string | undefined;
  google?: string | undefined;
  xai?: string | undefined;
  deepseek?: string | undefined;
  cerebras?: string | undefined;
  moonshotai?: string | undefined;
  openrouter?: string | undefined;
  vast?: string | undefined;
  local?: string | undefined;
  alibaba?: string | undefined;
  zhipu?: string | undefined;
  meta?: string | undefined;
  xiaomi?: string | undefined;
  /** Base URL (ending in `/v1`) of the generic user-supplied endpoint. */
  custom?: string | undefined;
};

export interface SDKConfig {
  keys: SDKKeys;
  urls: SDKUrls;
  /** Default model per vendor, for specs that name the vendor only (`-m custom`). */
  models?: Partial<Record<string, string>>;
  /** Wire override per vendor, for when prefix inference picks the wrong protocol. */
  wires?: Partial<Record<string, WireApi>>;
  /** Extra request headers per vendor, for endpoints the SDK does not model. */
  headers?: Partial<Record<string, Record<string, string>>>;
}
