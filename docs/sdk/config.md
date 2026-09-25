# SDKConfig — key and URL injection

Every SDK call that needs credentials takes an injected `SDKConfig` (`config.ts:33`):

```ts
interface SDKConfig {
  keys: SDKKeys;  // API keys by vendor (all optional)
  urls: SDKUrls;  // base URLs by vendor (all optional)
}
```

The SDK has **zero `node:*` imports and zero `process.env` reads**. It never calls `process.env` itself, never reads token files, and never looks at the filesystem. Everything the providers need arrives through `SDKConfig`, which is how the same package runs unchanged in Node, Bun, and the browser.

## Keys (`SDKKeys`, `config.ts:1-14`)

| Slot | Vendors served |
|---|---|
| `openai` | `openai` (aliases `g/p/t/c/e/r`; also `vast`/`local`, which ignore the key) |
| `anthropic` | `s`/`o`/`f` |
| `google` | `i`/`j`/`l` |
| `xai` | `x` |
| `deepseek` | `d`/`D` |
| `cerebras` | Cerebras models (`gpt-oss-120b`, `gemma-4-31b`) |
| `moonshotai` | `k`/`K` |
| `openrouter` | raw ids containing `/` (no alias) |
| `alibaba` | `a`/`at`/`al`/`af` |
| `zhipu` | **`zai`** vendor (`z`/`zf`) — note the slot is `zhipu`, not `zai` (`VENDOR_KEY`, `models.ts:233-246`) |
| `meta` | `m`/`mc` (Bearer auth, Responses API) |
| `xiaomi` | `mi`/`mif` (sent as the `api-key` header, never as a bearer) |

Keys are looked up only from `config.keys`; a vendor with no key builds a provider without one (e.g. self-hosted `vast`/`local`, or proxies that inject keys server-side).

## URLs (`SDKUrls`, `config.ts:16-30`)

Per-vendor `baseURL` override, honored by every handler via the AI SDK's `baseURL` option. Two slots have **no** default at all:

* `urls.vast` — required for `v` (throws without it: `vendor "vast" requires urls.vast`).
* `urls.local` — required for `q`.

Every other vendor has a built-in default (e.g. `zai` → `https://api.z.ai/api/paas/v4`, `meta` → `https://api.meta.ai/v1`, `xiaomi` → `https://api.xiaomimimo.com/v1`). Setting a `urls.*` entry turns that provider into a CORS-friendly custom endpoint.

## Who assembles `SDKConfig`

* The **CLI** owns environment resolution: `packages/cli/src/env.ts` reads `process.env` (`{VENDOR}_API_KEY`) with `~/.config/<vendor>.token` fallbacks and builds the config for `create_ask_ai`.
* The **web server** reads `process.env` only (no token files) via `load_sdk_config_from_env` in `packages/web/src/server/server.ts`.
* **Browsers / your code** build the config explicitly and pass it in — see the quick-reference example in `packages/sdk/README.md`.

## Browser safety contract

Two properties make the SDK browser-loadable:

1. **No ambient environment.** All environment concerns (keys, URLs, platform info) are parameters. The `tell()` options mirror this: `keys`, `urls`, `cwd`, `platform`, `system` are all optional and injected (`src/tell.ts:6-27`).
2. **Self-contained bundles.** The tsup build bundles `ai` and every `@ai-sdk/*` provider via `noExternal` (`tsup.config.ts`) — a `'@ai-sdk/*'` glob would not match scoped packages and would leave bare imports. The transitive `@vercel/oidc` (a dependency of `ai`) pulls in `path`/`fs`/`os` and reads `process` at module scope, so those builtins are aliased to `src/shims/node.cjs` and a `var process = {…}` banner is prepended. The shims return inert values (empty files, `'/'` for `homedir`, etc.) because OIDC helpers are never exercised in the browser.

Sanity check after a build:

```bash
grep -cE '^import ' packages/sdk/dist/browser*.js   # must print 0
```

## CORS proxies

Because keys are optional, the browser pattern is to **not ship real keys** and instead point `urls.<vendor>` at a CORS proxy that forwards to the provider API and injects the key server-side. The repo ships a minimal example — `examples/sdk/proxy.ts` (Bun) plus `examples/sdk/index.html`:

```ts
create_ask_ai('g', {
  keys: { openai: 'proxy' },
  urls: { openai: 'https://my-proxy.example/v1' },
});
```

Google can authenticate with an `x-goog-api-key` header instead of `Authorization: Bearer`, which some proxies find easier to forward; the demo uses that. Xiaomi is the reverse case: MiMo **requires** `api-key`, so the SDK never sends a bearer for it and the example proxy injects `api-key` server-side from `MIMO_API_KEY`.

## Custom endpoints

Any `urls.<vendor>` slot overrides the built-in default — a CORS proxy, a localhost mock, or a self-hosted server (Ollama and friends via the keyless `local`/`vast` vendors). `examples/sdk/custom-endpoint.ts` walks through all three shapes and runs offline:

```ts
// 1. Any vendor pointed at a custom OpenAI-compatible URL (no key needed).
const ai = await create_ask_ai('local:mock-model:high', {
  keys: {},
  urls: { local: 'http://127.0.0.1:11434/v1' },
});
await ai.ask('hi', { system: 'be concise', stream: false });

// 2. Self-hosted via CLI: LOCAL_OPENAI_BASE_URL=<url> tell -m q "..."
// 3. Brand-new vendor: add the name to SUPPORTED_VENDORS plus a URL —
//    vendors without a dedicated handler fall back to the generic
//    OpenAI-compatible provider, so no handler code is needed.
```

```bash
bun examples/sdk/custom-endpoint.ts                    # offline mock, no keys
OLLAMA_MODEL=qwen3 bun examples/sdk/custom-endpoint.ts # needs `ollama serve`
```

## Design contract (tests)

`test/test-sdk.js` verifies: public export surface, spec parsing (aliases/fast/thinking budgets), the `MODELS` round-trip invariant (every spec re-parses to itself) and its 147-entry size, offline `get_model` handles — including that `vast`/`local` reject an empty config with the `urls.*` error — plus localhost wire tests pinning Meta to `/v1/responses` with a bearer and `forceReasoning`, and Xiaomi to `/v1/chat/completions` with an `api-key` header and no `Authorization`. The exec/no-exec system prompts and tag helpers are covered there as well.

Sources: `config.ts:1-32`, `models.ts:208-219`, `models.ts:528-541`, `tsup.config.ts:1-85`, `src/shims/node.cjs:1-107`.