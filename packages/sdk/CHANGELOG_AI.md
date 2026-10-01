# Changelog

## v0.3.0 — 2026-10-01

### Features
- Add `AskInstance.ask_stream(input, { system })` — a streaming completion that yields `AskStreamEvent`s in emission order: `reasoning` (deltas), `reasoning_end`, then `text` (deltas). Backed by `streamText()` (`ai` SDK) using the same resolved model handle and reasoning budget as `ask()`.
- `ask_stream` accepts a one-shot prompt (`string`) or a full multi-turn conversation (`Array<{ role, content }>`) and returns a lazy `AsyncIterable` — constructing it never starts a request; the provider call only runs on first `next()`.
- Provider `error` parts are re-thrown so consumers keep the same error handling as `ask()`.
- Export `AskStreamEvent` and `AskStreamInput` types from both the main (`index.ts`) and browser (`browser.ts`) entry points.
- Export `sanitize_reasoning` from the main, browser, and global entry points; it neutralizes angle brackets so model reasoning cannot forge reserved `<think>`/`<RUN>` boundaries.
- Consume `streamText()` via `result.stream` (`fullStream` is a deprecated alias of the same type).
- `ModelHandle` gains optional `providerOptions`, forwarded as `providerOptions` by `ask`/`ask_stream` (and by `/api/tell` in `@tell-ai/web`).
- Reasoning matrix (`resolve_reasoning` in `models.ts`): the `AI_SDK_THINKING` table is passthrough, except `max`, which the generic reasoning→effort map lacks — `anthropic`/`deepseek`/`moonshotai` send it explicitly (`effort`/`reasoningEffort: 'max'`, explicit options take precedence, no warning), `xai` sends `xhigh` and `google` sends `high` (their enum tops). Fast mode always resolves to `none` with no explicit options.
- Vendors without a dedicated handler fall back to the generic OpenAI-compatible provider, so future vendors only need a `SUPPORTED_VENDORS` entry plus a URL to work.
- All provider caches are keyed by effective base URL and injected credential, so different endpoints or API keys in one process never share a stale provider.
- New direct `meta` vendor (Llama API at `https://api.meta.ai/v1`): `handle_meta` calls `@ai-sdk/openai`'s `.responses(model)`, so requests hit `/v1/responses` with `Authorization: Bearer` instead of going through OpenRouter. `resolve_reasoning` adds `providerOptions.openai.forceReasoning: true` for it, without which the provider treats an unknown model id as non-reasoning and silently drops the effort.
- New direct `xiaomi` vendor (MiMo at `https://api.xiaomimimo.com/v1`): `handle_xiaomi` uses `@ai-sdk/openai-compatible` (Chat Completions) and sends the key in the `api-key` header — `COMPAT_API_KEY_HEADERS`-style `key_header` handling never sets `apiKey` on the provider, so no `Authorization: Bearer` is added.
- `SDKKeys`/`SDKUrls` gain `meta` and `xiaomi` slots; both vendors honor `urls.<vendor>` overrides like every other handler.
- One wire path for all four OpenAI-wire vendors (`alibaba`, `zai`, `xiaomi`, `meta`): a single `OPENAI_WIRE_VENDORS` table (`api: 'chat' | 'responses'`, `default_url`, `url_key`, `key_header?`, `force_reasoning?`) drives `get_openai_wire_factory`, which caches a model factory per `vendor::api::base_url::credential` and is shared by four thin handlers plus the no-handler fallback. Adding a vendor is one table row.
- `MODELS` grows to 142 aliases: `g` → `openai:gpt-6.1-sol`, `p` → `openai:gpt-6.1-sol-pro`, `r` → `openai:gpt-6-astra-pro`, `at*` → `alibaba:qwen3.8-27b`, `s` → `anthropic:claude-sonnet-5-5`, and `i` → `google:gemini-3.1-pro`. The three pro/27B ids are confirmed on OpenRouter.
- New alias: `h` (Claude Haiku 4.5).
- Moonshot K3 now sends `low`, `high` and `max` through `providerOptions.moonshotai.reasoningEffort`; the invalid `medium` tier is not exposed.
- `infer_vendor` gains `muse` → `meta` and `mimo` → `xiaomi`; the `/` rule runs before those prefixes (after the `alibaba/` exception) so raw OpenRouter ids like `meta/muse-spark-1.3` or `mimo/mimo-v2.6-pro` keep routing to OpenRouter.
- New runnable example `examples/sdk/custom-endpoint.ts`: any `urls.<vendor>` pointed at a custom OpenAI-compatible endpoint (localhost mock, runs offline with no keys), an optional Ollama scenario (`OLLAMA_MODEL=...`), and CLI equivalents — plus how to add a brand-new vendor (a `SUPPORTED_VENDORS` entry plus a URL, no handler needed thanks to the fallback).

### Security
- Provider caches are credential-aware: two `SDKConfig` instances using the same vendor and base URL no longer reuse the first API key. Cache tokens never contain the raw credential in the provider cache key.
- Every dedicated provider receives an explicit injected API key and default/injected base URL. Node/Bun usage no longer falls back to ambient `*_API_KEY`/`*_BASE_URL` values, so a custom endpoint cannot silently receive a credential from the host environment.
- Model reasoning is sanitized before it is wrapped into a response or emitted as a streaming event, preventing reasoning text from injecting a closing `</think>` or a forged `<RUN>` block into the executable response boundary.
- `tell()` now honors its documented no-exec default when `options.exec` is omitted.

### Fixes
- Suppress raw provider error logging and sanitize error messages before logging or emitting to clients.
- `extract_runs` returns at most the first `<RUN>` block, matching the one-command contract in the system prompt; all `<RUN>` blocks are still removed from visible text.
- `strip_think_tags` and `strip_run_tags` are case-insensitive, consistent with `extract_runs`.
- The browser ESM and global IIFE entries export the same `sanitize_reasoning` API as the Node entry points.

### Refactors
- Remove the Fireworks AI provider (replaced by Alibaba Qwen and Z.ai GLM) and update the DeepSeek model aliases.
- Rework provider dispatch around the shared `OPENAI_WIRE_VENDORS` table: one cached factory per `vendor::api::base_url::credential` backs the four dedicated OpenAI-wire handlers and the no-handler fallback, with per-vendor reasoning overrides resolved in `resolve_reasoning`.

### Tests
- Extend `test/test-sdk.js` (wired as `test:sdk`): `create_ask_ai` builds offline, both `ask`/`ask_stream` are functions, `ask_stream` returns a lazily-constructed async iterable for single-prompt and multi-turn inputs.
- Same suite now covers offline `get_model` for compat/native vendors, the full reasoning matrix (`d+`/`s++`→`max`, `l++`→`high`, `x++`→`xhigh`), explicit `providerOptions` (incl. fast mode carrying none), per-vendor+URL cache routing against two localhost mocks, and wire assertions (`output_config.effort=max` for Anthropic, `reasoning_effort=max` for DeepSeek/MoonshotAI) with zero reasoning warnings via `process.on('warning')`.
- Meta/Xiaomi coverage: the new aliases and tier ladders, raw slash ids still resolving to `openrouter`, `forceReasoning` present for `m`/`mc` (and absent for fast mode), and localhost wire tests pinning Meta to `POST /v1/responses` with a bearer key and `reasoning.effort`, Xiaomi to `POST /v1/chat/completions` with `api-key` and **no** `Authorization`. `MODELS` size is pinned at 142.
- Credential isolation regressions send two keys to the same localhost URL and assert each request uses its own bearer; a separate test proves `DEEPSEEK_API_KEY` and `OPENAI_BASE_URL` in the host environment are not adopted when `SDKConfig` omits them.
- Catalog regressions pin the corrected IDs, legacy remaps, 142-entry count and Moonshot effort options for `K-`, `K` and `K+`.
- Pin the Xiaomi missing-key vs literal `tell-sdk-missing-api-key` cache distinction, browser/global `sanitize_reasoning` exports, the default no-exec prompt from `tell()`, reasoning tag neutralization, case-insensitive tag stripping, and the one-command `extract_runs` contract.

### Documentation
- Sync `docs/sdk/` with the new surface: `ask_stream` and the `AskStreamEvent`/`AskStreamInput` types in `streaming.md` and `api.md`, `sanitize_reasoning` plus the `meta`/`xiaomi` vendors in `api.md`/`models.md`, and the credential-aware caches and explicit key/URL injection rules in `config.md`.
- Add the custom-endpoint walkthrough under `examples/sdk/` (localhost mock, Ollama, registering a new vendor) and fix stale paths in the existing examples.

---

## v0.2.2 — 2026-09-08

### Features
- Export `get_model` and the `ModelHandle` type so Node consumers (e.g. the web server) can resolve a vendor provider handle for multi-turn `generateText()` calls without going through `create_ask_ai()`
- Add new model shortcut tiers (e.g., `e`, `r`, `al`, `af`, `zf`, `m`) and update provider model versions
- Add support for the Cerebras vendor and dedicated handler

### Fixes
- Tighten OpenAI vendor detection and improve base URL handling defaults
- Resolve `:fast` model aliases correctly in model spec parsing and unify reasoning configuration

### Tests
- Add comprehensive test suite covering web backend functionality, chat threads, session management, terminal layout, PTY, HTTP routes, and server guards
- Add dedicated `test/test-sdk.js` suite (wired as `test:sdk`, first in `npm test`): public export surface, `resolve_model_spec` aliases/fast/thinking budgets, `MODELS` table round-trip invariant, offline `get_model` handles (incl. vast/local URL errors), exec/no-exec system prompts and tag helpers
---

## v0.2.1 — 2026-08-15

### Features
- Overhaul CLI context management to use explicit flags and namespaces with strict validation
- Add Z.ai model provider and GLM-5.3 support
- Update model mappings and version tiers across Gemini, Google, X.ai, and DeepSeek
- Introduce browser-safe bundles, Node module shims, and global IIFE build support
- Add custom base URLs per model vendor and introduce the `tell` programmatic assistant function

### Refactors
- Extract system prompt generation to SDK and support alternative execution variants
- Migrate CLI package output from CommonJS to ESM modules and enhance package metadata
- Modularize ask functionality and update package exports

### Documentation
- Structure project README and add dedicated package README files for the CLI and SDK

### Chores
- Update project license to MIT and synchronize workspace package versions and documentation references

---

## 0.2.0 — 2026-08-11

### Features
- Browser bundles are now truly self-contained and browser-loadable: `dist/browser.js` (ESM, `@tell-ai/sdk/browser`) and `dist/browser-global.global.js` (IIFE, `@tell-ai/sdk/browser-global`, assigns `globalThis.TellSDK`, listed in `sideEffects`, also the `unpkg`/`jsdelivr` targets).
- `tsup.config.ts` now lists `ai` and every `@ai-sdk/*` provider in `noExternal` explicitly — a `'@ai-sdk/*'` glob does not match scoped packages and previously produced bundles with bare imports that browsers cannot resolve.
- Node builtins (`path`, `fs`, `os`) pulled in by `@vercel/oidc` (transitive dependency of `ai`) are aliased at build time to `src/shims/node.cjs`, and a `var process = { version:'', env:{}, platform:'browser' }` banner covers its module-scope user-agent construction. The OIDC token helpers are never exercised in the browser, but they used to crash bundle initialization (`Dynamic require of "path"`).
- Added `examples/web/` demo (served by the Bun `proxy.ts`): a no-build page using the IIFE `TellSDK` build, Google auth via the `x-goog-api-key` header (replacing `Authorization: Bearer`), server-side key injection with a `proxy` placeholder, and a `demo.ts` end-to-end walkthrough.
- License changed from GPL-3.0 to MIT.

### Documentation
- New `docs/sdk/imports.md` comparing the three build variants (Node ESM/CJS, browser ESM, browser global IIFE) with loading and tree-shaking guidance.

---

## 0.1.1 — 2026-08-07

### Features
- New `tell(message, options)` function — `tell --no-exec` as a library call. Builds the tell system prompt (execution disabled by default), calls `create_ask_ai`, and returns the final answer with ` thinking`/`<RUN>` tags stripped. Supports injected `keys`/`urls` (browser-safe, no environment reads), optional `context` prefix, custom `system` override, `ask` (reuse an existing `AskInstance`) and `raw` (skip tag stripping) options.
- The tell system prompt moved into the SDK (`get_system_prompt` with `PromptOptions { chain?, exec?, cwd?, platform? }`), shared by the CLI and web. `exec: false` produces a no-execution variant that forbids `<RUN>` and instructs the model to answer in plain text.
- `create_ask_ai`/`AskInstance` moved to `src/ask.ts` (re-exported from the SDK index) to avoid circular imports.
- All provider handlers now honor `SDKConfig.urls` per vendor (openai, anthropic, google, xai, deepseek, fireworks, cerebras, moonshotai) via `baseURL`, enabling CORS proxies for browser use.
- New browser bundle `dist/browser.js` (`@tell-ai/sdk/browser` export): self-contained ESM that bundles `ai` + all providers, importable directly in the browser without a build step.
- Added `examples/web/` — a no-build demo page (`index.html`) using `tell()` with per-vendor keys stored in localStorage, and an optional Bun CORS proxy (`proxy.ts`) that forwards `/vendor/*` to provider APIs and injects keys from env.

---

## 0.1.0 — 2026-08-05

### Features
- Initial release: `@tell-ai/sdk`, a browser-safe AI provider layer born from the tell-ai monorepo split (same parent release as tell-ai v0.5.0).
- All environment concerns are received via an injected `SDKConfig` (`keys`/`urls`, both partial); zero `node:*` imports and zero `process.env` reads, so it runs in browsers, Node, and Bun without changes.
- `MODELS`, `resolve_model_spec`, provider dispatch, `<RUN>`/` thinking`/markdown tag functions, and `summarize_context` moved in from the CLI, exported from `packages/sdk/src/index.ts`.
- The SDK type-checks without `@types/node` to enforce browser safety.
