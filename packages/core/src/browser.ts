/**
 * Browser-safe surface of `@tell-ai/core`.
 *
 * Only modules with zero builtin imports (bare or `node:`-prefixed) and zero
 * module-scope environment access may be re-exported here. `runtime-api` is
 * types-only (`export type` is erased, so it adds no runtime edge) because its
 * values import `@tell-ai/sdk`; `loop`, `runtime`, `exec`, `paths`,
 * `project-context` and `sdk-config` are Node-only and stay out. The
 * `test-core-package.js` gate fails the build if this entry ever gains a
 * builtin import. Browser callers must pass environment records explicitly
 * (`load_env_layer`, `runtime_env_from_process`); the `process.env` defaults
 * exist only on Node.
 */

export { createLocalStorageAdapter } from './browser-runtime';
export type { ChainDecision, ChainDecisionPayload, ChainDecisionValidation } from './chain-decision';
export { validate_chain_decision_payload } from './chain-decision';
export type { ConfigLayer, CoreConfig, CoreHost, ResolvedConfigInput } from './config';
export { HOST_DEFAULT_MODEL, load_env_layer, resolve_core_config } from './config';
export type {
  CommandFeedbackKind,
  CommandFeedbackOptions,
  ParsedCommandFeedback,
} from './loop-feedback';
export {
  COMMAND_FEEDBACK_FAILED_PREAMBLE,
  COMMAND_FEEDBACK_INSTRUCTION,
  format_command_feedback,
  format_command_result,
  format_command_skipped,
  format_executed_command,
  format_failed_command,
  parse_command_feedback,
} from './loop-feedback';
export type { RiskProfile, RiskRule } from './risk';
export { assess_base_risk, create_base_risk_port, DEFAULT_RISK_PROFILE } from './risk';
export type {
  RiskAssessment,
  RiskCategory,
  RiskPort,
  RiskSeverity,
  StorageLike,
  StoragePort,
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
