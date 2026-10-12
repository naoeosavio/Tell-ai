import { homedir } from 'node:os';
import { load_sdk_config_from_env } from '@tell-ai/core';
import type { SDKConfig } from '@tell-ai/sdk';

const ENV = (name: string): string => (process.env[name] ?? '').trim();

export const DEBUG: boolean = ENV('DEBUG').toLowerCase() === 'true' || ENV('DEBUG') === '1';

/**
 * Loads the SDK config from the process environment.
 *
 * Thin client over the core owner: the vendor → key/url table, the
 * `*_BASE_URL` overrides and the `CUSTOM_*` knobs all live in
 * `load_sdk_config_from_env`; the CLI only enables the
 * `~/.config/<vendor>.token` fallback the Web server skips.
 *
 * @returns The injected `SDKConfig`.
 */
export async function load_sdk_config(): Promise<SDKConfig> {
  const config: SDKConfig = await load_sdk_config_from_env(process.env, {
    token_files: true,
    home_dir: homedir(),
  });
  return config;
}
