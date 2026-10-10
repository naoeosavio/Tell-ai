# Core runtime API (`@tell-ai/core`)

Injectable single-turn runtime for applications. `tell()` (in `@tell-ai/sdk`)
stays the one-shot no-exec call (`Promise<string>`); anything needing
`TellResult`, storage, an executor or approval uses `createTellRuntime` from
the core package. The runtime contract moved from `@tell-ai/sdk/runtime` to
`@tell-ai/core` (SDK left clean); the primitive exec/loop lives in the core
(`src/loop.ts`/`src/runtime.ts`). Boundary history: `packages/sdk/docs/runtime-api.md`.

## Import without running the binary

```ts
import { createTellRuntime, MemoryStorageAdapter } from '@tell-ai/core';
```

The CLI binary (`tell-ai`, `packages/cli/src/Tell.ts`) runs `main()` on load
and is never an importable library — always import `@tell-ai/core`.

## Minimal use (offline mock)

```ts
const runtime = createTellRuntime({
  model: { ask: async () => 'plain answer' }, // any AskInstance fits ModelPort
});
const result = await runtime.run('hello');
// { status: 'completed', text: 'plain answer', timeline: [...], commands: [] }
```

Effects are opt-in: without explicit `exec: true` plus an `executor` **and**
an `approval`, commands are reported and never executed.

## Execution wiring

```ts
const runtime = createTellRuntime({
  model,
  exec: true,
  storage: new MemoryStorageAdapter(), // default when omitted (per runtime)
  executor: async ({ script }) => ({ stdout: 'out', stderr: '', exit_code: 0 }),
  approval: async ({ script }) => 'approved', // 'approved' | 'denied' | 'skipped'
  risk: { assess: async (script) => ({ risky: false }) }, // composed by policy later
  redact: (value) => value.replaceAll('SECRET', '[redacted]'), // default: identity
  callbacks: {
    onThinking: (content) => {},
    onText: (text) => {},
    onCommandRequest: ({ script, risk }) => {},
    onCommandStart: ({ script }) => {},
    onCommandOutput: ({ script, output, exit_code }) => {},
    onCommandSkip: ({ script, status, reason }) => {},
    onStorageLoad: ({ key }) => {},
    onStorageSave: ({ key }) => {},
    onExecutorError: ({ script, error }) => {},
  },
});
```

Callback order per turn: `onStorageLoad → onThinking? → onText →
onCommandRequest? → (onCommandSkip | onCommandStart → onCommandOutput) →
onStorageSave`. Callbacks observe or authorize; consumer errors propagate
(nothing is swallowed). The request callback cannot widen authority: approval
returns a verdict for the exact requested script.

## Command lifecycle

`CommandStatus` is exactly
`requested | awaiting_approval | approved | skipped | denied | executed | cancelled | failed`
— no status outside this union is produced. The Web chain store
(`packages/web/src/server/chain-store.ts`) reuses this union for its run
commands; it never invents a new status.

| Situation | Command status | `TellResult.status` |
|---|---|---|
| `exec` off (default) | `denied`, `reason: 'disabled'`, `source: '--no-exec'` | `completed` |
| `exec` on, no executor | `requested` (`reason: 'no-executor'`) | `completed` |
| executor, no approval | `awaiting_approval` | `awaiting_approval` |
| approval denies / skips | `denied` / `skipped` | `completed` |
| approved, exit 0 | `executed` (+ `output`, `exit_code`) | `completed` |
| approved, exit ≠ 0 | `failed` (+ `output`, `exit_code`) | `completed` |
| executor throws | `failed` (+ redacted error) + `onExecutorError` | `failed` |
| token cancelled | `cancelled` / no commands | `cancelled` |

`no-exec` is always `denied`/`disabled` (never `reason: 'no-exec'`). Deny,
skip and pending-approval events are always recorded — never hidden.

## Redaction boundary

The single injected redactor runs immediately after the executor returns
stdout/stderr, before model feedback, callbacks, logs, context/history,
cache, `TellResult` or JSON. Raw output exists only in the transient executor
scope; non-secret content is preserved by the injector. `script` goes through
the same redactor. The default is identity (preserve everything).

## Chain confirm payloads (Web)

`validate_chain_decision_payload` (`src/chain-decision.ts`) is the pure,
fail-closed gate in front of every Web chain transition: it accepts exactly
one identifier (`decisionId` or `approvalId`), a non-negative integer
`expectedVersion` and `decision: 'approve'|'skip'`. Any `script`, `command`,
`path` or other extra field is rejected — the client never supplies free
scripts. Stateful concerns (version compare, command-hash TOCTOU,
idempotency, conflicts, cancel, TTL) live in the Web-owned
`packages/web/src/server/chain-store.ts`, which the server always drives
through this validator first. Covered by `test/test-core-chain-decision.js`
(validator) plus the chain blocks in `test/test-web-backend.js` (store) and
`test/test-web-sandbox.js` (live routes).

## Structural contracts (no DOM, no globals)

- `StorageLike` (`getItem`/`setItem`/`removeItem`, sync) — the browser adapter
  takes it as a parameter: `createLocalStorageAdapter(storage)`. Never reads
  ambient storage; SSR-safe with no storage. `StoragePort`
  (`load`/`save`/`clear`/`appendLog`, async) is what the runtime uses.
- `FetchLike` — structural `(request) => Promise<response>` with
  package-owned request/response shapes. No global `fetch`, no DOM
  `Response`; the host provides the real implementation when a tool needs
  network.
- `CancellationToken` (`cancelled` + `on_cancel` returning unsubscribe) — no
  direct `AbortController`; core adapters translate it outside this contract.
  Helpers: `never_cancelled()`, `cancelled_token()`,
  `create_cancellation_token()`.

Resolved-option precedence (applied by the caller, core): explicit options >
host environment adapter > resolved project/user config > defaults. The SDK
never reads files or environment. `createTellRuntime` is idempotent: no
filesystem, network, approval or global singleton is created in the factory.

## Monorepo split (conscious divergence from Gail's single package)

Gail proposed one package for CLI + library. The repo ships MIT
`@tell-ai/sdk`, GPL `tell-ai`, GPL `@tell-ai/web` and MIT `@tell-ai/core`:
the public runtime library is `@tell-ai/core` (this page), which also owns
the primitive loop (`src/loop.ts`) and the executable runtime
(`src/runtime.ts`); the SDK keeps `tell()`, models and providers only, and
the binary stays a binary. `tell()` keeps its signature and no-exec behavior.

## Examples and tests

Offline examples (mocked `ModelPort`, no provider/network):
`examples/core/core-node.ts`, `core-bun.ts` (env allowlist demo),
`core-browser.ts` (injected `StorageLike`/`FetchLike`, no executor),
`core-express.ts` (backend handler shape).

Suites: `bun run test:core-api` (11 tests: defaults, execution, approval,
cancellation, order, idempotence, adapters, `tell()` compat) and
`bun run test:core` (contract conformance, config/paths/context/decision and
the primitive loop). Run examples with
`bun run test:core-examples` and compile them with `bun run build:core-examples`.
