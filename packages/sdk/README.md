# @tell-ai/sdk

Browser-safe AI provider layer for tell-ai: model resolution, multi-vendor dispatch, RUN/think tag handling, and context summarization.

The SDK has zero `node:*` imports and zero `process.env` reads. All environment concerns (API keys, base URLs, platform info) are injected via `SDKConfig`, so the same code runs in Node, Bun, and the browser.

## Features

- **`MODELS` / `resolve_model_spec(model)`** — 142 short aliases (e.g. `g` → `openai:gpt-6.1-sol:medium`) resolving to `vendor:model:thinking_budget` specs, with dot-prefix fast mode (`.g`).
- **`create_ask_ai(spec, config)`** — returns an `AskInstance` with `ask()` (one-shot, backed by `generateText()`) and `ask_stream()` (token-by-token, backed by `streamText()`) over openai, anthropic, google, xai, deepseek, cerebras, and moonshotai providers.
- **`tell(message, options)`** — one-shot `tell --no-exec` as a library call: builds the tell system prompt (execution disabled by default), calls the model, and returns the answer with ` thinking`/`<RUN>` tags stripped.
- **`get_system_prompt(options)`** — the shared tell system prompt (`PromptOptions { chain?, exec?, cwd?, platform? }`); `exec: false` emits the no-command-execution variant.
- **Tag helpers** — `extract_runs`, `strip_run_tags`, `strip_think_tags`, `strip_markdown_code_blocks` for `<RUN>`/reasoning/markdown handling.
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

const ai = await create_ask_ai('g', { keys: { openai: process.env.OPENAI_API_KEY } });
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