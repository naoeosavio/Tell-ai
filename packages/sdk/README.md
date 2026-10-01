# @tell-ai/sdk

Browser-safe AI provider layer for tell-ai: model resolution, multi-vendor dispatch, RUN/think tag handling, and context summarization.

The SDK has zero `node:*` imports and zero `process.env` reads. All environment concerns (API keys, base URLs, platform info) are injected via `SDKConfig`, so the same code runs in Node, Bun, and the browser.

## Features

- **`MODELS` / `resolve_model_spec(model)`** — 142 short aliases (e.g. `g` → `openai:gpt-6.1-sol:medium`) resolving to `vendor:model:thinking_budget` specs, with dot-prefix fast mode (`.g`).
- **`create_ask_ai(spec, config)`** — returns an `AskInstance` with `ask()` (one-shot, backed by `generateText()`) and `ask_stream()` (token-by-token, backed by `streamText()`), over the `openai`, `anthropic`, `google`, `xai`, `deepseek`, `cerebras`, `moonshotai`, `openrouter`, `alibaba`, `zai`, `meta` and `xiaomi` vendors plus the self-hosted `vast`/`local` endpoints.
- **`get_model(spec, config)`** — the lower-level handle (`{ model, reasoning, fast, providerOptions? }`) behind `create_ask_ai()`, for consumers that need a `ModelHandle` for their own `generateText()`/`streamText()` calls (e.g. multi-turn chat in a server).
- **`tell(message, options)`** — one-shot `tell --no-exec` as a library call: builds the tell system prompt (execution disabled by default), calls the model, and returns the answer with ` thinking`/`<RUN>` tags stripped.
- **`get_system_prompt(options)`** — the shared tell system prompt (`PromptOptions { chain?, exec?, cwd?, platform? }`); `exec: false` emits the no-command-execution variant.
- **Tag helpers** — `extract_runs`, `strip_run_tags`, `strip_think_tags`, `strip_markdown_code_blocks` for `<RUN>`/reasoning/markdown handling, plus `sanitize_reasoning` so provider reasoning cannot forge a `<think>`/`<RUN>` boundary.
- **`summarize_context(ai, text)`** — AI-driven conversation history compression.

## Install

```bash
bun add @tell-ai/sdk or npm add @tell-ai/sdk
```

## Usage (Node / Bun)

```ts
import { create_ask_ai, tell } from '@tell-ai/sdk';

const ai = create_ask_ai('openai:gpt-6.1-sol', { keys: { openai: process.env.OPENAI_API_KEY } });
const { text } = await ai.ask('explain this repository in one paragraph');
```

Streaming: consume reasoning/`text` deltas as the model generates them. `ask_stream` accepts a single prompt or a full multi-turn message array and returns a lazy `AsyncIterable` — the provider request only starts on first `next()`:

```ts
import { create_ask_ai } from '@tell-ai/sdk';

const ai = create_ask_ai('g', { keys: { openai: process.env.OPENAI_API_KEY } });
let text = '';
for await (const event of ai.ask_stream('explain this repo', { system: 'be brief' })) {
  switch (event.type) {
    case 'reasoning':
      process.stderr.write(`\x1b[2m${event.text}\x1b[0m`);
      break;
    case 'reasoning_end': // provider finished reasoning (may never come on some models)
      break;
    case 'text':
      text += event.text;
      process.stdout.write(event.text);
      break;
  }
}
```

Emits `AskStreamEvent`s in order: `reasoning` (deltas), `reasoning_end`, then `text` (deltas). Provider errors are thrown like `ask()`. Multi-turn:

```ts
const events = ai.ask_stream(
  [
    { role: 'user', content: 'what vendors are supported?' },
    { role: 'assistant', content: 'openai, anthropic, google, ...' },
    { role: 'user', content: 'give me an example' },
  ],
  { system: 'answer concisely' },
);
```

One-shot no-exec call (tag stripping included):

```ts
import { tell } from '@tell-ai/sdk';

const answer = await tell('summarize the uncommitted changes', {
  keys: { anthropic: process.env.ANTHROPIC_API_KEY },
});
```

All providers honor `SDKConfig.urls` via `baseURL`, enabling CORS proxies:

```ts
create_ask_ai('openai:gpt-6.1-sol', {
  keys: { openai: 'sk-...' },
  urls: { openai: 'https://my-proxy.example/v1' },
});
```

## Vendors, keys and endpoints

Keys and base URLs are injected per vendor, never read from the environment
(the SDK performs zero `process.env` reads):

| `keys` / `urls` slot | Vendor | Wire |
|---|---|---|
| `openai`, `anthropic`, `google`, `xai`, `deepseek`, `cerebras`, `moonshotai` | native providers | dedicated `@ai-sdk/*` handlers |
| `openrouter` | OpenRouter | any `vendor/model` id, including raw ids belonging to other vendors |
| `alibaba` | Alibaba Qwen | OpenAI-compatible chat completions |
| `zhipu` | Z.ai GLM (`zai` vendor) | OpenAI-compatible chat completions |
| `meta` | Meta Llama API | Responses API (`/v1/responses`) with `Authorization: Bearer` |
| `xiaomi` | Xiaomi MiMo | OpenAI-compatible chat completions, `api-key` header (no bearer) |
| `vast`, `local` | self-hosted | `urls` only — bring your own endpoint and key |

A vendor without a dedicated handler falls back to the generic
OpenAI-compatible provider, so pointing `urls.<vendor>` at a custom endpoint
(localhost mock, Ollama, a brand-new vendor) needs no code change beyond the
spec. The reasoning budget is resolved per vendor (`none`/`low`/`medium`/`high`/
`xhigh`/`max`), with `max` mapped to each provider's closest option
(`effort: 'max'` for Anthropic/DeepSeek/Moonshot, `xhigh` for xAI, `high` for
Google), and provider caches are keyed by base URL *and* credential, so two
configs never share a provider.

## Usage (browser)

Two self-contained bundles ship with the package — `ai` and all providers are bundled inline, so no build step or module server is required.

**ESM (bundlers, import maps):**

```js
import { tell, MODELS } from '@tell-ai/sdk/browser';

const answer = await tell('what is in this repo?', {
  keys: { openai: localStorage.getItem('openai_key') },
});
```

**Script tag (no bundler):** load the IIFE global from a CDN, then use `window.TellSDK`:

```html
<script src="https://unpkg.com/@tell-ai/sdk"></script>
<script>
  TellSDK.tell('hello', { keys: { openai: localStorage.getItem('openai_key') } });
</script>
```

See `examples/sdk/` in the repository for a no-build demo page, an optional Bun CORS proxy, and a custom-endpoint walkthrough (`custom-endpoint.ts`, runs offline).

## Build variants

| Subpath | Format | File | Use for |
|---|---|---|---|
| `.` | ESM / CJS + types | `dist/index.js`, `dist/index.cjs` | Node / Bun |
| `./browser` | ESM, bundled | `dist/browser.js` | Bundlers / browsers |
| `./browser-global` | IIFE global | `dist/browser-global.global.js` | `<script>` tags (CDN: `unpkg`, `jsdelivr`) |

## License

MIT — see [LICENSE](./LICENSE).