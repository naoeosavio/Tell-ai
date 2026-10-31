import * as os from 'os';
import * as path from 'path';
import {
  type ApprovalPort,
  assess_base_risk,
  type CommandExecutor,
  type CoreConfig,
  create_base_risk_port,
  create_core_runtime,
  create_node_executor,
  EXEC_DEFAULT_TIMEOUT_MS,
  LOOP_MAX_ROUNDS,
  type ModelPort,
  type RiskAssessment,
  type RiskPort,
  type RuntimeCallbacks,
  resolve_core_config,
  SENSITIVE_ENV_NAMES,
  SENSITIVE_ENV_SUFFIX,
  type StoragePort,
  type TellResult,
} from '@tell-ai/core';
import { type AskInstance, sanitize_reasoning } from '@tell-ai/sdk';
import { is_outside_cwd } from './mentions';

/** Re-exported core runtime factory so the CLI consumes a single seam. */
export { create_core_runtime, LOOP_MAX_ROUNDS };
export type { CoreConfig, RuntimeCallbacks, TellResult };

/** Readline confirmation budget in milliseconds (mirrors the exec timeout, as before). */
export const READLINE_CONFIRM_TIMEOUT_MS = EXEC_DEFAULT_TIMEOUT_MS;

/** Effective execution mode, resolved once from the flags (fail-closed). */
export type ExecMode = 'no-exec' | 'confirm-all' | 'auto-risk';

/** User confirmation callback (readline prompt in the CLI, stubbed in tests). */
export type CliConfirmFn = (script: string) => Promise<boolean>;

/** Flag subset resolved once into a `CoreConfig` (keys stay in `env.ts`). */
export type CliCoreConfigFlags = {
  /** Commander `exec` flag (`false` when `--no-exec` is passed). */
  exec?: boolean | undefined;
  /** Commander `chain` flag. */
  chain?: boolean | undefined;
  /** Per-command timeout override in milliseconds. */
  exec_timeout_ms?: number | undefined;
};

/**
 * Classifies one script through the core base rules (CLI permissive profile).
 *
 * Local interpreter one-liners stay allowed by design; only
 * network/decode-coupled eval is risky — the same matrix the CLI always
 * enforced, now owned by `@tell-ai/core`. Credential-file reads are the
 * exception: they are high-risk in both profiles, so `cat .env` needs
 * explicit confirmation even with `-y`.
 *
 * @param script - Command script to classify.
 * @returns The base `RiskAssessment` (never an action verdict).
 */
export function assess_cli_risk(script: string): RiskAssessment {
  return assess_base_risk(script, 'permissive');
}

/**
 * Returns true when a script matches the CLI high-risk matrix.
 *
 * Thin boolean over `assess_cli_risk`, preserving the historical
 * `is_high_risk_script` contract (prompts, auto-risk gating).
 *
 * @param script - Command script to classify.
 * @returns True when the script needs explicit confirmation.
 */
export function is_high_risk_script(script: string): boolean {
  return assess_cli_risk(script).risky;
}

/**
 * Creates the CLI risk port (permissive profile) for runtime wiring.
 *
 * @returns A `RiskPort` observing through the core base classifier.
 */
export function cli_risk_port(): RiskPort {
  return create_base_risk_port('permissive');
}

/**
 * Deletes sensitive variables from the current process environment.
 *
 * Runs once before the response loop so later `spawn` calls (web sandbox
 * included) never inherit provider keys or loader variables.
 */
export function lock_process_environment(): void {
  for (const name of Object.keys(process.env)) {
    if (SENSITIVE_ENV_NAMES.has(name) || SENSITIVE_ENV_SUFFIX.test(name)) {
      delete process.env[name];
    } else {
      // Non-secret variable — kept for the process and its children.
    }
  }
}

// Matches path-like tokens inside a command script: absolute (`/x`), home
// (`~/x`, `$HOME/x`, bare `$HOME`), relative with traversal (`../x`, `./x`,
// bare `..`), optionally after `=` (`--output=/x`) and inside quotes. The
// token body stops at whitespace or shell separators. The prefix class also
// covers the redirection operators (`<`, `>`) so `cat</etc/passwd` cannot
// smuggle an outside path past the gate.
const OUTSIDE_PATH_TOKEN =
  /(?:^|[\s;&|("'`=<>])((?:\/|~\/|(?:\$\{HOME\}|\$HOME)\/?|\.{1,2}\/)[^\s;&|'"]*|\$\{HOME\}|\$HOME|[~.]{1,2})(?=$|[\s;&|'")=<>])/g;
const FILE_ARGUMENT_TOKEN =
  /(?:^|[\s;&|])(?:cat|head|tail|less|more|file|stat|cp|mv|rm|ln|chmod|chown|truncate|tar)\b([^;&|]*)/g;
const SHELL_ARGUMENT_TOKEN = /"([^"]*)"|'([^']*)'|([^\s]+)/g;

/**
 * Returns true when a script references any path outside `cwd`.
 *
 * Reads included, mirroring the `@path` mention read gate. Resolution is
 * delegated to `is_outside_cwd` (lexical + symlink/realpath); `~`/`$HOME`
 * expand via `os.homedir()`, so when cwd IS `$HOME` a `~/x` reference
 * resolves inside and stays allowed.
 *
 * @param script - Command script to inspect.
 * @param cwd - Working directory paths resolve against.
 * @returns True when any referenced path escapes `cwd`.
 */
export function script_touches_outside_cwd(script: string, cwd: string): boolean {
  const home = os.homedir();
  const compact = script
    .replace(/\\\n/g, ' ')
    .replace(/\\\//g, '/')
    .replace(/\$\{PWD\}|\$PWD/g, cwd);
  if (/\$\{(?:PWD|HOME)(?::[-=+?]|\+)/.test(compact)) {
    return true;
  }
  for (const match of compact.matchAll(OUTSIDE_PATH_TOKEN)) {
    const token = match[1];
    if (!token) {
      continue;
    }
    const expanded = token
      .replace(/^\$\{HOME\}/, home)
      .replace(/^\$HOME/, home)
      .replace(/^~(?=\/|$)/, home);
    const resolved = path.resolve(cwd, expanded);
    if (is_outside_cwd(resolved, cwd)) {
      return true;
    }
  }
  for (const match of compact.matchAll(FILE_ARGUMENT_TOKEN)) {
    const args = match[1];
    if (!args) {
      continue;
    }
    for (const argument of args.matchAll(SHELL_ARGUMENT_TOKEN)) {
      const token = argument[1] ?? argument[2] ?? argument[3];
      if (!token || token.startsWith('-')) {
        continue;
      }
      const resolved = path.resolve(cwd, token);
      if (is_outside_cwd(resolved, cwd)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Creates the CLI command executor port (the core Node executor).
 *
 * Honors per-call `cwd`/`timeout_ms`/`max_output_bytes`/`env`/`cancellation`
 * overrides; constructor defaults mirror the historical CLI behavior (120s,
 * 32 MB) while per-call values win. A pre-cancelled token rejects without
 * spawning.
 *
 * @returns A `CommandExecutor` for runtime wiring (the only CLI executor).
 */
export function create_cli_executor(defaults?: { timeout_ms?: number; max_output_bytes?: number }): CommandExecutor {
  return create_node_executor({
    ...(defaults?.timeout_ms !== undefined ? { timeout_ms: defaults.timeout_ms } : {}),
    ...(defaults?.max_output_bytes !== undefined ? { max_output_bytes: defaults.max_output_bytes } : {}),
  });
}

/**
 * Decides whether one script needs interactive confirmation.
 *
 * Pure helper behind both the readline prompt and the approval port:
 * `auto-risk` runs safe inside-cwd scripts directly and asks for
 * high-risk or outside-cwd ones; `confirm-all` always asks.
 *
 * @param script - Command script to decide about.
 * @param mode - Effective execution mode.
 * @param cwd - Working directory outside checks resolve against.
 * @returns True when the script may run without asking.
 */
export function can_auto_approve(script: string, mode: ExecMode, cwd: string): boolean {
  if (mode !== 'auto-risk') {
    return false;
  } else if (is_high_risk_script(script)) {
    return false;
  } else if (script_touches_outside_cwd(script, cwd)) {
    return false;
  } else {
    return true;
  }
}

/**
 * Creates the CLI approval port over an injected confirmation callback.
 *
 * `no-exec` is always `denied` (the caller prints the disabled notice and
 * never executes); safe auto-risk scripts are `approved` without asking;
 * anything else follows the callback, with a decline recorded as `skipped`
 * (matching the historical "Skipped by user" wording). The future policy
 * engine remains the only source of `PolicyDecision`.
 *
 * @param mode - Effective execution mode.
 * @param confirm - Interactive confirmation (readline in the CLI).
 * @param cwd - Working directory outside checks resolve against.
 * @returns An `ApprovalPort` authorizing one requested script.
 */
export function create_cli_approval(mode: ExecMode, confirm: CliConfirmFn, cwd?: string): ApprovalPort {
  return async (request: { script: string; risk?: RiskAssessment }): Promise<'approved' | 'denied' | 'skipped'> => {
    if (mode === 'no-exec') {
      return 'denied';
    } else if (can_auto_approve(request.script, mode, cwd ?? process.cwd())) {
      return 'approved';
    } else if (await confirm(request.script)) {
      return 'approved';
    } else {
      return 'skipped';
    }
  };
}

/**
 * Resolves CLI flags once into a core config (no keys involved).
 *
 * Only `exec`/`chain`/timeout flow here; provider keys and URLs stay in
 * `packages/cli/src/env.ts` until the explicit tellkey handoff owns
 * `packages/core/src/config.ts`. Deny wins: `--no-exec` disables
 * execution regardless of every other layer.
 *
 * @param flags - Commander flag subset for this invocation.
 * @returns The resolved core config for host `cli` (default model `g`).
 */
export function resolve_cli_core_config(flags: CliCoreConfigFlags): CoreConfig {
  return resolve_core_config({
    host: 'cli',
    flag: {
      ...(flags.exec !== undefined ? { exec_enabled: flags.exec } : {}),
      ...(flags.chain !== undefined ? { chain: flags.chain } : {}),
      ...(flags.exec_timeout_ms !== undefined ? { exec_timeout_ms: flags.exec_timeout_ms } : {}),
    },
  });
}

/** IO surfaces for the CLI model port (streaming UX lives inside `ask`). */
export type CliModelIO = {
  /** Live token streaming (mirrors `--stream`). */
  stream: boolean;
  /** Dim reasoning on stderr (mirrors `--think`). */
  think: boolean;
  /** Hide `<RUN>`/`<DELEGATE>`/`<SUBTASK>` blocks from the live stream (default off = show). */
  hide_tags?: boolean;
  /** Receives the full raw response of every round (feeds log/timeline). */
  on_raw?: (response: string) => void;
  /** Sampling temperature 0..2, forwarded only when present. */
  temperature?: number;
  /** Silent port for delegation children (no stdout/stderr writes, no `on_raw`). */
  silent?: boolean;
};

/**
 * Pulls the reasoning text out of a raw `<think>...</think>` response.
 *
 * @param response - Raw model response.
 * @returns Trimmed reasoning content, or empty string when absent.
 */
function extract_think(response: string): string {
  return /<think>([\s\S]*?)<\/think>/i.exec(response)?.[1]?.trim() ?? '';
}

/**
 * Sanitizes a wrapped `<think>` reasoning span for terminal display.
 *
 * @param response - Raw model response.
 * @returns The response with its reasoning span sanitized.
 */
function sanitize_wrapped_reasoning(response: string): string {
  const lower = response.toLowerCase();
  const start = lower.indexOf('<think>');
  const end = lower.lastIndexOf('</think>');
  if (start < 0 || end < start + '<think>'.length) {
    return response;
  } else {
    const reasoning = response.slice(start + '<think>'.length, end);
    return `${response.slice(0, start)}<think>${sanitize_reasoning(reasoning)}</think>${response.slice(end + '</think>'.length)}`;
  }
}

/**
 * Prints model reasoning dimmed on stderr (no-op for empty reasoning).
 *
 * @param reasoning - Reasoning text to display.
 */
function print_reasoning(reasoning: string): void {
  if (!reasoning) {
    return;
  } else {
    process.stderr.write(`\x1b[2m${reasoning}\x1b[0m\n`);
  }
}

/**
 * Calls the model once without streaming (legacy `tell_silently` path).
 *
 * @param ai - SDK ask instance.
 * @param message - Composed user message.
 * @param system - Fully composed system prompt.
 * @param io - Stream/think/raw surfaces.
 * @returns The raw model response (sanitized reasoning span).
 */
async function ask_silently(ai: AskInstance, message: string, system: string, io: CliModelIO): Promise<string> {
  if (io.silent !== true) {
    process.stderr.write('\x1b[2mThinking...\x1b[0m');
  }
  let response: string;
  try {
    response = await ai.ask(
      message,
      io.temperature !== undefined ? { system, stream: false, temperature: io.temperature } : { system, stream: false },
    );
  } finally {
    if (io.silent !== true) {
      process.stderr.write('\r\x1b[K');
    }
  }
  response = sanitize_wrapped_reasoning(response);
  if (io.silent === true) {
    return response;
  }
  if (io.think) {
    print_reasoning(extract_think(response));
  } else {
    // Reasoning stays hidden without --think.
  }
  io.on_raw?.(response);
  return response;
}

/** Protocol tags whose live text is hidden by default (`--tags` shows them). */
const HIDDEN_STREAM_TAGS = ['run', 'delegate', 'subtask'] as const;
/** Longest opener (`<delegate>` / `<subtask>`), used for cross-chunk tails. */
const MAX_STREAM_OPENER = Math.max(...HIDDEN_STREAM_TAGS.map((tag) => tag.length + 2));

/** Streaming filter that drops protocol tag blocks while keeping prose. */
type TagHider = {
  /** Feeds a delta and returns the visible prefix. */
  push(chunk: string): string;
  /** Returns the remaining visible text (an unclosed tag is dropped). */
  flush(): string;
};

/**
 * Builds a stateful filter for the live stream.
 *
 * The model emits `<RUN>`, `<DELEGATE>` and `<SUBTASK>` blocks as protocol, not
 * prose. Hiding them by default removes the duplicate command copy (the
 * approval prompt keeps the script) and the delegation objective noise. The
 * filter is deliberately simple: case-insensitive opener/closer pairs, a small
 * tail buffer for tags split across deltas, and no markdown-fence awareness —
 * a literal tag inside a fence is hidden too (use `--tags` to see it).
 *
 * @returns A push/flush filter.
 */
function create_tag_hider(): TagHider {
  let buffer = '';
  let closer: string | null = null;

  const find_opener = (text: string): { at: number; length: number } | null => {
    const lower = text.toLowerCase();
    let best: { at: number; length: number } | null = null;
    for (const tag of HIDDEN_STREAM_TAGS) {
      const opener = `<${tag}>`;
      const at = lower.indexOf(opener);
      if (at !== -1 && (best === null || at < best.at)) {
        best = { at, length: opener.length };
      }
    }
    return best;
  };

  return {
    push(chunk: string): string {
      buffer += chunk;
      let out = '';
      for (;;) {
        if (closer !== null) {
          const at = buffer.toLowerCase().indexOf(closer);
          if (at === -1) {
            // Discard hidden content, keeping only a possible partial closer.
            const keep = Math.max(0, closer.length - 1);
            if (buffer.length > keep) {
              buffer = buffer.slice(buffer.length - keep);
            }
            return out;
          }
          buffer = buffer.slice(at + closer.length);
          closer = null;
        } else {
          const opener = find_opener(buffer);
          if (opener === null) {
            // Emit text but keep a tail that could start a split opener.
            const keep = Math.max(0, MAX_STREAM_OPENER - 1);
            if (buffer.length > keep) {
              out += buffer.slice(0, buffer.length - keep);
              buffer = buffer.slice(buffer.length - keep);
            }
            return out;
          }
          out += buffer.slice(0, opener.at);
          const tag = buffer.slice(opener.at + 1, opener.at + opener.length - 1).toLowerCase();
          buffer = buffer.slice(opener.at + opener.length);
          closer = `</${tag}>`;
        }
      }
    },
    flush(): string {
      const out = closer === null ? buffer : '';
      buffer = '';
      closer = null;
      return out;
    },
  };
}

/**
 * Calls the model with live token streaming (legacy `tell_streaming` path).
 *
 * Text deltas go to stdout as they arrive (markup included, exactly like the
 * historical path); reasoning prints dimmed on stderr only with `--think`.
 * Returns the reconstructed raw response so log/context/`<RUN>` extraction
 * stay identical to the non-streaming path.
 *
 * @param ai - SDK ask instance.
 * @param message - Composed user message.
 * @param system - Fully composed system prompt.
 * @param io - Stream/think/raw surfaces.
 * @returns The reconstructed raw model response.
 */
async function ask_streaming(ai: AskInstance, message: string, system: string, io: CliModelIO): Promise<string> {
  process.stderr.write('\x1b[2mThinking...\x1b[0m');
  let is_indicator_active = true;
  let is_reasoning_open = false;
  let text = '';
  let visible = '';
  let reasoning = '';
  const hider = io.hide_tags === true ? create_tag_hider() : null;

  const clear_indicator = (): void => {
    if (!is_indicator_active) {
      return;
    } else {
      process.stderr.write('\r\x1b[K');
      is_indicator_active = false;
    }
  };

  // Reasoning is a dim stderr block; close its line before text or at the end.
  const close_reasoning_line = (): void => {
    if (!is_reasoning_open) {
      return;
    } else {
      if (!reasoning.endsWith('\n')) {
        process.stderr.write('\n');
      } else {
        // Reasoning already ends its line — nothing to close.
      }
      is_reasoning_open = false;
    }
  };

  try {
    const stream_options = io.temperature !== undefined ? { system, temperature: io.temperature } : { system };
    for await (const event of ai.ask_stream(message, stream_options)) {
      if (event.type === 'reasoning') {
        const safe_reasoning = sanitize_reasoning(event.text);
        reasoning += safe_reasoning;
        if (io.think) {
          clear_indicator();
          process.stderr.write(`\x1b[2m${safe_reasoning}\x1b[0m`);
          is_reasoning_open = true;
        } else {
          // Hidden reasoning still accumulates for the reconstruction.
        }
      } else if (event.type === 'text') {
        clear_indicator();
        close_reasoning_line();
        text += event.text;
        const chunk = hider === null ? event.text : hider.push(event.text);
        if (chunk !== '') {
          visible += chunk;
          process.stdout.write(chunk);
        }
      } else {
        // reasoning_end: nothing to print, just close the dim block.
        close_reasoning_line();
      }
    }
  } finally {
    if (hider !== null) {
      const tail = hider.flush();
      if (tail !== '') {
        visible += tail;
        process.stdout.write(tail);
      }
    }
    clear_indicator();
    close_reasoning_line();
  }

  const printed = hider === null ? text : visible;
  if (printed && !printed.endsWith('\n')) {
    process.stdout.write('\n');
  } else {
    // Already terminated (or empty) — no extra newline.
  }
  const reconstructed = reasoning ? `<think>${reasoning}</think>\n${text}` : text;
  io.on_raw?.(reconstructed);
  return reconstructed;
}

/**
 * Creates the CLI model port over an SDK ask instance.
 *
 * Streaming is a transport detail inside `ask`: with `stream` the port
 * consumes `ask_stream` and prints live (recording stream calls exactly
 * like the historical path); otherwise it calls `ask` once. Either way the
 * full raw response is reported through `on_raw` and returned for the
 * core wiring (which strips/extracts downstream).
 *
 * @param ai - SDK ask instance (real or mocked).
 * @param io - Stream/think/raw surfaces for this invocation.
 * @returns A `ModelPort` for the core runtime.
 */
export function create_cli_model(ai: AskInstance, io: CliModelIO): ModelPort {
  return {
    async ask(message: string, options: { system: string; stream: false }): Promise<string> {
      if (io.silent === true) {
        return ask_silently(ai, message, options.system, io);
      } else if (io.stream) {
        return ask_streaming(ai, message, options.system, io);
      } else {
        return ask_silently(ai, message, options.system, io);
      }
    },
  };
}

/**
 * Creates an in-memory storage port seeded with previous context.
 *
 * `load` serves the seed (the context file content, so the core prompt
 * composition matches the legacy `Previous context:` wrapper byte for
 * byte); per-turn writes stay in memory while the CLI mirrors its own log
 * and context files through the runtime callbacks.
 *
 * @param seed - Previous context text (empty when no context applies).
 * @returns A `StoragePort` for the core runtime.
 */
export function create_cli_memory_storage(seed: string): StoragePort {
  let current = seed;
  return {
    async load(_key: string): Promise<string> {
      return current;
    },
    async save(_key: string, value: string): Promise<void> {
      current = value;
    },
    async clear(_key: string): Promise<void> {
      current = '';
    },
    async appendLog(_key: string, entry: string): Promise<void> {
      current += entry;
    },
  };
}
