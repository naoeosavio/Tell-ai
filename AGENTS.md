# AGENTS.md

This file provides guidance to AI when working with code in this repository.

## Repository expectations

- Use `bun` as the package manager (not npm/pnpm/yarn for installing dependencies).
- Formatting and linting are handled by Biome v2.2.6 (config in `biome.json`): single quotes, 2-space indent, 120-char line width.
- Monorepo workspace (bun): `packages/sdk` (`@tell-ai/sdk`, browser-safe LIB), `packages/cli` (`tell-ai`, bin `tell`) and `packages/web` (`@tell-ai/web`, bin `tell-web`).

## Build / test / lint / format

All commands run from the root and delegate to the packages:

```bash
npm run build          # SDK (ESM+CJS+dts + 2 browser bundles) + tell-ai (minified .mjs) + web sandbox (tsup server + vite assets → packages/web/dist/)
npm run lint           # tsc --noEmit in all three packages (type-check only)
npm run format         # biome check --write packages/  (auto-fix formatting)
npm run check          # biome check packages/  (check only)
npm test               # sdk + security + context + stream + mentions + web suites
npm run test:security  # build the SDK, then node test/test-tell-security.js
npm run test:stream    # build the SDK, then node test/test-tell-stream.js (--stream/--think CLI behavior)
npm run test:mentions  # build the SDK, then node test/test-tell-mentions.js (@path mention expansion + read gate)
npm run test:web       # backend harness + web build, then sandbox suite (live servers boot dist/server.js)
npm run ci             # build + lint + format check + test (runs in order)
```

TypeScript is checked with `tsc` but bundled with `tsup` (ESBuild). Entry points: `packages/sdk/src/index.ts` → `packages/sdk/dist/` and `packages/cli/src/Tell.ts` → `packages/cli/dist/Tell.js`. The SDK build also emits two browser bundles from `src/browser.ts` + `src/browser-global.ts`. After building, sanity-check them with `grep -cE '^import ' packages/sdk/dist/browser*.js` — must be `0` (self-contained; bare imports/dynamic `require` break the browser).

## Architecture

`tell-ai` is a one-shot terminal assistant — a CLI that sends a prompt to an LLM and optionally executes bash commands the model returns inside `<RUN>...</RUN>` tags. It supports 10+ AI vendors through short model aliases, persistent conversation context, and a chain mode for iterative command sequences.

The codebase has four layers:

### Monorepo root (bun workspace)

- `package.json` — private, `"workspaces": ["packages/*"]`, orchestration scripts via `bun run --filter @tell-ai/sdk …` / `--filter tell-ai` / `--filter @tell-ai/web`.
- `tsconfig.base.json` — strict shared TS config (noUncheckedIndexedAccess, exactOptionalPropertyTypes, erasableSyntaxOnly…), extended by all three packages.

### LIB: `packages/sdk` (`@tell-ai/sdk` — ~900 lines)

Browser-safe AI provider layer: **zero `node:*` imports, zero `process.env` reads**. All environment concerns are injected via `SDKConfig` (`{ keys, urls }`, both partial). Built by tsup to ESM + CJS + `.d.ts`/`.d.cts`.

Key exports from `packages/sdk/src/index.ts`:
- **`MODELS`** — Record of 147 short aliases (e.g., `g` → `openai:gpt-6-sol:medium`)
- **`resolve_model_spec(model)`** — Parses `vendor:model:thinking` specs, handles dot-prefix fast mode
- **`get_model(spec, config)`** — Returns a `ModelHandle` (`{ model, reasoning, fast}`) backed by the vendor provider; used by `create_ask_ai()` and directly by the web server for multi-turn `generateText()` calls
- **`create_ask_ai(spec, config)`** — Returns an `AskInstance` with an `ask()` method (one-shot, `generateText()`) and an `ask_stream()` method (token-by-token, `streamText()`). Streaming yields `AskStreamEvent`s (`reasoning`/`reasoning_end`/`text`) as a **lazy** `AsyncIterable`; input is a prompt string or a multi-turn message array (`AskStreamInput`)
- **`tell(message, options)`** — `tell --no-exec` as a function: builds the system prompt (execution disabled by default), calls the model, returns the answer with `<think>`/`<RUN>` stripped. `TellOptions`: `model?`, `keys?`, `urls?`, `exec?`, `cwd?`, `platform?`, `context?`, `system?`, `ask?` (reuse an existing `AskInstance`), `raw?` (skip stripping, used by the CLI's `tell_silently`)
- **`get_system_prompt(options)`** — Shared tell system prompt with `PromptOptions { chain?, exec?, cwd?, platform? }`; `exec: false` emits the no-command-execution variant used by `tell()` in the browser
- **`extract_runs`, `strip_run_tags`, `strip_think_tags`, `strip_markdown_code_blocks`** — `<RUN>`/`<think>`/markdown handling
- **`summarize_context(ai, text)`** — AI-driven conversation history compression

Files:
- `src/index.ts` — public exports
- `src/browser.ts` — browser ESM entry (re-exports the browser-safe API)
- `src/browser-global.ts` — IIFE entry: assigns `globalThis.TellSDK`
- `src/shims/node.cjs` — CJS stubs for `path`/`fs`/`os` aliased into the browser bundles (see below)
- `src/ask.ts` — `create_ask_ai()` factory, `AskInstance` (`ask` + `ask_stream`), `AskStreamEvent`/`AskStreamInput` types
- `src/models.ts` — `MODELS` table, alias resolution, provider instances, injected key/url lookup (all providers honor `config.urls` via `baseURL`)
- `src/config.ts` — `SDKConfig`/`SDKKeys`/`SDKUrls` types (partial, injected)
- `src/systemPrompt.ts` — shared exec/no-exec system prompt (`get_system_prompt()`), `PromptOptions`
- `src/tell.ts` — `tell()` one-shot no-exec function
- `src/tags.ts` — pure `<RUN>`/` thinking`/code-block strip & extract functions
- `src/summarize.ts` — `summarize_context`

Builds: tsup emits ESM + CJS + dts (`dist/`) plus two self-contained browser bundles: `dist/browser.js` (ESM, exported as `@tell-ai/sdk/browser`) and `dist/browser-global.global.js` (IIFE, `@tell-ai/sdk/browser-global`, defines `globalThis.TellSDK`, listed in `sideEffects`; also the `unpkg`/`jsdelivr` targets).

To keep the browser bundles self-contained, `tsup.config.ts` lists `ai` + the eight `@ai-sdk/*` providers (`openai`, `anthropic`, `google`, `xai`, `deepseek`, `cerebras`, `moonshotai`, `openai-compatible`) in `noExternal` **explicitly** — a `'@ai-sdk/*'` glob does not match scoped packages and silently leaves bare imports. `@vercel/oidc` (a transitive dep of `ai`) requires `path`/`fs`/`os` and touches `process` at module scope, so those builtins are aliased to `src/shims/node.cjs` and a `var process = { version:'', env:{}, platform:'browser' }` banner is prepended. Full variant comparison: `docs/sdk/imports.md`.

### CLI: `packages/cli` (`tell-ai` — ~930 lines + `mentions.ts`)

Single-file Node entry point for the `tell` binary (CJS bundle, `#!/usr/bin/env node`). Uses `commander` for CLI parsing. Key behaviors:
- Reads piped stdin (30s timeout, `-i` flag)
- Expands `@path` mentions in the prompt (`src/mentions.ts`): files inline as `File:` blocks (64 KB cap), directories as 3-level trees; missing/binary targets warn and pass through; outside-cwd reads need confirmation even with `-y`
- Extracts `<RUN>...</RUN>` tags from AI responses and prompts before executing commands
- `--stream` prints the answer token by token as generated (each `--chain` round streams too; the full response is still accumulated, so log/context/`<RUN>` extraction stay identical to the non-stream path)
- `--think` prints the model reasoning dimmed on stderr, with or without `--stream` (without streaming, it appears once the response arrives); reasoning never reaches stdout or the saved context
- `--chain` iterates up to 8 steps, feeding command outputs back to the model
- `-c` persists the default per-directory+model context (SHA-256 hash, `~/.ai/tell_context/`)
- `--ctx [ref]` context ref + prompt: the first word is the ref when it is `@N` (recency, must exist) or `%id` (use-or-create over the id/file-name namespace — exact id or unique hex prefix resumes, else creates `<id>.txt`); the rest is prompt text for that context. No ref = prompt text for the default context (`-c` synonym, unnamed contexts never saved as `%id`). A bare single token is prompt text when no positional prompt follows, but a bare single token WITH a positional prompt is an error (naming requires `%`); multi-word text is always default-context prompt
- `-n` reset modifier: `--ctx %id -n` starts empty, even if the id exists
- `-l` lists saved contexts (`@N`, id, age, preview) and conversations (`%N`, date, model, preview) via `--history`; `--history @N`/`%N` reprints an entry, any other value searches both stores (`src/history.ts`)
- `-y` auto-executes commands (high-risk commands still require confirmation)
- `--no-exec` disables all command execution

**Security**: `isHighRiskScript()` blocks patterns like `sudo`, `rm -rf`, `dd of=`, `curl|sh` (and pipes into any interpreter: `python3`, `node`, …), process substitution (`bash <(curl …)`, `x <(wget …)`), network-coupled interpreter one-liners (`node -e "require('https')…"`, `python3 -c "…urllib…"`), `mkfs`, writes to system paths (`/etc`, `/boot`, `/usr`, systemd units), crontab manipulation, etc. Local-only interpreter one-liners (e.g. `node -e "console.log(1)"`) are allowed by design. Execution timeout is 120s.

Files:
- `src/Tell.ts` — CLI: commander, stdin, exec, confirm/high-risk, context/logs, loop chain, main
- `src/mentions.ts` — `expand_mentions()` + `is_outside_cwd()` read gate, called in `run_tell()` before context/log assembly
- `src/history.ts` — read-only history module: `list_sessions()`, `search_contexts()`/`search_sessions()`, `print_history_list()`, `show_entry()` (backs `-l/--history`)
- `src/systemPrompt.ts` — the `<RUN>`/injection-policy execution system prompt (`get_system_prompt()`), with `PromptOptions`
- `src/env.ts` — Node-only: reads `process.env` + `~/.config/<vendor>.token` files, assembles the `SDKConfig` passed to `create_ask_ai()`

### WEB: `packages/web` (`@tell-ai/web` — browser sandbox + `tell-web` server)

Browser-based terminal + AI console (`tell-web` bin → `dist/server.js`), anchored to a working directory (`--cwd`). Built by tsup (`src/server/server.ts` → `dist/server.js`, ESM) + vite frontend assets into the same `dist/` (`--emptyOutDir false`, served from `__dirname` in production; vite middleware in dev). `node-pty` (native), `ws` and `vite` stay external. Requires Node `>=22`. Depends on `@tell-ai/sdk` (workspace) for model resolution (`MODELS`, `resolve_model_spec`, `get_model`) and the shared system prompt (`get_system_prompt({ chain: true })` composed with the project context); keys/URLs are captured from `process.env` in `server.ts` and the credential environment is then purged; workspace `.env` loads only with `TELL_TRUST_WORKSPACE_ENV=true` (no token files).

Key behaviors:
- Real PTY panes (`node-pty` + WebSocket + xterm.js, up to 8 sessions max, scrollback persisted)
- Token auth (`TELL_TOKEN`, case-insensitive Bearer boundary on `/api/*` + `?token=` on WS, memory-only login screen, failed-attempt rate limit); `TELL_ALLOWED_HOSTS` gates HTTP/WS Host and Origin against DNS rebinding
- `.tell/` session persistence (`session.json`, `history/`, `latest` symlink), private `0700/0600` modes, symlink-safe workspace paths
- Stricter `isHighRiskScript()` than the CLI (`src/server/guards.ts`: blocks all interpreter `-c`/`-e`, network clients, `env` launches, `base64 -d`, shell expansions — test-pinned divergence, do not "dedupe")
- Commands and PTY panes receive a scrubbed child environment without provider keys, `TELL_TOKEN`, or loader-injection variables
- Execution toggles (chat header, per browser session): `Auto-Run` / `Require Approval` / `No-Exec` (Auto-Run requires `-y`; server `--no-exec` is enforced by `/api/execute` and overrides saved browser toggles); feedback cards start minimized
- `--stream` replies on `/api/tell` as NDJSON (`reasoning`/`reasoning_end`/`text`/`done`/`error`; codec shared in `src/shared/chat-stream.ts`); collapsed reasoning headers with a live `Thinking… Ns` timer
- `--think` seeds reasoning headers expanded on first visit; manual expand/collapse persists to `localStorage`. Provider `reasoning_end` is not universal — the client freezes the timer on the first `text` delta
- Sensitive files never served (`.env*` except `.env.example`, `.tell/**`, `.git/**`, `*.key`, `*.pem`); per-IP rate limits on chat/execute/auth

Files:
- `src/server/server.ts` — express app + `/api/*` routes + vite/static serving (~790 lines)
- `src/server/guards.ts` — pure guards (sensitive paths, rate limiter, PTY/auth guards, payload validation, risk patterns); loaded directly by `test/test-web-backend.js`, keep dependency-light
- `src/server/context-builder.ts` — project tree (4 levels) + README/AGENTS system-prompt context
- `src/server/cli-args.ts`, `src/server/paths.ts`, `src/server/pty.ts`, `src/server/session.ts` — flags, traversal guard, terminal server, `.tell/` persistence
- `src/shared/` — `chain-feedback.ts`, `chat-threads.ts`, `terminal-layout.ts` (pure, shared by UI + tests)
- `src/App.tsx`, `src/components/`, `src/api.ts`, `src/auth.ts`, `src/theme.tsx` — React frontend (execution toggles live in `ChatSection.tsx`)

### Model alias conventions

- **First character(s)** = vendor+model: `g` = GPT-5.6 Sol, `o` = Claude Opus 5, `s` = Claude Sonnet 5, `f` = Claude Fable 5, `l` = Gemini 3.8 Flash, `j` = Gemini 3.5 Flash Lite, `d` = DeepSeek Flash, `z` = GLM-5.3 (Z.ai)
- **Suffix** = thinking budget: `--` none, `-` low, (none) medium, `+` high, `++` xhigh/max
- **Dot prefix** (`.g`) = fast mode
- **Self-hosted**: `q` = local `/root/model`, `v` = vast `/root/model`

Canonical format: `vendor:official_model_name:thinking_budget` (e.g., `openai:gpt-6-sol:high`).

## Dependencies

- **[ai](https://sdk.vercel.ai)** — AI SDK core (`generateText` + `streamText`)
- **[@ai-sdk/openai](https://www.npmjs.com/package/@ai-sdk/openai)** — OpenAI provider (native; also serves `vast`/`local`/`openrouter` via `baseURL`)
- **[@ai-sdk/anthropic](https://www.npmjs.com/package/@ai-sdk/anthropic)** — Anthropic provider (native)
- **[@ai-sdk/google](https://www.npmjs.com/package/@ai-sdk/google)** — Google provider (native)
- **[@ai-sdk/xai](https://www.npmjs.com/package/@ai-sdk/xai)** — xAI Grok provider (native)
- **[@ai-sdk/deepseek](https://www.npmjs.com/package/@ai-sdk/deepseek)** — DeepSeek provider (native)
- **[@ai-sdk/cerebras](https://www.npmjs.com/package/@ai-sdk/cerebras)** — Cerebras provider (native)
- **[@ai-sdk/moonshotai](https://www.npmjs.com/package/@ai-sdk/moonshotai)** — MoonshotAI provider (native)
- **[@ai-sdk/openai-compatible](https://www.npmjs.com/package/@ai-sdk/openai-compatible)** — OpenAI-compatible Chat Completions provider (`alibaba`/`zai`/`xiaomi` vendors + fallback for vendors without a dedicated handler); `meta` shares the same wire path but uses `@ai-sdk/openai`'s `.responses()` (`OPENAI_WIRE_VENDORS` in `models.ts`)
- **[commander](https://www.npmjs.com/package/commander)** — CLI argument parsing

The provider packages above are dependencies of `@tell-ai/sdk`; `commander` lives in `tell-ai`. The web package adds `express`, `ws`, `node-pty` (native), `vite` + `react`/`@xterm/*` for the frontend.

## API key configuration

API keys are resolved in the CLI (`packages/cli/src/env.ts`): env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `ALIBABA_API_KEY`, etc.) with fallback to `~/.config/<vendor>.token` files, then injected into the SDK as `SDKConfig`. The web server resolves keys from `process.env` only (`load_sdk_config_from_env` in `packages/web/src/server/server.ts`, no token files). The SDK never touches the environment itself.

## Related docs

- `docs/sdk/` — SDK reference: `README.md` (index + examples), `api.md` (API surface), `models.md` (aliases/specs/reasoning matrix/custom endpoints), `streaming.md` (AskStream events), `config.md` (SDKConfig injection/browser safety), `imports.md` (build variants)
- `docs/cli/` — CLI reference pages (flags, context, execution, chain mode, env config, security, development, mentions)
- `docs/usage.md`, `docs/integrations.md` — CLI usage and integrations
- `docs/web-sandbox.md`, `packages/web/README.md` — web sandbox guide (`tell --web`) and package reference (flags, `/api/*` routes, `.tell/` layout); backend harness `test/test-web-backend.js`, sandbox suite `test/test-web-sandbox.js` (`bun run --filter @tell-ai/web test`)
- `examples/sdk/` — `proxy.ts` (API proxy + static serving) + `index.html` (uses the IIFE `TellSDK` build) + `demo.ts` (proxy walkthrough) + `custom-endpoint.ts` (custom URLs/Ollama/new-vendor walkthrough, runs offline)
- `packages/sdk/CHANGELOG_AI.md`, `packages/cli/CHANGELOG_AI.md`, `packages/web/CHANGELOG_AI.md` — Version history per package
