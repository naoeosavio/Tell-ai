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

  'o--': 'anthropic:claude-opus-4-8:none',
  'o-': 'anthropic:claude-opus-4-8:low',
  o: 'anthropic:claude-opus-4-8:medium',
  'o+': 'anthropic:claude-opus-4-8:high',
  'o++': 'anthropic:claude-opus-4-8:max',
  O: 'anthropic:claude-opus-4-8:high',

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

  'j-': 'google:gemini-3.1-flash-lite:low',
  j: 'google:gemini-3.1-flash-lite:medium',
  'j+': 'google:gemini-3.1-flash-lite:high',
  J: 'google:gemini-3.1-flash-lite:high',

  'l-': 'google:gemini-3.5-flash:low',
  l: 'google:gemini-3.5-flash:medium',
  'l+': 'google:gemini-3.5-flash:high',
  L: 'google:gemini-3.5-flash:high',

  'x-': 'xai:grok-4.5:low',
  x: 'xai:grok-4.5:medium',
  X: 'xai:grok-4.5:high',

  q: 'local:/root/model:none',

  v: 'vast:/root/model:none',

  'D--': 'deepseek:deepseek-v4-pro:low',
  'D-': 'deepseek:deepseek-v4-pro:medium',
  'D+': 'deepseek:deepseek-v4-pro:high',
  D: 'deepseek:deepseek-v4-pro:high',

  'd--': 'deepseek:deepseek-v4-flash:low',
  'd-': 'deepseek:deepseek-v4-flash:medium',
  'd+': 'deepseek:deepseek-v4-flash:high',
  d: 'deepseek:deepseek-v4-flash:high',

  'z--': 'fireworks:glm-5p2:none',
  'z-': 'fireworks:glm-5p2:low',
  z: 'fireworks:glm-5p2:medium',
  'z+': 'fireworks:glm-5p2:high',
  'z++': 'fireworks:glm-5p2:max',
  Z: 'fireworks:glm-5p2:high',

  k: 'moonshotai:kimi-k2.7-code:none',
  K: 'moonshotai:kimi-k3:max',
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

async function getApiKey(vendor: string): Promise<string | undefined> {
  const keyName = VENDOR_KEY[vendor];
  if (keyName && API_KEYS[keyName]) return API_KEYS[keyName];
  try {
    const token = (await readFile(join(homedir(), '.config', `${vendor}.token`), 'utf8')).trim();
    if (token) return token;
  } catch {}
  return undefined;
}

function inferVendor(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized.startsWith('gpt') || normalized.startsWith('o')) return 'openai';
  if (normalized.startsWith('claude')) return 'anthropic';
  if (normalized.startsWith('gemini')) return 'google';
  if (normalized.startsWith('grok')) return 'xai';
  if (normalized.startsWith('kimi')) return 'moonshotai';
  if (normalized.includes('/')) return 'openrouter';
  throw new Error(`Unsupported vendor for model "${model}"`);
}

let _openai: any = null;
let _anthropic: any = null;
let _google: any = null;
let _xai: any = null;
let _deepseek: any = null;
let _fireworks: any = null;
let _cerebras: any = null;
let _moonshotai: any = null;
let _openrouter: any = null;
const _vastProviders: Record<string, any> = {};
const _localProviders: Record<string, any> = {};

async function getOpenrouterProvider(): Promise<any> {
  if (_openrouter) return _openrouter;
  const apiKey = await getApiKey('openrouter');
  _openrouter = createOpenAI({ apiKey, baseURL: API_URLS.openrouter, name: 'openrouter' });
  return _openrouter;
}

const VALID_THINKING = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);

function normalizeThinking(raw: string): ThinkingLevel | null {
  const normalized = raw.trim().toLowerCase();
  return VALID_THINKING.has(normalized) ? (normalized as ThinkingLevel) : null;
}

function resolveSinglePart(term: string, fast: boolean): ResolvedModelSpec {
  const alias = MODELS[term];
  if (alias) {
    if (alias.includes(':')) {
      const resolved = parseModelSpecRaw(alias);
      resolved.fast = resolved.fast || fast;
      return resolved;
    }
    return { model: alias, vendor: inferVendor(alias), thinking: 'auto', fast };
  }
  return { model: term, vendor: inferVendor(term), thinking: 'auto', fast };
}

function resolveMultiPart(parts: string[], fast: boolean): ResolvedModelSpec {
  const [vendorRaw, modelRaw, thinkingRaw] = parts as [string, string, string | undefined];
  const vendor = vendorRaw.trim().toLowerCase();
  if (!SUPPORTED_VENDORS.has(vendor)) throw new Error(`Unsupported vendor: ${vendorRaw}`);

  const modelValue = modelRaw.trim();
  if (!modelValue) throw new Error('Model name must be provided after vendor');

  let model = modelValue;
  let aliasThinking: ThinkingLevel | undefined;
  if (MODELS[modelValue]) {
    const aliasSpec = parseModelSpecRaw(MODELS[modelValue]);
    if (aliasSpec.vendor !== vendor) {
      throw new Error(`Model alias "${modelValue}" belongs to vendor "${aliasSpec.vendor}", not "${vendorRaw}"`);
    }
    model = aliasSpec.model;
    aliasThinking = aliasSpec.thinking;
  }

  let thinking: ThinkingLevel = 'auto';
  if (thinkingRaw) {
    const level = normalizeThinking(thinkingRaw);
    if (!level) throw new Error(`Unsupported thinking budget "${thinkingRaw}"`);
    thinking = level;
  } else if (aliasThinking) {
    thinking = aliasThinking;
  }

  return { vendor, model, thinking, fast };
}

function parseModelSpecRaw(spec: string): ResolvedModelSpec {
  let trimmed = spec.trim();
  if (!trimmed) throw new Error('Model spec must be provided');

  let fast = false;
  if (trimmed.startsWith('.')) {
    fast = true;
    trimmed = trimmed.slice(1);
  }

  const parts = trimmed.split(':');
  if (parts.length > 1 && parts[parts.length - 1].trim().toLowerCase() === 'fast') {
    fast = true;
    parts.pop();
  }

  if (parts.length === 1) return resolveSinglePart(trimmed, fast);
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Expected "vendor:model" or "vendor:model:thinking", got "${spec}"`);
  }
  return resolveMultiPart(parts, fast);
}

export function resolveModelSpec(spec: string): ResolvedModelSpec {
  return parseModelSpecRaw(spec);
}

async function getVastProvider(baseURL: string): Promise<any> {
  if (_vastProviders[baseURL]) return _vastProviders[baseURL];
  _vastProviders[baseURL] = createOpenAI({ apiKey: 'not-needed', baseURL, name: 'vast' });
  return _vastProviders[baseURL];
}

async function getLocalProvider(baseURL: string): Promise<any> {
  if (_localProviders[baseURL]) return _localProviders[baseURL];
  _localProviders[baseURL] = createOpenAI({ apiKey: 'not-needed', baseURL, name: 'local' });
  return _localProviders[baseURL];
}

async function handleCerebras(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!_cerebras) {
    const apiKey = await getApiKey('cerebras');
    _cerebras = createCerebras({ apiKey });
  }
  return { model: _cerebras(model), reasoning, fast };
}

async function handleOpenAI(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!_openai) {
    const apiKey = await getApiKey('openai');
    _openai = createOpenAI({ apiKey });
  }
  return { model: _openai(model), reasoning, fast };
}

async function handleAnthropic(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!_anthropic) {
    const apiKey = await getApiKey('anthropic');
    _anthropic = createAnthropic({ apiKey });
  }
  return { model: _anthropic(model), reasoning, fast };
}

async function handleGoogle(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!_google) {
    const apiKey = await getApiKey('google');
    _google = apiKey ? createGoogleGenerativeAI({ apiKey }) : createGoogleGenerativeAI();
  }
  return { model: _google(model), reasoning, fast };
}

async function handleXai(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!_xai) {
    const apiKey = await getApiKey('xai');
    _xai = createXai({ apiKey });
  }
  return { model: _xai(model), reasoning, fast };
}

async function handleDeepseek(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!_deepseek) {
    const apiKey = await getApiKey('deepseek');
    _deepseek = createDeepSeek({ apiKey });
  }
  return { model: _deepseek(model), reasoning, fast };
}

async function handleFireworks(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!_fireworks) {
    const apiKey = await getApiKey('fireworks');
    _fireworks = createFireworks({ apiKey });
  }
  return { model: _fireworks(model), reasoning, fast };
}

async function handleMoonshotAI(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  if (!_moonshotai) {
    const apiKey = await getApiKey('moonshotai');
    _moonshotai = createMoonshotAI({ apiKey });
  }
  const reasoningEffort = reasoning !== 'none' ? 'max' : undefined;
  return { model: _moonshotai(model), reasoning, reasoningEffort, fast };
}

async function handleOpenrouter(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  const provider = await getOpenrouterProvider();
  return { model: provider(model), reasoning, fast };
}
async function handleVast(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  const provider = await getVastProvider(API_URLS.vast);
  return { model: provider.chat(model), reasoning, fast };
}

async function handleLocal(model: string, reasoning: string, fast: boolean): Promise<ModelHandle> {
  const provider = await getLocalProvider(API_URLS.local);
  return { model: provider.chat(model), reasoning, fast };
}

const VENDOR_HANDLERS: Record<string, (m: string, r: string, f: boolean) => Promise<ModelHandle>> = {
  openai: handleOpenAI,
  anthropic: handleAnthropic,
  google: handleGoogle,
  xai: handleXai,
  deepseek: handleDeepseek,
  fireworks: handleFireworks,
  moonshotai: handleMoonshotAI,
  openrouter: handleOpenrouter,
  vast: handleVast,
  local: handleLocal,
};

export async function getModel(spec: string): Promise<ModelHandle> {
  const resolved = resolveModelSpec(spec);
  const reasoning = AI_SDK_THINKING[resolved.thinking] ?? 'medium';

  if (resolved.vendor === 'openai' && CEREBRAS_MODELS.has(resolved.model)) {
    return handleCerebras(resolved.model, reasoning, resolved.fast);
  }

  const handler = VENDOR_HANDLERS[resolved.vendor];
  if (!handler) throw new Error(`Unsupported vendor: ${resolved.vendor}`);
  return handler(resolved.model, reasoning, resolved.fast);
}
