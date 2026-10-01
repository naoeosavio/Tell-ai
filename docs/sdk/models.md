# Model resolution

Model specs are the single way to pick a model across the CLI, SDK, and web sandbox. `resolve_model_spec(spec)` is a pure parser; `get_model(spec, config)` builds the live provider handle.

## Spec format

```
vendor:model:thinking
```

* `vendor` — one of the supported vendors (lowercased).
* `model` — the vendor's official model name, or an alias whose own vendor matches.
* `thinking` — optional thinking budget: `none | low | medium | high | xhigh | max | auto`.

Two- and three-part forms, an optional `.` fast prefix, and an optional `:fast` suffix:

```text
deepseek:deepseek-flash:high   vendor:model:thinking
deepseek:deepseek-flash        vendor:model           → thinking auto
muse-spark-1.3                 unknown vendor         → alias/model + infer_vendor (meta)
openai:g:?                     alias in model slot   → alias model/thinking, same vendor required
.g                             dot prefix            → fast mode
openai:gpt-6.1-sol:high:fast   :fast suffix          → fast mode
```

Parsing rules (`parse_model_spec_raw`):

1. A leading `.` sets `fast` and is stripped.
2. A trailing `:fast` (case-insensitive) sets `fast` and is popped before resolving the base spec.
3. One part → `resolve_single_part`: alias lookup in `MODELS`, else treat as a raw model name with `infer_vendor`.
4. Multiple parts → the first must be a supported vendor (`SUPPORTED_VENDORS`) or the whole value falls back to single-part resolution; exactly `vendor:model` or `vendor:model:thinking` afterwards.
5. In `resolve_multi_part` the model slot may itself be an alias (e.g. `openai:p`), but it must belong to the same vendor or it throws.
6. If the third part is not a valid thinking level, it is appended to the model name instead.

`thinking: 'auto'` is the default for vendor:model forms and single-part specs, mapped to AI SDK `medium` through `AI_SDK_THINKING`.

## Alias conventions

A suffix encodes the thinking budget; the uppercase letter is the `high` tier:

| Suffix | Thinking | Example |
|---|---|---|
| *(none)* | `medium` | `g` |
| `-` | `low` | `g-` |
| `--` | `none` | `c--` |
| `+` | `high` | `g+` |
| `++` | `max` or vendor top | `g++` |
| Uppercase | `high` | `G` |

Fast mode (`.g` or `:fast`) disables reasoning regardless of the tier.

## Vendors in the alias table

`MODELS` holds 142 aliases across these vendors:

| Vendor | Aliases | Families |
|---|---:|---|
| openai | 34 | `g` GPT-6.1 Sol, `p` GPT-6.1 Sol Pro, `t` Terra, `c` GPT-6 Luna, `e` GPT-6 Astra, `r` GPT-6 Astra Pro |
| alibaba | 18 | `a` Qwen3.8 Max, `at` Qwen3.8 27B, `af` Qwen3.8 Flash |
| anthropic | 19 | `s` Sonnet 5.5, `o` Opus 5.5, `f` Fable 5.1, `h` Haiku 4.5 |
| google | 15 | `i` Gemini 3.1 Pro, `j` 3.5 Flash Lite, `l` 3.8 Flash |
| meta | 12 | `m` Muse Spark 1.3, `mc` Muse Spark 1.3 Contributor |
| xiaomi | 12 | `mi` MiMo-V2.6 Pro, `mif` MiMo-V2.6 Flash |
| zai | 12 | `z` GLM-5.3, `zf` GLM-5.3 Flash |
| deepseek | 8 | `d` V4.1 Flash, `D` V4 Pro |
| xai | 6 | `x` Grok 4.7 |
| moonshotai | 4 | `k` Kimi K2.7 Code, `K` Kimi K3 |
| vast | 1 | `v` self-hosted `/root/model` |
| local | 1 | `q` local `/root/model` |

`cerebras` and `openrouter` remain supported without short aliases. Cerebras is reachable through an explicit `cerebras:…` spec; `gpt-oss-120b` may also route there from an `openai:` spec through `CEREBRAS_MODELS`. OpenRouter is used for explicit specs and raw ids containing `/`.

### Tier quirks

* `gpt-6.1-sol` and the GPT-6 families do not support `none`; legacy `g--`, `e--` and `r--` therefore map to `low`.
* The lowercase DeepSeek series skips `medium`: `d` → `high`, `d-` → `low`, `d--` → `none`, `d+` → `max`.
* `k` is the Kimi K2.7 Code model at `none`. K3 supports only official `low`, `high` and `max` efforts: `K-` low, `K` high, `K+` max.
* Gemini `max` maps to `high`; Grok and Alibaba cap `++` at `xhigh`.
* `m`/`mc`/`mi`/`mif` share the full `none/low/medium/high/max` ladder.

### Legacy remaps

Short aliases are retained for muscle memory while pointing at published models:

| Legacy alias family | Official target |
|---|---|
| `g*` | `openai:gpt-6.1-sol` |
| `p*` | `openai:gpt-6.1-sol-pro` (confirmed on OpenRouter) |
| `e*` | `openai:gpt-6-astra` |
| `r*` | `openai:gpt-6-astra-pro` (confirmed on OpenRouter) |
| `at*` | `alibaba:qwen3.8-27b` (confirmed on OpenRouter) |

## Vendor inference (`infer_vendor`)

Used for single-part specs and unknown-vendor cases: `alibaba/` prefix → alibaba, any other name containing `/` → openrouter, then `glm` → zai, `gpt`/`o\d` → openai, `claude` → anthropic, `gemini` → google, `grok` → xai, `kimi` → moonshotai, `muse` → meta, `mimo` → xiaomi; otherwise the parser throws. The `/` rule runs first, so raw ids like `meta/muse-spark-1.3` stay on OpenRouter while `muse-spark-1.3` goes direct.

## Dispatch (`get_model`)

1. `resolve_model_spec` resolves the alias and `resolve_reasoning` maps its thinking budget.
2. OpenAI models listed in `CEREBRAS_MODELS` are redirected to the Cerebras handler.
3. `VENDOR_HANDLERS` builds native providers using the injected key/URL. `zai` uses the `zhipu` key slot; `vast`/`local` require their URL slots.
4. `OPENAI_WIRE_VENDORS` describes the Chat Completions/Responses wire vendors: alibaba, zai, xiaomi and meta. Vendors without a dedicated handler fall back to the same Chat Completions factory.
5. Provider caches are keyed by vendor, effective base URL and credential token so two tenants with the same endpoint never reuse a stale key.

### Reasoning matrix

* Anthropic `max` uses adaptive thinking with `effort: 'max'`.
* DeepSeek `max` uses `reasoningEffort: 'max'`.
* Moonshot `low`, `high` and `max` are sent explicitly through `providerOptions.moonshotai.reasoningEffort`.
* Google maps `max` to `high`; xAI maps it to `xhigh`.
* Meta adds `providerOptions.openai.forceReasoning` so unknown Muse model ids still emit reasoning.
* Fast mode always resolves to `none` with no explicit vendor options.

## URLs and auth

All providers honor `SDKConfig.urls.<vendor>`. Xiaomi authenticates with an `api-key` header rather than `Authorization: Bearer`; other OpenAI-wire vendors use bearer auth. Self-hosted `vast`/`local` have no default and fail clearly when unset.

Walkthrough: `examples/sdk/custom-endpoint.ts` covers custom URLs, Ollama and adding a vendor.

Sources: `packages/sdk/src/models.ts`, `packages/sdk/src/config.ts`, `test/test-sdk.js`.