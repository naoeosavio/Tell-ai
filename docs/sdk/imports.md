# SDK build variants

`@tell-ai/sdk` ships three entry points. All expose the same API (`tell`, `MODELS`, `create_ask_ai`, `get_system_prompt`, tag helpers, …) but differ in how they are loaded and consumed.

| | **Node** | **Browser ESM** | **Browser global (IIFE)** |
|---|---|---|---|
| Export path | `@tell-ai/sdk` | `@tell-ai/sdk/browser` | `@tell-ai/sdk/browser-global` |
| File | `dist/index.js` / `index.cjs` | `dist/browser.js` | `dist/browser-global.global.js` |
| Formats | ESM + CJS (+ `.d.ts`) | ESM | IIFE |
| Load | `import` / `require` | `<script type="module">` or bundler import | `<script src="...">` classic tag |
| Access | named imports | named imports | global `TellSDK` |
| Environment | Node (CLI, servers) | browsers | browsers, `file://`, CDN |
| Tree-shakeable | yes | yes | no (marked `sideEffects`) |
| Global pollution | none | none | defines `globalThis.TellSDK` |
| Needs a bundler step | no | no | no |
| Resolution of deps | from `node_modules` | self-contained | self-contained |

## Node (`@tell-ai/sdk`)

The runtime entry used by the `tell-ai` CLI and server-side code. It ships as both ESM (`dist/index.js`) and CJS (`dist/index.cjs`) with type declarations, and resolves provider packages from `node_modules`. Environment concerns (API keys, URLs) must be **injected** via `SDKConfig` — the SDK never reads `process.env` itself.

```ts
import { tell, create_ask_ai, MODELS } from '@tell-ai/sdk';

const ai = create_ask_ai('g', { keys: { openai: process.env.OPENAI_API_KEY } });
const answer = await tell('hello', { ask: ai });
```

## Browser ESM (`@tell-ai/sdk/browser`)

A single self-contained module bundle (ESM only). All AI-SDK core and all eight providers are bundled in, so there are no bare imports to resolve — it can be imported directly in a browser with no bundler:

```html
<script type="module">
  import { tell, MODELS } from './browser.js';
  console.log(MODELS); // 70+ aliases
</script>
```

- Tree-shakeable: when consumed through a bundler (Vite, webpack, esbuild), unused exports are dropped.
- No globals are touched.
- Requires module support in the browser.

## Browser global (`@tell-ai/sdk/browser-global`)

The same bundle compiled as an IIFE and loaded with a classic `<script>` tag. It defines `globalThis.TellSDK` with the full API — no import resolution of any kind, so it also works from `file://`, CDNs, or any environment without module support.

```html
<script src="./browser-global.global.js"></script>
<script>
  const { tell, MODELS, get_system_prompt } = globalThis.TellSDK;
  tell('hello', { keys: { google: 'proxy' } });
</script>
```

It is declared in `sideEffects` in `package.json` so bundlers never tree-shake it away: its global assignment is the point of loading it. It is also what the demo in `examples/sdk/` uses and what `unpkg`/`jsdelivr` fields point to.

The page demo (`examples/web/proxy.ts` + `index.html`) is served by the proxy and uses this IIFE build — a classic script has no module-resolution step, which makes it the most failure-proof choice for a standalone demo page.

## Build details

Both browser bundles are produced with the same TSUP configuration and are fully self-contained:

- `noExternal` lists `ai` and every `@ai-sdk/*` provider explicitly (a `'@ai-sdk/*'` glob does not match scoped packages, which previously produced a bundle with bare imports the browser cannot resolve).
- Node builtins (`path`, `fs`, `os`) pulled in by `@vercel/oidc` (a dependency of `ai`) are aliased to stubs from `packages/sdk/src/shims/node.cjs`, and a `var process = { version: '', env: {}, platform: 'browser' }` banner covers its module-scope user-agent construction — the OIDC helpers are never exercised in the browser.
- Result: zero bare imports and zero dynamic `require` calls at load time in both files.

## Which one to pick

- Server, CLI, scripts → `@tell-ai/sdk`.
- A browser app built with a bundler → `@tell-ai/sdk/browser` (tree-shaking, no globals).
- A plain HTML page, a CDN include, or a `file://` demo → `@tell-ai/sdk/browser-global` (zero setup, global `TellSDK`).