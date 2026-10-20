# Host config + custom instructions

`src/config.ts` resolves *which model, whether exec is allowed, chain on/off, and the exec timeout*. The seven operational limits live next door in [runtime-limits.md](runtime-limits.md); vendor keys/URLs live in [sdk-config.md](sdk-config.md). The core accepts every layer as plain data — `.tellrc` parsing belongs to the CLI (`packages/cli/src/tellrc.ts`), the core only merges.

## Hosts and defaults

```ts
import { HOST_DEFAULT_MODEL, load_env_layer, resolve_core_config } from '@tell-ai/core';

resolve_core_config({ host: 'cli', flag: { chain: true } });
// { model: 'g', exec_enabled: true, chain: true, exec_timeout_ms: 120000 }
```

There is no global model default: `HOST_DEFAULT_MODEL` is CLI → `g`, Web → `l`. Adapters pass their host; `TELL_MODEL` overrides only when provided and non-empty.

## Precedence

`resolve_core_config({ host, flag, env, project, user })` merges in `flag > env > project .tellrc > user ~/.tellrc > default` order. The first defined value wins — except `exec_enabled`, where an explicit deny in **any** layer wins over every allow (no layer relaxes a deny). Blank models count as absent; the timeout clamps to `MIN/MAX_EXEC_TIMEOUT_MS` (aliases of the limits owner) and falls back to the default on garbage.

`load_env_layer(env)` reads the base environment layer: only `TELL_MODEL`, only when non-blank. `TELL_KEY`/`TELL_BASE_URL` and vendor keys/URLs are owned by the later tellkey handoff and are deliberately ignored here. The environment always arrives as an explicit parameter — the core never binds `process.env` itself (the `process.env` default exists only for Node convenience).

## Custom instructions (shared preamble)

`compose_custom_system(custom, base)` (`src/custom-system.ts`, pure text, no builtins) prepends host-resolved custom instructions before the safety prompt:

```ts
compose_custom_system('Prefer bun.', '<RUN> protocol…');
// 'Custom instructions:\nPrefer bun.\n\n<RUN> protocol…'
```

Blank custom text returns the base unchanged. The custom text is a preamble — the base prompt (execution protocol, approval, `<RUN>` rules) always runs last, so configuration can add style or domain context but never replaces safety. Both the CLI (`tellrc.ts`) and the Web server prepend through this owner, so the two hosts can never drift on the prefix. `CUSTOM_SYSTEM_PREFIX` (`Custom instructions:`) is owned here; no host declares the literal itself.

Sources: `packages/core/src/config.ts`, `src/custom-system.ts`, `packages/cli/src/tellrc.ts`, `test/test-core-config.js`.
