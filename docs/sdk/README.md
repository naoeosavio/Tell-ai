# SDK documentation

Complete reference for the `@tell-ai/sdk` package (`packages/sdk/`): a browser-safe AI provider layer shared by the CLI and the web sandbox.

| Page | Contents |
|------|----------|
| [api.md](api.md) | Full API reference: `create_ask_ai` / `ask` / `ask_stream`, `tell`, `get_model`, `resolve_model_spec`, `MODELS`, `get_system_prompt`, tag helpers, `summarize_context` |
| [models.md](models.md) | Model spec format (`vendor:model:thinking`), 147 aliases, fast/dot mode, thinking budgets, vendor dispatch |
| [streaming.md](streaming.md) | `AskStream` events (`reasoning`, `reasoning_end`, `text`), lazy iteration, Node/browser consumption |
| [config.md](config.md) | `SDKConfig` key/URL injection, browser-safety contract, CORS proxies |
| [imports.md](imports.md) | Build variants: Node ESM/CJS, browser ESM, browser global (IIFE) |

## Sources of truth

* Implementation: `packages/sdk/src/ask.ts`, `src/models.ts`, `src/tell.ts`, `src/config.ts`, `src/systemPrompt.ts`, `src/tags.ts`, `src/summarize.ts`
* Package metadata: `packages/sdk/package.json`, `packages/sdk/tsup.config.ts`
* Behavior contracts: `test/test-sdk.js` (public export surface, spec parsing, table round-trip, system prompts, tag helpers)
* Related docs (not duplicated here): `../cli/` (CLI reference pages), `../usage.md` (user guide), `../web-sandbox.md` (web sandbox), `../../packages/sdk/README.md` (quick reference), `../../packages/sdk/CHANGELOG_AI.md`

## Conventions used in these pages

* `ask.ts:<line>` refers to `packages/sdk/src/ask.ts`, `models.ts:<line>` to `packages/sdk/src/models.ts`, and so on.
* The alias table lives in `MODELS` (`models.ts:26-181`); the snapshot in `../usage.md` may lag it. Line references are approximate — the exports themselves are authoritative.
* The SDK never reads `process.env`; every call takes an injected `SDKConfig` (`config.ts:29`).