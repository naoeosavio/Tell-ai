import { createAnthropic } from '@ai-sdk/anthropic';
import { createCerebras } from '@ai-sdk/cerebras';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import type { SDKConfig, SDKKeys, SDKUrls } from './config';

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
  fast: boolean;
  /** Explicit vendor options forwarded as `providerOptions` (e.g. Anthropic effort). */
  providerOptions?: Record<string, any>;
}

export const MODELS: Record<string, string> = {
  'g--': 'openai:gpt-6-sol:none',
  'g-': 'openai:gpt-6-sol:low',
  g: 'openai:gpt-6-sol:medium',
  'g+': 'openai:gpt-6-sol:high',
  'g++': 'openai:gpt-6-sol:max',
  G: 'openai:gpt-6-sol:high',

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

  'c--': 'openai:gpt-6-luna:none',
  'c-': 'openai:gpt-6-luna:low',
  c: 'openai:gpt-6-luna:medium',
  'c+': 'openai:gpt-6-luna:high',
  'c++': 'openai:gpt-6-luna:max',
  C: 'openai:gpt-6-luna:high',

  'e--': 'openai:gpt-6-astra:none',
  'e-': 'openai:gpt-6-astra:low',
  e: 'openai:gpt-6-astra:medium',
  'e+': 'openai:gpt-6-astra:high',
  'e++': 'openai:gpt-6-astra:max',
  E: 'openai:gpt-6-astra:high',

  'r--': 'openai:gpt-6-astra-pro:none',
  'r-': 'openai:gpt-6-astra-pro:low',
  r: 'openai:gpt-6-astra-pro:medium',
  'r+': 'openai:gpt-6-astra-pro:high',
  'r++': 'openai:gpt-6-astra-pro:max',
  R: 'openai:gpt-6-astra-pro:high',

  's--': 'anthropic:claude-sonnet-5:none',
  's-': 'anthropic:claude-sonnet-5:low',
  s: 'anthropic:claude-sonnet-5:medium',
  's+': 'anthropic:claude-sonnet-5:high',
  's++': 'anthropic:claude-sonnet-5:max',
  S: 'anthropic:claude-sonnet-5:high',

  'o--': 'anthropic:claude-opus-5.5:none',
  'o-': 'anthropic:claude-opus-5.5:low',
  o: 'anthropic:claude-opus-5.5:medium',
  'o+': 'anthropic:claude-opus-5.5:high',
  'o++': 'anthropic:claude-opus-5.5:max',
  O: 'anthropic:claude-opus-5.5:high',

  'f--': 'anthropic:claude-fable-5.1:none',
  'f-': 'anthropic:claude-fable-5.1:low',
  f: 'anthropic:claude-fable-5.1:medium',
  'f+': 'anthropic:claude-fable-5.1:high',
  'f++': 'anthropic:claude-fable-5.1:max',
  F: 'anthropic:claude-fable-5.1:high',

  'i-': 'google:gemini-3.1-pro-preview:low',
  i: 'google:gemini-3.1-pro-preview:medium',
  'i+': 'google:gemini-3.1-pro-preview:high',
  I: 'google:gemini-3.1-pro-preview:high',

  'j--': 'google:gemini-3.5-flash-lite:none',
  'j-': 'google:gemini-3.5-flash-lite:low',
  j: 'google:gemini-3.5-flash-lite:medium',
  'j+': 'google:gemini-3.5-flash-lite:high',
  J: 'google:gemini-3.5-flash-lite:high',

  'l--': 'google:gemini-3.8-flash:none',
  'l-': 'google:gemini-3.8-flash:low',
  l: 'google:gemini-3.8-flash:medium',
  'l+': 'google:gemini-3.8-flash:high',
  'l++': 'google:gemini-3.8-flash:max',
  L: 'google:gemini-3.8-flash:high',

  'x--': 'xai:grok-4.7:none',
  'x-': 'xai:grok-4.7:low',
  x: 'xai:grok-4.7:medium',
  'x+': 'xai:grok-4.7:high',
  'x++': 'xai:grok-4.7:xhigh',
  X: 'xai:grok-4.7:high',

  q: 'local:/root/model:none',

  v: 'vast:/root/model:none',

  'a--': 'alibaba:qwen3.8-max:none',
  'a-': 'alibaba:qwen3.8-max:low',
  a: 'alibaba:qwen3.8-max:medium',
  'a+': 'alibaba:qwen3.8-max:high',
  'a++': 'alibaba:qwen3.8-max:xhigh',
  A: 'alibaba:qwen3.8-max:high',

  'at--': 'alibaba:qwen3.8-2.4t-a95b:none',
  'at-': 'alibaba:qwen3.8-2.4t-a95b:low',
  at: 'alibaba:qwen3.8-2.4t-a95b:medium',
  'at+': 'alibaba:qwen3.8-2.4t-a95b:high',
  'at++': 'alibaba:qwen3.8-2.4t-a95b:xhigh',
  AT: 'alibaba:qwen3.8-2.4t-a95b:high',

  'al--': 'alibaba:qwen3.8-27b:none',
  'al-': 'alibaba:qwen3.8-27b:low',
  al: 'alibaba:qwen3.8-27b:medium',
  'al+': 'alibaba:qwen3.8-27b:high',
  'al++': 'alibaba:qwen3.8-27b:xhigh',
  AL: 'alibaba:qwen3.8-27b:high',

  'af--': 'alibaba:qwen3.8-flash:none',
  'af-': 'alibaba:qwen3.8-flash:low',
  af: 'alibaba:qwen3.8-flash:medium',
  'af+': 'alibaba:qwen3.8-flash:high',
  'af++': 'alibaba:qwen3.8-flash:xhigh',
  AF: 'alibaba:qwen3.8-flash:high',

  'd--': 'deepseek:deepseek-flash:none',
  'd-': 'deepseek:deepseek-flash:low',
  d: 'deepseek:deepseek-flash:high',
  'd+': 'deepseek:deepseek-flash:max',

  'D--': 'deepseek:deepseek-v4-pro:none',
  'D-': 'deepseek:deepseek-v4-pro:low',
  D: 'deepseek:deepseek-v4-pro:high',
  'D+': 'deepseek:deepseek-v4-pro:max',

  'z--': 'zai:glm-5.3:none',
  'z-': 'zai:glm-5.3:low',
  z: 'zai:glm-5.3:medium',
  'z+': 'zai:glm-5.3:high',
  'z++': 'zai:glm-5.3:max',
  Z: 'zai:glm-5.3:high',

  'zf--': 'zai:glm-5.3-flash:none',
  'zf-': 'zai:glm-5.3-flash:low',
  zf: 'zai:glm-5.3-flash:medium',
  'zf+': 'zai:glm-5.3-flash:high',
  'zf++': 'zai:glm-5.3-flash:max',
  ZF: 'zai:glm-5.3-flash:high',

  k: 'moonshotai:kimi-k2.7-code:none',

  'K-': 'moonshotai:kimi-k3:low',
  K: 'moonshotai:kimi-k3:high',
  'K+': 'moonshotai:kimi-k3:max',

  'm--': 'meta:muse-spark-1.3:none',
  'm-': 'meta:muse-spark-1.3:low',
  m: 'meta:muse-spark-1.3:medium',
  'm+': 'meta:muse-spark-1.3:high',
  'm++': 'meta:muse-spark-1.3:max',
  M: 'meta:muse-spark-1.3:high',

  'mc--': 'meta:muse-spark-1.3-contributor:none',
  'mc-': 'meta:muse-spark-1.3-contributor:low',
  mc: 'meta:muse-spark-1.3-contributor:medium',
  'mc+': 'meta:muse-spark-1.3-contributor:high',
  'mc++': 'meta:muse-spark-1.3-contributor:max',
  MC: 'meta:muse-spark-1.3-contributor:high',

  'mi--': 'xiaomi:mimo-v2.6-pro:none',
  'mi-': 'xiaomi:mimo-v2.6-pro:low',
  mi: 'xiaomi:mimo-v2.6-pro:medium',
  'mi+': 'xiaomi:mimo-v2.6-pro:high',
  'mi++': 'xiaomi:mimo-v2.6-pro:max',
  MI: 'xiaomi:mimo-v2.6-pro:high',

  'mif--': 'xiaomi:mimo-v2.6-flash:none',
  'mif-': 'xiaomi:mimo-v2.6-flash:low',
  mif: 'xiaomi:mimo-v2.6-flash:medium',
  'mif+': 'xiaomi:mimo-v2.6-flash:high',
  'mif++': 'xiaomi:mimo-v2.6-flash:max',
  MIF: 'xiaomi:mimo-v2.6-flash:high',
};

const AI_SDK_THINKING: Record<string, string> = {
  none: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
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
  'deepseek',
  'cerebras',
  'alibaba',
  'zai',
  'meta',
  'xiaomi',
]);

const VENDOR_KEY: Record<string, keyof SDKKeys> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  xai: 'xai',
  deepseek: 'deepseek',
  cerebras: 'cerebras',
  moonshotai: 'moonshotai',
  openrouter: 'openrouter',
  alibaba: 'alibaba',
  zai: 'zhipu',
  meta: 'meta',
  xiaomi: 'xiaomi',
};

const CEREBRAS_MODELS = new Set(['gpt-oss-120b', 'gemma-4-31b']);

function get_api_key(vendor: string, config: SDKConfig): string | undefined {
  const key_name = VENDOR_KEY[vendor];
  if (key_name) return config.keys[key_name];
  return undefined;
}

const MISSING_API_KEY = 'tell-sdk-missing-api-key';
const DEFAULT_VENDOR_URLS = {
  anthropic: 'https://api.anthropic.com/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  deepseek: 'https://api.deepseek.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  moonshotai: 'https://api.moonshot.ai/v1',
  openai: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
};
const API_KEY_CACHE_TOKENS = new Map<string, string>();
let next_api_key_cache_token = 0;

function api_key_cache_token(api_key: string | undefined): string {
  const value = api_key === undefined ? 'missing' : `key:${api_key}`;
  const existing = API_KEY_CACHE_TOKENS.get(value);
  if (existing) return existing;
  const token = `key-${next_api_key_cache_token++}`;
  API_KEY_CACHE_TOKENS.set(value, token);
  return token;
}

function provider_cache_key(vendor: string, base_url: string, api_key: string | undefined): string {
  return `${vendor}\0${base_url}\0${api_key_cache_token(api_key)}`;
}

function injected_api_key(api_key: string | undefined): string {
  return api_key ?? MISSING_API_KEY;
}

function infer_vendor(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized.startsWith('alibaba/')) return 'alibaba';
  if (normalized.includes('/')) return 'openrouter';
  if (normalized.startsWith('glm')) return 'zai';
  if (normalized.startsWith('gpt') || /^o\d/.test(normalized)) return 'openai';
  if (normalized.startsWith('claude')) return 'anthropic';
  if (normalized.startsWith('gemini')) return 'google';
  if (normalized.startsWith('grok')) return 'xai';
  if (normalized.startsWith('kimi')) return 'moonshotai';
  if (normalized.startsWith('muse')) return 'meta';
  if (normalized.startsWith('mimo')) return 'xiaomi';
  throw new Error(`Unsupported vendor for model "${model}"`);
}

// Provider caches are keyed by effective base URL ('' = provider default),
// so different endpoints in one process never share a stale provider.
const OPENAI_PROVIDERS: Record<string, any> = {};
const ANTHROPIC_PROVIDERS: Record<string, any> = {};
const GOOGLE_PROVIDERS: Record<string, any> = {};
const XAI_PROVIDERS: Record<string, any> = {};
const DEEPSEEK_PROVIDERS: Record<string, any> = {};
const CEREBRAS_PROVIDERS: Record<string, any> = {};
const MOONSHOTAI_PROVIDERS: Record<string, any> = {};
const OPENROUTER_PROVIDERS: Record<string, any> = {};
const OPENAI_WIRE_PROVIDERS: Record<string, (model: string) => any> = {};
const VAST_PROVIDERS: Record<string, any> = {};
const LOCAL_PROVIDERS: Record<string, any> = {};

/** Vendors that speak one of the OpenAI wire APIs, with no dedicated AI SDK package. */
type OpenAiWireVendor = 'alibaba' | 'zai' | 'xiaomi' | 'meta';

type OpenAiWireSpec = {
  /** `responses` = OpenAI Responses API, `chat` = Chat Completions. */
  api: 'chat' | 'responses';
  default_url: string;
  url_key: keyof SDKUrls;
  /** Header carrying the API key when it is not a Bearer token. */
  key_header?: string;
  /** Force the provider to send reasoning for model ids it does not recognize. */
  force_reasoning?: boolean;
};

const OPENAI_WIRE_VENDORS: Record<OpenAiWireVendor, OpenAiWireSpec> = {
  alibaba: {
    api: 'chat',
    default_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    url_key: 'alibaba',
  },
  zai: {
    api: 'chat',
    default_url: 'https://api.z.ai/api/paas/v4',
    url_key: 'zhipu',
  },
  xiaomi: {
    api: 'chat',
    default_url: 'https://api.xiaomimimo.com/v1',
    url_key: 'xiaomi',
    key_header: 'api-key',
  },
  meta: {
    api: 'responses',
    default_url: 'https://api.meta.ai/v1',
    url_key: 'meta',
    force_reasoning: true,
  },
};

async function get_openrouter_provider(config: SDKConfig): Promise<any> {
  const base_url = config.urls.openrouter ?? 'https://openrouter.ai/api/v1';
  const api_key = get_api_key('openrouter', config);
  const cache_key = provider_cache_key('openrouter', base_url, api_key);
  if (OPENROUTER_PROVIDERS[cache_key]) return OPENROUTER_PROVIDERS[cache_key];
  OPENROUTER_PROVIDERS[cache_key] = createOpenAI({
    apiKey: injected_api_key(api_key),
    baseURL: base_url,
    name: 'openrouter',
  });
  return OPENROUTER_PROVIDERS[cache_key];
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

  // `:fast` was already popped from parts — pass the popped spec, not the raw
  // trimmed input (otherwise `<alias>:fast` keeps the suffix and fails vendor lookup).
  const base_spec = parts.join(':');
  if (parts.length === 1) return resolve_single_part(base_spec, fast);

  const first_part = parts[0]?.trim().toLowerCase() ?? '';
  if (!SUPPORTED_VENDORS.has(first_part)) return resolve_single_part(base_spec, fast);

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

/**
 * Builds a model factory for vendors that speak an OpenAI wire API but have no
 * dedicated AI SDK package — Chat Completions goes through
 * `@ai-sdk/openai-compatible`, while the Responses API reuses `@ai-sdk/openai`'s
 * `.responses()`. The factory is cached per vendor + API + base URL so different
 * endpoints in one process never share a stale provider. Vendors in
 * `OPENAI_WIRE_VENDORS` are described by that table; any other vendor without a
 * dedicated handler falls back to Chat Completions so future vendors only need
 * a URL to work.
 */
async function get_openai_wire_factory(vendor: string, config: SDKConfig): Promise<(model: string) => any> {
  const wire = (OPENAI_WIRE_VENDORS as Record<string, OpenAiWireSpec | undefined>)[vendor];
  const api = wire?.api ?? 'chat';
  const url_key = wire?.url_key;
  const base_url = (url_key ? config.urls[url_key] : undefined) ?? wire?.default_url ?? '';
  const api_key = get_api_key(vendor, config);
  const cache_key = provider_cache_key(vendor, `${api}::${base_url}`, api_key);
  if (OPENAI_WIRE_PROVIDERS[cache_key]) return OPENAI_WIRE_PROVIDERS[cache_key];
  if (api === 'responses') {
    const provider = createOpenAI({
      apiKey: injected_api_key(api_key),
      baseURL: base_url,
      name: vendor,
    });
    OPENAI_WIRE_PROVIDERS[cache_key] = (model) => provider.responses(model);
  } else {
    const provider = createOpenAICompatible({
      name: vendor,
      ...(wire?.key_header
        ? { ...(api_key ? { headers: { [wire.key_header]: api_key } } : {}) }
        : { apiKey: injected_api_key(api_key) }),
      baseURL: base_url,
    });
    OPENAI_WIRE_PROVIDERS[cache_key] = (model) => provider(model);
  }
  return OPENAI_WIRE_PROVIDERS[cache_key];
}

async function handle_cerebras(
  model: string,
  reasoning: string,
  fast: boolean,
  config: SDKConfig,
): Promise<ModelHandle> {
  const api_key = get_api_key('cerebras', config);
  const base_url = config.urls.cerebras ?? DEFAULT_VENDOR_URLS.cerebras;
  const cache_key = provider_cache_key('cerebras', base_url, api_key);
  if (!CEREBRAS_PROVIDERS[cache_key]) {
    CEREBRAS_PROVIDERS[cache_key] = createCerebras({
      apiKey: injected_api_key(api_key),
      baseURL: base_url,
    });
  }
  return { model: CEREBRAS_PROVIDERS[cache_key](model), reasoning, fast };
}

async function handle_open_ai(
  model: string,
  reasoning: string,
  fast: boolean,
  config: SDKConfig,
): Promise<ModelHandle> {
  const api_key = get_api_key('openai', config);
  const base_url = config.urls.openai ?? DEFAULT_VENDOR_URLS.openai;
  const cache_key = provider_cache_key('openai', base_url, api_key);
  if (!OPENAI_PROVIDERS[cache_key]) {
    OPENAI_PROVIDERS[cache_key] = createOpenAI({
      apiKey: injected_api_key(api_key),
      baseURL: base_url,
    });
  }
  return { model: OPENAI_PROVIDERS[cache_key](model), reasoning, fast };
}

async function handle_anthropic(
  model: string,
  reasoning: string,
  fast: boolean,
  config: SDKConfig,
): Promise<ModelHandle> {
  const api_key = get_api_key('anthropic', config);
  const base_url = config.urls.anthropic ?? DEFAULT_VENDOR_URLS.anthropic;
  const cache_key = provider_cache_key('anthropic', base_url, api_key);
  if (!ANTHROPIC_PROVIDERS[cache_key]) {
    ANTHROPIC_PROVIDERS[cache_key] = createAnthropic({
      apiKey: injected_api_key(api_key),
      baseURL: base_url,
    });
  }
  return { model: ANTHROPIC_PROVIDERS[cache_key](model), reasoning, fast };
}

async function handle_google(model: string, reasoning: string, fast: boolean, config: SDKConfig): Promise<ModelHandle> {
  const api_key = get_api_key('google', config);
  const base_url = config.urls.google ?? DEFAULT_VENDOR_URLS.google;
  const cache_key = provider_cache_key('google', base_url, api_key);
  if (!GOOGLE_PROVIDERS[cache_key]) {
    GOOGLE_PROVIDERS[cache_key] = createGoogleGenerativeAI({
      apiKey: injected_api_key(api_key),
      baseURL: base_url,
    });
  }
  return { model: GOOGLE_PROVIDERS[cache_key](model), reasoning, fast };
}

async function handle_xai(model: string, reasoning: string, fast: boolean, config: SDKConfig): Promise<ModelHandle> {
  const api_key = get_api_key('xai', config);
  const base_url = config.urls.xai ?? DEFAULT_VENDOR_URLS.xai;
  const cache_key = provider_cache_key('xai', base_url, api_key);
  if (!XAI_PROVIDERS[cache_key]) {
    XAI_PROVIDERS[cache_key] = createXai({
      apiKey: injected_api_key(api_key),
      baseURL: base_url,
    });
  }
  return { model: XAI_PROVIDERS[cache_key](model), reasoning, fast };
}

async function handle_deepseek(
  model: string,
  reasoning: string,
  fast: boolean,
  config: SDKConfig,
): Promise<ModelHandle> {
  const api_key = get_api_key('deepseek', config);
  const base_url = config.urls.deepseek ?? DEFAULT_VENDOR_URLS.deepseek;
  const cache_key = provider_cache_key('deepseek', base_url, api_key);
  if (!DEEPSEEK_PROVIDERS[cache_key]) {
    DEEPSEEK_PROVIDERS[cache_key] = createDeepSeek({
      apiKey: injected_api_key(api_key),
      baseURL: base_url,
    });
  }
  return { model: DEEPSEEK_PROVIDERS[cache_key](model), reasoning, fast };
}

async function handle_moonshot_ai(
  model: string,
  reasoning: string,
  fast: boolean,
  config: SDKConfig,
): Promise<ModelHandle> {
  const api_key = get_api_key('moonshotai', config);
  const base_url = config.urls.moonshotai ?? DEFAULT_VENDOR_URLS.moonshotai;
  const cache_key = provider_cache_key('moonshotai', base_url, api_key);
  if (!MOONSHOTAI_PROVIDERS[cache_key]) {
    MOONSHOTAI_PROVIDERS[cache_key] = createMoonshotAI({
      apiKey: injected_api_key(api_key),
      baseURL: base_url,
    });
  }
  return { model: MOONSHOTAI_PROVIDERS[cache_key](model), reasoning, fast };
}

async function handle_openrouter(
  model: string,
  reasoning: string,
  fast: boolean,
  config: SDKConfig,
): Promise<ModelHandle> {
  const provider = await get_openrouter_provider(config);
  return { model: provider(model), reasoning, fast };
}
async function handle_alibaba(
  model: string,
  reasoning: string,
  fast: boolean,
  config: SDKConfig,
): Promise<ModelHandle> {
  const factory = await get_openai_wire_factory('alibaba', config);
  // DashScope model ids may carry the `alibaba/` prefix — strip it.
  return { model: factory(model.replace(/^alibaba\//i, '')), reasoning, fast };
}

async function handle_zhipu(model: string, reasoning: string, fast: boolean, config: SDKConfig): Promise<ModelHandle> {
  const factory = await get_openai_wire_factory('zai', config);
  return { model: factory(model), reasoning, fast };
}

async function handle_xiaomi(model: string, reasoning: string, fast: boolean, config: SDKConfig): Promise<ModelHandle> {
  const factory = await get_openai_wire_factory('xiaomi', config);
  return { model: factory(model), reasoning, fast };
}

async function handle_meta(model: string, reasoning: string, fast: boolean, config: SDKConfig): Promise<ModelHandle> {
  const factory = await get_openai_wire_factory('meta', config);
  return { model: factory(model), reasoning, fast };
}

async function handle_vast(model: string, reasoning: string, fast: boolean, config: SDKConfig): Promise<ModelHandle> {
  // Self-hosted endpoints have no meaningful default — fail with a clear message.
  const base_url = config.urls.vast;
  if (!base_url) throw new Error('vendor "vast" requires urls.vast (CLI env: VAST_BASE_URL)');
  const provider = await get_vast_provider(base_url);
  return { model: provider(model), reasoning, fast };
}

async function handle_local(model: string, reasoning: string, fast: boolean, config: SDKConfig): Promise<ModelHandle> {
  const base_url = config.urls.local;
  if (!base_url) throw new Error('vendor "local" requires urls.local (CLI env: LOCAL_OPENAI_BASE_URL)');
  const provider = await get_local_provider(base_url);
  return { model: provider.chat(model), reasoning, fast };
}

const VENDOR_HANDLERS: Record<string, (m: string, r: string, f: boolean, config: SDKConfig) => Promise<ModelHandle>> = {
  openai: handle_open_ai,
  anthropic: handle_anthropic,
  google: handle_google,
  xai: handle_xai,
  deepseek: handle_deepseek,
  cerebras: handle_cerebras,
  moonshotai: handle_moonshot_ai,
  openrouter: handle_openrouter,
  alibaba: handle_alibaba,
  zai: handle_zhipu,
  xiaomi: handle_xiaomi,
  meta: handle_meta,
  vast: handle_vast,
  local: handle_local,
};

/**
 * Maps a thinking level to the wire reasoning value plus explicit provider
 * options. The generic reasoning→effort map has no `max` entry, so vendors
 * whose enums top out elsewhere need a per-vendor rule — otherwise `max`
 * warns as unsupported and is dropped. Explicit options always take
 * precedence over the generic mapping. Fast mode never carries explicit
 * thinking: callers force `reasoning: 'none'` there, so it would leak
 * reasoning into a no-think request.
 */
function resolve_reasoning(
  vendor: string,
  mapped: string,
  fast: boolean,
): { reasoning: string; providerOptions?: Record<string, any> } {
  if (fast) return { reasoning: 'none' };
  if ((OPENAI_WIRE_VENDORS as Record<string, OpenAiWireSpec | undefined>)[vendor]?.force_reasoning) {
    return { reasoning: mapped, providerOptions: { openai: { forceReasoning: true } } };
  }
  if (mapped !== 'max') return { reasoning: mapped };
  switch (vendor) {
    case 'anthropic':
      return {
        reasoning: 'max',
        providerOptions: { anthropic: { effort: 'max', thinking: { type: 'adaptive', display: 'summarized' } } },
      };
    case 'deepseek':
      return { reasoning: 'max', providerOptions: { deepseek: { reasoningEffort: 'max' } } };
    case 'moonshotai':
      return { reasoning: 'max', providerOptions: { moonshotai: { reasoningEffort: 'max' } } };
    case 'xai':
      // Grok tops out at `xhigh` (kept verbatim on grok-4.7, else `high`).
      return { reasoning: 'xhigh' };
    case 'google':
      // Gemini thinking levels top out at `high`.
      return { reasoning: 'high' };
    default:
      // OpenAI and OpenAI-compatible endpoints forward `max` verbatim.
      return { reasoning: mapped };
  }
}

export async function get_model(spec: string, config: SDKConfig): Promise<ModelHandle> {
  const resolved = resolve_model_spec(spec);
  const { reasoning, providerOptions } = resolve_reasoning(
    resolved.vendor,
    AI_SDK_THINKING[resolved.thinking] ?? 'medium',
    resolved.fast,
  );

  if (resolved.vendor === 'openai' && CEREBRAS_MODELS.has(resolved.model)) {
    return handle_cerebras(resolved.model, reasoning, resolved.fast, config);
  }

  const handler = VENDOR_HANDLERS[resolved.vendor];
  if (!handler) {
    // No dedicated handler: use the OpenAI wire factory (Chat Completions or
    // Responses, per OPENAI_WIRE_VENDORS) so future vendors only need a URL.
    const factory = await get_openai_wire_factory(resolved.vendor, config);
    return {
      model: factory(resolved.model),
      reasoning,
      fast: resolved.fast,
      ...(providerOptions ? { providerOptions } : {}),
    };
  }
  const handle = await handler(resolved.model, reasoning, resolved.fast, config);
  return providerOptions ? { ...handle, providerOptions } : handle;
}
