# Browser-safe surface

`src/browser.ts` is the browser-safe surface of `@tell-ai/core`, served through the `browser` condition of the main entry so Vite and bundlers never pull Node builtins:

```ts
import { assess_base_risk, parse_runtime_limits } from '@tell-ai/core'; // browser build resolves here
```

## What ships to the browser

Only modules with zero builtin imports (bare or `node:`-prefixed) and zero module-scope environment access: loop-feedback, risk, chain-decision, runtime-limits, config, browser-runtime, `loop` and the runtime wiring (`runtime-api` values + `runtime`) — the runtime depends only on the dependency-free `@tell-ai/sdk/pure` entry (tags, system prompt, wire constants: no provider, no network), so it adds neither a provider graph nor a builtin. `exec`, `paths`, `project-context` and `sdk-config` are Node-only and stay out (builtins / filesystem / env). The `test/test-core-package.js` gate fails the build if this entry ever gains a builtin import; `test/test-core-browser.js` proves the bundle runs with no Node globals.

The Web offline fallback loop formats and parses through this surface, so its wording can never drift from the server's.

Type imports in this graph must be top-level `import type` / `export type` — never mixed inline (`import { type X, value }`). The bundler keeps a mixed statement as a side-effect import, which once dragged a bare `@tell-ai/sdk` import (and its Node builtins) into `dist/browser.*`. The package gate would not catch that shape; the browser smoke test does (it fails on any `require` in the sandbox).

## The surface at a glance

67 exports ship to the browser, grouped by what they give a host:

| Capability | Exports | What the host provides |
|---|---|---|
| **The runtime** | `create_core_runtime`, `createTellRuntime`, `MemoryStorageAdapter` | the model port (+ storage, optionally an executor) |
| **The primitive loop** | `run_primitive_loop`, `chain_limit_notice`, `LOOP_MAX_ROUNDS`, `CHAIN_LIMIT_NOTICE`, `CONTINUE_INSTRUCTION`, `CORE_MAX_OUTPUT_BYTES` | an injected single turn |
| **The risk port** | `assess_base_risk`, `create_base_risk_port`, `DEFAULT_RISK_PROFILE` | nothing — the classifier is pure (`permissive` for the CLI, `strict` for the Web) |
| **Cancellation** | `create_cancellation_token`, `cancelled_token`, `never_cancelled` | the token the loop checks at every round boundary |
| **Storage** | `createLocalStorageAdapter` | a `StorageLike` (`getItem`/`setItem`/`removeItem`) — never `globalThis.localStorage` |
| **Config** | `resolve_core_config`, `HOST_DEFAULT_MODEL`, `load_env_layer`, `compose_custom_system`, `CUSTOM_SYSTEM_PREFIX` | the env record (explicit — the browser has no `process.env`) |
| **Limits** | `parse_runtime_limits`, `build_execution_options`, `truncate_context`, `truncate_output`, `split_context_turns`, `has_balanced_tags`, `validate_tellrc_limit_value`, `runtime_env_from_process`, `RuntimeLimitError`, `StdinLimitError` + the `DEFAULT_*`/`MAX_*`/`MIN_*`/`EXIT_*`/`PAYLOAD_MAX_*`/`TELL*_KEYS` constants | the flag/env/tellrc records |
| **The command-feedback protocol** | `format_executed_command`, `format_failed_command`, `format_command_result`, `format_command_skipped`, `format_cancelled_command`, `format_command_feedback`, `parse_command_feedback` + `EXECUTED_HEADER`, `SKIPPED_HEADER`, `CANCELLED_HEADER`, `OUTPUT_SEPARATOR`, `COMMAND_FEEDBACK_INSTRUCTION`, `COMMAND_FEEDBACK_FAILED_PREAMBLE` | nothing — this is the wording every host shares |
| **The chain confirm** | `validate_chain_decision_payload` | the payload |

`examples/core/core-browser.ts` exercises every row of that table (and prints what the browser cannot do).

## What does NOT ship, and why

28 exports stay Node-only. Each one is blocked by a concrete builtin, not by accident:

| Blocked by | Exports | What to do in the browser |
|---|---|---|
| **`child_process` + a real shell** | `create_node_executor`, `format_timeout_message`, `resolve_exec_cwd`, `collect_exec_secrets`, `create_secret_redactor`, `sanitize_exec_env`, `SENSITIVE_ENV_NAMES`, `SENSITIVE_ENV_SUFFIX`, `EXEC_SHELL`, `EXEC_DEFAULT_TIMEOUT_MS`, `EXEC_MAX_OUTPUT_BYTES`, `EXEC_REDACTED_MARKER`, `EXEC_TIMEOUT_EXIT_CODE`, `EXEC_CANCELLED_EXIT_CODE`, `EXEC_KILL_GRACE_MS` | **Do not execute in the browser.** Leave the executor out: the runtime then *reports* the requested command and never runs it (the existing `TellRuntimeOptions.executor` contract, not a browser special case). A command that was not executed stops the loop (fail-closed). A host that must run commands talks to a server that owns the executor. |
| **`realpath` (filesystem)** | `canonical_path`, `canonical_write_path`, `is_path_inside_base`, `has_lexical_target` | Keep the path checks on the server: the fail-closed path rules are a server-side concern (a browser has no workspace to guard). |
| **Directory walking** | `build_project_context`, `PROJECT_TREE_MAX_DEPTH`, `PROJECT_TREE_MAX_FILES`, `PROJECT_DOC_FILES`, `PROJECT_DOC_MAX_BYTES`, `PROJECT_DOC_MAX_CHARS`, `PROJECT_SKIP_DIRS` | Ask the server for the project context (the Web server composes it into the system prompt). |
| **`process.env` + token files** | `load_sdk_config_from_env`, `build_sdk_config_from_env` | Keep the credentials on the server. The browser host injects the model port; it never sees a provider key. |

The practical rule: **the browser owns the protocol, the server owns the world.** Iteration, wording, limits, risk, storage and cancellation are the core's in the browser; execution, the filesystem and the credentials are the server's.

## `run_primitive_loop` (`src/loop.ts`)

The real primitive loop runs in the browser: the single-turn runner arrives injected, so the bundle never imports the SDK main entry.

```ts
import { create_ask_ai } from '@tell-ai/sdk/browser';
import { run_primitive_loop } from '@tell-ai/core';

const single_turn = /* TellRuntime over the SDK browser bundle, storage adapter, no executor */;
const result = await run_primitive_loop('hi', { runtime_options: {}, single_turn, max_rounds: 8 });
```

Same iteration, wording, cancellation and fail-closed stops as Node — only the ports differ: no executor means commands are reported, never run (`TellRuntimeOptions.executor` absent is an existing contract, not a browser special case). The loop is the low-level seam; `create_core_runtime` (below) is the full path and needs no hand-written single turn.

`runtime_options` is a `Partial<TellRuntimeOptions>`: the loop reads only the cancellation token from it (the ports live in the injected runner), so a browser host passes `{ runtime_options: {} }` — or `{ runtime_options: { cancellation } }` — and never has to invent a `model` it does not have.

Cancellation is split across the two boundaries: the loop checks the token from `runtime_options.cancellation` at every round boundary, and forwards it to the injected runner (`single_turn.run(message, { cancellation })`), which owns the executor boundary. A browser host that injects its own single-turn must honour the `override.cancellation` it receives — that is what stops a command after a cancel, exactly as on Node.

## `create_core_runtime` (`src/runtime.ts`)

The whole Node path also runs in the browser — the core wires the single turn itself, so the host injects only the model and the storage:

```ts
import { create_ask_ai } from '@tell-ai/sdk/browser';
import { createLocalStorageAdapter, create_core_runtime, resolve_core_config } from '@tell-ai/core';

const runtime = create_core_runtime({
  config: resolve_core_config({ host: 'web', layers: [{}] }),
  model: create_ask_ai('g', { keys, urls }),
  storage: createLocalStorageAdapter(localStorage),
});
const result = await runtime.run('hi');
```

No executor is injected, so a requested command is **reported, never run** — the existing `TellRuntimeOptions.executor` contract, not a browser special case. A command that was not executed stops the loop (fail-closed).

## A real host: the Web client

The Web client is that host. Its fallback chain (the path used when the server chain is unavailable) runs on `run_primitive_loop` — the injected turn talks to the **server** (`/api/tell`, `/api/execute`), so the provider key never reaches the browser. The round cap, the feedback wording, the fail-closed stops and the feedback-card vocabulary are the core's, which is why the browser fallback and the server chain speak one protocol.

```ts
// packages/web/src/shared/local-loop.ts (the browser's turn over the server)
const result = await run_local_loop({
  message: prompt,
  max_rounds: budget,
  cancellation: { get cancelled() { return controller.signal.aborted; }, on_cancel: (cb) => … },
  ask: async (message) => ({ text, script }),
  execute: async (script) => ({ output, exit_code }),
  may_execute: async (script) => true, // false holds the command for the user
});
```

A command the user must approve stops the loop (`awaiting_approval` — the core never executes on its own); the client resumes the chain with the decision it took, using the core's own `format_command_feedback` wording.

## `createLocalStorageAdapter` (`src/browser-runtime.ts`)

Wraps an injected `StorageLike` (`getItem`/`setItem`/`removeItem`, sync) as an async `StoragePort`:

```ts
import { createLocalStorageAdapter } from '@tell-ai/core';

const storage = createLocalStorageAdapter(localStorage); // or any StorageLike fake
```

The storage is always a parameter — the adapter never reads `globalThis.localStorage`, `window` or any ambient global, so it works in SSR (pass a fake or omit storage) and any browser context. Malformed stores throw at construction, not on first use. `MemoryStorageAdapter` (in `runtime-api.ts`) covers the no-storage default; this adapter covers the persisted case.

## Environment records are explicit

`load_env_layer()` and `runtime_env_from_process()` take the record as an argument — the browser has no `process.env` to read. `load_env_layer()` without an argument returns `{}` (it guards `typeof process`), so it is safe to call anywhere, but a host that wants the model from the environment must pass the record in.

Sources: `packages/core/src/browser.ts`, `src/browser-runtime.ts`, `src/loop.ts`, `src/runtime.ts`, `examples/core/core-browser.ts` (the runnable inventory), `test/test-core-package.js` (builtin-import gate), `test/test-core-browser.js` (no-globals smoke).
