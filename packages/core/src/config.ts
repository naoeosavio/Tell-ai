import { DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS, MIN_EXEC_TIMEOUT_MS } from './runtime-limits';

/** Hosts with distinct model defaults. The core never assumes one global default. */
export type CoreHost = 'cli' | 'web';

/** Model default per host: the CLI keeps `g`, the Web keeps `l`. */
export const HOST_DEFAULT_MODEL: Record<CoreHost, string> = { cli: 'g', web: 'l' };

/** Fully resolved core options injected into the runtime ports. */
export type CoreConfig = {
  /** Model alias or full spec (already trimmed, never blank). */
  model: string;
  /** False disables every execution (`--no-exec`); deny wins across layers. */
  exec_enabled: boolean;
  /** Whether to continue after command output until a final answer. */
  chain: boolean;
  /** Per-command timeout in milliseconds, clamped to the min/max above. */
  exec_timeout_ms: number;
};

/** One precedence layer; every field is optional and blank means absent. */
export type ConfigLayer = {
  model?: string;
  exec_enabled?: boolean;
  chain?: boolean;
  exec_timeout_ms?: number;
};

/** Layers for `resolve_core_config` in `flag > env > project > user` order. */
export type ResolvedConfigInput = {
  /** Host selecting the fallback model (`g` for CLI, `l` for Web). */
  host: CoreHost;
  /** CLI flags (highest precedence). */
  flag?: ConfigLayer;
  /** Environment layer (see `load_env_layer`). */
  env?: ConfigLayer;
  /** Project `.tellrc` layer, parsed by the tellrc task and passed as data. */
  project?: ConfigLayer;
  /** User `~/.tellrc` layer, parsed by the tellrc task and passed as data. */
  user?: ConfigLayer;
};

/**
 * Returns the first non-blank value across layers, or undefined when absent.
 *
 * A blank string means "absent" (the `ConfigLayer` contract), so an empty
 * layer never shadows the layers below it.
 *
 * @param layers - Layers in precedence order (highest first).
 * @param pick - Field selector for the wanted option.
 * @returns The winning value, or undefined when no layer defines it.
 */
function first_defined<T>(
  layers: (ConfigLayer | undefined)[],
  pick: (layer: ConfigLayer) => T | undefined,
): T | undefined {
  for (const layer of layers) {
    if (layer === undefined) {
    } else {
      const value = pick(layer);
      if (value !== undefined) {
        return value;
      } else {
      }
    }
  }
  return undefined;
}

/**
 * Returns the first non-blank string across layers, or undefined.
 *
 * @param layers - Layers in precedence order (highest first).
 * @param pick - Field selector for the wanted option.
 * @returns The winning trimmed value, or undefined when no layer has one.
 */
function first_non_blank(
  layers: (ConfigLayer | undefined)[],
  pick: (layer: ConfigLayer) => string | undefined,
): string | undefined {
  for (const layer of layers) {
    if (layer === undefined) {
    } else {
      const value = pick(layer);
      const trimmed = (value ?? '').trim();
      if (trimmed !== '') {
        return trimmed;
      } else {
        // Blank means absent — keep looking.
      }
    }
  }
  return undefined;
}

/**
 * Clamps a raw timeout to the supported range, falling back on garbage.
 *
 * @param value - Raw timeout candidate from a config layer.
 * @returns The clamped timeout, or the default when the value is unusable.
 */
function clamp_timeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  } else {
    return Math.min(MAX_EXEC_TIMEOUT_MS, Math.max(MIN_EXEC_TIMEOUT_MS, Math.round(value)));
  }
}

/**
 * Merges config layers into the resolved options injected into ports.
 *
 * Precedence is `flag > env > project .tellrc > user ~/.tellrc > default`:
 * the first defined value wins, except `exec_enabled`, where an explicit
 * deny in any layer wins over every allow (no layer relaxes a deny).
 *
 * @param input - Host plus the four precedence layers.
 * @returns The resolved core config (model is never blank).
 */
export function resolve_core_config(input: ResolvedConfigInput): CoreConfig {
  const layers = [input.flag, input.env, input.project, input.user];
  const fallback = HOST_DEFAULT_MODEL[input.host];
  const model = first_non_blank(layers, (layer) => layer.model);
  const denied = layers.some((layer) => layer?.exec_enabled === false);
  return {
    model: model ?? fallback,
    exec_enabled: !denied,
    chain: first_defined(layers, (layer) => layer.chain) ?? false,
    exec_timeout_ms: clamp_timeout(first_defined(layers, (layer) => layer.exec_timeout_ms)),
  };
}

/**
 * Reads the process environment when the host has one.
 *
 * The browser entry has no `process`, so the lookup is guarded instead of
 * assumed — the browser bundle must never throw a `ReferenceError`.
 *
 * @returns The process environment, empty when the host has none.
 */
function read_process_env(): Record<string, string | undefined> {
  if (typeof process === 'undefined') {
    return {};
  } else {
    return process.env;
  }
}

/**
 * Reads the base environment layer (never credential or URL keys).
 *
 * Only `TELL_MODEL` is honored, and only when non-blank. `TELL_KEY`,
 * `TELL_BASE_URL` and vendor keys/URLs are owned by the later tellkey
 * handoff and are deliberately ignored here.
 *
 * @param env - Environment record (defaults to `process.env` on Node).
 * @returns The env layer, empty when `TELL_MODEL` is absent or blank.
 */
export function load_env_layer(env: Record<string, string | undefined> = read_process_env()): ConfigLayer {
  const model = (env['TELL_MODEL'] ?? '').trim();
  if (model === '') {
    return {};
  } else {
    return { model };
  }
}
