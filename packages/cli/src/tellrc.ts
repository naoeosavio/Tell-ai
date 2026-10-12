import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TELLRC_LIMIT_KEYS, validate_tellrc_limit_value } from '@tell-ai/core';

/** Max bytes of a `.tellrc` file read before it is ignored with a warning. */
export const TELLRC_MAX_BYTES = 256 * 1024;
/** Max bytes of a `system-file` payload injected as custom instructions. */
export const SYSTEM_FILE_MAX_BYTES = 64 * 1024;
/** Valid temperature interval forwarded to the provider. */
export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 2;
/** Built-in profile names shipped as data (enforcement lives in policy-sandbox). */
export const BUILTIN_PROFILES = ['node', 'security', 'devops'] as const;
/** Profile name type for the three built-in profiles. */
export type BuiltinProfileName = (typeof BUILTIN_PROFILES)[number];

/** Delegatable numeric limits (validated data, enforcement in runtime-limits). */
export type TellrcLimits = {
  max_chain_steps?: number | undefined;
  max_buffer_bytes?: number | undefined;
  context_chars?: number | undefined;
  stdin_timeout_ms?: number | undefined;
  stdin_max_bytes?: number | undefined;
  exec_timeout_ms?: number | undefined;
  output_max_bytes?: number | undefined;
};

/** Profile data: prompt/style/model/temperature plus deny data and limits. */
export type TellrcProfile = {
  name: string;
  prompt?: string | undefined;
  style?: string | undefined;
  model?: string | undefined;
  temperature?: number | undefined;
  system?: string | undefined;
  system_file?: string | undefined;
  /** Origin of `system_file` (file path), for the project path gate. */
  system_file_from?: string | undefined;
  /** Loaded `system_file` payload (set by the caller, never parsed). */
  system_text?: string | undefined;
  /** Aliases scoped to this profile (below file-level `[aliases]`). */
  aliases: Record<string, string>;
  deny_commands: string[];
  limits: TellrcLimits;
};

/** One parsed `.tellrc` file with its origin for provenance. */
export type ParsedTellrc = {
  source: string;
  model?: string | undefined;
  system?: string | undefined;
  system_file?: string | undefined;
  temperature?: number | undefined;
  profile?: string | undefined;
  aliases: Record<string, string>;
  deny_commands: string[];
  limits: TellrcLimits;
  profiles: Record<string, TellrcProfile>;
  warnings: string[];
};

/** A file layer with explicit precedence rank (user below project). */
export type TellrcLayer = ParsedTellrc & {
  rank: number;
};

/** Fully resolved tellrc config for one CLI invocation. */
export type ResolvedTellrc = {
  model?: string | undefined;
  system?: string | undefined;
  system_file?: string | undefined;
  system_text?: string | undefined;
  temperature?: number | undefined;
  profile?: string | undefined;
  profile_data?: TellrcProfile | undefined;
  aliases: Record<string, string>;
  deny_commands: string[];
  limits: TellrcLimits;
  provenance: Record<string, string>;
  warnings: string[];
};

/** Scalar CLI flag overrides accepted on top of env and files. */
export type TellrcFlags = {
  model?: string | undefined;
  system?: string | undefined;
  system_file?: string | undefined;
  temperature?: number | undefined;
  profile?: string | undefined;
};

/** Env layer subset (TELL_* knobs, never secrets). */
export type TellrcEnv = {
  TELL_MODEL?: string | undefined;
  TELL_SYSTEM?: string | undefined;
  TELL_SYSTEM_FILE?: string | undefined;
  TELL_TEMPERATURE?: string | undefined;
  TELL_PROFILE?: string | undefined;
};

const KNOWN_TOP_KEYS = new Set(['model', 'system', 'system-file', 'system_file', 'temperature', 'profile']);
const KNOWN_PROFILE_KEYS = new Set([
  'prompt',
  'style',
  'model',
  'temperature',
  'system',
  'system-file',
  'system_file',
  'deny_commands',
  'denycommands',
  'deny',
  ...TELLRC_LIMIT_KEYS,
]);
const KNOWN_LIMIT_KEYS = new Set(TELLRC_LIMIT_KEYS);
/** Charset for custom profile names (`profiles.<name>` sections). */
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Splits a `profiles.*` section name into its profile and kind.
 *
 * Accepts `profiles.<name>` and the aliases subsection
 * `profiles.<name>.aliases` for any name matching
 * `PROFILE_NAME_PATTERN` (sections are lowercased before parsing).
 *
 * @param name - Lowercased section name starting with `profiles.`.
 * @returns The profile name and subsection kind, or null when invalid.
 */
export function parse_profile_section(name: string): { profile: string; aliases_only: boolean } | null {
  const rest = name.slice('profiles.'.length);
  if (!rest) {
    return null;
  } else {
    const alias_suffix = '.aliases';
    if (rest.endsWith(alias_suffix)) {
      const profile = rest.slice(0, -alias_suffix.length);
      if (!PROFILE_NAME_PATTERN.test(profile)) {
        return null;
      } else {
        return { profile, aliases_only: true };
      }
    } else if (!PROFILE_NAME_PATTERN.test(rest)) {
      return null;
    } else {
      return { profile: rest, aliases_only: false };
    }
  }
}

/**
 * Emits a yellow CLI-style warning to stderr without leaking values.
 *
 * @param message - Warning text without secrets.
 */
function warn_tellrc(message: string): void {
  process.stderr.write(`\x1b[33mWarning: ${message}\x1b[0m\n`);
}

/**
 * Expands a leading `~` in a path value only (never in free text).
 *
 * @param value - Raw path value from the INI file.
 * @param home - Home directory used for `~` expansion.
 * @returns The expanded path.
 */
export function expand_tilde_path(value: string, home: string): string {
  if (value === '~') {
    return home;
  } else if (value.startsWith('~/')) {
    return path.join(home, value.slice(2));
  } else {
    return value;
  }
}

/**
 * Splits a deny value on commas into trimmed non-empty entries.
 *
 * @param value - Raw deny value.
 * @returns The deny entries.
 */
function split_deny_value(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Validates a temperature value from INI/env/flags.
 *
 * @param raw - Raw numeric value.
 * @returns The temperature, or undefined when invalid.
 */
export function validate_temperature(raw: unknown): number | undefined {
  const value = typeof raw === 'string' ? Number(raw) : (raw as number);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  } else if (value < TEMPERATURE_MIN || value > TEMPERATURE_MAX) {
    return undefined;
  } else {
    return value;
  }
}

/**
 * Creates an empty parsed tellrc for one source.
 *
 * @param source - Provenance label (file path or layer name).
 * @returns An empty `ParsedTellrc`.
 */
export function empty_parsed_tellrc(source: string): ParsedTellrc {
  return { source, aliases: {}, deny_commands: [], limits: {}, profiles: {}, warnings: [] };
}

/**
 * Parses INI text into a `ParsedTellrc` without dependencies.
 *
 * Rules: `key = value` lines, whole-line `#`/`;` comments, sections
 * `[aliases]`, `[profiles.<name>]` (any valid name, plus an aliases
 * subsection `profiles.<name>.aliases`), `[policy]` and `[limits]`. Inline `#`/`;` stays in values. Repeated scalars keep the
 * last assignment; deny entries accumulate.
 *
 * @param text - Raw INI file content.
 * @param source - Provenance label for warnings.
 * @returns The parsed tellrc with warnings (no secrets in warnings).
 */
export function parse_tellrc(text: string, source: string): ParsedTellrc {
  const parsed = empty_parsed_tellrc(source);
  if (text.includes('\0')) {
    parsed.warnings.push(`${source}: NUL byte rejected`);
    return parsed;
  } else {
    // NUL-free input continues below.
  }
  let section = '';
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw_line = lines[index] ?? '';
    const line = raw_line.trim();
    if (!line) {
      continue;
    } else if (line.startsWith('#') || line.startsWith(';')) {
      continue;
    } else if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim().toLowerCase();
      if (name === 'aliases' || name === 'policy' || name === 'limits') {
        section = name;
      } else if (name === 'profiles' || name.startsWith('profiles.')) {
        if (parse_profile_section(name) === null) {
          parsed.warnings.push(`${source}:${index + 1}: unknown section [${name}]`);
          section = '';
        } else {
          section = name;
        }
      } else {
        parsed.warnings.push(`${source}:${index + 1}: unknown section [${name}]`);
        section = '';
      }
      continue;
    } else {
      // Key/value lines handled below.
    }
    const eq = raw_line.indexOf('=');
    if (eq < 0) {
      parsed.warnings.push(`${source}:${index + 1}: invalid line (missing =)`);
      continue;
    } else {
      // Valid separator found.
    }
    const raw_key = raw_line.slice(0, eq).trim();
    const raw_value = raw_line.slice(eq + 1).trim();
    if (!raw_key || raw_key.includes('\0') || raw_value.includes('\0')) {
      parsed.warnings.push(`${source}:${index + 1}: invalid key/value`);
      continue;
    } else {
      // Key and value are usable.
    }
    const key = raw_key.toLowerCase();
    if (section === '') {
      if (!KNOWN_TOP_KEYS.has(key)) {
        parsed.warnings.push(`${source}:${index + 1}: unknown key ${raw_key}`);
      } else if (key === 'model') {
        parsed.model = raw_value;
      } else if (key === 'system') {
        parsed.system = raw_value;
      } else if (key === 'system-file' || key === 'system_file') {
        parsed.system_file = raw_value;
      } else if (key === 'temperature') {
        const value = validate_temperature(raw_value);
        if (value === undefined) {
          parsed.warnings.push(`${source}:${index + 1}: invalid temperature`);
        } else {
          parsed.temperature = value;
        }
      } else if (key === 'profile') {
        parsed.profile = raw_value.toLowerCase();
      } else {
        parsed.warnings.push(`${source}:${index + 1}: unknown key ${raw_key}`);
      }
    } else if (section === 'aliases') {
      if (!key) {
        parsed.warnings.push(`${source}:${index + 1}: invalid alias`);
      } else {
        parsed.aliases[raw_key.trim()] = raw_value;
      }
    } else if (section === 'policy') {
      if (key === 'deny_commands' || key === 'denycommands' || key === 'deny') {
        parsed.deny_commands.push(...split_deny_value(raw_value));
      } else {
        parsed.warnings.push(`${source}:${index + 1}: unknown policy key ${raw_key}`);
      }
    } else if (section === 'limits') {
      if (!KNOWN_LIMIT_KEYS.has(key)) {
        parsed.warnings.push(`${source}:${index + 1}: unknown limit ${raw_key}`);
      } else {
        const value = validate_tellrc_limit_value(key, raw_value);
        if (value === undefined) {
          parsed.warnings.push(`${source}:${index + 1}: invalid limit ${raw_key}`);
        } else {
          (parsed.limits as Record<string, number>)[key] = value;
        }
      }
    } else if (section.startsWith('profiles.')) {
      const part = parse_profile_section(section);
      if (part === null) {
        parsed.warnings.push(`${source}:${index + 1}: key outside a known section`);
        continue;
      } else {
        // Section header was validated; route the key below.
      }
      const existing: TellrcProfile = parsed.profiles[part.profile] ?? {
        name: part.profile,
        aliases: {},
        deny_commands: [],
        limits: {},
      };
      if (part.aliases_only) {
        const alias_name = raw_key.trim();
        if (!alias_name) {
          parsed.warnings.push(`${source}:${index + 1}: invalid alias`);
        } else {
          existing.aliases[alias_name] = raw_value;
        }
      } else if (!KNOWN_PROFILE_KEYS.has(key)) {
        parsed.warnings.push(`${source}:${index + 1}: unknown profile key ${raw_key}`);
        continue;
      } else if (key === 'prompt') {
        existing.prompt = raw_value;
      } else if (key === 'style') {
        existing.style = raw_value;
      } else if (key === 'model') {
        existing.model = raw_value;
      } else if (key === 'temperature') {
        const value = validate_temperature(raw_value);
        if (value === undefined) {
          parsed.warnings.push(`${source}:${index + 1}: invalid profile temperature`);
        } else {
          existing.temperature = value;
        }
      } else if (key === 'system') {
        existing.system = raw_value;
      } else if (key === 'system-file' || key === 'system_file') {
        existing.system_file = raw_value;
        existing.system_file_from = source;
      } else if (key === 'deny_commands' || key === 'denycommands' || key === 'deny') {
        existing.deny_commands.push(...split_deny_value(raw_value));
      } else if (KNOWN_LIMIT_KEYS.has(key)) {
        const value = validate_tellrc_limit_value(key, raw_value);
        if (value === undefined) {
          parsed.warnings.push(`${source}:${index + 1}: invalid profile limit ${raw_key}`);
        } else {
          (existing.limits as Record<string, number>)[key] = value;
        }
      } else {
        parsed.warnings.push(`${source}:${index + 1}: unknown profile key ${raw_key}`);
        continue;
      }
      parsed.profiles[part.profile] = existing;
    } else {
      parsed.warnings.push(`${source}:${index + 1}: key outside a known section`);
    }
  }
  return parsed;
}

/**
 * Reads one `.tellrc` file with size cap and silent absence.
 *
 * @param file - Absolute file path.
 * @returns The parsed file, or null when absent.
 */
export function load_tellrc_file(file: string): ParsedTellrc | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    const parsed = empty_parsed_tellrc(file);
    parsed.warnings.push(`${file}: not a regular file`);
    return parsed;
  } else {
    // Regular file continues below.
  }
  if (stat.size > TELLRC_MAX_BYTES) {
    const parsed = empty_parsed_tellrc(file);
    parsed.warnings.push(`${file}: exceeds 256 KB, ignored`);
    return parsed;
  } else {
    // Size within cap.
  }
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    const parsed = empty_parsed_tellrc(file);
    parsed.warnings.push(`${file}: unreadable`);
    return parsed;
  }
  return parse_tellrc(text, file);
}

/**
 * Loads user and project `.tellrc` layers (absence is silent).
 *
 * @param cwd - Working directory owning the project `.tellrc`.
 * @param home - Home directory owning `~/.tellrc`.
 * @returns Layers ordered user then project, each with a rank.
 */
export function load_tellrc(cwd: string, home: string): TellrcLayer[] {
  const base_home = home || os.homedir();
  const base_cwd = cwd || process.cwd();
  const layers: TellrcLayer[] = [];
  const user_file = path.join(base_home, '.tellrc');
  const user = load_tellrc_file(user_file);
  if (user) {
    layers.push({ ...user, rank: 1 });
  } else {
    // No user file — silent by design.
  }
  const project_file = path.join(base_cwd, '.tellrc');
  if (path.resolve(project_file) === path.resolve(user_file)) {
    return layers;
  } else {
    const project = load_tellrc_file(project_file);
    if (project) {
      layers.push({ ...project, rank: 2 });
    } else {
      // No project file — silent by design.
    }
    return layers;
  }
}

/**
 * Builds the built-in profile record for one name.
 *
 * Known names carry default prompt/style data; any other valid name starts
 * empty (custom profiles have no built-in defaults).
 *
 * @param name - Profile name (built-in or custom).
 * @returns The built-in profile data.
 */
export function builtin_profile(name: string): TellrcProfile {
  if (name === 'security') {
    return {
      name,
      prompt: 'You are a security-focused assistant. Prefer least privilege and call out risks.',
      style: 'cautious',
      aliases: {},
      deny_commands: [],
      limits: {},
    };
  } else if (name === 'devops') {
    return {
      name,
      prompt: 'You are a DevOps assistant. Prefer idempotent commands and explicit verification.',
      style: 'operational',
      aliases: {},
      deny_commands: [],
      limits: {},
    };
  } else if (name === 'node') {
    return {
      name,
      prompt: 'You are a Node.js assistant. Prefer bun, TypeScript and minimal dependencies.',
      style: 'concise',
      aliases: {},
      deny_commands: [],
      limits: {},
    };
  } else {
    return { name, aliases: {}, deny_commands: [], limits: {} };
  }
}

/**
 * Resolves file layers plus env and flags into one `ResolvedTellrc`.
 *
 * Precedence for scalars: flag > env > project > user > default. Deny
 * lists are union-only (most restrictive always wins and is never
 * removed by a lower layer or flag).
 *
 * @param layers - File layers from `load_tellrc` (rank decides precedence).
 * @param flags - CLI flag overrides.
 * @param env - Env subset (TELL_* only, never secrets).
 * @returns The resolved config with per-value provenance.
 */
export function resolve_tellrc(layers: TellrcLayer[], flags: TellrcFlags = {}, env: TellrcEnv = {}): ResolvedTellrc {
  const sorted = [...layers].sort((a, b) => a.rank - b.rank);
  const provenance: Record<string, string> = {};
  const warnings: string[] = [];
  const aliases: Record<string, string> = {};
  const deny_commands: string[] = [];
  const limits: TellrcLimits = {};
  const profiles: Record<string, TellrcProfile> = {};
  let model: string | undefined;
  let model_from = '';
  let system: string | undefined;
  let system_from = '';
  let system_file: string | undefined;
  let system_file_from = '';
  let temperature: number | undefined;
  let temperature_from = '';
  let profile: string | undefined;
  let profile_from = '';

  for (const layer of sorted) {
    for (const warning of layer.warnings) warnings.push(warning);
    Object.assign(aliases, layer.aliases);
    if (Object.keys(layer.aliases).length > 0) provenance['aliases'] = layer.source;
    for (const entry of layer.deny_commands) {
      if (!deny_commands.includes(entry)) deny_commands.push(entry);
    }
    if (layer.deny_commands.length > 0) provenance['deny_commands'] = 'union';
    for (const [key, value] of Object.entries(layer.limits)) {
      (limits as Record<string, number>)[key] = value as number;
      provenance[`limits.${key}`] = layer.source;
    }
    for (const [name, entry] of Object.entries(layer.profiles)) {
      const merged: TellrcProfile = profiles[name] ?? { name, aliases: {}, deny_commands: [], limits: {} };
      if (entry.prompt !== undefined) merged.prompt = entry.prompt;
      if (entry.style !== undefined) merged.style = entry.style;
      if (entry.model !== undefined) merged.model = entry.model;
      if (entry.temperature !== undefined) merged.temperature = entry.temperature;
      if (entry.system !== undefined) merged.system = entry.system;
      if (entry.system_file !== undefined) {
        merged.system_file = entry.system_file;
        merged.system_file_from = layer.source;
      } else {
        // No system-file for this profile in this layer.
      }
      Object.assign(merged.aliases, entry.aliases);
      for (const deny of entry.deny_commands) {
        if (!merged.deny_commands.includes(deny)) merged.deny_commands.push(deny);
      }
      Object.assign(merged.limits, entry.limits);
      profiles[name] = merged;
      provenance[`profiles.${name}`] = layer.source;
    }
    if (layer.model !== undefined) {
      model = layer.model;
      model_from = layer.source;
    } else {
      // No model in this layer.
    }
    if (layer.system !== undefined) {
      system = layer.system;
      system_from = layer.source;
    } else {
      // No system in this layer.
    }
    if (layer.system_file !== undefined) {
      system_file = layer.system_file;
      system_file_from = layer.source;
    } else {
      // No system-file in this layer.
    }
    if (layer.temperature !== undefined) {
      temperature = layer.temperature;
      temperature_from = layer.source;
    } else {
      // No temperature in this layer.
    }
    if (layer.profile !== undefined) {
      profile = layer.profile;
      profile_from = layer.source;
    } else {
      // No profile in this layer.
    }
  }

  const env_temperature = env.TELL_TEMPERATURE !== undefined ? validate_temperature(env.TELL_TEMPERATURE) : undefined;
  if (env.TELL_MODEL?.trim()) {
    model = env.TELL_MODEL.trim();
    model_from = 'env:TELL_MODEL';
  } else {
    // No env model.
  }
  if (env.TELL_SYSTEM?.trim()) {
    system = env.TELL_SYSTEM;
    system_from = 'env:TELL_SYSTEM';
  } else {
    // No env system.
  }
  if (env.TELL_SYSTEM_FILE?.trim()) {
    system_file = env.TELL_SYSTEM_FILE.trim();
    system_file_from = 'env:TELL_SYSTEM_FILE';
  } else {
    // No env system-file.
  }
  if (env_temperature !== undefined) {
    temperature = env_temperature;
    temperature_from = 'env:TELL_TEMPERATURE';
  } else if (env.TELL_TEMPERATURE !== undefined) {
    warnings.push('env:TELL_TEMPERATURE: invalid temperature');
  } else {
    // No env temperature.
  }
  if (env.TELL_PROFILE?.trim()) {
    profile = env.TELL_PROFILE.trim().toLowerCase();
    profile_from = 'env:TELL_PROFILE';
  } else {
    // No env profile.
  }

  const flag_temperature = flags.temperature;
  if (flags.model?.trim()) {
    model = flags.model.trim();
    model_from = 'flag';
  } else {
    // No flag model.
  }
  if (flags.system?.trim()) {
    system = flags.system;
    system_from = 'flag';
  } else {
    // No flag system.
  }
  if (flags.system_file?.trim()) {
    system_file = flags.system_file.trim();
    system_file_from = 'flag';
  } else {
    // No flag system-file.
  }
  if (flag_temperature !== undefined) {
    const value = validate_temperature(flag_temperature);
    if (value === undefined) {
      warnings.push('flag: invalid temperature');
    } else {
      temperature = value;
      temperature_from = 'flag';
    }
  } else {
    // No flag temperature.
  }
  if (flags.profile?.trim()) {
    profile = flags.profile.trim().toLowerCase();
    profile_from = 'flag';
  } else {
    // No flag profile.
  }

  if (model_from) provenance['model'] = model_from;
  if (system_from) provenance['system'] = system_from;
  if (system_file_from) provenance['system_file'] = system_file_from;
  if (temperature_from) provenance['temperature'] = temperature_from;
  if (profile_from) provenance['profile'] = profile_from;

  let profile_data: TellrcProfile | undefined;
  if (profile) {
    if (!PROFILE_NAME_PATTERN.test(profile)) {
      warnings.push(`invalid profile name ${profile}`);
      profile_data = undefined;
    } else {
      const base = builtin_profile(profile);
      const overlay = profiles[profile];
      if (overlay) {
        profile_data = {
          name: profile,
          prompt: overlay.prompt ?? base.prompt,
          style: overlay.style ?? base.style,
          model: overlay.model ?? base.model,
          temperature: overlay.temperature ?? base.temperature,
          system: overlay.system ?? base.system,
          system_file: overlay.system_file ?? base.system_file,
          system_file_from: overlay.system_file_from ?? base.system_file_from,
          aliases: { ...base.aliases, ...overlay.aliases },
          deny_commands: [
            ...base.deny_commands,
            ...overlay.deny_commands.filter((d) => !base.deny_commands.includes(d)),
          ],
          limits: { ...base.limits, ...overlay.limits },
        };
      } else if ((BUILTIN_PROFILES as readonly string[]).includes(profile)) {
        profile_data = {
          ...base,
          aliases: { ...base.aliases },
          deny_commands: [...base.deny_commands],
          limits: { ...base.limits },
        };
      } else {
        warnings.push(`profile ${profile} selected but not defined`);
        profile_data = undefined;
      }
    }
    if (profile_data) {
      for (const entry of profile_data.deny_commands) {
        if (!deny_commands.includes(entry)) deny_commands.push(entry);
      }
      for (const [key, value] of Object.entries(profile_data.limits)) {
        if ((limits as Record<string, number>)[key] === undefined) {
          (limits as Record<string, number>)[key] = value as number;
          provenance[`limits.${key}`] = `profile:${profile}`;
        } else {
          // Explicit limits layer wins over profile defaults.
        }
      }
      if (profile_data.model && model === undefined) {
        model = profile_data.model;
        provenance['model'] = `profile:${profile}`;
      } else {
        // Explicit model wins over the profile default.
      }
      if (profile_data.temperature !== undefined && temperature === undefined) {
        temperature = profile_data.temperature;
        provenance['temperature'] = `profile:${profile}`;
      } else {
        // Explicit temperature wins over the profile default.
      }
      if (profile_data.system_file !== undefined && system_file === undefined && system === undefined) {
        system_file = profile_data.system_file;
        system_file_from = profile_data.system_file_from ?? `profile:${profile}`;
        provenance['system_file'] = system_file_from;
      } else {
        // Explicit system wins over the profile default.
      }
      if (profile_data.system !== undefined && system_file === undefined && system === undefined) {
        system = profile_data.system;
        system_from = `profile:${profile}`;
        provenance['system'] = system_from;
      } else {
        // Explicit system wins over the profile default.
      }
      // Profile aliases sit below file-level `[aliases]` (project > user >
      // profile): only gaps are filled, never overrides.
      let profile_alias_count = 0;
      for (const [alias, spec] of Object.entries(profile_data.aliases)) {
        if (aliases[alias] === undefined) {
          aliases[alias] = spec;
          profile_alias_count += 1;
        } else {
          // File-level alias wins over the profile default.
        }
      }
      if (profile_alias_count > 0 && provenance['aliases'] === undefined) {
        provenance['aliases'] = `profile:${profile}`;
      } else {
        // File aliases already carry the provenance.
      }
    } else {
      // Invalid or undefined profile — no data to merge.
    }
  } else {
    // No profile selected.
  }

  // System and system-file: last occurrence wins in the winning layer —
  // the resolver already kept only the topmost scalar, and an explicit
  // system-file suppresses inline system from the same resolution.
  // Profile system fills the same slots only when both are empty (above).
  let resolved_system = system;
  const resolved_system_file = system_file;
  if (resolved_system_file !== undefined && resolved_system !== undefined) {
    resolved_system = system;
  } else {
    // Single system source — nothing to disambiguate.
  }

  const resolved: ResolvedTellrc = {
    aliases,
    deny_commands,
    limits,
    provenance,
    warnings,
  };
  if (model !== undefined) resolved.model = model;
  if (resolved_system !== undefined) resolved.system = resolved_system;
  if (resolved_system_file !== undefined) resolved.system_file = resolved_system_file;
  if (temperature !== undefined) resolved.temperature = temperature;
  if (profile !== undefined) resolved.profile = profile;
  if (profile_data !== undefined) resolved.profile_data = profile_data;
  return resolved;
}

/**
 * Resolves a model input through custom aliases without mutating MODELS.
 *
 * Accepts a custom alias in any position the CLI parser accepts (including
 * `-m`, `--model` and a valid positional model), plus built-in aliases,
 * dot-prefix fast mode and full `vendor:model[:thinking]` specs.
 *
 * @param value - Raw model input.
 * @param custom_aliases - Per-invocation alias table from the tellrc.
 * @param known - Built-in MODELS table (never mutated).
 * @returns The resolved model spec string.
 */
export function resolve_model_input(
  value: string,
  custom_aliases: Record<string, string>,
  known: Record<string, string>,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  } else if (custom_aliases[trimmed] !== undefined) {
    return custom_aliases[trimmed] as string;
  } else if (known[trimmed] !== undefined) {
    return trimmed;
  } else if (trimmed.startsWith('.')) {
    const bare = trimmed.slice(1);
    if (custom_aliases[bare] !== undefined) {
      return `.${custom_aliases[bare] as string}`;
    } else {
      return trimmed;
    }
  } else {
    return trimmed;
  }
}

/**
 * Reads the resolved system-file payload with safety gates.
 *
 * Cap 64 KB, regular file only, NUL rejected; a project `.tellrc`
 * system-file must stay inside `cwd` (lexical plus symlink target).
 * Warnings never include file content.
 *
 * @param system_file - Raw system-file value (tilde expanded for paths only).
 * @param cwd - Working directory for the project-file gate.
 * @param home - Home directory for `~` expansion.
 * @param is_project_file - True when the value came from `<cwd>/.tellrc`.
 * @returns The file text, or undefined when rejected (warning emitted).
 */
export function load_system_file_text(
  system_file: string,
  cwd: string,
  home: string,
  is_project_file: boolean,
): string | undefined {
  const expanded = expand_tilde_path(system_file.trim(), home || os.homedir());
  const resolved = path.resolve(cwd || process.cwd(), expanded);
  if (is_project_file) {
    const base = path.resolve(cwd || process.cwd());
    const relative = path.relative(base, resolved);
    const escapes = relative === '' ? false : relative.startsWith('..') || path.isAbsolute(relative);
    if (escapes) {
      warn_tellrc('project system-file escapes the working directory, ignored');
      return undefined;
    } else {
      try {
        const real_base = fs.realpathSync(base);
        const real_target = fs.realpathSync(resolved);
        const real_relative = path.relative(real_base, real_target);
        if (real_relative !== '' && (real_relative.startsWith('..') || path.isAbsolute(real_relative))) {
          warn_tellrc('project system-file symlink escapes the working directory, ignored');
          return undefined;
        } else {
          // Symlink target stays inside cwd.
        }
      } catch {
        // Unresolvable target falls through to the regular-file check below.
      }
    }
  } else {
    // User/global and flag/env files are the caller's explicit choice.
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    warn_tellrc('system-file is not readable, ignored');
    return undefined;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    if (stat.isSymbolicLink() && !is_project_file) {
      try {
        const target_stat = fs.statSync(resolved);
        if (!target_stat.isFile()) {
          warn_tellrc('system-file is not a regular file, ignored');
          return undefined;
        } else {
          // Explicit non-project symlink to a regular file is allowed.
        }
      } catch {
        warn_tellrc('system-file is not a regular file, ignored');
        return undefined;
      }
    } else if (is_project_file) {
      warn_tellrc('system-file is not a regular file, ignored');
      return undefined;
    } else {
      warn_tellrc('system-file is not a regular file, ignored');
      return undefined;
    }
  } else {
    // Regular file confirmed.
  }
  if (stat.size > SYSTEM_FILE_MAX_BYTES) {
    warn_tellrc('system-file exceeds 64 KB, ignored');
    return undefined;
  } else {
    // Size within cap.
  }
  let text: string;
  try {
    const fd = fs.openSync(resolved, 'r');
    try {
      const buffer = Buffer.alloc(SYSTEM_FILE_MAX_BYTES + 1);
      const read = fs.readSync(fd, buffer, 0, SYSTEM_FILE_MAX_BYTES + 1, 0);
      if (read > SYSTEM_FILE_MAX_BYTES) {
        warn_tellrc('system-file exceeds 64 KB, ignored');
        return undefined;
      } else {
        text = buffer.subarray(0, read).toString('utf8');
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    warn_tellrc('system-file is not readable, ignored');
    return undefined;
  }
  if (text.includes('\0')) {
    warn_tellrc('system-file contains NUL, ignored');
    return undefined;
  } else {
    return text;
  }
}

/**
 * Composes tellrc custom instructions before the safety system prompt.
 *
 * Config can only prepend context — it never replaces `<RUN>`, approval,
 * injection or deny rules, which stay last in the safety prompt.
 *
 * @param safety_prompt - The canonical safety/execution system prompt.
 * @param custom_text - Custom instructions (inline system, file, profile).
 * @returns The composed prompt with safety last.
 */
export function compose_system_prompt(safety_prompt: string, custom_text?: string): string {
  const custom = (custom_text ?? '').trim();
  if (!custom) {
    return safety_prompt;
  } else {
    return `Custom instructions:\n${custom}\n\n${safety_prompt}`;
  }
}

/**
 * Collects the custom instruction text for a resolved tellrc.
 *
 * Order: top-level file/inline system, then profile file/inline system,
 * then profile prompt/style. Profile system is a fill-if-empty default:
 * it is included only when no top-level system text exists (never
 * duplicated with a filled slot, never stacked over an explicit choice).
 * Empty blocks are skipped.
 *
 * @param resolved - Resolved tellrc (system/system_text/profile_data).
 * @returns The combined custom text (empty when none).
 */
export function tellrc_custom_text(resolved: ResolvedTellrc): string {
  const parts: string[] = [];
  const top_text = (resolved.system_text ?? resolved.system ?? '').trim();
  if (top_text) {
    parts.push(top_text);
  } else {
    // No top-level inline or file system text.
  }
  const profile_data = resolved.profile_data;
  if (!top_text) {
    const profile_text = (profile_data?.system_text ?? profile_data?.system ?? '').trim();
    if (profile_text) parts.push(profile_text);
  }
  const profile_prompt = profile_data?.prompt?.trim();
  const profile_style = profile_data?.style?.trim();
  if (profile_prompt) parts.push(profile_prompt);
  if (profile_style) parts.push(`Style: ${profile_style}`);
  return parts.join('\n\n');
}

// CamelCase aliases for the task contract (implementations stay snake_case).
export const loadTellrc = load_tellrc;
export const resolveTellrc = resolve_tellrc;
export const resolveModelInput = resolve_model_input;
