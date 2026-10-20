/**
 * Browser-safe surface of `@tell-ai/core`.
 *
 * Only modules with zero builtin imports (bare or `node:`-prefixed) and zero
 * module-scope environment access may be re-exported here. `runtime-api` is
 * in because its only SDK dependency is the dependency-free `@tell-ai/sdk/pure`
 * entry (tags, system prompt, wire constants — no provider, no network), so
 * it adds no provider graph and no builtin. `loop` is import-pure (the
 * single-turn runner arrives injected). `exec`, `paths`, `project-context` and
 * `sdk-config` are Node-only and stay out (builtins / filesystem / env).
 * The `test-core-package.js` gate fails the build if this entry ever gains a
 * builtin import; `test-core-browser.js` proves the bundle runs with no Node
 * globals. Browser callers must pass environment records explicitly
 * (`load_env_layer`, `runtime_env_from_process`) and inject the model/storage
 * ports (no executor in the browser — commands are reported, never run); the
 * `process.env` defaults exist only on Node.
 */

export { createLocalStorageAdapter } from './browser-runtime';
export type { ChainDecision, ChainDecisionPayload, ChainDecisionValidation } from './chain-decision';
export { validate_chain_decision_payload } from './chain-decision';
export type { ConfigLayer, CoreConfig, CoreHost, ResolvedConfigInput } from './config';
export { HOST_DEFAULT_MODEL, load_env_layer, resolve_core_config } from './config';
export { CUSTOM_SYSTEM_PREFIX, compose_custom_system } from './custom-system';
export type { CoreLoopOptions } from './loop';
export {
  CHAIN_LIMIT_NOTICE,
  CONTINUE_INSTRUCTION,
  chain_limit_notice,
  LOOP_MAX_ROUNDS,
  run_primitive_loop,
} from './loop';
export type {
  CommandFeedbackKind,
  CommandFeedbackOptions,
  ParsedCommandFeedback,
} from './loop-feedback';
export {
  CANCELLED_HEADER,
  COMMAND_FEEDBACK_FAILED_PREAMBLE,
  COMMAND_FEEDBACK_INSTRUCTION,
  EXECUTED_HEADER,
  format_cancelled_command,
  format_command_feedback,
  format_command_result,
  format_command_skipped,
  format_executed_command,
  format_failed_command,
  OUTPUT_SEPARATOR,
  parse_command_feedback,
  SKIPPED_HEADER,
} from './loop-feedback';
export type { RiskProfile, RiskRule } from './risk';
export { assess_base_risk, create_base_risk_port, DEFAULT_RISK_PROFILE } from './risk';
export type { CoreRuntime, CoreRuntimeInput } from './runtime';
export { CORE_MAX_OUTPUT_BYTES, create_core_runtime } from './runtime';
export type {
  ApprovalPort,
  CancellationToken,
  CommandExecutor,
  ModelPort,
  Redactor,
  RiskAssessment,
  RiskCategory,
  RiskPort,
  RiskSeverity,
  RuntimeCallbacks,
  StorageLike,
  StoragePort,
  TellResult,
  TellRuntime,
  TellRuntimeOptions,
} from './runtime-api';
export {
  type ApprovalDecision,
  cancelled_token,
  create_cancellation_token,
  createTellRuntime,
  MemoryStorageAdapter,
  never_cancelled,
  type RuntimeCommand,
  type RuntimeStatus,
} from './runtime-api';
export type {
  ExecutionOptions,
  ParseRuntimeLimitsInput,
  RuntimeLimitEnv,
  RuntimeLimitFlags,
  RuntimeLimits,
  RuntimeLimitTellrcLayer,
  StdinLimitErrorKind,
} from './runtime-limits';
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
  EXIT_LIMIT,
  EXIT_MODEL_ERROR,
  EXIT_SUCCESS,
  EXIT_TIMEOUT,
  has_balanced_tags,
  MAX_CHAIN_STEPS,
  MAX_EXEC_TIMEOUT_MS,
  MIN_EXEC_TIMEOUT_MS,
  OUTPUT_TRUNCATE_MARKER_PREFIX,
  PAYLOAD_MAX_CONTENT_CHARS,
  PAYLOAD_MAX_MESSAGES,
  PAYLOAD_MAX_SYSTEM_CHARS,
  parse_runtime_limits,
  RuntimeLimitError,
  runtime_env_from_process,
  StdinLimitError,
  split_context_turns,
  TELL_LIMIT_ENV_KEYS,
  TELLRC_LIMIT_KEYS,
  truncate_context,
  truncate_output,
  validate_tellrc_limit_value,
} from './runtime-limits';
