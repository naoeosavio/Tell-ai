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
};

export interface SDKConfig {
  keys: SDKKeys;
  urls: SDKUrls;
}
