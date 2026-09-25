# Environment and configuration

The CLI is the only layer that touches the environment. It assembles an `SDKConfig { keys, urls }` (both partial) and injects it into `create_ask_ai`. The SDK never reads `process.env` itself.

## `load_sdk_config` (`src/env.ts:19-47`)

Keys: env var first, `~/.config/<vendor>.token` file fallback (trimmed, empty ignored via `read_token_file`, `src/env.ts:10-18`).

| SDK key | Env var(s) | Token file |
|---------|-----------|------------|
| `openai` | `OPENAI_API_KEY` | `~/.config/openai.token` |
| `anthropic` | `ANTHROPIC_API_KEY` | `~/.config/anthropic.token` |
| `google` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` | `~/.config/google.token` |
| `xai` | `XAI_API_KEY` | `~/.config/xai.token` |
| `deepseek` | `DEEPSEEK_API_KEY` | `~/.config/deepseek.token` |
| `cerebras` | `CEREBRAS_API_KEY` | `~/.config/cerebras.token` |
| `moonshotai` | `MOONSHOTAI_API_KEY` | `~/.config/moonshotai.token` |
| `openrouter` | `OPENROUTER_API_KEY` | `~/.config/openrouter.token` |
| `alibaba` | `ALIBABA_API_KEY` | `~/.config/alibaba.token` |
| `zhipu` (vendor `zai`) | `ZHIPU_API_KEY` | `~/.config/zhipu.token` |
| `meta` | `META_API_KEY` | `~/.config/meta.token` |
| `xiaomi` | `MIMO_API_KEY` | `~/.config/mimo.token` |

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_API_KEY="..."        # or GEMINI_API_KEY
export DEEPSEEK_API_KEY="..."
echo -n "sk-..." > ~/.config/openai.token   # fallback when env is unset
```

URLs (`SDKUrls`): the CLI injects a default for every vendor that has one — `openai` → `https://api.openai.com/v1`, `anthropic` → `https://api.anthropic.com/v1`, `google` → `https://generativelanguage.googleapis.com/v1beta`, `xai` → `https://api.x.ai/v1`, `deepseek` → `https://api.deepseek.com`, `cerebras` → `https://api.cerebras.ai/v1`, `moonshotai` → `https://api.moonshot.ai/v1`, `openrouter` → `https://openrouter.ai/api/v1`, `alibaba` → `$ALIBABA_BASE_URL` or `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, `zhipu` → `$ZHIPU_BASE_URL` or `https://api.z.ai/api/paas/v4`, `meta` → `$META_BASE_URL` or `https://api.meta.ai/v1`, `xiaomi` → `$MIMO_BASE_URL` or `https://api.xiaomimimo.com/v1`. Only `alibaba`/`zai`/`xiaomi` (plus vendors without a dedicated handler) go through `@ai-sdk/openai-compatible`; `xiaomi` authenticates with an `api-key` header instead of a bearer token. `meta` has its own handler and calls the OpenAI Responses API (`/v1/responses`). Self-hosted vendors have no default and fail clearly when unset: `vast` requires `VAST_BASE_URL`, `local` requires `LOCAL_OPENAI_BASE_URL` (errors from `packages/sdk/src/models.ts`).

```bash
export VAST_BASE_URL="http://..."
tell v "summarize this file"
export LOCAL_OPENAI_BASE_URL="http://localhost:8080/v1"
tell q "explain this code"
export ZHIPU_BASE_URL="https://proxy.example/v1"      # optional override for vendor zai
export ALIBABA_BASE_URL="https://proxy.example/v1"    # optional override for vendor alibaba
export META_BASE_URL="https://proxy.example/v1"      # optional override for vendor meta
export MIMO_BASE_URL="https://proxy.example/v1"     # optional override for vendor xiaomi
```

## CLI-only variables

| Variable | Read at | Default | Meaning |
|----------|---------|---------|---------|
| `TELL_MODEL` | `Tell.ts:24` (module scope) | `'g'` | Default model when no positional/`-m` given |
| `DEBUG` | `src/env.ts:8` (`'true'`/`'1'`) | unset | Exported SDK-config debug flag (currently no verbose logging wired in `Tell.ts`) |

## System prompt wiring (`src/systemPrompt.ts:6-12`)

```ts
sdk_get_system_prompt({ ...(chain !== undefined ? { chain } : {}), cwd: process.cwd(), platform: `${os.platform()} ${os.release()}` })
```

Thin wrapper: same shared prompt the SDK `tell()` uses, plus live cwd and `platform release` so the model proposes correct local commands. `tell_silently` passes `{ chain: autoContinue }` on the first call and `{ chain: true }` on chain follow-ups (`Tell.ts:600-625`); the non-chain final-answer call uses `{ chain: false }`.

All providers honor `config.urls.*` as `baseURL`, so a proxy URL works for any vendor that defines one.

Sources: `src/env.ts`, `src/systemPrompt.ts`, `Tell.ts:24`, `Tell.ts:460-471`, `packages/sdk/src/models.ts:273-306`.
