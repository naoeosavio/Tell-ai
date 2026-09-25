# Model resolution

Model specs are the single way to pick a model across the CLI, SDK, and web sandbox. `resolve_model_spec(spec)` (`models.ts:408`) is a pure, synchronous parser; `get_model(spec, config)` (`models.ts:683`) builds the live provider handle.

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
muse-spark-1.3               unknown vendor          → alias/model + infer_vendor (meta)
openai:g:?                     alias in model slot      → alias model/thinking, same vendor required
.fast                          dot prefix              → fast mode
openai:gpt-6-sol:high:fast     :fast suffix            → fast mode (popped before vendor lookup)
```

Parsing rules (`parse_model_spec_raw`, `models.ts:377-406`):

1. A leading `.` sets `fast` and is stripped.
2. A trailing `:fast` (case-insensitive) sets `fast` and is popped before resolving the base spec.
3. One part → `resolve_single_part`: alias lookup in `MODELS`, else treat as a raw model name with `infer_vendor`.
4. Multiple parts → the first must be a supported vendor (`SUPPORTED_VENDORS`, `models.ts:216-231`) or the whole thing falls back to single-part resolution; exactly `vendor:model` or `vendor:model:thinking` afterwards.
5. In `resolve_multi_part` the model slot may itself be an alias (e.g. `openai:p`), but it must belong to the same vendor or it throws.
6. If the third part is not a valid thinking level, it is appended to the model name instead (covers model names containing `:`).

`thinking: 'auto'` is the default for vendor:model forms and single-part specs; mapped to AI SDK `medium` (`AI_SDK_THINKING`). The map is passthrough (`max` → `max`, `xhigh` → `xhigh`); `openai-compatible` forwards `reasoning_effort` verbatim, so both survive.

## Alias conventions

A suffix encodes the thinking budget; the uppercase letter is the "high" tier:

| Suffix | Thinking | Example |
|---|---|---|
| *(none)* | `medium` | `g` |
| `-` | `low` | `g-` |
| `--` | `none` | `g--` |
| `+` | `high` | `g+` |
| `++` | `max` | `g++` |
| Uppercase | `high` | `G` |

Fast mode (`.g` or `:fast`) zeroes reasoning regardless of the tier: callers map it via `handle.fast ? 'none' : handle.reasoning` (`ask.ts`, `server.ts`).

## Vendors in the alias table

`MODELS` (`models.ts:28-204`) holds 147 aliases across these vendors:

| Vendor | Aliases | Families |
|---|---|---|
| openai | 34 | `g` GPT-6 Sol, `p` Sol-Pro, `t` Terra, `c` GPT-6 Luna, `e` GPT-6 Astra, `r` Astra-Pro |
| alibaba | 24 | `a` Qwen3.8 Max, `at` 2.4T-A95B, `al` 27B, `af` Flash |
| anthropic | 18 | `s` Sonnet 5, `o` Opus 5.5, `f` Fable 5.1 |
| google | 15 | `i` Gemini 3.1 Pro, `j` 3.5 Flash Lite, `l` 3.8 Flash |
| meta | 12 | `m` Muse Spark 1.3, `mc` Muse Spark 1.3 Contributor |
| xiaomi | 12 | `mi` MiMo-V2.6 Pro, `mif` MiMo-V2.6 Flash |
| zai | 12 | `z` GLM-5.3, `zf` GLM-5.3 Flash |
| deepseek | 8 | `d` Flash, `D` V4 Pro |
| xai | 6 | `x` Grok 4.7 |
| moonshotai | 4 | `k` Kimi K2.7 Code, `K` Kimi K3 |
| vast | 1 | `v` self-hosted `/root/model` |
| local | 1 | `q` local `/root/model` |

`cerebras` and `openrouter` are supported vendors but expose no alias: Cerebras is reachable either via an explicit `cerebras:…` spec or because certain OpenAI models route to it (`gpt-oss-120b`, `gemma-4-31b` — `CEREBRAS_MODELS`, `models.ts:248`, checked in `get_model` at `models.ts:693-695`), while OpenRouter is only used for raw ids that contain a `/` (`openrouter:meta/muse-spark-1.3` stays on OpenRouter — the `m` alias talks to Meta directly).

Tier quirks to be aware of (from the table):

* The lowercase deepseek series skips `medium`: `d` → `high`, `d-` → `low`, `d--` → `none`, `d+` → `max`.
* `k` is the Kimi K2.7 code model at `none`; `K` tiers are `K-` low / `K` high / `K+` max.
* The `google` `i` (3.1 Pro) and `j` (3.5 Flash Lite) tiers stop at high; `l` and the openai, meta and xiaomi families go up to `max`.
* Grok caps at `xhigh` for `++`; alibaba caps at `xhigh` for `++`.
* `m`/`mc`/`mi`/`mif` share one tier ladder: `--` none, `-` low, base medium, `+` high, `++` max, uppercase high.

## Vendor inference (`infer_vendor`, `models.ts:256-269`)

Used for single-part specs and unknown-vendor cases: `alibaba/` prefix → alibaba, any other name containing `/` → openrouter, then `glm` → zai, `gpt`/`o\d` → openai, `claude` → anthropic, `gemini` → google, `grok` → xai, `kimi` → moonshotai, `muse` → meta, `mimo` → xiaomi; otherwise throws. The `/` rule runs first, so raw ids like `meta/muse-spark-1.3` and `mimo/mimo-v2.6-pro` stay on OpenRouter while `muse-spark-1.3` and `mimo-v2.6-pro` go direct.

## Dispatch (`get_model`, `models.ts:710-735`)

1. `resolve_model_spec` + thinking mapping (`resolve_reasoning` below).
2. OpenAI models that live on Cerebras are redirected to the Cerebras handler.
3. `VENDOR_HANDLERS` builds the native provider (memoized per process per effective base URL) using the injected key/URL for that vendor. Keys are looked up through `VENDOR_KEY` — note `zai` uses the **`zhipu`** key slot; `vast`/`local` never need a key but require `urls.vast`/`urls.local`. DashScope model ids may carry an `alibaba/` prefix, stripped in `handle_alibaba`.
4. The OpenAI-wire vendors have one thin handler each — `handle_alibaba`, `handle_zhipu`, `handle_xiaomi`, `handle_meta` — all delegating to `get_openai_wire_factory` (`models.ts:460-499`), so provider construction, caching and auth live in one place. Vendors **without** a handler fall back to the same factory, so `alibaba`/`zai`/`xiaomi`, `meta` and any future vendor share one path. `OPENAI_WIRE_VENDORS` (`models.ts:299-323`) describes each: the wire API (`chat` → `@ai-sdk/openai-compatible`, `responses` → `@ai-sdk/openai`'s `.responses(model)`, hence `/v1/responses`), the default base URL, the `SDKUrls` slot (`zai` reads `zhipu`) and an optional non-bearer key header. Vendors missing from the table fall back to Chat Completions with no default URL, so a future vendor only needs a URL to work. The factory is cached per `vendor::api::base_url` in `OPENAI_WIRE_PROVIDERS`.
5. Reasoning matrix (`resolve_reasoning`, `models.ts:666-696`): the table is passthrough, except `max`, which the generic reasoning→effort map lacks — `anthropic`/`deepseek`/`moonshotai` send it explicitly (`effort`/`reasoningEffort: 'max'`, explicit options take precedence, no warning), `xai` sends `xhigh` (its enum top), `google` sends `high` (its enum top). Vendors flagged `force_reasoning` in `OPENAI_WIRE_VENDORS` (only `meta` today) always add `providerOptions.openai.forceReasoning: true` — without it the provider treats an unknown model id as non-reasoning and silently drops the effort. Fast mode always resolves to `none` with no explicit options.

Base URLs all honor `SDKConfig.urls.<vendor>` via `baseURL` (`config.ts:14-30`); the `zai` default is `https://api.z.ai/api/paas/v4`, `meta` is `https://api.meta.ai/v1` (`models.ts:273`) and `xiaomi` is `https://api.xiaomimimo.com/v1` (`models.ts:289-294`). Self-hosted `vast`/`local` have no default and throw without their URL.

Auth quirk: Xiaomi MiMo authenticates with an `api-key` header, not `Authorization: Bearer`, so `key_header: 'api-key'` makes the factory pass the key as a custom header and never set `apiKey` on the provider (which would add a bearer header). Every other wire vendor keeps the default bearer behavior — including `meta`, which is the only one on the Responses API.

Walkthrough: `examples/sdk/custom-endpoint.ts` (custom URL via `SDKConfig`, optional Ollama scenario, CLI equivalents; runs offline with `bun examples/sdk/custom-endpoint.ts`).

Sources: `models.ts:28-204`, `models.ts:216-323`, `models.ts:377-406`, `models.ts:460-499`, `models.ts:611-636`, `models.ts:652-735`.