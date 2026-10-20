# Development

## Layout

```
packages/cli/
  package.json       # name tell-ai 0.5.1, bin tell → dist/Tell.mjs, deps @tell-ai/sdk + commander
  tsup.config.ts     # entry src/Tell.ts → ESM .mjs, minified, #!/usr/bin/env node
  tsconfig.json      # extends ../../tsconfig.base.json, types [node], noEmit
  src/Tell.ts        # CLI (935 lines)
  src/mentions.ts    # @path mention expansion (356 lines)
  src/env.ts         # load_sdk_config (thin client of the core SDK-config owner)
  dist/Tell.mjs      # built artifact (chmod +x)
```

Root orchestration (`package.json`, bun workspaces `packages/*` — SDK, core, CLI, web):

```bash
npm run build          # SDK (ESM+CJS+dts+2 browser) + core (ESM+CJS+dts) + CLI (minified .mjs) + web (tsup server + vite assets)
npm run lint           # tsc --noEmit in SDK + core + CLI + web
npm run format         # biome check --write packages/
npm run check          # biome check packages/
npm run test:security  # build SDK + core, then node test/test-tell-security.js
npm run test:mentions  # build SDK + core, then node test/test-tell-mentions.js
npm run test:core      # core contract + config/paths/context/decision/runtime/risk/exec suites
npm run test:web       # web backend harness + web build, then packages/web suite (live servers boot dist/server.js)
npm run test           # test:sdk + test:core-api + test:env + test:runtime + test:tellrc + test:security + test:context + test:stream + test:mentions + test:cli-adapters + test:fuzz + test:core + test:web
npm run test:fuzz     # seeded fuzz/differential suite (41 checks, in test/ci)
npm run test:live-model # live validation with a real model (7 checks, opt-in, skips without OPENROUTER_API_KEY)
npm run ci             # build + lint + format check + test
```

> Web notes: `packages/web/src/server/server.ts` resolves models through `@tell-ai/sdk`
> (`MODELS`, `resolve_model_spec`, `get_model`) with keys/URLs injected from the
> environment — the SDK never reads `process.env` itself. `buildSystemPrompt`
> composes the project context (tree + README/AGENTS) with the SDK's
> `get_system_prompt({ chain: true })`, so the `<RUN>`/injection protocol has a
> single source of truth. The `auth`/`routes` suites spawn a real server via
> `tsx` and need its `node_modules` installed.
>
> Intentional divergences (test-pinned, do not "dedupe"): `isHighRiskScript`
> blocks all interpreter `-c`/`-e`, `env`, `base64 -d` and shell expansions
> (the CLI allows local one-liners by design); the frontend executes only the
> first `<RUN>` script by design (with an explicit warning about extras) while
> extraction itself delegates to the SDK `extract_runs` via
> `@tell-ai/sdk/browser` (the SDK resolves a block only when it owns a closing
> tag); `App.tsx` keeps a static fallback prompt and never imports the SDK Node
> entry (browser-safe subpath only).

Package script (`packages/cli/package.json:10-16`): `build: tsup && chmod +x dist/Tell.mjs`, `lint: tsc -p tsconfig.json`, `format/check: biome … src`, `ci: lint + check + build`. Formatting: Biome 2.2.6, single quotes, 2-space, 120 cols (`biome.json`).

## Build notes

`tsup.config.ts`: `entry: ['src/Tell.ts']`, `format: ['esm']`, `outExtension: .mjs`, `dts: false`, `minify: true`, banner shebang. Output is executable (`chmod +x`); `bin.tell` points at it. Strict TS comes from `tsconfig.base.json` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, …).

## Test harness

All CLI suites avoid network/LLM by transpiling the real `Tell.ts` (`typescript.transpileModule`, CJS/ES2020) and running it in a `vm` sandbox with:

* `@tell-ai/sdk`: real module spread, but `create_ask_ai` stubbed to replay canned responses while recording `{ message, options }`.
* `./env`: `load_sdk_config → { keys: {}, urls: {} }`.
* `./mentions`: the real `mentions.ts` compiled **into the same sandbox** (`vm.runInContext`), so it binds to the faked `process`/`stderr`/`cwd` per test.
* `./core-adapters`: the real module compiled into the same sandbox, but its `@tell-ai/core` import is a recording stand-in for `create_node_executor` (scripts/options recorded, canned result) — no command ever runs for real.
* `child_process.exec[promisify.custom]`: legacy recording hook (kept); execution now flows through the core-executor stand-in above.
* `os.homedir`: redirected into a temp dir; `process.cwd`: temp work dir; `argv/stdin/stdout/stderr/exitCode`: faked.

`test/test-tell-security.js` (426 lines): risky-script skips, injection policy, stdin shapes, `<RUN>`/`<think>` extraction, chain, context hygiene. `test/test-tell-context.js` (42 tests): `--ctx` grammar (`@N`, `%id`, ref + prompt text, bare-token error), use-or-create resume/create, `-n` reset + traversal rejection, `--history` (combined listing, `@N`/`%N` cat, search, exit codes), multi-word semantics, control-char-free context label echo, incremental-save non-duplication, poisoned-context safety. `test/test-tell-mentions.js` (22 tests): unit layer (file/dir/missing/binary/truncation/escape/punctuation/tree limits/`is_outside_cwd`/symlink/FIFO) + integration layer (model/log/context receive the expansion, outside-cwd denial, poisoned-file inertness, stdin + `--ctx` combo).

```bash
bun run test:security   # via root; builds SDK first (tag fns exercised for real)
bun run test:mentions   # mention expansion + read-gate security
bun run test:fuzz       # differential pins: risk port x core permissive, outside-cwd gate, alias own-property
bun run test            # all suites
```

## Touch points for contributors

* New flag: `CliOptions` + `build_program` + `build_context_plan`/`run_tell` wiring + `format_missing_prompt_error` if it affects required input; add cases to both suites.
* New high-risk shape: one `RiskRule` in `packages/core/src/risk.ts` (profile flags: common / `permissive_only` / `strict_only`) + one entry in `docs/cli/security.md` table + one `riskyScripts` line in the security suite. Keep local-only one-liners allowed unless they gain a network/decode token. Document the rule in [../core/risk.md](../core/risk.md).
* Context semantics: `ContextPlan` is the contract — update `docs/cli/context.md` alongside `resolve_context_ref`/`build_context_plan`.
* Mention semantics: `expand_mentions` + `is_outside_cwd` are the contract — update `docs/cli/mentions.md` alongside `src/mentions.ts`, and add cases to `test/test-tell-mentions.js`.
* Model/alias changes live in the SDK (`packages/sdk/src/models.ts`); the CLI only calls `resolve_model_spec`/`model_label`. Never read `process.env` from the SDK.

Sources: `package.json`, `packages/cli/package.json`, `packages/cli/tsup.config.ts`, `packages/cli/tsconfig.json`, `test/test-tell-security.js:1-120`, `test/test-tell-context.js:1-75`.
