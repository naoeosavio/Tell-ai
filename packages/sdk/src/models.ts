import { createAnthropic } from '@ai-sdk/anthropic';
import { createCerebras } from '@ai-sdk/cerebras';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import type { SDKConfig, SDKKeys } from './config';

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

  'o--': 'anthropic:claude-opus-5:none',
  'o-': 'anthropic:claude-opus-5:low',
  o: 'anthropic:claude-opus-5:medium',
  'o+': 'anthropic:claude-opus-5:high',
  'o++': 'anthropic:claude-opus-5:max',
  O: 'anthropic:claude-opus-5:high',

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

  'x--': 'xai:grok-4.6:none',
  'x-': 'xai:grok-4.6:low',
  x: 'xai:grok-4.6:medium',
  'x+': 'xai:grok-4.6:high',
  'x++': 'xai:grok-4.6:xhigh',
  X: 'xai:grok-4.6:high',

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

  'm--': 'openrouter:meta/muse-spark-1.3:none',
  'm-': 'openrouter:meta/muse-spark-1.3:low',
  m: 'openrouter:meta/muse-spark-1.3:medium',
  'm+': 'openrouter:meta/muse-spark-1.3:high',
  'm++': 'openrouter:meta/muse-spark-1.3:max',
  M: 'openrouter:meta/muse-spark-1.3:high',
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
};

const CEREBRAS_MODELS = new Set(['gpt-oss-120b', 'gemma-4-31b']);

function get_api_key(vendor: string, config: SDKConfig): string | undefined {
  const key_name = VENDOR_KEY[vendor];
  if (key_name) return config.keys[key_name];
  return undefined;
}

function infer_vendor(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized.startsWith('alibaba/')) return 'alibaba';
  if (normalized.startsWith('glm')) return 'zai';
  if (normalized.startsWith('gpt') || /^o\d/.test(normalized)) return 'openai';
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
let CEREBRAS: any = null;
let MOONSHOTAI: any = null;
let OPENROUTER: any = null;
let ALIBABA: any = null;
let ZHIPU: any = null;
const VAST_PROVIDERS: Record<string, any> = {};
const LOCAL_PROVIDERS: Record<string, any> = {};

async function get_openrouter_provider(config: SDKConfig): Promise<any> {
  if (OPENROUTER) return OPENROUTER;
  const api_key = get_api_key('openrouter', config);
  OPENROUTER = createOpenAI({
    ...(api_key ? { apiKey: api_key } : {}),
    baseURL: config.urls.openrouter ?? 'https://openrouter.ai/api/v1',
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

async function handle_cerebras(
  model: string,
  reasoning: string,
  fast: boolean,
  config: SDKConfig,
): Promise<ModelHandle> {
  if (!CEREBRAS) {
    const api_key = get_api_key('cerebras', config);
    const base_url = config.urls.cerebras;
    CEREBRAS = createCerebras({
      ...(api_key ? { apiKey: api_key } : {}),
      ...(base_url ? { baseURL: base_url } : {}),
    });
  }
  return { model: CEREBRAS(model), reasoning, fast };
}

async function handle_open_ai(
  model: string,
  reasoning: string,
  fast: boolean,
  config: SDKConfig,
): Promise<ModelHandle> {
  if (!OPENAI) {
    const api_key = get_api_key('openai', config);
    const base_url = config.urls.openai;
    OPENAI = createOpenAI({
      ...(api_key ? { apiKey: api_key } : {}),
      ...(base_url ? { baseURL: base_url } : {}),
    });
  }
  return { model: OPENAI(model), reasoning, fast };
}

async function handle_anthropic(
  model: string,
  reasoning: string,
  fast: boolean,
  config: SDKConfig,
): Promise<ModelHandle> {
  if (!ANTHROPIC) {
    const api_key = get_api_key('anthropic', config);
    const base_url = config.urls.anthropic;
    ANTHROPIC = createAnthropic({
      ...(api_key ? { apiKey: api_key } : {}),
      ...(base_url ? { baseURL: base_url } : {}),
    });
  }
  return { model: ANTHROPIC(model), reasoning, fast };
}

async function handle_google(model: string, reasoning: string, fast: boolean, config: SDKConfig): Promise<ModelHandle> {
  if (!GOOGLE) {
    const api_key = get_api_key('google', config);
    const base_url = config.urls.google;
    GOOGLE = api_key
      ? createGoogleGenerativeAI({ apiKey: api_key, ...(base_url ? { baseURL: base_url } : {}) })
      : createGoogleGenerativeAI({ ...(base_url ? { baseURL: base_url } : {}) });
  }
  return { model: GOOGLE(model), reasoning, fast };
}

async function handle_xai(model: string, reasoning: string, fast: boolean, config: SDKConfig): Promise<ModelHandle> {
  if (!XAI) {
    const api_key = get_api_key('xai', config);
    const base_url = config.urls.xai;
    XAI = createXai({
      ...(api_key ? { apiKey: api_key } : {}),
      ...(base_url ? { baseURL: base_url } : {}),
    });
  }
  return { model: XAI(model), reasoning, fast };
}

async function handle_deepseek(
  model: string,
  reasoning: string,
  fast: boolean,
  config: SDKConfig,
): Promise<ModelHandle> {
  if (!DEEPSEEK) {
    const api_key = get_api_key('deepseek', config);
    const base_url = config.urls.deepseek;
    DEEPSEEK = createDeepSeek({
      ...(api_key ? { apiKey: api_key } : {}),
      ...(base_url ? { baseURL: base_url } : {}),
    });
  }
  return { model: DEEPSEEK(model), reasoning, fast };
}

async function handle_moonshot_ai(
  model: string,
  reasoning: string,
  fast: boolean,
  config: SDKConfig,
): Promise<ModelHandle> {
  if (!MOONSHOTAI) {
    const api_key = get_api_key('moonshotai', config);
    const base_url = config.urls.moonshotai;
    MOONSHOTAI = createMoonshotAI({
      ...(api_key ? { apiKey: api_key } : {}),
      ...(base_url ? { baseURL: base_url } : {}),
    });
  }
  return { model: MOONSHOTAI(model), reasoning, fast };
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
  if (!ALIBABA) {
    const api_key = get_api_key('alibaba', config);
    const base_url = config.urls.alibaba;
    ALIBABA = createOpenAI({
      ...(api_key ? { apiKey: api_key } : {}),
      ...(base_url ? { baseURL: base_url } : {}),
      name: 'alibaba',
    });
  }
  return { model: ALIBABA(model.replace(/^alibaba\//i, '')), reasoning, fast };
}

async function handle_zhipu(model: string, reasoning: string, fast: boolean, config: SDKConfig): Promise<ModelHandle> {
  if (!ZHIPU) {
    const api_key = get_api_key('zai', config);
    const base_url = config.urls.zhipu;
    ZHIPU = createOpenAICompatible({
      name: 'zhipu',
      ...(api_key ? { apiKey: api_key } : {}),
      baseURL: base_url ?? 'https://api.z.ai/api/paas/v4',
    });
  }
  return { model: ZHIPU(model), reasoning, fast };
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
      // Grok tops out at `xhigh` (kept verbatim on grok-4.6, else `high`).
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
  if (!handler) throw new Error(`Unsupported vendor: ${resolved.vendor}`);
  return handler(resolved.model, reasoning, resolved.fast, config);
}
