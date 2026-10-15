/** Chars of accumulated conversation context (mirrors the CLI baseline). */
export const DEFAULT_CONTEXT_MAX_CHARS = 64 * 1024;
/** Stdin deadline in milliseconds (zero disables the deadline). */
export const DEFAULT_STDIN_TIMEOUT_MS = 30_000;
/** Stdin byte cap (active even when the timeout is disabled). */
export const DEFAULT_STDIN_MAX_BYTES = 1_048_576;
/** Per-command execution timeout in milliseconds. */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
/** Default chain rounds (mirrors the core loop cap). */
export const DEFAULT_MAX_CHAIN_STEPS = 8;
/** Upper bound for `--max-chain` (the core loop enforces no upper clamp). */
export const MAX_CHAIN_STEPS = 128;
/** Internal exec buffer cap in bytes. */
export const DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/** Delivered output cap in bytes (marker appended on truncation). */
export const DEFAULT_OUTPUT_MAX_BYTES = 204_800;
/** Max items accepted in one chat-payload message list. */
export const PAYLOAD_MAX_MESSAGES = 200;
/** Max characters per chat-payload message content. */
export const PAYLOAD_MAX_CONTENT_CHARS = 50 * 1024;
/** Max characters for a chat-payload system prompt. */
export const PAYLOAD_MAX_SYSTEM_CHARS = 30 * 1024;

/** Invalid flag/env/tellrc limit value (the host maps this to its exit status). */
export const EXIT_CONFIG_ERROR = 2;

/** Success exit status. */
export const EXIT_SUCCESS = 0;
/** Usage/model failure preserves the historical status. */
export const EXIT_MODEL_ERROR = 1;
/** Execution timeout (mirrors the core/exec convention). */
export const EXIT_TIMEOUT = 124;
/** Stdin or output cap overflow. */
export const EXIT_LIMIT = 125;

/** Marker prepended when old context turns are dropped. */
export const CONTEXT_TRUNCATE_MARKER = '[older context truncated]';
/** Marker appended when delivered output is cut. */
export const OUTPUT_TRUNCATE_MARKER_PREFIX = '[output truncated at';

/** Fully resolved runtime limits for one invocation. */
export type RuntimeLimits = {
  context_max_chars: number;
  stdin_timeout_ms: number;
  stdin_max_bytes: number;
  exec_timeout_ms: number;
  max_chain_steps: number;
  max_buffer_bytes: number;
  output_max_bytes: number;
};

/** External executor options injected into the core executor/loop. */
export type ExecutionOptions = {
  timeout_ms: number;
  max_output_bytes: number;
  max_buffer_bytes: number;
  max_rounds: number;
};

/** Flag layer subset (raw host values, strings or numbers). */
export type RuntimeLimitFlags = {
  context_max_chars?: string | number | undefined;
  stdin_timeout_ms?: string | number | undefined;
  no_stdin_timeout?: boolean | undefined;
  stdin_max_bytes?: string | number | undefined;
  exec_timeout_ms?: string | number | undefined;
  max_chain_steps?: string | number | undefined;
  max_buffer_bytes?: string | number | undefined;
  output_max_bytes?: string | number | undefined;
};

/** Env layer subset (`TELL_*` knobs only, never secrets). */
export type RuntimeLimitEnv = {
  TELL_CONTEXT_MAX_CHARS?: string | undefined;
  TELL_STDIN_TIMEOUT_MS?: string | undefined;
  TELL_STDIN_MAX_BYTES?: string | undefined;
  TELL_EXEC_TIMEOUT_MS?: string | undefined;
  TELL_MAX_CHAIN_STEPS?: string | undefined;
  TELL_MAX_BUFFER_BYTES?: string | undefined;
  TELL_OUTPUT_MAX_BYTES?: string | undefined;
};

/**
 * Tellrc layer subset (project/user limits plus provenance label).
 *
 * Structurally typed on purpose: the runtime never imports the tellrc schema,
 * so the dependency only points one way (`tellrc.ts` → this module, which owns
 * the keys via `TELLRC_LIMIT_KEYS`). Only `tellrc_key` names are read here.
 */
export type RuntimeLimitTellrcLayer = {
  source: string;
  limits: { [key: string]: number | undefined };
};

/** Input layers for `parse_runtime_limits` in precedence order. */
export type ParseRuntimeLimitsInput = {
  flags?: RuntimeLimitFlags | undefined;
  env?: RuntimeLimitEnv | undefined;
  project?: RuntimeLimitTellrcLayer | undefined;
  user?: RuntimeLimitTellrcLayer | undefined;
};

/** Limit validation failure (carries the host status for an invalid limit). */
export class RuntimeLimitError extends Error {
  exit_code: number;
  limit: string;
  source: string;
  constructor(limit: string, source: string, message: string) {
    super(message);
    this.name = 'RuntimeLimitError';
    this.limit = limit;
    this.source = source;
    this.exit_code = EXIT_CONFIG_ERROR;
  }
}

/** Identifiable stdin failure (timeout vs byte-cap overflow). */
export type StdinLimitErrorKind = 'timeout' | 'overflow';

/**
 * Stdin failure with a stable exit status (124/125).
 *
 * Stdin has no other host target (the sandbox never reads stdin), but the
 * error stays here with the rest of the limit contract so no host restates
 * the statuses.
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

type LimitSpec = {
  key: keyof RuntimeLimits;
  min: number;
  max: number;
  allow_zero: boolean;
  flag_key: keyof RuntimeLimitFlags;
  env_key: keyof RuntimeLimitEnv;
  tellrc_key: string;
};

// A Record keyed by `RuntimeLimits` makes a missing limit a type error
// instead of a silently defaulted key at runtime.
const LIMIT_SPECS: Record<keyof RuntimeLimits, LimitSpec> = {
  context_max_chars: {
    key: 'context_max_chars',
    min: 1024,
    max: 1024 * 1024,
    allow_zero: false,
    flag_key: 'context_max_chars',
    env_key: 'TELL_CONTEXT_MAX_CHARS',
    tellrc_key: 'context_chars',
  },
  stdin_timeout_ms: {
    key: 'stdin_timeout_ms',
    min: 1,
    max: 600_000,
    allow_zero: true,
    flag_key: 'stdin_timeout_ms',
    env_key: 'TELL_STDIN_TIMEOUT_MS',
    tellrc_key: 'stdin_timeout_ms',
  },
  stdin_max_bytes: {
    key: 'stdin_max_bytes',
    min: 1024,
    max: 32 * 1024 * 1024,
    allow_zero: false,
    flag_key: 'stdin_max_bytes',
    env_key: 'TELL_STDIN_MAX_BYTES',
    tellrc_key: 'stdin_max_bytes',
  },
  exec_timeout_ms: {
    key: 'exec_timeout_ms',
    min: 1000,
    max: 600_000,
    allow_zero: false,
    flag_key: 'exec_timeout_ms',
    env_key: 'TELL_EXEC_TIMEOUT_MS',
    tellrc_key: 'exec_timeout_ms',
  },
  max_chain_steps: {
    key: 'max_chain_steps',
    min: 1,
    max: MAX_CHAIN_STEPS,
    allow_zero: false,
    flag_key: 'max_chain_steps',
    env_key: 'TELL_MAX_CHAIN_STEPS',
    tellrc_key: 'max_chain_steps',
  },
  max_buffer_bytes: {
    key: 'max_buffer_bytes',
    min: 1024,
    max: 256 * 1024 * 1024,
    allow_zero: false,
    flag_key: 'max_buffer_bytes',
    env_key: 'TELL_MAX_BUFFER_BYTES',
    tellrc_key: 'max_buffer_bytes',
  },
  output_max_bytes: {
    key: 'output_max_bytes',
    min: 1024,
    max: 32 * 1024 * 1024,
    allow_zero: false,
    flag_key: 'output_max_bytes',
    env_key: 'TELL_OUTPUT_MAX_BYTES',
    tellrc_key: 'output_max_bytes',
  },
};

const LIMIT_SPEC_LIST: LimitSpec[] = Object.values(LIMIT_SPECS);

/** `.tellrc` `[limits]` keys accepted by the runtime, derived from the single spec table. */
export const TELLRC_LIMIT_KEYS: string[] = LIMIT_SPEC_LIST.map((spec) => spec.tellrc_key);

/** Lower clamp for the per-command timeout (read from the exec spec, never a second literal). */
export const MIN_EXEC_TIMEOUT_MS = LIMIT_SPECS.exec_timeout_ms.min;
/** Upper clamp for the per-command timeout (read from the exec spec, never a second literal). */
export const MAX_EXEC_TIMEOUT_MS = LIMIT_SPECS.exec_timeout_ms.max;

const DEFAULT_LIMITS: RuntimeLimits = {
  context_max_chars: DEFAULT_CONTEXT_MAX_CHARS,
  stdin_timeout_ms: DEFAULT_STDIN_TIMEOUT_MS,
  stdin_max_bytes: DEFAULT_STDIN_MAX_BYTES,
  exec_timeout_ms: DEFAULT_EXEC_TIMEOUT_MS,
  max_chain_steps: DEFAULT_MAX_CHAIN_STEPS,
  max_buffer_bytes: DEFAULT_MAX_BUFFER_BYTES,
  output_max_bytes: DEFAULT_OUTPUT_MAX_BYTES,
};

/**
 * Parses a raw limit value into a positive integer.
 *
 * @param raw - Raw flag/env/tellrc value.
 * @returns The integer value, or undefined when unusable.
 */
function to_limit_int(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return undefined;
    } else {
      return Math.floor(raw);
    }
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    } else if (!/^\d+$/.test(trimmed)) {
      return undefined;
    } else {
      return Number(trimmed);
    }
  } else {
    return undefined;
  }
}

/**
 * Validates one resolved limit value against its range.
 *
 * @param spec - Range spec for the limit.
 * @param value - Parsed integer candidate.
 * @param source - Provenance label for the error.
 * @returns The validated value.
 * @throws {RuntimeLimitError} When out of range (`EXIT_CONFIG_ERROR`).
 */
function validate_limit_value(spec: LimitSpec, value: number, source: string): number {
  if (spec.allow_zero && value === 0) {
    return 0;
  } else if (value < spec.min || value > spec.max) {
    throw new RuntimeLimitError(
      spec.key,
      source,
      `invalid ${spec.key} ${value} from ${source} (expected ${spec.min}..${spec.max}${spec.allow_zero ? ' or 0 to disable' : ''})`,
    );
  } else {
    return value;
  }
}

/**
 * Validates one `.tellrc` `[limits]` value against the same spec table.
 *
 * Non-throwing variant of the internal validator, used by the tellrc parser:
 * an unknown key, a non-integer or an out-of-range value is dropped so the
 * caller can warn and keep the default, instead of failing the run (the exit
 * status is reserved for flag/env layers, which are explicit user input).
 *
 * @param key - Tellrc limit key (`context_chars`, `max_chain_steps`, ...).
 * @param raw - Raw value read from the INI file.
 * @returns The validated integer, or undefined when the key is unknown or invalid.
 */
export function validate_tellrc_limit_value(key: string, raw: unknown): number | undefined {
  const spec = LIMIT_SPEC_LIST.find((entry) => entry.tellrc_key === key);
  if (spec === undefined) {
    return undefined;
  }
  const parsed = to_limit_int(raw);
  if (parsed === undefined) {
    return undefined;
  }
  try {
    return validate_limit_value(spec, parsed, 'tellrc');
  } catch {
    return undefined;
  }
}

/**
 * Resolves runtime limits with `flag > env > project > user > default`.
 *
 * Flag/env values are validated strictly: any present-but-invalid value
 * fails before a model is created or a command runs. Tellrc values are
 * validated the same way but carry their file source so the failure is
 * diagnosable instead of silently falling back to a default.
 *
 * @param input - Flag/env/tellrc layers (all optional).
 * @returns The resolved limits.
 * @throws {RuntimeLimitError} On any invalid layer value.
 */
export function parse_runtime_limits(input: ParseRuntimeLimitsInput = {}): RuntimeLimits {
  const resolved: RuntimeLimits = { ...DEFAULT_LIMITS };
  for (const spec of LIMIT_SPEC_LIST) {
    const flag_raw = input.flags?.[spec.flag_key];
    if (spec.flag_key === 'stdin_timeout_ms' && input.flags?.no_stdin_timeout === true) {
      resolved[spec.key] = 0;
      continue;
    } else {
      // Explicit no-stdin-timeout only affects the stdin timeout.
    }
    if (flag_raw !== undefined) {
      const parsed = to_limit_int(flag_raw);
      if (parsed === undefined) {
        throw new RuntimeLimitError(spec.key, 'flag', `invalid ${spec.key} from flag (expected integer)`);
      } else {
        resolved[spec.key] = validate_limit_value(spec, parsed, 'flag');
      }
      continue;
    } else {
      // No flag value — fall through to env.
    }
    const env_raw = input.env?.[spec.env_key];
    if (env_raw !== undefined && String(env_raw).trim() !== '') {
      const parsed = to_limit_int(env_raw);
      if (parsed === undefined) {
        throw new RuntimeLimitError(
          spec.key,
          `env:${String(spec.env_key)}`,
          `invalid ${spec.key} from env (expected integer)`,
        );
      } else {
        resolved[spec.key] = validate_limit_value(spec, parsed, `env:${String(spec.env_key)}`);
      }
      continue;
    } else {
      // No env value — fall through to tellrc.
    }
    const project_raw = input.project?.limits[spec.tellrc_key];
    if (project_raw !== undefined) {
      const parsed = to_limit_int(project_raw);
      if (parsed === undefined) {
        throw new RuntimeLimitError(
          spec.key,
          input.project?.source ?? 'project tellrc',
          `invalid ${spec.key} from project tellrc`,
        );
      } else {
        resolved[spec.key] = validate_limit_value(spec, parsed, input.project?.source ?? 'project tellrc');
      }
      continue;
    } else {
      // No project value — fall through to user.
    }
    const user_raw = input.user?.limits[spec.tellrc_key];
    if (user_raw !== undefined) {
      const parsed = to_limit_int(user_raw);
      if (parsed === undefined) {
        throw new RuntimeLimitError(
          spec.key,
          input.user?.source ?? 'user tellrc',
          `invalid ${spec.key} from user tellrc`,
        );
      } else {
        resolved[spec.key] = validate_limit_value(spec, parsed, input.user?.source ?? 'user tellrc');
      }
    } else {
      // Default stays.
    }
  }
  return resolved;
}

/**
 * Builds the external executor options injected into the core executor/loop.
 *
 * Pure mapping only: timeout/output caps flow to the executor, chain rounds
 * flow to the loop. No executor, loop or state machine is created here.
 *
 * @param limits - Resolved runtime limits.
 * @returns The executor options for the core ports.
 */
export function build_execution_options(limits: RuntimeLimits): ExecutionOptions {
  return {
    timeout_ms: limits.exec_timeout_ms,
    max_output_bytes: limits.output_max_bytes,
    max_buffer_bytes: limits.max_buffer_bytes,
    max_rounds: limits.max_chain_steps,
  };
}

/**
 * The `TELL_*` env keys a host may honor, derived from the spec table.
 *
 * Reading them is a host concern (the CLI needs it inside its test
 * sandboxes), so the owner exports only the names — never a reader that
 * binds the host environment itself.
 */
export const TELL_LIMIT_ENV_KEYS: (keyof RuntimeLimitEnv)[] = LIMIT_SPEC_LIST.map(
  (spec) => spec.env_key as keyof RuntimeLimitEnv,
);

/**
 * Reads `TELL_*` runtime env values (never secrets).
 *
 * The environment arrives as an explicit parameter and the owner never binds
 * the host environment itself: hosts pass their own record (the real one in
 * production, a fake record inside the CLI test sandboxes), so a `TELL_*`
 * variable leaked by the caller's shell can never change limits under test.
 *
 * @param env - Environment record to read the limit keys from.
 * @returns The env layer for `parse_runtime_limits`.
 */
export function runtime_env_from_process(env: Record<string, string | undefined>): RuntimeLimitEnv {
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

/**
 * Splits conversation text into atomic turns.
 *
 * A turn starts at a `User:`, `Assistant:`, `Executed command:`,
 * `Command failed`, `Command cancelled:`, `Skipped by user` or
 * `Command execution disabled` line; text before the first marker is its own
 * leading turn so nothing is lost. Every command header listed here is owned
 * by `loop-feedback.ts`, so a runtime timeline splits record by record.
 *
 * @param text - Full conversation text.
 * @returns The atomic turns in order.
 */
export function split_context_turns(text: string): string[] {
  const lines = text.split('\n');
  const turns: string[] = [];
  let current: string[] = [];
  const is_turn_start = (line: string): boolean => {
    if (/^(User|Assistant):\s*$/.test(line)) {
      return true;
    } else if (/^Executed command:\s*$/.test(line)) {
      return true;
    } else if (/^Command failed/.test(line)) {
      return true;
    } else if (/^Command cancelled:\s*$/.test(line)) {
      return true;
    } else if (/^Command [a-z_]+:\s*$/.test(line)) {
      return true;
    } else if (/^Skipped by user:\s*$/.test(line)) {
      return true;
    } else if (/^Command execution disabled/.test(line)) {
      return true;
    } else {
      return false;
    }
  };
  for (const line of lines) {
    if (is_turn_start(line) && current.length > 0) {
      turns.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    turns.push(current.join('\n'));
  } else {
    // Empty input yields no turns.
  }
  return turns.filter((turn) => turn.trim() !== '');
}

/**
 * Counts balanced tag pairs without matching across kinds.
 *
 * @param text - Text to inspect.
 * @param open - Opening tag.
 * @param close - Closing tag.
 * @returns Open and close counts.
 */
function count_tag_pair(text: string, open: string, close: string): { open: number; close: number } {
  const lower = text.toLowerCase();
  const lower_open = open.toLowerCase();
  const lower_close = close.toLowerCase();
  let open_count = 0;
  let close_count = 0;
  let index = 0;
  while (index < lower.length) {
    if (lower.startsWith(lower_open, index)) {
      open_count += 1;
      index += lower_open.length;
    } else if (lower.startsWith(lower_close, index)) {
      close_count += 1;
      index += lower_close.length;
    } else {
      index += 1;
    }
  }
  return { open: open_count, close: close_count };
}

/**
 * Returns true when `<think>` and `<RUN>` blocks are balanced.
 *
 * @param text - Candidate output text.
 * @returns True when every opener has a closer.
 */
export function has_balanced_tags(text: string): boolean {
  const think = count_tag_pair(text, '<think>', '</think>');
  const run = count_tag_pair(text, '<run>', '</run>');
  if (think.open !== think.close) {
    return false;
  } else if (run.open !== run.close) {
    return false;
  } else {
    return true;
  }
}

/**
 * Removes a trailing partial tag fragment (`<`, `</R`, `<RUN` ...).
 *
 * @param text - Candidate tail text.
 * @returns The text without a dangling tag opener.
 */
function strip_trailing_partial_tag(text: string): string {
  return text.replace(/<[^\n<>]*$/u, '');
}

/**
 * Safely truncates one oversized turn to its tail without splitting tags.
 *
 * Takes the tail, drops the leading partial line, removes a trailing
 * partial tag, and closes any unbalanced opener so no `<`/`>` fragment or
 * unclosed block escapes.
 *
 * @param turn - Single oversized turn.
 * @param max_chars - Budget for the returned text.
 * @returns The safe tail (possibly with appended closers).
 */
function truncate_single_turn(turn: string, max_chars: number): string {
  if (turn.length <= max_chars) {
    return turn;
  } else {
    let tail = turn.slice(-max_chars);
    const newline = tail.indexOf('\n');
    if (newline >= 0) {
      tail = tail.slice(newline + 1);
    } else {
      // No newline — the whole tail is one long line.
    }
    tail = strip_trailing_partial_tag(tail);
    // A tail cut can orphan a closer whose opener was cut away; drop leading
    // orphan closers so the remainder stays balanced instead of half-tagged.
    let think = count_tag_pair(tail, '<think>', '</think>');
    let run = count_tag_pair(tail, '<run>', '</run>');
    for (let index = 0; index < think.close - think.open; index += 1) {
      tail = tail.replace(/<\/think>/i, '');
    }
    for (let index = 0; index < run.close - run.open; index += 1) {
      tail = tail.replace(/<\/RUN>/i, '');
    }
    think = count_tag_pair(tail, '<think>', '</think>');
    run = count_tag_pair(tail, '<run>', '</run>');
    let suffix = '';
    for (let index = 0; index < think.open - think.close; index += 1) suffix += '\n</think>';
    for (let index = 0; index < run.open - run.close; index += 1) suffix += '\n</RUN>';
    return `${tail}${suffix}`;
  }
}

/**
 * Truncates conversation context to whole turns with balanced tags.
 *
 * Keeps the newest turns that fit, drops whole old turns with an explicit
 * marker, and never splits a turn, a `<think>` block, a `<RUN>` block or a
 * message. A single turn larger than the budget is tail-cut at a safe
 * boundary (never leaving a dangling `<` fragment or unclosed tag).
 *
 * @param text - Full conversation text.
 * @param max_chars - Character budget (defaults to 64 Ki).
 * @returns The truncated context with a marker when anything was dropped.
 */
export function truncate_context(text: string, max_chars: number = DEFAULT_CONTEXT_MAX_CHARS): string {
  if (text.length <= max_chars) {
    return text;
  } else if (max_chars < 1024) {
    return `${CONTEXT_TRUNCATE_MARKER}\n${truncate_single_turn(text, max_chars)}`;
  } else {
    // Standard path keeps whole turns below.
  }
  const turns = split_context_turns(text);
  if (turns.length === 0) {
    return text;
  } else if (turns.length === 1 && turns[0] !== undefined) {
    return `${CONTEXT_TRUNCATE_MARKER}\n${truncate_single_turn(turns[0] as string, max_chars)}`;
  } else {
    // Multiple turns — select newest-first below.
  }
  const marker = `${CONTEXT_TRUNCATE_MARKER}\n`;
  const budget = max_chars - marker.length;
  const kept: string[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index] as string;
    if (!has_balanced_tags(turn)) {
      // Unbalanced turn is dropped — never emitted half-tagged.
    } else if (used + turn.length + (kept.length > 0 ? 1 : 0) <= budget) {
      kept.unshift(turn);
      used += turn.length + (kept.length > 1 ? 1 : 0);
    } else {
      // Turn does not fit — older turns are dropped too.
    }
  }
  if (kept.length === 0) {
    const newest = turns[turns.length - 1] as string;
    return `${marker}${truncate_single_turn(newest, budget)}`;
  } else if (kept.length === turns.length) {
    return kept.join('\n');
  } else {
    return `${marker}${kept.join('\n')}`;
  }
}

/**
 * Truncates delivered output to a byte budget with an explicit marker.
 *
 * Byte-aware (UTF-8) so multi-byte characters are never split; the marker
 * always notes the cap. Fits the marker inside the budget when possible.
 *
 * @param output - Raw command/model output.
 * @param max_bytes - Byte budget (defaults to 200 Ki).
 * @returns The output with a truncation marker when cut.
 */
export function truncate_output(output: string, max_bytes: number = DEFAULT_OUTPUT_MAX_BYTES): string {
  if (Buffer.byteLength(output, 'utf8') <= max_bytes) {
    return output;
  } else {
    const marker = `\n${OUTPUT_TRUNCATE_MARKER_PREFIX} ${max_bytes} bytes]`;
    const budget = max_bytes - Buffer.byteLength(marker, 'utf8');
    if (budget <= 0) {
      return marker.slice(-max_bytes);
    } else {
      let cut = output;
      while (cut.length > 0 && Buffer.byteLength(cut, 'utf8') > budget) {
        cut = cut.slice(0, Math.max(0, Math.floor((cut.length * budget) / Buffer.byteLength(cut, 'utf8'))));
      }
      return `${cut}${marker}`;
    }
  }
}
