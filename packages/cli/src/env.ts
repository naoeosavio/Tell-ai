import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SDKConfig, SDKKeys, SDKUrls } from '@tell-ai/sdk';

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
  };
  return { keys, urls };
}
