# Core provenance and GPL→MIT relicense signoff

This is the human-approval record required by `tasks/task_035_core.md`
(Phase 1 legal gate) before any `packages/core` scaffold, copy, publication
or relicense. The fail-closed harness `test/test-core-package.js` reads this
file: without it — or without explicit human approval language covering
GPL→MIT — the core task stays BLOCKED.

## 1. License inventory (verified 2026-10-07)

| Path | License | Evidence |
|---|---|---|
| `/LICENSE` | GPL-3.0 | `GNU GENERAL PUBLIC LICENSE, Version 3, 29 June 2007` (lines 1–2) |
| `packages/cli/package.json` | GPL-3.0 | `"license": "GPL-3.0"` (line 22) |
| `packages/web/package.json` | GPL-3.0 | `"license": "GPL-3.0"` (line 6) |
| `package.json` (root) | MIT | `"license": "MIT"` (line 32) |
| `packages/sdk/package.json` | MIT | `"license": "MIT"` (line 5) |

`@tell-ai/sdk` is already MIT and browser-safe; `tell-ai` and `@tell-ai/web`
are GPL-3.0. The future `@tell-ai/core` will be MIT-gated by the signoff below.

## 2. Source inventory for the extraction

Single author across all sources below: `nao e o savio` (per `git log`).

| Source | Content to extract | Recent history |
|---|---|---|
| `packages/cli/src/Tell.ts:148-175` | Model-spec helpers (`is_model_spec`, spec label) | `1cd8593` 2026-10-02, `388f457` 2026-09-25 |
| `packages/cli/src/Tell.ts:472-598` | Context-plan / history wiring reused by core adapters | same line of history as above |
| `packages/web/src/server/guards.ts:190-225` | Risk-pattern / guard helpers consumed by classification | `63dd132` 2026-09-25 |
| `packages/web/src/server/paths.ts:7-12` | Traversal-guard helper (core reimplements with realpath, fail-closed) | `63dd132` 2026-09-25 |
| `packages/web/src/server/context-builder.ts:39-184` | Project-tree / README-AGENTS context mover to `project-context.ts` | `63dd132` 2026-09-25, `d008407` 2026-09-16 |
| `/LICENSE` | GPL-3.0 grant being partially relicensed for the new package | `b42c8b7` 2026-07-08 relicense to GPL-3.0 |

No other GPL file is in scope for the MIT core. `mentions.ts`, `history.ts`
and the Web flags stay where they are; adapters only consume them.

## 3. Human approval (signoff)

I, the repository owner, **approve and authorize** the relicense from
**GPL-3.0 to MIT** for the new `packages/core` package, including code
derived from the GPL sources inventoried in section 2. Autorizo a criação do
`packages/core` sob licença MIT nos termos acima.

- Signoff date: 2026-10-07.
- Scope: `packages/core` only (scaffold, `src/*`, `LICENSE` MIT). No existing
  GPL file is relicensed; `packages/cli` and `packages/web` stay GPL-3.0.
- This approval must also be recorded in the PR description that introduces
  `packages/core/LICENSE` (MIT). Without that PR note, do not publish.
- Constraints carried forward: no `packages/core/src/*` before this record
  (enforced by the harness); no `TELL_KEY`/`TELL_BASE_URL` in core before the
  `task_00N_tellkey.md` handoff; `task_00N_policy-sandbox.md` stays BLOCKED
  and policy decides nothing in core.

## 4. Verification

```bash
node test/test-core-package.js
```

Passing output is `core package gate passed`. Any `BLOCKED:` line keeps
`tasks/task_035_core.md` BLOCKED — fix the cited reason, do not edit the gate
to skip it.
