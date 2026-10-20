# Overview

`@tell-ai/core` (`packages/core/`) is the shared Node runtime for tell-ai (MIT). It owns the injectable exec/loop contract, the Node executor, base risk classification, host config, fail-closed paths, project context and the operational limits. The CLI (`tell-ai`) and the web sandbox (`@tell-ai/web`) are thin adapters over it: they parse flags, render output and inject ports — they never reimplement turn logic, execution or classification.

```bash
npm i @tell-ai/core
```

## What it owns vs the neighbors

| Layer | Package | Responsibilities |
|-------|---------|------------------|
| LIB | `@tell-ai/sdk` (`packages/sdk/`) | Model resolution (`MODELS`, `resolve_model_spec`), vendor dispatch (`create_ask_ai`), one-shot `tell()`, `get_system_prompt()`, `<RUN>`/`<think>` helpers, `summarize_context`. Browser-safe: no `node:*`, no `process.env`. |
| RUNTIME | `@tell-ai/core` (`packages/core/`, this doc) | Injectable single-turn wiring (`createTellRuntime`), primitive exec/loop (`run_primitive_loop`), executable runtime (`create_core_runtime`), Node executor (`create_node_executor`), base risk (`assess_base_risk`), host config + limits, fail-closed paths, project context. |
| CLI | `tell-ai` (`packages/cli/`) | Commander parsing, stdin, `@path` mention expansion (`src/mentions.ts`), `@N`/`%N` history (`src/history.ts`), confirmation prompts, log/context files. Exec/loop/risk/env arrive from the core via `src/core-adapters.ts`. |
| WEB | `@tell-ai/web` (`packages/web/`) | PTY terminals, file APIs, chat UI, server-side chain store. Loop wording, path checks, project scan and risk base come from the core. |

Dependency direction is one-way: CLI/Web → core → SDK. The core never imports the CLI or the Web; the SDK never reads the environment.

## Boundary (what stays out)

* `tell()` stays a one-shot no-exec API in the SDK; the core does not change it.
* Base risk returns only `RiskAssessment` (severity, category, reasons, flags) — never `allow|confirm|deny`. `PolicyDecision` belongs to the future policy engine (`tasks/task_00N_policy-sandbox.md`, still BLOCKED).
* `mentions.ts` / `history.ts` stay CLI-owned (`@path` expansion, `@N`/`%N` history); Web flags (`--port/--host/--prompt/--exec-timeout`) stay parsed in `packages/web/src/server/cli-args.ts`.
* The core never persists the Web system prompt; `/api/context` remains the server-side project-context origin. The Web `context-builder.ts` delegates its scan to `build_project_context` and keeps only host-side composition.
* Chain approval state is Web-owned (`packages/web/src/server/chain-store.ts`); the core owns only the pure confirm validator (`validate_chain_decision_payload`).
* `TELL_KEY`/`TELL_BASE_URL` are owned by the later tellkey handoff (`tasks/task_00N_tellkey.md`) and are not read here.

Provenance and the GPL→MIT signoff live in `../core-provenance.md`; the fail-closed Phase 1 gate is `test/test-core-package.js`.

## Adapters (who injects what)

* CLI (`packages/cli/src/core-adapters.ts`): permissive risk port, scrubbed env, the core `create_node_executor` transport, promise-based approval port, `resolve_cli_core_config` (host `cli`, default `g`), streaming-capable model port, seeded storage. `Tell.ts` keeps prompting, mentions, history, flags, stdin and rendering; its response loop delegates to `create_core_runtime().run()`. `env.ts` is a thin client of the core SDK-config owner (token files on).
* Web (`packages/web/src/server/chain-store.ts` + routes in `server.ts`, client in `src/App.tsx`): the loop, the pending script and the approval state stay server-side; the App submits, renders events incrementally and answers by decision id, with the local loop as offline fallback. The client No-Exec toggle never reaches the server confirm — it cancels the run and follows the local no-exec path.

## Defaults per host

There is no global model default. Adapters pass their host and the core resolves `HOST_DEFAULT_MODEL`: CLI → `g`, Web → `l`. `TELL_MODEL` overrides only when provided and non-empty. See [config.md](config.md).

## Browser surface

Pure modules (loop-feedback, risk, chain-decision, runtime-limits, config, browser-runtime + erased port types) are re-exported through the `browser` condition of the main entry so browsers and Vite never bundle Node builtins. Node-only modules (`loop`, `runtime`, `exec`, `paths`, `project-context`, `sdk-config`) stay out. See [browser.md](browser.md).

Sources: `packages/core/src/index.ts`, `src/browser.ts`, `packages/core/package.json`, `packages/cli/src/core-adapters.ts`, `../core-provenance.md`.
