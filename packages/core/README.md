# `@tell-ai/core`

Shared Node runtime for tell-ai (MIT). It owns the injectable contract, the
single primitive exec/loop, the Node executor, base risk classification, base
config, fail-closed paths and project context consumed by the CLI and Web
adapters.

Provenance and the GPL→MIT signoff live in `docs/core-provenance.md`; the
fail-closed Phase 1 gate is `test/test-core-package.js`.

## Install

```bash
npm i @tell-ai/core
```

```bash
bun add @tell-ai/core
```

## Documentation

Full reference: [`docs/core/`](../../docs/core/README.md) — runtime API, loop,
exec, risk, config, limits, paths, project context, SDK config, chain
decisions, feedback wording, browser surface, development.

## Boundary

- The public injectable contract (`createTellRuntime`, `TellResult`, ports,
  callbacks) lives here (`src/runtime-api.ts`, moved from `@tell-ai/sdk`,
  which is clean again). The core also runs the single primitive loop.
- `tell()` stays a one-shot no-exec API in the SDK; the core does not change
  it.
- Base risk classification returns only `RiskAssessment` (severity, category,
  reasons, observable flags) — never `allow|confirm|deny`. `PolicyDecision`
  is owned by the future policy engine (`task_00N_policy-sandbox.md`, still
  BLOCKED): policy composes the base assessment, it never replaces the
  classifier, the executor or the loop.
- `mentions.ts` and `history.ts` stay in the CLI (owners of `@path`
  expansion and `@N`/`%N` history); Web flags
  (`--port/--host/--prompt/--exec-timeout`) stay parsed in
  `packages/web/src/server/cli-args.ts`. Adapters consume these modules —
  the core does not absorb, rewrite or delete them.
- The core never persists the Web system prompt; `/api/context` remains the
  server-side project-context origin. The Web `context-builder.ts` delegates
  its scan to the core `build_project_context` and only keeps the host-side
  system-prompt composition; the scan caps and the `ProjectContext` shape are
  owned here.
- Chain approval state is Web-owned (`packages/web/src/server/chain-store.ts`,
  in-memory, TTL, idempotent decisions); the core owns only the pure confirm
  validator (`src/chain-decision.ts`), which the server runs before any
  store transition.
- The vendor → key/url mapping is owned here (`src/sdk-config.ts`): the CLI
  (`token_files: true`) and the Web server (`token_files: false`) both build
  their `SDKConfig` from it, so every vendor honors its `*_BASE_URL`.
- The command-feedback wording is owned here (`src/loop-feedback.ts`, served to
  browsers through the `browser` condition of the main entry, `src/browser.ts`):
  the CLI log, the Web chain messages and the Web offline fallback loop all
  format through it, and the Web parser delegates to it.

## Defaults per host

There is no global model default. Adapters pass their host and the core
resolves `HOST_DEFAULT_MODEL`: CLI → `g`, Web → `l`. `TELL_MODEL` overrides
only when provided and non-empty.

## Config precedence

`resolve_core_config` merges layers in
`flag > env > project .tellrc > user ~/.tellrc > default` order. The first
defined value wins, except `exec_enabled`, where the most restrictive rule
(deny) wins across every layer. `.tellrc` parsing belongs to
`task_036_tellrc.md`; the core accepts project/user layers as plain objects.
`TELL_KEY`/`TELL_BASE_URL` are owned by the later `task_00N_tellkey.md`
handoff and are not read here.

## Modules

| Module | Responsibility |
|---|---|
| `src/runtime-api.ts` | Injectable contract + `createTellRuntime` factory , `TellResult`, ports, callbacks, tokens |
| `src/browser-runtime.ts` | `createLocalStorageAdapter` over injected `StorageLike` |
| `src/browser.ts` | Browser-safe surface (loop-feedback, risk, chain-decision, runtime-limits, config, browser-runtime + erased port types; never `runtime-api` values, `loop`, `runtime`, or Node-only modules); built to `dist/browser.js` and served through the `browser` condition of the main entry so Vite never bundles Node builtins |
| `src/config.ts` | Host defaults, `CoreConfig`/`ConfigLayer`, precedence resolver, base env loader |
| `src/runtime-limits.ts` | Single owner of every limit value: defaults, range table, `parse_runtime_limits` (flag > env > project tellrc > user tellrc > default), `TELLRC_LIMIT_KEYS`, `truncate_context`/`truncate_output`, `build_execution_options`, chat-payload caps (`PAYLOAD_MAX_*`) |
| `src/paths.ts` | `canonical_path` / `canonical_write_path` (realpath, symlink fail-closed, opt-in `create_parents`) |
| `src/project-context.ts` | Bounded project tree + README/AGENTS docs (the Web `context-builder` delegates here); publishes the tree/doc caps |
| `src/loop-feedback.ts` | Single owner of the command-feedback wording (`format_*`, `parse_command_feedback`); pure, no builtin imports |
| `src/sdk-config.ts` | Single owner of the vendor → key/url mapping (`build_sdk_config_from_env` sync + `load_sdk_config_from_env` with token files) |
| `src/chain-decision.ts` | Pure `validate_chain_decision_payload` for `/api/chain` confirm (no server state) |
| `src/risk.ts` | Base `assess_base_risk` + `create_base_risk_port` (`permissive` CLI / `strict` Web, `RiskAssessment` only) |
| `src/exec.ts` | Node `create_node_executor` (`/bin/bash`, real cwd, 120s/exit 124, 32 MB cap, process group, structural token, scrubbed env, `format_timeout_message`); the timeout/buffer numbers are aliases of `src/runtime-limits.ts`; both hosts execute through it |
| `src/loop.ts` | The single primitive exec/loop (≤8 rounds via `DEFAULT_MAX_CHAIN_STEPS`, exit-code feedback via `src/loop-feedback.ts`, cancel, fail-closed) |
| `src/runtime.ts` | `create_core_runtime`: injects resolved config into SDK ports, runs the loop |

## Environment allowlist

`sanitize_exec_env` drops every name in `SENSITIVE_ENV_NAMES` (`TELL_KEY`,
`TELL_TOKEN`, `NODE_OPTIONS`, `BASH_ENV`, loader/preload variables…) and every
name matching `SENSITIVE_ENV_SUFFIX` (`*_API_KEY`, `*_TOKEN`, `*_SECRET`,
`*_PASSWORD`, …), so provider keys and tokens never reach a child process or
PTY. `collect_exec_secrets` harvests the dropped values for
`create_secret_redactor`, which masks them in scripts and outputs at the
single runtime redaction boundary (right after the executor returns, before
feedback, callbacks, logs, context, cache, `TellResult` or JSON).

## Fail-closed paths

`canonical_path` / `canonical_write_path` resolve through realpath and fail
closed on symlinks, missing bases, sibling prefixes and external targets.
They are tested first in the core (`test/test-core-paths.js`); adapters adopt
the helper afterwards. `mentions.ts`'s read gate is preserved UX, not a
security proof — the core helper is the canonical check.

## Chain state (Web)

`POST /api/chain` runs the model loop on the server (≤8 rounds,
`CHAIN_MAX_ROUNDS`); `GET /api/chain/:runId` replays the sequenced events;
`POST /api/chain/:runId/confirm` answers a pending approval by decision id
(`validate_chain_decision_payload` accepts only `decisionId`/`approvalId`,
`expectedVersion`, `decision: 'approve'|'skip'` — any script/command/path is
400); `POST /api/chain/:runId/cancel` invalidates the run. Same decision id +
same verdict replays without re-executing; a different verdict is 409; cancel
wins over in-flight confirms; entries expire after 15 min and restarts drop
everything. `no-exec` denies with `reason: 'disabled'` / `source: '--no-exec'`
(never `reason: 'no-exec'`). `/api/tell`, `/api/execute` and `/api/risk-check`
stay stable beside the chain routes.

## Adapters

- CLI (`packages/cli/src/core-adapters.ts`): permissive risk port, scrubbed
  env, the core `create_node_executor` transport (pinned by the VM harnesses
  through a recording stand-in, so no command ever runs for real in the
  sandbox),
  promise-based approval port, `resolve_cli_core_config` (host `cli`,
  default `g`), streaming-capable model port and seeded storage. `Tell.ts`
  keeps prompting, mentions, history, flags, stdin and rendering; its response
  loop delegates to `create_core_runtime().run()`. `env.ts` is a thin client
  of the core SDK-config owner (token files on).
- Web (`packages/web/src/server/chain-store.ts` + routes in `server.ts`,
  client in `src/App.tsx`): the loop, the pending script and the approval
  state stay server-side; the App submits, renders events incrementally and
  answers by decision id, with the local loop as offline fallback. The client
  No-Exec toggle never reaches the server confirm — it cancels the run and
  follows the local no-exec path.
