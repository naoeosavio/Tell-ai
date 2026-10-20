# Core documentation

Complete reference for the `@tell-ai/core` package (`packages/core/`): the shared Node runtime consumed by the CLI and web adapters. Single owner of the injectable exec/loop contract, the Node executor, base risk classification, host config, fail-closed paths, project context and the operational limits.

```bash
npm i @tell-ai/core
```

```bash
bun add @tell-ai/core
```

| Page | Contents |
|------|----------|
| [overview.md](overview.md) | What the core is, boundary vs SDK/CLI/Web, layers, adapters |
| [runtime-api.md](runtime-api.md) | Injectable contract: `createTellRuntime`, `TellResult`, ports, callbacks, command lifecycle, redaction boundary |
| [loop.md](loop.md) | Primitive exec/loop (`run_primitive_loop`) + executable runtime (`create_core_runtime`) |
| [exec.md](exec.md) | Node executor (`create_node_executor`), env allowlist, secret redaction, timeout/cancel/buffer |
| [risk.md](risk.md) | Base risk classification (`assess_base_risk`), permissive/strict profiles, rule catalog |
| [config.md](config.md) | Host defaults, `CoreConfig` precedence, env layer, custom-system composition |
| [runtime-limits.md](runtime-limits.md) | Limits owner: defaults, ranges, `parse_runtime_limits`, truncation, exit codes |
| [paths.md](paths.md) | Fail-closed paths (`canonical_path`, `canonical_write_path`, lexical helpers) |
| [project-context.md](project-context.md) | Bounded project tree + README/AGENTS docs (`build_project_context`) |
| [sdk-config.md](sdk-config.md) | Vendor → key/URL mapping, token files, `CUSTOM_*` knobs |
| [chain-decision.md](chain-decision.md) | Chain confirm validator + Web chain-store boundary |
| [loop-feedback.md](loop-feedback.md) | Command-feedback wording (`format_*`, `parse_command_feedback`) |
| [browser.md](browser.md) | Browser-safe surface + `createLocalStorageAdapter` |
| [development.md](development.md) | Layout, build, lint, tests |

## Sources of truth

* Implementation: `packages/core/src/` (16 modules; see [development.md](development.md) for the layout)
* Package metadata: `packages/core/package.json`, `packages/core/tsup.config.ts`
* Behavior contracts: `test/test-core-package.js` (provenance gate), `test/test-core-api.js` (runtime contract), `test/test-core-*.js` (config/paths/context/decision/loop/runtime/risk/exec/limits/sdk-config)
* Related docs (not duplicated here): `../cli/` (CLI reference pages), `../sdk/` (SDK reference pages), `../usage.md` (user guide), `../web-sandbox.md` (web sandbox), `../core-provenance.md` (GPL→MIT signoff record), `../../packages/core/README.md` (quick reference + install), `../../packages/core/CHANGELOG_AI.md`

## Conventions used in these pages

* `loop.ts:<line>` refers to `packages/core/src/loop.ts`, `exec.ts:<line>` to `packages/core/src/exec.ts`, and so on.
* Line references are approximate — the exports themselves are authoritative.
* The core never invents a `PolicyDecision` and never reads credentials; ports and layers arrive injected by the host.
