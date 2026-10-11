/**
 * CLI view of the runtime-limits contract owned by `@tell-ai/core`.
 *
 * The contract itself (defaults, range table, precedence, `parse_runtime_limits`,
 * `truncate_context`) lives in `packages/core/src/runtime-limits.ts` because
 * every host needs it — the CLI, the core executor/loop and the web sandbox.
 * This file keeps only what is genuinely process-level and re-exports the
 * rest, so `./runtime-limits` stays the single CLI import site and no limit
 * literal is ever restated here.
 */

import { type RuntimeLimitEnv, TELL_LIMIT_ENV_KEYS } from '@tell-ai/core';

export {
  build_execution_options,
  CONTEXT_TRUNCATE_MARKER,
  DEFAULT_CONTEXT_MAX_CHARS,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_MAX_CHAIN_STEPS,
  DEFAULT_OUTPUT_MAX_BYTES,
  DEFAULT_STDIN_MAX_BYTES,
  DEFAULT_STDIN_TIMEOUT_MS,
  EXIT_CONFIG_ERROR,
  type ExecutionOptions,
  has_balanced_tags,
  MAX_CHAIN_STEPS,
  OUTPUT_TRUNCATE_MARKER_PREFIX,
  type ParseRuntimeLimitsInput,
  parse_runtime_limits,
  type RuntimeLimitEnv,
  RuntimeLimitError,
  type RuntimeLimitFlags,
  type RuntimeLimits,
  type RuntimeLimitTellrcLayer,
  split_context_turns,
  TELL_LIMIT_ENV_KEYS,
  TELLRC_LIMIT_KEYS,
  truncate_context,
  truncate_output,
  validate_tellrc_limit_value,
} from '@tell-ai/core';

/** Success exit status. */
export const EXIT_SUCCESS = 0;
/** Usage/model failure preserves the historical status. */
export const EXIT_MODEL_ERROR = 1;
/** Execution timeout (mirrors the core/exec convention). */
export const EXIT_TIMEOUT = 124;
/** Stdin or output cap overflow. */
export const EXIT_LIMIT = 125;

/** Identifiable stdin failure (timeout vs byte-cap overflow). */
export type StdinLimitErrorKind = 'timeout' | 'overflow';

/**
 * Stdin failure with a stable exit status (124/125).
 *
 * Stdin exists only in this host: the sandbox has no stdin target, which is
 * why the error and its statuses stay here instead of in the owner.
 */
export class StdinLimitError extends Error {
  kind: StdinLimitErrorKind;
  exit_code: number;
  constructor(kind: StdinLimitErrorKind, message: string) {
    super(message);
    this.name = 'StdinLimitError';
    this.kind = kind;
    this.exit_code = kind === 'timeout' ? EXIT_TIMEOUT : EXIT_LIMIT;
  }
}

/**
 * Reads `TELL_*` runtime env values (never secrets).
 *
 * Deliberately host-side: reading the environment is a process concern, and
 * the four CLI test sandboxes run this module inside a `vm` with a fake
 * `process`. When this lived in `@tell-ai/core` the default parameter bound
 * to the real process and the host's `TELL_MAX_CHAIN_STEPS` leaked into those
 * suites. The core still owns the key list (`TELL_LIMIT_ENV_KEYS`).
 *
 * @param env - Environment record (defaults to `process.env`).
 * @returns The env layer for `parse_runtime_limits`.
 */
export function runtime_env_from_process(env: Record<string, string | undefined> = process.env): RuntimeLimitEnv {
  const layer: RuntimeLimitEnv = {};
  for (const key of TELL_LIMIT_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') {
      layer[key] = value;
    } else {
      // Absent or blank — treated as default.
    }
  }
  return layer;
}
