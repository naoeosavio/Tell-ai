# Runtime limits (single owner)

`src/runtime-limits.ts` owns every limit value: defaults, range table, `parse_runtime_limits` (flag > env > project tellrc > user tellrc > default), `TELLRC_LIMIT_KEYS`, `truncate_context`/`truncate_output`, `build_execution_options`, chat-payload caps and the exit-status family. Every `120_000`/`32 Mi`/8-round literal in core and web is an alias of this module. CLI history and before/after rationale stay in `../cli/runtime-limits.md` — this page is the module reference.

## Defaults and ranges

| Limit | Key | Default | Range | Flag | Env | Tellrc |
|---|---|---:|---|---|---|---|
| Context chars | `context_max_chars` | 65 536 | 1 024..1 048 576 | `--context-max-chars` | `TELL_CONTEXT_MAX_CHARS` | `context_chars` |
| Stdin timeout | `stdin_timeout_ms` | 30 000 ms (`0` disables) | 1..600 000 or 0 | `--stdin-timeout` / `--no-stdin-timeout` | `TELL_STDIN_TIMEOUT_MS` | `stdin_timeout_ms` |
| Stdin bytes | `stdin_max_bytes` | 1 048 576 | 1 024..33 554 432 | `--stdin-max-bytes` | `TELL_STDIN_MAX_BYTES` | `stdin_max_bytes` |
| Exec timeout | `exec_timeout_ms` | 120 000 ms | 1 000..600 000 | `--exec-timeout` | `TELL_EXEC_TIMEOUT_MS` | `exec_timeout_ms` |
| Chain rounds | `max_chain_steps` | 8 | 1..128 | `--max-chain` | `TELL_MAX_CHAIN_STEPS` | `max_chain_steps` |
| Internal buffer | `max_buffer_bytes` | 33 554 432 | 1 024..268 435 456 | `--max-buffer` | `TELL_MAX_BUFFER_BYTES` | `max_buffer_bytes` |
| Delivered output | `output_max_bytes` | 204 800 | 1 024..33 554 432 | `--output-max-bytes` | `TELL_OUTPUT_MAX_BYTES` | `output_max_bytes` |

Precedence: `flag > env > project .tellrc > user ~/.tellrc > default`. Flag/env values are validated strictly — any present-but-invalid value throws `RuntimeLimitError` (exit `EXIT_CONFIG_ERROR` = 2) before any model call or execution. Tellrc values carry their file source so failures are diagnosable. A `Record<keyof RuntimeLimits, LimitSpec>` makes a missing limit a type error instead of a silent default.

Exit codes: `EXIT_SUCCESS` 0 · `EXIT_MODEL_ERROR` 1 · `EXIT_CONFIG_ERROR` 2 · `EXIT_TIMEOUT` 124 (stdin or exec timeout) · `EXIT_LIMIT` 125 (stdin or output overflow). `StdinLimitError` (`timeout` → 124, `overflow` → 125) stays here with the rest of the contract.

## Functions

* `parse_runtime_limits({ flags, env, project, user })` → resolved `RuntimeLimits`. `no_stdin_timeout` forces the stdin timeout to 0; blank env values count as absent.
* `validate_tellrc_limit_value(key, raw)` — non-throwing variant for the tellrc parser: unknown keys, non-integers and out-of-range values return `undefined` so the caller warns and keeps the default. The dependency is one-way (`tellrc.ts` → this module).
* `build_execution_options(limits)` → `{ timeout_ms, max_output_bytes, max_buffer_bytes, max_rounds }` for the executor/loop ports. Pure mapping, no state machine.
* `truncate_context(text, max_chars)` — keeps the newest whole turns (`User:`/`Assistant:`/command records via `split_context_turns`) with balanced `<think>`/`<RUN>` blocks and a `[older context truncated]` marker; a single oversized turn is tail-cut at a safe boundary (no dangling `<` fragment, no unclosed tag; orphan closers dropped). Never splits a turn or a message. The marker and the closing tags are part of the budget: the result never exceeds `max_chars`.
* `truncate_output(output, max_bytes)` — byte-aware (UTF-8, never splits a char), marker `[output truncated at N bytes]` fits inside the budget (the marker itself is cut when the budget is too small for it). The result never exceeds `max_bytes` bytes.
* `runtime_env_from_process(env)` / `TELL_LIMIT_ENV_KEYS` — the `TELL_*` names a host may honor; the environment always arrives as a parameter, never bound.
* Chat-payload caps: `PAYLOAD_MAX_MESSAGES` (200), `PAYLOAD_MAX_CONTENT_CHARS` (50 Ki), `PAYLOAD_MAX_SYSTEM_CHARS` (30 Ki).

Divergences (test-pinned): `--stdin-max-bytes`/`--output-max-bytes` are CLI-only (the Web has no stdin); the sandbox clamps chain to 8. See `../cli/runtime-limits.md`.

Sources: `packages/core/src/runtime-limits.ts`, `test/test-core-limits.js`, `test/test-tell-runtime-limits.js`.
