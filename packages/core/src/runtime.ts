import type { CoreConfig } from './config';
import { type CoreLoopOptions, run_primitive_loop } from './loop';
import type {
  ApprovalPort,
  CancellationToken,
  CommandExecutor,
  ModelPort,
  Redactor,
  RiskPort,
  RuntimeCallbacks,
  StoragePort,
  TellResult,
  TellRuntimeOptions,
} from './runtime-api';
import { DEFAULT_MAX_BUFFER_BYTES } from './runtime-limits';

/** Default per-command internal buffer (owned by `./runtime-limits`). */
export const CORE_MAX_OUTPUT_BYTES = DEFAULT_MAX_BUFFER_BYTES;

/** Input for `create_core_runtime`: resolved config plus injected ports. */
export type CoreRuntimeInput = {
  /** Resolved core config (host defaults + precedence already applied). */
  config: CoreConfig;
  /** Model port (AskInstance-compatible, mockable offline). */
  model: ModelPort;
  /** Persistence port (in-memory default inside the SDK wiring). */
  storage?: StoragePort;
  /** Node executor adapter (absent means commands are reported, never run). */
  executor?: CommandExecutor;
  /** Approval port (absent with an executor means fail-closed pending). */
  approval?: ApprovalPort;
  /** Advisory risk classifier (observed only; policy decides later). */
  risk?: RiskPort;
  /** Working directory announced to the model and forwarded to the executor. */
  cwd?: string;
  /** Platform string announced to the model. */
  platform?: string;
  /** Previous conversation prepended as context. */
  context?: string;
  /** Full system prompt override. */
  system?: string;
  /** Sanitized environment forwarded to the executor. */
  env?: Record<string, string>;
  /** Structural cancellation token (host adapts it to its own primitive). */
  cancellation?: CancellationToken;
  /** Single redactor applied at the SDK executor boundary. */
  redact?: Redactor;
  /** Observer/authorizer callbacks (they never drive the loop). */
  callbacks?: RuntimeCallbacks;
  /** Primitive-loop round cap (defaults to `LOOP_MAX_ROUNDS`). */
  max_rounds?: number;
};

/** Executable core runtime handle (loop owned by core, contract by the SDK). */
export type CoreRuntime = {
  /** Runs the primitive loop for one user message. */
  run(message: string, override?: { cancellation?: CancellationToken }): Promise<TellResult>;
};

/**
 * Creates the executable core runtime: injects the resolved config into the
 * SDK ports and runs the single primitive loop. Contract types
 * (`TellResult`, ports, callbacks) are reused from `@tell-ai/sdk`, never
 * redefined. No `PolicyDecision` is fabricated: risk is observed through
 * the injected port, approval verdicts come only from the injected approval
 * port, and anything without an explicit approval fails closed in the SDK
 * wiring (`awaiting_approval`) and stops the loop.
 *
 * @param input - Resolved config plus the host-provided ports.
 * @returns Independent runtime handle (no globals, no singletons).
 */
export function create_core_runtime(input: CoreRuntimeInput): CoreRuntime {
  const base_options: TellRuntimeOptions = {
    model: input.model,
    ...(input.storage !== undefined ? { storage: input.storage } : {}),
    ...(input.executor !== undefined ? { executor: input.executor } : {}),
    ...(input.approval !== undefined ? { approval: input.approval } : {}),
    ...(input.risk !== undefined ? { risk: input.risk } : {}),
    exec: input.config.exec_enabled,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.system !== undefined ? { system: input.system } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.cancellation !== undefined ? { cancellation: input.cancellation } : {}),
    ...(input.redact !== undefined ? { redact: input.redact } : {}),
    ...(input.callbacks !== undefined ? { callbacks: input.callbacks } : {}),
    timeout_ms: input.config.exec_timeout_ms,
    max_output_bytes: CORE_MAX_OUTPUT_BYTES,
  };
  const loop_options: CoreLoopOptions = {
    runtime_options: base_options,
    ...(input.max_rounds !== undefined ? { max_rounds: input.max_rounds } : {}),
  };

  async function run(message: string, override?: { cancellation?: CancellationToken }): Promise<TellResult> {
    if (override?.cancellation === undefined) {
      return run_primitive_loop(message, loop_options);
    } else {
      return run_primitive_loop(message, {
        ...loop_options,
        runtime_options: { ...loop_options.runtime_options, cancellation: override.cancellation },
      });
    }
  }

  return { run };
}
