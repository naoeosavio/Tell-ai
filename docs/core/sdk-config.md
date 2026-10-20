# SDK config (vendor → key/URL mapping)

`src/sdk-config.ts` is the single owner of the vendor → key/URL mapping. The CLI and the Web server both build their `SDKConfig` from it, so every vendor honors its `*_BASE_URL` override. The SDK itself never touches the environment — hosts hand over the record.

```ts
import { build_sdk_config_from_env, load_sdk_config_from_env } from '@tell-ai/core';

// Web server (no token files):
const config = build_sdk_config_from_env(process.env);

// CLI (token-file fallback on):
const config = await load_sdk_config_from_env(process.env, { token_files: true, home_dir: os.homedir() });
```

## Vendor table

| `keys` / `urls` slot | Key env (first hit wins) | URL override | Default URL | Token file |
|---|---|---|---|---|
| `openai` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | `https://api.openai.com/v1` | `openai` |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` | `anthropic` |
| `google` | `GOOGLE_API_KEY`, `GEMINI_API_KEY` | `GOOGLE_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | `google` |
| `xai` | `XAI_API_KEY` | `XAI_BASE_URL` | `https://api.x.ai/v1` | `xai` |
| `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | `deepseek` |
| `cerebras` | `CEREBRAS_API_KEY` | `CEREBRAS_BASE_URL` | `https://api.cerebras.ai/v1` | `cerebras` |
| `moonshotai` | `MOONSHOTAI_API_KEY` | `MOONSHOTAI_BASE_URL` | `https://api.moonshot.ai/v1` | `moonshotai` |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | `openrouter` |
| `alibaba` | `ALIBABA_API_KEY` | `ALIBABA_BASE_URL` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `alibaba` |
| `zhipu` | `ZHIPU_API_KEY` | `ZHIPU_BASE_URL` | `https://api.z.ai/api/paas/v4` | `zhipu` |
| `meta` | `META_API_KEY` | `META_BASE_URL` | `https://api.meta.ai/v1` | `meta` |
| `xiaomi` | `MIMO_API_KEY` | `MIMO_BASE_URL` | `https://api.xiaomimimo.com/v1` | `mimo` |
| `custom` | `CUSTOM_API_KEY` | `CUSTOM_BASE_URL` | (none — unset stays absent) | `custom` |
| `vast` / `local` | (URL only) | `VAST_BASE_URL` / `LOCAL_OPENAI_BASE_URL` | (none) | — |

Blank values count as absent; unset URLs stay absent (never an empty string). An explicit proxy URL is never silently ignored.

## Token files and `CUSTOM_*` knobs

* `load_sdk_config_from_env(env, { token_files, home_dir })`: pure mapping first, then a missing key falls back to `~/.config/<vendor>.token` only when the host enables token files (the CLI does, the Web server does not). Env hits win over token files.
* `custom` vendor extras: `CUSTOM_MODEL` (default model id), `CUSTOM_API` (wire pin, must be one of `chat`/`responses`/`messages`), `CUSTOM_HEADERS` (JSON object of extra headers). Invalid `CUSTOM_API`/`CUSTOM_HEADERS` throw here instead of degrading silently, so the run fails at boot rather than misrouting requests. Wire inference and header merge themselves live in the SDK (`../sdk/models.md`).

Sources: `packages/core/src/sdk-config.ts`, `packages/cli/src/env.ts` (thin client, token files on), `packages/web/src/server/server.ts` (sync builder), `test/test-core-sdk-config.js`, `test/test-tell-env.js`.
