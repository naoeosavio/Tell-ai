# `@tell-ai/core`

Shared Node runtime for tell-ai (MIT). It owns base config, fail-closed
paths, project context and — in later phases — the single exec/loop, Node
executor and base risk classification consumed by the CLI and Web adapters.

Provenance and the GPL→MIT signoff live in `docs/core-provenance.md`; the
fail-closed Phase 1 gate is `test/test-core-package.js`.

## Boundary

- The public injectable contract (`createTellRuntime`, `TellResult`, ports,
  callbacks) lives here (`src/runtime-api.ts`, moved from `@tell-ai/sdk`,
  which is clean again). The core also runs the single primitive loop.
- `tell()` stays a one-shot no-exec API in the SDK; the core does not change
  it.
- Base risk classification returns only `RiskAssessment` (severity, category,
  reasons, observable flags) — never `allow|confirm|deny`. `PolicyDecision`
  is owned by the future policy engine (`task_00N_policy-sandbox.md`, still
  BLOCKED).
- `mentions.ts` and `history.ts` stay in the CLI; Web flags
  (`--port/--host/--prompt/--exec-timeout`) stay parsed in
  `packages/web/src/server/cli-args.ts`. Adapters consume these modules —
  the core does not absorb them.
- The core never persists the Web system prompt; `/api/context` remains the
  server-side project-context origin until the Phase 6 migration.

## Defaults per host

There is no global model default. Adapters pass their host and the core
resolves `HOST_DEFAULT_MODEL`: CLI → `g`, Web → `l`. `TELL_MODEL` overrides
only when provided and non-empty.

## Config precedence

`resolve_core_config` merges layers in
`flag > env > project .tellrc > user ~/.tellrc > default` order. The first
defined value wins, except `exec_enabled`, where the most restrictive rule
(deny) wins across every layer. `.tellrc` parsing belongs to
`task_00N_tellrc.md`; the core accepts project/user layers as plain objects.
`TELL_KEY`/`TELL_BASE_URL` are owned by the later `task_00N_tellkey.md`
handoff and are not read here.

## Modules

| Module | Responsibility |
|---|---|
| `src/runtime-api.ts` | Injectable contract + `createTellRuntime` factory , `TellResult`, ports, callbacks, tokens |
| `src/browser-runtime.ts` | `createLocalStorageAdapter` over injected `StorageLike` |
| `src/config.ts` | Host defaults, `CoreConfig`/`ConfigLayer`, precedence resolver, base env loader |
| `src/paths.ts` | `canonical_path` / `canonical_write_path` (realpath, symlink fail-closed) |
| `src/project-context.ts` | Bounded project tree + README/AGENTS docs, ported from the Web `context-builder` |
| `src/chain-decision.ts` | Pure `validate_chain_decision_payload` for `/api/chain` confirm (no server state) |
| `src/loop.ts` | The single primitive exec/loop (≤8 rounds, exit-code feedback, cancel, fail-closed) |
| `src/runtime.ts` | `create_core_runtime`: injects resolved config into SDK ports, runs the loop |

Later phases add `src/risk.ts` (`RiskAssessment` only), `src/exec.ts`
(allowlisted environment) and the CLI/Web adapters that migrate `Tell.ts`
and the App onto this runtime.
