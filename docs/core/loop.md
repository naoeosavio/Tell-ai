# Primitive loop + executable runtime

One loop, owned once. `run_primitive_loop` (`src/loop.ts`) iterates model→command rounds; `create_core_runtime` (`src/runtime.ts`) injects the resolved config into the SDK ports and runs that loop. Hosts never write their own loop — the CLI chain (`--chain`) and the Web server chain both call into these.

## `run_primitive_loop` (`src/loop.ts`)

```ts
import { create_core_runtime } from '@tell-ai/core';

const runtime = create_core_runtime({ config, model, executor, approval, risk });
const result = await runtime.run('fix the failing test');
```

* Round cap: `LOOP_MAX_ROUNDS` (alias of `DEFAULT_MAX_CHAIN_STEPS`, 8). `max_rounds` overrides per run, minimum 1 — the loop enforces no upper clamp; hosts clamp (CLI accepts up to 128, the Web sandbox clamps to 8).
* Each round delegates to the single-turn wiring (`createTellRuntime`): storage, thinking/text callbacks, approval, executor, redaction boundary. The loop only iterates — it never duplicates turn logic.
* Stop conditions: the model answers without a `<RUN>` script; a command is not executed (`denied` / `skipped` / `awaiting_approval` / `cancelled`); the token is cancelled; the round cap is hit (records `CHAIN_LIMIT_NOTICE`, then returns).
* Feedback between rounds is built by `format_command_feedback` (see [loop-feedback.md](loop-feedback.md)): `Executed command:` header (or the `Command failed` variant with the `FAILED` self-healing preamble) plus the continuation instruction. History itself travels through the storage port, so only the new feedback becomes the next message. Raw output never reaches here — the redaction boundary already ran.
* Executor failures self-heal through the `FAILED` feedback variant. No `PolicyDecision` is fabricated: without an explicit approval the single-turn wiring already fails closed (`awaiting_approval`) and the loop stops on that status.
* Timeline merge: round timelines append; only round one keeps its `User:` line.

## `create_core_runtime` (`src/runtime.ts`)

Input (`CoreRuntimeInput`): resolved `CoreConfig` plus injected ports — `model` (required), `storage`, `executor`, `approval`, `risk`, `cwd`, `platform`, `context`, `system`, `env`, `cancellation`, `redact`, `callbacks`, `max_rounds`. Returns `{ run(message, override?) }`.

Wiring: `exec: config.exec_enabled`, `timeout_ms: config.exec_timeout_ms`, `max_output_bytes: CORE_MAX_OUTPUT_BYTES` (alias of the 32 Mi internal buffer). Contract types (`TellResult`, ports, callbacks) are reused from the runtime contract, never redefined. The factory creates no filesystem, network, approval or singleton — ports are stored and used per `run()` call. `override.cancellation` replaces the token for one run.

CLI use (see `../cli/chain-mode.md`): `run_response_loop` builds the config via `resolve_cli_core_config`, seeds storage with the loaded context, and calls `run()` with `max_rounds: 1` (one-shot) or 8 (`--chain`).

## Offline examples (mocked `ModelPort`, no provider/network)

`examples/core/core-node.ts`, `core-bun.ts` (env allowlist demo), `core-browser.ts` (injected `StorageLike`/`FetchLike`, no executor), `core-express.ts` (backend handler shape). Run with `bun run test:core-examples`, compile with `bun run build:core-examples`.

Sources: `packages/core/src/loop.ts`, `src/runtime.ts`, `src/index.ts:29-30,70-71`, `packages/cli/src/core-adapters.ts`, `test/test-core-loop-feedback.js` (feedback wording), `test/test-core-runtime.js`.
