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

const ENV = (name: string): string => (process.env[name] ?? '').trim();

export const DEBUG: boolean = ENV('DEBUG').toLowerCase() === 'true' || ENV('DEBUG') === '1';

export const API_KEYS: ApiKeys = {
  openai: ENV('OPENAI_API_KEY'),
  anthropic: ENV('ANTHROPIC_API_KEY'),
  google: ENV('GOOGLE_API_KEY') || ENV('GEMINI_API_KEY'),
  xai: ENV('XAI_API_KEY'),
  deepseek: ENV('DEEPSEEK_API_KEY'),
  fireworks: ENV('FIREWORKS_API_KEY'),
  cerebras: ENV('CEREBRAS_API_KEY'),
  moonshotai: ENV('MOONSHOTAI_API_KEY'),
  openrouter: ENV('OPENROUTER_API_KEY'),
};

export const API_URLS: ApiBaseUrls = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  openrouter: 'https://openrouter.ai/api/v1',
  vast: ENV('VAST_BASE_URL'),
  local: ENV('LOCAL_OPENAI_BASE_URL'),
};
