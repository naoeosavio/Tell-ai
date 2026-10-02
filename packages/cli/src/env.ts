import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { is_wire_api, type SDKConfig, type SDKKeys, type SDKUrls, WIRE_APIS, type WireApi } from '@tell-ai/sdk';

const ENV = (name: string): string => (process.env[name] ?? '').trim();

export const DEBUG: boolean = ENV('DEBUG').toLowerCase() === 'true' || ENV('DEBUG') === '1';

async function read_token_file(vendor: string): Promise<string | undefined> {
  try {
    const token = (await readFile(join(homedir(), '.config', `${vendor}.token`), 'utf8')).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads `CUSTOM_API`, the wire-protocol override for the `custom` vendor.
 *
 * @param raw - Raw env value.
 * @returns The wire to pin, or undefined when the env var is empty.
 * @throws When the value is not one of `WIRE_APIS`.
 */
function parse_custom_wire(raw: string): WireApi | undefined {
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (!is_wire_api(value)) {
    throw new Error(`CUSTOM_API must be one of: ${WIRE_APIS.join(', ')} (got "${raw}")`);
  }
  return value;
}

/**
 * Reads `CUSTOM_HEADERS`, the escape hatch for endpoints that need a header the
 * SDK does not model (routing ids, tenant tags, gateway auth). JSON object of
 * string values, e.g. `{"x-tenant":"acme"}`.
 *
 * @param raw - Raw env value.
 * @returns Headers to merge into every custom-endpoint request.
 * @throws When the value is not a JSON object.
 */
function parse_custom_headers(raw: string): Record<string, string> {
  const value = raw.trim();
  if (!value) return {};
  const hint = 'CUSTOM_HEADERS must be a JSON object, e.g. \'{"x-tenant":"acme"}\'';
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(hint);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(hint);
  return Object.fromEntries(Object.entries(parsed).map(([name, header]) => [name, String(header)]));
}

export async function load_sdk_config(): Promise<SDKConfig> {
  const keys: SDKKeys = {
    openai: ENV('OPENAI_API_KEY') || (await read_token_file('openai')),
    anthropic: ENV('ANTHROPIC_API_KEY') || (await read_token_file('anthropic')),
    google: ENV('GOOGLE_API_KEY') || ENV('GEMINI_API_KEY') || (await read_token_file('google')),
    xai: ENV('XAI_API_KEY') || (await read_token_file('xai')),
    deepseek: ENV('DEEPSEEK_API_KEY') || (await read_token_file('deepseek')),
    cerebras: ENV('CEREBRAS_API_KEY') || (await read_token_file('cerebras')),
    moonshotai: ENV('MOONSHOTAI_API_KEY') || (await read_token_file('moonshotai')),
    openrouter: ENV('OPENROUTER_API_KEY') || (await read_token_file('openrouter')),
    alibaba: ENV('ALIBABA_API_KEY') || (await read_token_file('alibaba')),
    zhipu: ENV('ZHIPU_API_KEY') || (await read_token_file('zhipu')),
    meta: ENV('META_API_KEY') || (await read_token_file('meta')),
    xiaomi: ENV('MIMO_API_KEY') || (await read_token_file('mimo')),
    custom: ENV('CUSTOM_API_KEY') || (await read_token_file('custom')),
  };
  const urls: SDKUrls = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta',
    xai: 'https://api.x.ai/v1',
    deepseek: 'https://api.deepseek.com',
    cerebras: 'https://api.cerebras.ai/v1',
    moonshotai: 'https://api.moonshot.ai/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    alibaba: ENV('ALIBABA_BASE_URL') || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    zhipu: ENV('ZHIPU_BASE_URL') || 'https://api.z.ai/api/paas/v4',
    meta: ENV('META_BASE_URL') || 'https://api.meta.ai/v1',
    xiaomi: ENV('MIMO_BASE_URL') || 'https://api.xiaomimimo.com/v1',
    vast: ENV('VAST_BASE_URL'),
    local: ENV('LOCAL_OPENAI_BASE_URL'),
    custom: ENV('CUSTOM_BASE_URL') || undefined,
  };
  const config: SDKConfig = { keys, urls };

  // The three `CUSTOM_*` knobs are optional; each one only lands in the config
  // when set, so `get_model` keeps raising its own missing-env error otherwise.
  const model = ENV('CUSTOM_MODEL');
  if (model) config.models = { custom: model };
  const wire = parse_custom_wire(ENV('CUSTOM_API'));
  if (wire) config.wires = { custom: wire };
  const headers = parse_custom_headers(ENV('CUSTOM_HEADERS'));
  if (Object.keys(headers).length > 0) config.headers = { custom: headers };

  return config;
}
