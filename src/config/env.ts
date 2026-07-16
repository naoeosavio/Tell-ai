export type ApiKeys = {
  openai: string;
  anthropic: string;
  google: string;
  xai: string;
  deepseek: string;
  fireworks: string;
  cerebras: string;
  moonshotai: string;
  openrouter: string;
};

export type ApiBaseUrls = {
  openai: string;
  deepseek: string;
  openrouter: string;
  vast: string;
  local: string;
};

export type EnvConfig = {
  debug: boolean;
  keys: ApiKeys;
  urls: ApiBaseUrls;
};

const env = (name: string): string => (process.env[name] ?? '').trim();

export const DEBUG: boolean = env('DEBUG').toLowerCase() === 'true' || env('DEBUG') === '1';

export const API_KEYS: ApiKeys = {
  openai: env('OPENAI_API_KEY'),
  anthropic: env('ANTHROPIC_API_KEY'),
  google: env('GOOGLE_API_KEY') || env('GEMINI_API_KEY'),
  xai: env('XAI_API_KEY'),
  deepseek: env('DEEPSEEK_API_KEY'),
  fireworks: env('FIREWORKS_API_KEY'),
  cerebras: env('CEREBRAS_API_KEY'),
  moonshotai: env('MOONSHOTAI_API_KEY'),
  openrouter: env('OPENROUTER_API_KEY'),
};

export const API_URLS: ApiBaseUrls = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  openrouter: 'https://openrouter.ai/api/v1',
  vast: env('VAST_BASE_URL'),
  local: env('LOCAL_OPENAI_BASE_URL'),
};
