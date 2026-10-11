import { extract_runs, get_system_prompt, strip_run_tags, strip_think_tags } from '@tell-ai/sdk';

import { DEFAULT_EXEC_TIMEOUT_MS, DEFAULT_MAX_BUFFER_BYTES } from './runtime-limits';

// Default key for the single conversation slot kept through StoragePort.
const DEFAULT_STORAGE_KEY = 'tell-runtime';

// The SDK only forwards timeout/buffer inside ExecutorOptions — enforcement
// belongs to the injected executor (core owns exec). Both values come from the
// single owner in `./runtime-limits`, never from a literal here.
const DEFAULT_MAX_OUTPUT_BYTES = DEFAULT_MAX_BUFFER_BYTES;

/**
 * Lifecycle of one requested command. Exactly the union the task contract
 * fixes — no intermediate status outside it is accepted.
 */
export type CommandStatus =
  | 'requested'
  | 'awaiting_approval'
  | 'approved'
  | 'skipped'
  | 'denied'
  | 'executed'
  | 'cancelled'
  | 'failed';

/** Overall outcome of a `run()` call. */
export type RuntimeStatus = 'completed' | 'awaiting_approval' | 'cancelled' | 'failed';

/** One command record inside a `TellResult`. Timestamps are optional. */
export type RuntimeCommand = {
  script: string;
  status: CommandStatus;
  output?: string;
  exit_code?: number;
  reason?: string;
  source?: string;
  started_at?: string;
  finished_at?: string;
};

/**
 * Final value of a runtime turn: the answer, the preserved turns and every
 * command event (deny, skip and pending approval are never hidden).
 */
export type TellResult = {
  status: RuntimeStatus;
  text: string;
  timeline: string[];
  commands: RuntimeCommand[];
};

/**
 * Structural synchronous key/value contract (DOM `Storage` shaped, but
 * defined here so no DOM type ever leaks into the SDK).
 */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** Minimal structural HTTP request owned by this package (no DOM types). */
export type FetchRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

/** Minimal structural HTTP response owned by this package (no DOM types). */
export type FetchResponse = {
  ok: boolean;
  status: number;
  url?: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

/**
 * Injectable structural fetch (no `globalThis.fetch`, no DOM `Response`).
 * The host/core provides the real implementation when a tool needs network.
 */
export type FetchLike = (request: FetchRequest) => Promise<FetchResponse>;

/**
 * Structural cancellation contract (no direct `AbortController` dependency).
 * Core adapters translate it to the host primitive outside this contract.
 */
export type CancellationToken = {
  readonly cancelled: boolean;
  on_cancel(callback: () => void): () => void;
};

/**
 * Model port. Structurally compatible with `AskInstance` (`ask` plus an
 * optional `ask_stream`), so existing instances and offline mocks fit.
 */
export type ModelPort = {
  ask(message: string, options: { system: string; stream: false }): Promise<string>;
  ask_stream?: (
    input: string | Array<{ role: 'user' | 'assistant'; content: string }>,
    options: { system: string },
  ) => AsyncIterable<{ type: 'reasoning' | 'reasoning_end' | 'text'; text?: string }>;
};

/** Async persistence port. In-memory adapters need no disk or localStorage. */
export type StoragePort = {
  load(key: string): Promise<string>;
  save(key: string, value: string): Promise<void>;
  clear(key: string): Promise<void>;
  appendLog(key: string, entry: string): Promise<void>;
};

/** Raw process result produced by the injected executor. */
export type ExecutorResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
};

/** Options the runtime forwards to the injected executor. */
export type ExecutorOptions = {
  script: string;
  cwd?: string;
  timeout_ms?: number;
  cancellation?: CancellationToken;
  env?: Record<string, string>;
  max_output_bytes?: number;
};

/** Executes one approved script. Implemented by the host (core/Node). */
export type CommandExecutor = (options: ExecutorOptions) => Promise<ExecutorResult>;

/** Approval verdict for one requested script. */
export type ApprovalDecision = 'approved' | 'denied' | 'skipped';

/** Authorizes one requested script. Absent approval means never execute. */
export type ApprovalPort = (request: { script: string; risk?: RiskAssessment }) => Promise<ApprovalDecision>;

/** Advisory severity for one classified script (observed only, never a verdict). */
export type RiskSeverity = 'low' | 'medium' | 'high';

/** Observable category for one classified script (what matched, not what to do). */
export type RiskCategory =
  | 'privilege-escalation'
  | 'network-download'
  | 'destructive'
  | 'persistence'
  | 'privileged-write'
  | 'interpreter-eval'
  | 'payload-decode'
  | 'shell-expansion'
  | 'environment-escape'
  | 'process-info'
  | 'general';

/**
 * Advisory risk classification, composed later by the policy engine.
 *
 * Only observable facts: whether any base rule matched, the highest
 * severity, the category of that match, human-readable reasons and stable
 * machine flags. It never carries an action verdict.
 */
export type RiskAssessment = {
  risky: boolean;
  reason?: string;
  severity?: RiskSeverity;
  category?: RiskCategory;
  reasons?: string[];
  flags?: string[];
};

/** Classifies one script. The runtime observes it; policy decides. */
export type RiskPort = {
  assess(script: string): RiskAssessment | Promise<RiskAssessment>;
};

/**
 * Single redactor injected by the host (core). Runs immediately after the
 * executor returns, before feedback, callbacks, logs, context, cache,
 * `TellResult` or JSON. The default preserves content (identity).
 */
export type Redactor = (value: string) => string;

/** Observer/authorizer callbacks. They observe; they never drive the loop. */
export type RuntimeCallbacks = {
  onThinking?: (content: string) => void | Promise<void>;
  onText?: (text: string) => void | Promise<void>;
  onCommandRequest?: (event: { script: string; risk?: RiskAssessment }) => void | Promise<void>;
  onCommandStart?: (event: { script: string }) => void | Promise<void>;
  onCommandOutput?: (event: { script: string; output: string; exit_code: number }) => void | Promise<void>;
  onCommandSkip?: (event: { script: string; status: CommandStatus; reason?: string }) => void | Promise<void>;
  onStorageLoad?: (event: { key: string }) => void | Promise<void>;
  onStorageSave?: (event: { key: string }) => void | Promise<void>;
  onExecutorError?: (event: { script: string; error: string }) => void | Promise<void>;
};

/**
 * Options for `createTellRuntime`. Precedence is explicit and resolved by the
 * caller (core): explicit options > host environment adapter > resolved
 * project/user config > defaults. The SDK never reads files or environment.
 */
export type TellRuntimeOptions = {
  model: ModelPort;
  storage?: StoragePort;
  executor?: CommandExecutor;
  approval?: ApprovalPort;
  risk?: RiskPort;
  fetch?: FetchLike;
  exec?: boolean;
  cwd?: string;
  platform?: string;
  context?: string;
  system?: string;
  cancellation?: CancellationToken;
  redact?: Redactor;
  callbacks?: RuntimeCallbacks;
  env?: Record<string, string>;
  timeout_ms?: number;
  max_output_bytes?: number;
};

/** Single-turn runtime handle produced by `createTellRuntime`. */
export type TellRuntime = {
  run(message: string, override?: { cancellation?: CancellationToken }): Promise<TellResult>;
};

/**
 * In-memory `StoragePort`. Safe default when no storage is injected: no disk,
 * no localStorage, no globals. Each instance is independent.
 */
export class MemoryStorageAdapter implements StoragePort {
  private store = new Map<string, string>();

  /**
   * Loads the value stored under a key.
   *
   * @param key - Storage key.
   * @returns The stored value, or empty string when missing.
   */
  async load(key: string): Promise<string> {
    const value = this.store.get(key);
    if (value === undefined) {
      return '';
    } else {
      return value;
    }
  }

  /**
   * Saves a value under a key.
   *
   * @param key - Storage key.
   * @param value - Value to store.
   */
  async save(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  /**
   * Removes the value stored under a key.
   *
   * @param key - Storage key.
   */
  async clear(key: string): Promise<void> {
    this.store.delete(key);
  }

  /**
   * Appends an entry to the value stored under a key.
   *
   * @param key - Storage key.
   * @param entry - Entry to append.
   */
  async appendLog(key: string, entry: string): Promise<void> {
    const current = await this.load(key);
    await this.save(key, `${current}${entry}`);
  }
}

/**
 * Creates a no-op cancellation token (never cancelled).
 *
 * @returns A token that never cancels.
 */
export function never_cancelled(): CancellationToken {
  return { cancelled: false, on_cancel: (_callback: () => void) => () => {} };
}

/**
 * Creates a pre-cancelled token (short-circuits `run()` immediately).
 *
 * @returns A token that is already cancelled.
 */
export function cancelled_token(): CancellationToken {
  return { cancelled: true, on_cancel: (_callback: () => void) => () => {} };
}

/**
 * Creates a manually cancellable token.
 *
 * @returns The token plus a `cancel()` trigger.
 */
export function create_cancellation_token(): CancellationToken & { cancel(): void } {
  let is_cancelled = false;
  const listeners = new Set<() => void>();
  return {
    get cancelled(): boolean {
      return is_cancelled;
    },
    on_cancel(callback: () => void): () => void {
      if (is_cancelled) {
        callback();
        return () => {};
      } else {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      }
    },
    cancel(): void {
      if (is_cancelled) {
        return;
      } else {
        is_cancelled = true;
        for (const listener of [...listeners]) {
          listener();
        }
        listeners.clear();
      }
    },
  };
}

/**
 * Extracts the first `<think>` block content from a model answer.
 *
 * @param raw - Raw model answer.
 * @returns Trimmed think content, or empty string when absent.
 */
function extract_think_content(raw: string): string {
  const content = /<think>([\s\S]*?)<\/think>/i.exec(raw)?.[1]?.trim();
  if (content) {
    return content;
  } else {
    return '';
  }
}

/**
 * Combines executor stdout/stderr into the single command output record.
 *
 * @param stdout - Redacted standard output.
 * @param stderr - Redacted standard error.
 * @returns Combined output, trimmed.
 */
function combine_output(stdout: string, stderr: string): string {
  if (stderr) {
    return `${stdout}\n${stderr}`.trim();
  } else {
    return stdout.trim();
  }
}

/**
 * Creates an injectable single-turn runtime. Idempotent factory: no
 * filesystem, network, approval or global singleton is created here — ports
 * are only stored and used per `run()` call.
 *
 * Wiring per turn (never a chain loop; core owns iteration): load storage,
 * call the model once through `ModelPort`, emit thinking/text, handle at
 * most one `<RUN>` script through approval/executor ports, redact, persist.
 *
 * @param options - Injected ports and resolved options (model is required).
 * @returns Independent runtime handle.
 */
export function createTellRuntime(options: TellRuntimeOptions): TellRuntime {
  if (options.model === undefined || options.model === null) {
    throw new Error('createTellRuntime requires options.model');
  }
  const model = options.model;
  const storage = options.storage ?? new MemoryStorageAdapter();
  const redact = options.redact ?? ((value: string): string => value);
  const exec_enabled = options.exec ?? false;
  const callbacks = options.callbacks ?? {};

  async function load_context(): Promise<string> {
    if (callbacks.onStorageLoad !== undefined) {
      await callbacks.onStorageLoad({ key: DEFAULT_STORAGE_KEY });
    } else {
      // No load observer — storage is still read below.
    }
    const stored = await storage.load(DEFAULT_STORAGE_KEY);
    if (options.context) {
      if (stored) {
        return `${options.context}\n${stored}`;
      } else {
        return options.context;
      }
    } else {
      return stored;
    }
  }

  async function save_turn(message: string, text: string): Promise<void> {
    await storage.appendLog(DEFAULT_STORAGE_KEY, `\nUser:\n${message}\nAssistant:\n${text}`);
    if (callbacks.onStorageSave !== undefined) {
      await callbacks.onStorageSave({ key: DEFAULT_STORAGE_KEY });
    } else {
      // No save observer — the turn is already persisted above.
    }
  }

  async function run(message: string, override?: { cancellation?: CancellationToken }): Promise<TellResult> {
    const token = override?.cancellation ?? options.cancellation ?? never_cancelled();
    const timeline = [`User:\n${message}`];
    if (token.cancelled) {
      return { status: 'cancelled', text: '', timeline, commands: [] };
    } else {
      // Cancellation is only checked at boundaries — ModelPort has no abort
      // signal by design (AskInstance carries none either).
    }

    const previous = await load_context();
    const prompt = previous ? `Previous context:\n${previous}\n\nUser:\n${message}` : message;
    const system =
      options.system ??
      get_system_prompt({
        exec: exec_enabled,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.platform !== undefined ? { platform: options.platform } : {}),
      });
    const raw = await model.ask(prompt, { system, stream: false });
    if (token.cancelled) {
      return { status: 'cancelled', text: '', timeline, commands: [] };
    } else {
      // Model answered before cancellation — continue with its answer.
    }

    const think = extract_think_content(raw);
    if (think && callbacks.onThinking !== undefined) {
      await callbacks.onThinking(think);
    } else {
      // No reasoning to report, or nobody observes it.
    }
    const text = strip_run_tags(strip_think_tags(raw)).trim();
    timeline.push(`Assistant:\n${text}`);
    if (callbacks.onText !== undefined) {
      await callbacks.onText(text);
    } else {
      // No text observer.
    }

    const scripts = extract_runs(raw).scripts;
    const first_script = scripts[0];
    if (first_script === undefined) {
      await save_turn(message, text);
      return { status: 'completed', text, timeline, commands: [] };
    } else {
      // One script requested — resolve it through the ports below.
    }
    const script = first_script.trim();

    let risk: RiskAssessment | undefined;
    if (options.risk !== undefined) {
      risk = await options.risk.assess(script);
    } else {
      // No risk port — policy composition happens in core, not here.
    }
    if (callbacks.onCommandRequest !== undefined) {
      if (risk !== undefined) {
        await callbacks.onCommandRequest({ script, risk });
      } else {
        await callbacks.onCommandRequest({ script });
      }
    } else {
      // No request observer.
    }

    async function skip_command(status: CommandStatus, reason?: string): Promise<TellResult> {
      const command: RuntimeCommand = reason !== undefined ? { script, status, reason } : { script, status };
      if (callbacks.onCommandSkip !== undefined) {
        if (reason !== undefined) {
          await callbacks.onCommandSkip({ script, status, reason });
        } else {
          await callbacks.onCommandSkip({ script, status });
        }
      } else {
        // No skip observer — the status is still recorded below.
      }
      timeline.push(`Command ${status}:\n${script}`);
      await save_turn(message, text);
      return { status: 'completed', text, timeline, commands: [command] };
    }

    if (exec_enabled === false) {
      // Opt-in effects: without explicit exec the command is reported and
      // never executed. Contract wording: denied/disabled with --no-exec
      // source, never reason 'no-exec'.
      const denied: RuntimeCommand = { script, status: 'denied', reason: 'disabled', source: '--no-exec' };
      if (callbacks.onCommandSkip !== undefined) {
        await callbacks.onCommandSkip({ script, status: 'denied', reason: 'disabled' });
      } else {
        // No skip observer.
      }
      timeline.push(`Command denied:\n${script}`);
      await save_turn(message, text);
      return { status: 'completed', text, timeline, commands: [denied] };
    } else if (options.executor === undefined) {
      return skip_command('requested', 'no-executor');
    } else if (options.approval === undefined) {
      // Fail-closed: an executor without an explicit approval never runs.
      timeline.push(`Command awaiting_approval:\n${script}`);
      await save_turn(message, text);
      return { status: 'awaiting_approval', text, timeline, commands: [{ script, status: 'awaiting_approval' }] };
    } else {
      // Approval decides — the request callback above cannot widen authority.
    }

    const verdict = await options.approval({ script, ...(risk !== undefined ? { risk } : {}) });
    if (verdict === 'approved') {
      // Falls through to execution below.
    } else if (verdict === 'denied') {
      return skip_command('denied');
    } else {
      return skip_command('skipped');
    }

    if (token.cancelled) {
      timeline.push(`Command cancelled:\n${script}`);
      await save_turn(message, text);
      return { status: 'cancelled', text, timeline, commands: [{ script, status: 'cancelled' }] };
    } else {
      // Still live — execute once below.
    }
    if (callbacks.onCommandStart !== undefined) {
      await callbacks.onCommandStart({ script });
    } else {
      // No start observer.
    }

    let result: ExecutorResult;
    try {
      result = await options.executor({
        script,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        timeout_ms: options.timeout_ms ?? DEFAULT_EXEC_TIMEOUT_MS,
        ...(token !== undefined ? { cancellation: token } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        max_output_bytes: options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      const message_text = error instanceof Error ? error.message : String(error);
      const redacted_error = redact(message_text);
      if (callbacks.onExecutorError !== undefined) {
        await callbacks.onExecutorError({ script: redact(script), error: redacted_error });
      } else {
        // No error observer — the failure is still recorded below.
      }
      timeline.push(`Command failed:\n${redact(script)}`);
      await save_turn(message, text);
      return {
        status: 'failed',
        text,
        timeline,
        commands: [{ script: redact(script), status: 'failed', output: redacted_error }],
      };
    }

    // Single redaction boundary: raw stdout/stderr exist only above. From
    // here on, every sink (callbacks, logs, context, TellResult) sees the
    // redacted values; non-secret content is preserved by the injector.
    const redacted_script = redact(script);
    const output = combine_output(redact(result.stdout), redact(result.stderr));
    const command_status: CommandStatus = result.exit_code === 0 ? 'executed' : 'failed';
    if (callbacks.onCommandOutput !== undefined) {
      await callbacks.onCommandOutput({ script: redacted_script, output, exit_code: result.exit_code });
    } else {
      // No output observer.
    }
    timeline.push(`Command ${command_status}:\n${redacted_script}\nOutput:\n${output}`);
    await save_turn(message, text);
    return {
      status: 'completed',
      text,
      timeline,
      commands: [{ script: redacted_script, status: command_status, output, exit_code: result.exit_code }],
    };
  }

  return { run };
}
