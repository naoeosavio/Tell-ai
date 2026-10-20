# Browser-safe surface

`src/browser.ts` is the browser-safe surface of `@tell-ai/core`, served through the `browser` condition of the main entry so Vite and bundlers never pull Node builtins:

```ts
import { assess_base_risk, parse_runtime_limits } from '@tell-ai/core'; // browser build resolves here
```

## What ships to the browser

Only modules with zero builtin imports (bare or `node:`-prefixed) and zero module-scope environment access: loop-feedback, risk, chain-decision, runtime-limits, config, browser-runtime — plus erased port types from `runtime-api` (`export type` adds no runtime edge). `runtime-api` values, `loop`, `runtime`, `exec`, `paths`, `project-context` and `sdk-config` are Node-only and stay out. The `test/test-core-package.js` gate fails the build if this entry ever gains a builtin import.

The Web offline fallback loop formats and parses through this surface, so its wording can never drift from the server's.

## `createLocalStorageAdapter` (`src/browser-runtime.ts`)

Wraps an injected `StorageLike` (`getItem`/`setItem`/`removeItem`, sync) as an async `StoragePort`:

```ts
import { createLocalStorageAdapter } from '@tell-ai/core';

const storage = createLocalStorageAdapter(localStorage); // or any StorageLike fake
```

The storage is always a parameter — the adapter never reads `globalThis.localStorage`, `window` or any ambient global, so it works in SSR (pass a fake or omit storage) and any browser context. Malformed stores throw at construction, not on first use. `MemoryStorageAdapter` (in `runtime-api.ts`) covers the no-storage default; this adapter covers the persisted case.

Sources: `packages/core/src/browser.ts`, `src/browser-runtime.ts`, `test/test-core-package.js` (builtin-import gate).
