# Development

## Layout

```
packages/cli/
  package.json       # name tell-ai 0.5.1, bin tell → dist/Tell.mjs, deps @tell-ai/sdk + commander
  tsup.config.ts     # entry src/Tell.ts → ESM .mjs, minified, #!/usr/bin/env node
  tsconfig.json      # extends ../../tsconfig.base.json, types [node], noEmit
  src/Tell.ts        # CLI (935 lines)
  src/mentions.ts    # @path mention expansion (356 lines)
  src/env.ts         # load_sdk_config (Node-only)
  src/systemPrompt.ts# get_system_prompt wrapper (cwd + platform)
  dist/Tell.mjs      # built artifact (chmod +x)
```

Root orchestration (`package.json`, bun workspaces `packages/*` — SDK, CLI, web):

```bash
npm run build          # SDK (ESM+CJS+dts+2 browser) + CLI (minified .mjs) + web (tsup server + vite assets)
npm run lint           # tsc --noEmit in SDK + CLI + web
npm run format         # biome check --write packages/
npm run check          # biome check packages/
npm run test:security  # build SDK, then node test/test-tell-security.js
npm run test:mentions  # build SDK, then node test/test-tell-mentions.js
npm run test:web       # web backend harness + web build, then packages/web suite (live servers boot dist/server.js)
npm run test           # test:sdk + test:security + test:context + test:stream + test:mentions + test:web
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
> (the CLI allows local one-liners by design); the frontend `extractRunScripts`
> matches `<RUN>` case-insensitively (SDK `extract_runs` is case-sensitive);
> `App.tsx` keeps a static fallback prompt so the frontend stays SDK-free.

Package script (`packages/cli/package.json:10-16`): `build: tsup && chmod +x dist/Tell.mjs`, `lint: tsc -p tsconfig.json`, `format/check: biome … src`, `ci: lint + check + build`. Formatting: Biome 2.2.6, single quotes, 2-space, 120 cols (`biome.json`).

## Build notes

`tsup.config.ts`: `entry: ['src/Tell.ts']`, `format: ['esm']`, `outExtension: .mjs`, `dts: false`, `minify: true`, banner shebang. Output is executable (`chmod +x`); `bin.tell` points at it. Strict TS comes from `tsconfig.base.json` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, …).

## Test harness

All CLI suites avoid network/LLM by transpiling the real `Tell.ts` (`typescript.transpileModule`, CJS/ES2020) and running it in a `vm` sandbox with:

* `@tell-ai/sdk`: real module spread, but `create_ask_ai` stubbed to replay canned responses while recording `{ message, options }`.
* `./env`: `load_sdk_config → { keys: {}, urls: {} }`.
* `./systemPrompt`: delegates to the real SDK `get_system_prompt`.
* `./mentions`: the real `mentions.ts` compiled **into the same sandbox** (`vm.runInContext`), so it binds to the faked `process`/`stderr`/`cwd` per test.
* `child_process.exec[promisify.custom]`: records scripts, returns canned stdout/stderr.
* `os.homedir`: redirected into a temp dir; `process.cwd`: temp work dir; `argv/stdin/stdout/stderr/exitCode`: faked.

`test/test-tell-security.js` (426 lines): risky-script skips, injection policy, stdin shapes, `<RUN>`/`<think>` extraction, chain, context hygiene. `test/test-tell-context.js` (599 lines, 22 tests): addressing (`@N`, `#hash`, names), `-n` reset + traversal rejection, `-l`, multi-word semantics, incremental-save non-duplication, poisoned-context safety. `test/test-tell-mentions.js` (22 tests): unit layer (file/dir/missing/binary/truncation/escape/punctuation/tree limits/`is_outside_cwd`/symlink/FIFO) + integration layer (model/log/context receive the expansion, outside-cwd denial, poisoned-file inertness, stdin + `--ctx` combo).

```bash
bun run test:security   # via root; builds SDK first (tag fns exercised for real)
bun run test:mentions   # mention expansion + read-gate security
bun run test            # all suites
```

## Touch points for contributors

* New flag: `CliOptions` + `build_program` + `build_context_plan`/`run_tell` wiring + `format_missing_prompt_error` if it affects required input; add cases to both suites.
* New high-risk shape: one regex in `is_high_risk_script` + one entry in `docs/cli/security.md` table + one `riskyScripts` line in the security suite. Keep local-only one-liners allowed unless they gain a network/decode token.
* Context semantics: `ContextPlan` is the contract — update `docs/cli/context.md` alongside `resolve_or_create_context_ref`/`build_context_plan`.
* Mention semantics: `expand_mentions` + `is_outside_cwd` are the contract — update `docs/cli/mentions.md` alongside `src/mentions.ts`, and add cases to `test/test-tell-mentions.js`.
* Model/alias changes live in the SDK (`packages/sdk/src/models.ts`); the CLI only calls `resolve_model_spec`/`model_label`. Never read `process.env` from the SDK.

Sources: `package.json`, `packages/cli/package.json`, `packages/cli/tsup.config.ts`, `packages/cli/tsconfig.json`, `test/test-tell-security.js:1-120`, `test/test-tell-context.js:1-75`.
