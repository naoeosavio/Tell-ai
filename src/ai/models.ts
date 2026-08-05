import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createCerebras } from '@ai-sdk/cerebras';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createFireworks } from '@ai-sdk/fireworks';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import { API_KEYS, API_URLS, type ApiKeys } from '../config/env';

export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

export interface ResolvedModelSpec {
  vendor: string;
  model: string;
  thinking: ThinkingLevel;
  fast: boolean;
}

export interface ModelHandle {
  model: any;
  reasoning: string;
  reasoningEffort?: string;
  fast: boolean;
}

export const MODELS: Record<string, string> = {
  'g--': 'openai:gpt-5.6-sol:none',
  'g-': 'openai:gpt-5.6-sol:low',
  g: 'openai:gpt-5.6-sol:medium',
  'g+': 'openai:gpt-5.6-sol:high',
  'g++': 'openai:gpt-5.6-sol:max',
  G: 'openai:gpt-5.6-sol:high',

  p: 'openai:gpt-5.6-sol-pro:medium',
  'p+': 'openai:gpt-5.6-sol-pro:high',
  'p++': 'openai:gpt-5.6-sol-pro:max',
  P: 'openai:gpt-5.6-sol-pro:high',

  't--': 'openai:gpt-5.6-terra:none',
  't-': 'openai:gpt-5.6-terra:low',
  t: 'openai:gpt-5.6-terra:medium',
  't+': 'openai:gpt-5.6-terra:high',
  't++': 'openai:gpt-5.6-terra:max',
  T: 'openai:gpt-5.6-terra:high',

  'c--': 'openai:gpt-5.6-luna:none',
  'c-': 'openai:gpt-5.6-luna:low',
  c: 'openai:gpt-5.6-luna:medium',
  'c+': 'openai:gpt-5.6-luna:high',
  'c++': 'openai:gpt-5.6-luna:max',
  C: 'openai:gpt-5.6-luna:high',

  's--': 'anthropic:claude-sonnet-5:none',
  's-': 'anthropic:claude-sonnet-5:low',
  s: 'anthropic:claude-sonnet-5:medium',
  's+': 'anthropic:claude-sonnet-5:high',
  's++': 'anthropic:claude-sonnet-5:max',
  S: 'anthropic:claude-sonnet-5:high',

  'o--': 'anthropic:claude-opus-5:none',
  'o-': 'anthropic:claude-opus-5:low',
  o: 'anthropic:claude-opus-5:medium',
  'o+': 'anthropic:claude-opus-5:high',
  'o++': 'anthropic:claude-opus-5:max',
  O: 'anthropic:claude-opus-5:high',

  'f--': 'anthropic:claude-fable-5:none',
  'f-': 'anthropic:claude-fable-5:low',
  f: 'anthropic:claude-fable-5:medium',
  'f+': 'anthropic:claude-fable-5:high',
  'f++': 'anthropic:claude-fable-5:max',
  F: 'anthropic:claude-fable-5:high',

  'i-': 'google:gemini-3.1-pro-preview:low',
  i: 'google:gemini-3.1-pro-preview:medium',
  'i+': 'google:gemini-3.1-pro-preview:high',
  I: 'google:gemini-3.1-pro-preview:high',

  'j-': 'google:gemini-3.5-flash-lite:low',
  j: 'google:gemini-3.5-flash-lite:medium',
  'j+': 'google:gemini-3.5-flash-lite:high',
  J: 'google:gemini-3.5-flash-lite:high',

  'l-': 'google:gemini-3.6-flash:low',
  l: 'google:gemini-3.6-flash:medium',
  'l+': 'google:gemini-3.6-flash:high',
  L: 'google:gemini-3.6-flash:high',

  'x-': 'xai:grok-4.5:low',
  x: 'xai:grok-4.5:medium',
  X: 'xai:grok-4.5:high',

  q: 'local:/root/model:none',

  v: 'vast:/root/model:none',

  'd-': 'deepseek:deepseek-v4-flash:none',
  d: 'deepseek:deepseek-v4-flash:high',
  'd+': 'deepseek:deepseek-v4-flash:max',
  'D-': 'deepseek:deepseek-v4-pro:none',
  D: 'deepseek:deepseek-v4-pro:high',
  'D+': 'deepseek:deepseek-v4-pro:max',

  'z--': 'fireworks:glm-5p2:none',
  'z-': 'fireworks:glm-5p2:low',
  z: 'fireworks:glm-5p2:medium',
  'z+': 'fireworks:glm-5p2:high',
  'z++': 'fireworks:glm-5p2:max',
  Z: 'fireworks:glm-5p2:high',

  k: 'moonshotai:kimi-k2.7-code:none',

  'K-': 'moonshotai:kimi-k3:low',
  K: 'moonshotai:kimi-k3:high',
  'K+': 'moonshotai:kimi-k3:max',
};

const AI_SDK_THINKING: Record<string, string> = {
  none: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
  auto: 'medium',
};

const SUPPORTED_VENDORS = new Set([
  'openai',
  'anthropic',
  'google',
  'moonshotai',
  'openrouter',
  'xai',
  'vast',
  'local',
  'fireworks',
  'deepseek',
]);

const VENDOR_KEY: Record<string, keyof ApiKeys> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  xai: 'xai',
  deepseek: 'deepseek',
  fireworks: 'fireworks',
  cerebras: 'cerebras',
  moonshotai: 'moonshotai',
  openrouter: 'openrouter',
};

const CEREBRAS_MODELS = new Set([
  'gpt-oss-120b',
  'gpt-oss-20b',
  'llama3.1-8b',
  'llama-3.3-70b',
  'qwen-3-32b',
  'qwen-3-235b-a22b-instruct-2507',
  'zai-glm-4.6',
]);

async function get_api_key(vendor: string): Promise<string | undefined> {
  const key_name = VENDOR_KEY[vendor];
  if (key_name && API_KEYS[key_name]) return API_KEYS[key_name];
  try {
    const token = (await readFile(join(homedir(), '.config', `${vendor}.token`), 'utf8')).trim();
    if (token) return token;
  } catch {}
  return undefined;
}

function infer_vendor(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized.startsWith('gpt') || normalized.startsWith('o')) return 'openai';
  if (normalized.startsWith('claude')) return 'anthropic';
  if (normalized.startsWith('gemini')) return 'google';
  if (normalized.startsWith('grok')) return 'xai';
  if (normalized.startsWith('kimi')) return 'moonshotai';
  if (normalized.includes('/')) return 'openrouter';
  throw new Error(`Unsupported vendor for model "${model}"`);
}

let OPENAI: any = null;
let ANTHROPIC: any = null;
let GOOGLE: any = null;
let XAI: any = null;
let DEEPSEEK: any = null;
let FIREWORKS: any = null;
let CEREBRAS: any = null;
let MOONSHOTAI: any = null;
let OPENROUTER: any = null;
const VAST_PROVIDERS: Record<string, any> = {};
const LOCAL_PROVIDERS: Record<string, any> = {};

async function get_openrouter_provider(): Promise<any> {
  if (OPENROUTER) return OPENROUTER;
  const api_key = await get_api_key('openrouter');
  OPENROUTER = createOpenAI({
    ...(api_key ? { apiKey: api_key } : {}),
    baseURL: API_URLS.openrouter,
    name: 'openrouter',
  });
  return OPENROUTER;
}

const VALID_THINKING = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);

function normalize_thinking(raw: string): ThinkingLevel | null {
  const normalized = raw.trim().toLowerCase();
  return VALID_THINKING.has(normalized) ? (normalized as ThinkingLevel) : null;
}

function resolve_single_part(term: string, fast: boolean): ResolvedModelSpec {
  const alias = MODELS[term];
  if (alias) {
    if (alias.includes(':')) {
      const resolved = parse_model_spec_raw(alias);
      resolved.fast = resolved.fast || fast;
      return resolved;
    }
    return {
      model: alias,
      vendor: infer_vendor(alias),
      thinking: 'auto',
      fast,
    };
  }
  return { model: term, vendor: infer_vendor(term), thinking: 'auto', fast };
}

function resolve_multi_part(parts: string[], fast: boolean): ResolvedModelSpec {
  const [vendor_raw, model_raw, thinking_raw] = parts as [string, string, string | undefined];
  const vendor = vendor_raw.trim().toLowerCase();
  if (!SUPPORTED_VENDORS.has(vendor)) throw new Error(`Unsupported vendor: ${vendor_raw}`);

  const model_value = model_raw.trim();
  if (!model_value) throw new Error('Model name must be provided after vendor');

  let model = model_value;
  let alias_thinking: ThinkingLevel | undefined;
  if (MODELS[model_value]) {
    const alias_spec = parse_model_spec_raw(MODELS[model_value]);
    if (alias_spec.vendor !== vendor) {
      throw new Error(`Model alias "${model_value}" belongs to vendor "${alias_spec.vendor}", not "${vendor_raw}"`);
    }
    model = alias_spec.model;
    alias_thinking = alias_spec.thinking;
  }

  let thinking: ThinkingLevel = 'auto';
  if (thinking_raw) {
    const level = normalize_thinking(thinking_raw);
    if (level) {
      thinking = level;
    } else {
      model = `${model_value}:${thinking_raw}`;
    }
  } else if (alias_thinking) {
    thinking = alias_thinking;
  }

  return { vendor, model, thinking, fast };
}

function parse_model_spec_raw(spec: string): ResolvedModelSpec {
  let trimmed = spec.trim();
  if (!trimmed) throw new Error('Model spec must be provided');

  let fast = false;
  if (trimmed.startsWith('.')) {
    fast = true;
    trimmed = trimmed.slice(1);
  }

  const parts = trimmed.split(':');
  const last_part = parts[parts.length - 1];
  if (parts.length > 1 && last_part?.trim().toLowerCase() === 'fast') {
    fast = true;
    parts.pop();
  }

  if (parts.length === 1) return resolve_single_part(trimmed, fast);

  const first_part = parts[0]?.trim().toLowerCase() ?? '';
  if (!SUPPORTED_VENDORS.has(first_part)) return resolve_single_part(trimmed, fast);

  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Expected "vendor:model" or "vendor:model:thinking", got "${spec}"`);
  }
  return resolve_multi_part(parts, fast);
}

export function resolve_model_spec(spec: string): ResolvedModelSpec {
  return parse_model_spec_raw(spec);
}

async function get_vast_provider(baseUrl: string): Promise<any> {
  if (VAST_PROVIDERS[baseUrl]) return VAST_PROVIDERS[baseUrl];
  VAST_PROVIDERS[baseUrl] = createOpenAI({
    apiKey: 'not-needed',
    baseURL: baseUrl,
    name: 'vast',
  });
  return VAST_PROVIDERS[baseUrl];
}

async function get_local_provider(baseUrl: string): Promise<any> {
  if (LOCAL_PROVIDERS[baseUrl]) return LOCAL_PROVIDERS[baseUrl];
  LOCAL_PROVIDERS[baseUrl] = createOpenAI({
    apiKey: 'not-needed',
    baseURL: baseUrl,
    name: 'local',
  });
  return LOCAL_PROVIDERS[baseUrl];
}

async function handle_cerebras(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!CEREBRAS) {
    const api_key = await get_api_key('cerebras');
    CEREBRAS = createCerebras({ ...(api_key ? { apiKey: api_key } : {}) });
  }
  return { model: CEREBRAS(model), reasoning, fast };
}

async function handle_open_ai(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!OPENAI) {
    const api_key = await get_api_key('openai');
    OPENAI = createOpenAI({ ...(api_key ? { apiKey: api_key } : {}) });
  }
  return { model: OPENAI(model), reasoning, fast };
}

async function handle_anthropic(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!ANTHROPIC) {
    const api_key = await get_api_key('anthropic');
    ANTHROPIC = createAnthropic({ ...(api_key ? { apiKey: api_key } : {}) });
  }
  return { model: ANTHROPIC(model), reasoning, fast };
}

async function handle_google(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!GOOGLE) {
    const api_key = await get_api_key('google');
    GOOGLE = api_key ? createGoogleGenerativeAI({ apiKey: api_key }) : createGoogleGenerativeAI();
  }
  return { model: GOOGLE(model), reasoning, fast };
}

async function handle_xai(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!XAI) {
    const api_key = await get_api_key('xai');
    XAI = createXai({ ...(api_key ? { apiKey: api_key } : {}) });
  }
  return { model: XAI(model), reasoning, fast };
}

async function handle_deepseek(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!DEEPSEEK) {
    const api_key = await get_api_key('deepseek');
    DEEPSEEK = createDeepSeek({ ...(api_key ? { apiKey: api_key } : {}) });
  }
  return { model: DEEPSEEK(model), reasoning, fast };
}

async function handle_fireworks(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!FIREWORKS) {
    const api_key = await get_api_key('fireworks');
    FIREWORKS = createFireworks({ ...(api_key ? { apiKey: api_key } : {}) });
  }
  return { model: FIREWORKS(model), reasoning, fast };
}

async function handle_moonshot_ai(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!MOONSHOTAI) {
    const api_key = await get_api_key('moonshotai');
    MOONSHOTAI = createMoonshotAI({ ...(api_key ? { apiKey: api_key } : {}) });
  }
  const reasoning_effort = reasoning !== 'none' ? 'max' : undefined;
  return {
    model: MOONSHOTAI(model),
    reasoning,
    ...(reasoning_effort ? { reasoningEffort: reasoning_effort } : {}),
    fast,
  };
}

async function handle_openrouter(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  const provider = await get_openrouter_provider();
  return { model: provider(model), reasoning, fast };
}
async function handle_vast(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  const provider = await get_vast_provider(API_URLS.vast);
  return { model: provider.chat(model), reasoning, fast };
}

async function handle_local(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  const provider = await get_local_provider(API_URLS.local);
  return { model: provider.chat(model), reasoning, fast };
}

const VENDOR_HANDLERS: Record<string, (m: string, r: string, f: boolean) => Promise<ModelHandle>> = {
  openai: handle_open_ai,
  anthropic: handle_anthropic,
  google: handle_google,
  xai: handle_xai,
  deepseek: handle_deepseek,
  fireworks: handle_fireworks,
  moonshotai: handle_moonshot_ai,
  openrouter: handle_openrouter,
  vast: handle_vast,
  local: handle_local,
};

export async function get_model(spec: string): Promise<ModelHandle> {
  const resolved = resolve_model_spec(spec);
  const reasoning = AI_SDK_THINKING[resolved.thinking] ?? 'medium';

  if (resolved.vendor === 'openai' && CEREBRAS_MODELS.has(resolved.model)) {
    return handle_cerebras(resolved.model, reasoning, resolved.fast);
  }

  const handler = VENDOR_HANDLERS[resolved.vendor];
  if (!handler) throw new Error(`Unsupported vendor: ${resolved.vendor}`);
  return handler(resolved.model, reasoning, resolved.fast);
}
