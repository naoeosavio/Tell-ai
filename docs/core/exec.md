# Node executor + environment allowlist

`create_node_executor` (`src/exec.ts`) is the runtime `CommandExecutor` port both hosts execute through. It runs the approved script through the explicit shell in the canonical cwd, with timeout, output cap, process-group kill, structural cancellation and a scrubbed environment. Raw `stdout`/`stderr` return untouched here — the single redaction boundary in `createTellRuntime` masks them immediately after, before feedback, callbacks, logs, context, cache, `TellResult` or JSON.

## Execution

* Shell: `EXEC_SHELL` (`/bin/bash`), spawned as `bash -c <script>` with `detached: true` so the whole process group can be killed (`SIGTERM`, then `SIGKILL` after `EXEC_KILL_GRACE_MS` = 2 s).
* cwd: `resolve_exec_cwd` (defaults to `process.cwd()`), resolved to its realpath, fail-closed when missing or not a directory.
* Timeout: per-call `timeout_ms`, else the host default, else `EXEC_DEFAULT_TIMEOUT_MS` (120 s, alias of the limits owner). Expiry reports exit `EXEC_TIMEOUT_EXIT_CODE` (124) with `format_timeout_message(script, timeout_ms)` — the script travels with the message because it becomes model context. See [runtime-limits.md](runtime-limits.md).
* Buffer: per-call `max_output_bytes`, else the host default, else `EXEC_MAX_OUTPUT_BYTES` (32 Mi, the internal accumulation cap — not the delivered-output cap). Overflow kills the group and finishes with exit 1 plus an `output exceeded N bytes` note.
* Cancel: a cancelled `CancellationToken` rejects with `cancelled` (exit `EXEC_CANCELLED_EXIT_CODE` = 130 when the process already died from the kill); `close` with null code also maps to 130.
* Pre-cancelled token throws before spawning — no process is ever created.

## Scrubbed environment

`sanitize_exec_env` drops every name in `SENSITIVE_ENV_NAMES` (`TELL_KEY`, `TELL_TOKEN`, `NODE_OPTIONS`, `BASH_ENV`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, loader/preload variables…) and every name matching `SENSITIVE_ENV_SUFFIX` (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, …), so provider keys and tokens never reach a child process or PTY. Entries with `undefined` values are dropped too; everything else passes verbatim. Merge order per call: `process.env` < executor defaults < call options — then scrubbed.

`collect_exec_secrets` harvests the dropped non-empty values; `create_secret_redactor(secrets)` masks each verbatim occurrence with `EXEC_REDACTED_MARKER` (`[redacted]`). Non-secret content is preserved. Both hosts build the redactor from the pre-scrub environment and inject it as the runtime `redact` port.

## Host wiring

* CLI: `create_cli_executor(defaults)` in `packages/cli/src/core-adapters.ts` — a thin seam over `create_node_executor`; the VM harnesses pin it through a recording stand-in so no command ever runs for real in tests.
* Web: the server executes through the same transport; PTY panes and `/api/execute` inherit the scrubbed environment.

Sources: `packages/core/src/exec.ts`, `src/runtime-api.ts:580-583` (redaction boundary), `packages/cli/src/core-adapters.ts`, `test/test-core-exec.js`.
