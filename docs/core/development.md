# Development

## Layout

```
packages/core/
  package.json       # name @tell-ai/core 0.1.1, MIT, Node >=22, dep @tell-ai/sdk
  tsup.config.ts     # entry src/index.ts (+ browser.ts) → ESM+CJS+dts
  tsconfig.json      # extends ../../tsconfig.base.json, noEmit
  src/index.ts            # public exports (everything below, re-exported)
  src/runtime-api.ts      # injectable contract + createTellRuntime (single-turn wiring)
  src/loop.ts             # run_primitive_loop (≤8 rounds, fail-closed iteration)
  src/runtime.ts          # create_core_runtime (config → ports → loop)
  src/exec.ts             # create_node_executor (/bin/bash, group kill, scrubbed env)
  src/risk.ts             # assess_base_risk + create_base_risk_port
  src/config.ts           # HOST_DEFAULT_MODEL, resolve_core_config, load_env_layer
  src/custom-system.ts    # compose_custom_system preamble
  src/runtime-limits.ts   # limits owner (defaults, ranges, parse, truncate)
  src/paths.ts            # canonical_path / canonical_write_path + lexical helpers
  src/project-context.ts  # build_project_context (tree + root docs)
  src/sdk-config.ts       # build/load_sdk_config_from_env (vendor mapping)
  src/chain-decision.ts   # validate_chain_decision_payload (pure)
  src/loop-feedback.ts    # feedback wording + parser (pure, browser-safe)
  src/browser-runtime.ts  # createLocalStorageAdapter (injected StorageLike)
  src/browser.ts          # browser-safe surface (browser condition of main entry)
```

Root orchestration (`package.json`, bun workspaces `packages/*` — SDK, core, CLI, web):

```bash
npm run build          # SDK + core + CLI + web
npm run lint           # tsc --noEmit in SDK + core + CLI + web
npm run format         # biome check --write packages/
npm run check          # biome check packages/
npm run test:core      # contract + config/paths/context/decision/runtime/risk/exec suites
npm run test:core-api  # library-contract conformance
npm run test           # sdk + core-api + env + runtime + tellrc + security + context + stream + mentions + cli-adapters + fuzz + core + web
npm run test:fuzz      # seeded fuzz/differential suite (41 checks, in test/ci)
npm run test:live-model # live validation with a real model (7 checks, opt-in, skips without OPENROUTER_API_KEY)
npm run ci             # build + lint + check + test
```

Package script (`packages/core/package.json:43-49`): `build: tsup`, `lint: tsc -p tsconfig.json`, `format/check: biome … src`, `ci: lint + check + build`. Formatting: Biome 2.2.6, single quotes, 2-space, 120 cols (`biome.json`).

## Test harness

Core suites run offline (mocked `ModelPort`, recording stand-ins, temp dirs) — no provider, network or real execution:

* `test/test-core-package.js` — provenance/phase gate (GPL→MIT signoff present, no `TELL_KEY`/`TELL_BASE_URL`, browser entry free of builtin imports). Fails closed: any `BLOCKED:` line keeps the core task blocked.
* `test/test-core-api.js` — library-contract conformance (defaults, execution, approval, cancellation, order, idempotence, adapters, `tell()` compat).
* `test/test-core-*.js` — one file per module: `config`, `paths`, `project-context`, `chain-decision`, `loop-feedback`, `runtime`, `risk`, `exec`, `limits`, `sdk-config`.
* Consumers pin the seam, not the internals: `test/test-cli-core-adapters.js` (CLI defaults/overrides through a recording executor), `test/test-tell-runtime-limits.js` (wiring), `test/test-tell-env.js` (env → `SDKConfig`).
* `test/test-fuzz-coverage.js` (`bun run test:fuzz`, 41 checks, in `test`/`ci`): seeded fuzz with a deterministic seed (mulberry32) + `run_property` + delta-debugging shrink — every failure reports the seed and the minimal input. Covers pure SDK surfaces (`resolve_model_spec`, tags, `list_custom_models`) and core surfaces (truncation, limits, risk, paths, env scrub) plus cross-package differential comparison (CLI x core, Web x core).
* `test/test-live-model.js` (`bun run test:live-model`, 7 checks, opt-in): live validation with a real model (`openrouter:minimax/minimax-m3.1-flash:free`); self-skips without `OPENROUTER_API_KEY`.

```bash
bun run test:core       # builds SDK + core first, then the contract + module suites
bun run test:core-api   # builds SDK + core first, then the conformance suite
bun run test:fuzz       # builds SDK + core first, then the fuzz/differential suite
bun run test:live-model # builds SDK first, then the live checks (needs OPENROUTER_API_KEY)
bun run build:core-examples && bun run test:core-examples
```

## Touch points for contributors

* New port: add the type to `runtime-api.ts`, thread it through `loop.ts`/`runtime.ts` input, document it in [runtime-api.md](runtime-api.md), and cover it in `test/test-core-api.js`.
* New limit: extend the `LIMIT_SPECS` table in `runtime-limits.ts` (defaults, ranges and `TELLRC_LIMIT_KEYS` derive from it) — never a second table. Document in [runtime-limits.md](runtime-limits.md).
* New risk rule: add one `RiskRule` entry with profile flags (`permissive_only`/`strict_only`/common). Document in [risk.md](risk.md) and the CLI [security](../cli/security.md) table when it affects confirmation UX.
* New browser-safe module: re-export it from `browser.ts` and keep it free of builtin imports — the package gate checks.
* Model/alias changes live in the SDK (`packages/sdk/src/models.ts`); the core only consumes specs. Never read `process.env` or credentials from a new module — the environment always arrives as a parameter.

Sources: `package.json`, `packages/core/package.json`, `packages/core/tsup.config.ts`, `packages/core/tsconfig.json`, `test/test-core-package.js`.
