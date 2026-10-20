# Changelog

## v0.1.1 — 2026-10-13

### Features
- Browser condition on the main entry (`task_042_core-browser-condition.md`): new `src/browser.ts` re-exports the pure surface only (loop-feedback, risk, chain-decision, runtime-limits, config, browser-runtime + erased port types), built to `dist/browser.js`/`.d.ts` and served as the FIRST `exports["."]` condition so Vite clients resolve it while Node keeps `import`/`require`. `runtime-api` values stay out (they import `@tell-ai/sdk`); the `./loop-feedback` subpath was removed in Phase 4 once nothing imported it (wording travels via the main entry + `browser` condition).
- `src/runtime-limits.ts` absorbs the last CLI-only pieces: `EXIT_SUCCESS`/`EXIT_MODEL_ERROR`/`EXIT_TIMEOUT`/`EXIT_LIMIT`, `StdinLimitError` and `runtime_env_from_process` (environment always explicit, no `process.env` default, so the owner never binds the host environment and the CLI `vm` sandboxes stay hermetic). `packages/cli/src/runtime-limits.ts` is deleted; `Tell.ts`/`tellrc.ts` import the owner directly.
- Single owners for every shared number, wording and policy (`task_039_core-migrations.md`, Fases 1-7): `src/loop-feedback.ts` owns the command-feedback wording (`format_executed_command`/`format_failed_command`/`format_command_result`/`format_command_skipped`/`format_command_feedback` + `parse_command_feedback`, pure, no `node:*`, the Web offline loop shares it through the `browser` condition of the main entry); `format_timeout_message` (`src/exec.ts`) owns the timeout wording (`Command timed out after Ns` + script, exit 124); chat-payload caps live in `src/runtime-limits.ts` (`PAYLOAD_MAX_*`); `canonical_path`/`canonical_write_path` reject a symlinked base and accept opt-in `create_parents` for missing parent chains; the project scan publishes its caps (`PROJECT_TREE_MAX_*`, `PROJECT_DOC_MAX_*`, `PROJECT_SKIP_DIRS`, `PROJECT_DOC_FILES`); `src/sdk-config.ts` owns the vendor → key/url table (`build_sdk_config_from_env` sync + `load_sdk_config_from_env` with token files, every vendor honoring its `*_BASE_URL`). The CLI and the Web both execute through `create_node_executor` now (process-group kill on timeout, live-validated with no orphans on both hosts).
- New `src/runtime-limits.ts`: single owner of every operational limit (defaults, the range table behind `parse_runtime_limits` with `flag > env > project tellrc > user tellrc > default`, `TELLRC_LIMIT_KEYS` + `validate_tellrc_limit_value` for the tellrc schema, `build_execution_options`, turn-atomic `truncate_context`, byte-aware `truncate_output`, `RuntimeLimitError` carrying `EXIT_CONFIG_ERROR`, and `runtime_env_from_process`). It moved out of `packages/cli/src` because the core is the only package both the CLI and the Web import, so it is the only place a shared number can have one owner. The CLI keeps a facade (`packages/cli/src/runtime-limits.ts`) that re-exports the contract and retains only the process-level pieces (`StdinLimitError`, `EXIT_SUCCESS`/`EXIT_MODEL_ERROR`/`EXIT_TIMEOUT`/`EXIT_LIMIT`).
- One number per quantity: `EXEC_DEFAULT_TIMEOUT_MS`, `EXEC_MAX_OUTPUT_BYTES`, `CORE_MAX_OUTPUT_BYTES`, `LOOP_MAX_ROUNDS` and the config timeout clamps are now aliases of `./runtime-limits` (same public names, same values — `120_000` and `32 Mi` no longer appear as literals anywhere else in the core), and the Web sandbox imports `DEFAULT_EXEC_TIMEOUT_MS`/`DEFAULT_MAX_BUFFER_BYTES`/`MIN`/`MAX_EXEC_TIMEOUT_MS` from the core. The sandbox keeps its own 8-round chain clamp on purpose (`chain-store.ts` stays dependency-light); the backend harness pins `CHAIN_MAX_ROUNDS === DEFAULT_MAX_CHAIN_STEPS`.
- Server-side Web chain contract: pure `validate_chain_decision_payload` (`src/chain-decision.ts`) gates every `/api/chain/:runId/confirm` transition — exactly one of `decisionId`/`approvalId`, non-negative integer `expectedVersion`, `decision: 'approve'|'skip'`; any `script`/`command`/`path`/extra field is rejected fail-closed before any store transition.
- Validation fixes (2026-10-09): `finishConfirm` preserves a mid-flight `cancelled` status (a cancel landing during execution never flips back to `running`).

### Refactors
- No `PolicyDecision` is fabricated while `task_00N_policy-sandbox.md` is BLOCKED: base risk returns `RiskAssessment` only; the future policy engine composes it and owns the verdict.

### Fixes
- `truncate_output` respects its **byte** budget: the cut is byte-aware (UTF-8, never a split character) and the result never exceeds `max_bytes` (the marker is cut too when the budget is too small for it). The old implementation measured bytes but sliced characters, so multi-byte output escaped the cap.
- `truncate_context` respects its **character** budget: the `[older context truncated]` marker and the closing tags it appends are part of the budget, so the result never exceeds `max_chars` (it used to return up to 26 characters more than the cap).
- The executor cuts the collected output by bytes (not characters) and keeps the output produced before a timeout instead of dropping it.
- The strict (Web) risk profile covers every interpreter eval form the permissive profile flags: `php -r`, `lua -e`, `deno eval` and `bun -e` join `python/node/perl/ruby` in the strict rule.
- The network-client and `printenv` rules only match a command that starts a shell segment, so `echo ssh`, `git commit -m "ssh support"` and `npm run env:prod` are no longer classified as dangerous; the strict `env` rule got the same treatment (`cat .env.example` is allowed again).
- `rm${IFS}-rf /` is classified as a recursive delete (the rule only accepted whitespace between `rm` and the flags).
- `canonical_path`/`canonical_write_path`/`is_path_inside_base` accept a legitimate name that starts with two dots (`..foo`): only a real `..` segment is an escape.
- A blank model in a higher layer no longer shadows the lower ones (`flag: { model: '   ' }` falls through to `env`/`project`/`user`).
- `parse_runtime_limits` survives a tellrc layer without a `limits` object (it used to throw a raw `TypeError`), rejects fractional values instead of flooring them (`0.5` used to silently disable the stdin deadline) and still validates an explicit `--stdin-timeout` when `--no-stdin-timeout` is also present.
- The chain-limit notice names the round cap in effect (`chain_limit_notice(max_rounds)`) instead of always reporting the default of 8.
- A command cancelled mid-run is reported as `cancelled` (status and timeline), not as a failed command.
- The project context no longer injects `AGENTS.md` twice (the README slot only accepts a real README).
- The browser entry works without Node globals: `truncate_output` uses `TextEncoder`/`TextDecoder` instead of `Buffer`, and `load_env_layer()` no longer touches `process` when there is none.
- `sanitize_exec_env` also drops `*_APIKEY` (e.g. `AZURE_OPENAI_APIKEY`), lowercase secret names and `*_URL` values carrying inline credentials; the redactor ignores secrets shorter than 4 characters (they used to shred the whole output).
- `create_core_runtime` accepts `max_output_bytes`, so the internal exec buffer cap (`--max-buffer` on the CLI) really reaches the executor.

### Tests
- New `test/test-fuzz-coverage.js` (`bun run test:fuzz`, in `test`/`ci`, 41 checks): seeded PRNG (mulberry32) driving `run_property`, with a delta-debugging shrinker — every failure reports the seed and the minimal input. Core invariants pinned: `truncate_output`/`truncate_context` stay inside their budgets, limit parsing never leaks a raw `TypeError`, risk classification is total and ordered per profile, path containment is fail-closed, the exec env scrub is total, a blank model falls through, and the browser entry runs without Node globals.

### Notes
- Requires `@tell-ai/sdk` 0.4.0 (`custom` vendor, wire resolution and the per-vendor `models`/`wires`/`headers` config slots); the `^0.3.0` floor in `cli`/`web`/`core` was raised accordingly.

## v0.1.0 — 2026-10-07

### Features
- Scaffold (`package.json` MIT, Node 22, ESM/CJS/d.ts, workspace dependency on the SDK/library contract) after the GPL→MIT signoff (`docs/core-provenance.md`).
- Base config (`src/config.ts`): host defaults (CLI `g`, Web `l`, never a global default), `flag > env > project .tellrc > user ~/.tellrc > default` precedence with deny-wins, `TELL_MODEL`-only env layer (no `TELL_KEY`/`TELL_BASE_URL` — tellkey handoff owns them).
- Fail-closed paths (`src/paths.ts`): realpath canonicalization for reads/writes; symlink, missing base, sibling prefix and external targets rejected.
- Project context (`src/project-context.ts`): bounded tree + README/AGENTS port of the Web builder, without the system prompt.
- Base risk (`src/risk.ts`): `assess_base_risk` + `create_base_risk_port` (`permissive` CLI / `strict` Web profiles), `RiskAssessment` only — no action verdicts.
- Node executor (`src/exec.ts`): explicit `/bin/bash`, real cwd, 120 s timeout (exit 124), 32 MB cap, process-group kill, structural `CancellationToken`, environment allowlist + secret redactor.
- Runtime + primitive loop (`src/runtime.ts`, `src/loop.ts`): `create_core_runtime` injects the resolved config into the SDK ports; the single ≤8-round loop with exit-code feedback, cancel and fail-closed stops. Contract types (`createTellRuntime`, `TellResult`, ports, callbacks) moved here from the SDK via `git mv`; the SDK is clean again.
- CLI adapters (`packages/cli/src/core-adapters.ts`, CLI-owned): permissive risk, scrubbed env, promisified-`exec` transport, approval port, host-`cli` config, streaming model port, seeded storage; `Tell.ts` delegates its response loop to `create_core_runtime().run()`.

### Tests
- `bun run test:core` (config, paths, project context, chain decision, runtime, risk, exec), `bun run test:core-api` (contract conformance), `bun run test:cli-adapters` (CLI ports), examples in `examples/core/`.
