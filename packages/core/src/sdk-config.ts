import { readFile } from 'fs/promises';
import { join } from 'path';
import { is_wire_api, type SDKConfig, type SDKKeys, type SDKUrls, WIRE_APIS, type WireApi } from '@tell-ai/sdk';

/** One vendor row of the environment mapping. */
type VendorSpec = {
  /** Config key receiving the credential. */
  key: keyof SDKKeys;
  /** Env names in priority order (the first non-blank value wins). */
  key_env: string[];
  /** Env name of the base-URL override (honored for every vendor). */
  url_env: string;
  /** Default base URL when the override is unset. */
  default_url?: string | undefined;
  /** `~/.config/<name>.token` fallback when token files are enabled. */
  token_file: string;
};

/**
 * Vendor → key/url mapping shared by every host.
 *
 * Every vendor honors its `*_BASE_URL` override (the strict behavior): an
 * explicit proxy URL is never silently ignored. Key lookup tries each
 * `key_env` name in order, then the `~/.config/<vendor>.token` file when the
 * host enables token files (the CLI does, the Web server does not).
 */
const VENDOR_SPECS: VendorSpec[] = [
  {
    key: 'openai',
    key_env: ['OPENAI_API_KEY'],
    url_env: 'OPENAI_BASE_URL',
    default_url: 'https://api.openai.com/v1',
    token_file: 'openai',
  },
  {
    key: 'anthropic',
    key_env: ['ANTHROPIC_API_KEY'],
    url_env: 'ANTHROPIC_BASE_URL',
    default_url: 'https://api.anthropic.com/v1',
    token_file: 'anthropic',
  },
  {
    key: 'google',
    key_env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    url_env: 'GOOGLE_BASE_URL',
    default_url: 'https://generativelanguage.googleapis.com/v1beta',
    token_file: 'google',
  },
  {
    key: 'xai',
    key_env: ['XAI_API_KEY'],
    url_env: 'XAI_BASE_URL',
    default_url: 'https://api.x.ai/v1',
    token_file: 'xai',
  },
  {
    key: 'deepseek',
    key_env: ['DEEPSEEK_API_KEY'],
    url_env: 'DEEPSEEK_BASE_URL',
    default_url: 'https://api.deepseek.com',
    token_file: 'deepseek',
  },
  {
    key: 'cerebras',
    key_env: ['CEREBRAS_API_KEY'],
    url_env: 'CEREBRAS_BASE_URL',
    default_url: 'https://api.cerebras.ai/v1',
    token_file: 'cerebras',
  },
  {
    key: 'moonshotai',
    key_env: ['MOONSHOTAI_API_KEY'],
    url_env: 'MOONSHOTAI_BASE_URL',
    default_url: 'https://api.moonshot.ai/v1',
    token_file: 'moonshotai',
  },
  {
    key: 'openrouter',
    key_env: ['OPENROUTER_API_KEY'],
    url_env: 'OPENROUTER_BASE_URL',
    default_url: 'https://openrouter.ai/api/v1',
    token_file: 'openrouter',
  },
  {
    key: 'alibaba',
    key_env: ['ALIBABA_API_KEY'],
    url_env: 'ALIBABA_BASE_URL',
    default_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    token_file: 'alibaba',
  },
  {
    key: 'zhipu',
    key_env: ['ZHIPU_API_KEY'],
    url_env: 'ZHIPU_BASE_URL',
    default_url: 'https://api.z.ai/api/paas/v4',
    token_file: 'zhipu',
  },
  {
    key: 'meta',
    key_env: ['META_API_KEY'],
    url_env: 'META_BASE_URL',
    default_url: 'https://api.meta.ai/v1',
    token_file: 'meta',
  },
  {
    key: 'xiaomi',
    key_env: ['MIMO_API_KEY'],
    url_env: 'MIMO_BASE_URL',
    default_url: 'https://api.xiaomimimo.com/v1',
    token_file: 'mimo',
  },
  {
    key: 'custom',
    key_env: ['CUSTOM_API_KEY'],
    url_env: 'CUSTOM_BASE_URL',
    token_file: 'custom',
  },
];

/** URL-only rows (self-hosted shims without a vendor key). */
const URL_ONLY_SPECS: { key: keyof SDKUrls; url_env: string }[] = [
  { key: 'vast', url_env: 'VAST_BASE_URL' },
  { key: 'local', url_env: 'LOCAL_OPENAI_BASE_URL' },
];

/** Environment record a host hands over (never read from `process` here). */
export type SdkConfigEnv = Record<string, string | undefined>;

/** Token-file source for `load_sdk_config_from_env`. */
export type SdkConfigSource = {
  /** Reads `~/.config/<vendor>.token` as a key fallback (CLI true, Web false). */
  token_files: boolean;
  /** Home directory the token files live under (required with `token_files`). */
  home_dir?: string | undefined;
};

/**
 * Reads a trimmed env value, blank/missing as undefined.
 *
 * @param env - Environment record handed over by the host.
 * @param name - Variable name.
 * @returns The trimmed value, or undefined when blank or missing.
 */
function env_value(env: SdkConfigEnv, name: string): string | undefined {
  const value = (env[name] ?? '').trim();
  return value === '' ? undefined : value;
}

/**
 * Reads `~/.config/<vendor>.token`, blank/missing as undefined.
 *
 * @param home_dir - Home directory the token files live under.
 * @param vendor - Token file name without the `.token` suffix.
 * @returns The trimmed token, or undefined when unreadable or blank.
 */
async function read_token_file(home_dir: string, vendor: string): Promise<string | undefined> {
  try {
    const token = (await readFile(join(home_dir, '.config', `${vendor}.token`), 'utf8')).trim();
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

/**
 * Reads `CUSTOM_API`, the wire-protocol override for the `custom` vendor.
 *
 * @param raw - Raw env value (already trimmed by the caller).
 * @returns The wire to pin, or undefined when unset.
 * @throws When the value is not one of `WIRE_APIS`.
 */
function parse_custom_wire(raw: string | undefined): WireApi | undefined {
  if (raw === undefined) {
    return undefined;
  } else {
    const value = raw.toLowerCase();
    if (!is_wire_api(value)) {
      throw new Error(`CUSTOM_API must be one of: ${WIRE_APIS.join(', ')} (got "${raw}")`);
    } else {
      return value;
    }
  }
}

/**
 * Reads `CUSTOM_HEADERS`, the escape hatch for endpoints that need a header
 * the SDK does not model (routing ids, tenant tags, gateway auth). JSON
 * object of string values, e.g. `{"x-tenant":"acme"}`.
 *
 * @param raw - Raw env value (already trimmed by the caller).
 * @returns Headers to merge into every custom-endpoint request.
 * @throws When the value is not a JSON object.
 */
function parse_custom_headers(raw: string | undefined): Record<string, string> {
  if (raw === undefined) {
    return {};
  } else {
    const hint = 'CUSTOM_HEADERS must be a JSON object, e.g. \'{"x-tenant":"acme"}\'';
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(hint);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(hint);
    } else {
      return Object.fromEntries(Object.entries(parsed).map(([name, header]) => [name, String(header)]));
    }
  }
}

/**
 * Builds the SDK config from a host environment record.
 *
 * Pure and synchronous: the vendor → key/url table, the `*_BASE_URL`
 * overrides and the `CUSTOM_*` knobs, but no token files. An invalid
 * `CUSTOM_API` or `CUSTOM_HEADERS` throws here instead of degrading
 * silently, so `get_model` keeps raising its own missing-credential errors
 * otherwise.
 *
 * @param env - Environment record handed over by the host.
 * @returns The injected `SDKConfig` (the SDK never reads the environment).
 */
export function build_sdk_config_from_env(env: SdkConfigEnv): SDKConfig {
  const keys: SDKKeys = {};
  for (const spec of VENDOR_SPECS) {
    for (const name of spec.key_env) {
      const value = env_value(env, name);
      if (value !== undefined) {
        keys[spec.key] = value;
        break;
      } else {
        // Try the next env name.
      }
    }
  }
  const urls: SDKUrls = {};
  for (const spec of VENDOR_SPECS) {
    const override = env_value(env, spec.url_env);
    if (override !== undefined) {
      urls[spec.key] = override;
    } else if (spec.default_url !== undefined) {
      urls[spec.key] = spec.default_url;
    } else {
      // Unset stays absent (never an empty string).
    }
  }
  for (const spec of URL_ONLY_SPECS) {
    const override = env_value(env, spec.url_env);
    if (override !== undefined) {
      urls[spec.key] = override;
    } else {
      // Unset stays absent (never an empty string).
    }
  }
  const config: SDKConfig = { keys, urls };
  const model = env_value(env, 'CUSTOM_MODEL');
  if (model !== undefined) {
    config.models = { custom: model };
  } else {
    // No custom default — `get_model` raises its own error.
  }
  const wire = parse_custom_wire(env_value(env, 'CUSTOM_API'));
  if (wire !== undefined) {
    config.wires = { custom: wire };
  } else {
    // No wire pin — prefix inference decides.
  }
  const headers = parse_custom_headers(env_value(env, 'CUSTOM_HEADERS'));
  if (Object.keys(headers).length > 0) {
    config.headers = { custom: headers };
  } else {
    // No extra headers — nothing to merge.
  }
  return config;
}

/**
 * Builds the SDK config, with the `~/.config/<vendor>.token` fallback.
 *
 * Single owner of the credential resolution: the pure mapping comes from
 * `build_sdk_config_from_env`, and a missing key falls back to its token
 * file only when the host enables token files (the CLI does, the Web server
 * does not).
 *
 * @param env - Environment record handed over by the host.
 * @param source - Token-file switch plus the home dir it reads from.
 * @returns The injected `SDKConfig` (the SDK never reads the environment).
 */
export async function load_sdk_config_from_env(
  env: SdkConfigEnv,
  source: SdkConfigSource = { token_files: false },
): Promise<SDKConfig> {
  const config = build_sdk_config_from_env(env);
  if (source.token_files && source.home_dir !== undefined) {
    for (const spec of VENDOR_SPECS) {
      if (config.keys[spec.key] === undefined) {
        const token = await read_token_file(source.home_dir, spec.token_file);
        if (token !== undefined) {
          config.keys[spec.key] = token;
        } else {
          // No token file either — stays absent.
        }
      } else {
        // Env hit wins over the token file.
      }
    }
  } else {
    // Token files off — env only.
  }
  return config;
}
