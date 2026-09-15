# Model resolution

Model specs are the single way to pick a model across the CLI, SDK, and web sandbox. `resolve_model_spec(spec)` (`models.ts:356`) is a pure, synchronous parser; `get_model(spec, config)` (`models.ts:558`) builds the live provider handle.

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
fast: gpt-5.6-sol              unknown vendor          → alias/model + infer_vendor
openai:g:?                     alias in model slot      → alias model/thinking, same vendor required
.fast                          dot prefix              → fast mode
openai:gpt-5.6-sol:high:fast   :fast suffix            → fast mode (popped before vendor lookup)
```

Parsing rules (`parse_model_spec_raw`, `models.ts:325-354`):

1. A leading `.` sets `fast` and is stripped.
2. A trailing `:fast` (case-insensitive) sets `fast` and is popped before resolving the base spec.
3. One part → `resolve_single_part`: alias lookup in `MODELS`, else treat as a raw model name with `infer_vendor`.
4. Multiple parts → the first must be a supported vendor (`SUPPORTED_VENDORS`, `models.ts:193-206`) or the whole thing falls back to single-part resolution; exactly `vendor:model` or `vendor:model:thinking` afterwards.
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

`MODELS` (`models.ts:26-181`) holds 129 aliases across these vendors:

| Vendor | Aliases | Families |
|---|---|---|
| openai | 34 | `g` GPT-5.6 Sol, `p` Sol-Pro, `t` Terra, `c` Luna, `e` GPT-6 Astra, `r` Astra-Pro |
| alibaba | 24 | `a` Qwen3.8 Max, `at` 2.4T-A95B, `al` 27B, `af` Flash |
| anthropic | 18 | `s` Sonnet 5, `o` Opus 5, `f` Fable 5.1 |
| google | 15 | `i` Gemini 3.1 Pro, `j` 3.5 Flash Lite, `l` 3.8 Flash |
| zai | 12 | `z` GLM-5.3, `zf` GLM-5.3 Flash |
| deepseek | 8 | `d` Flash, `D` V4 Pro |
| openrouter | 6 | `m` Meta Muse Spark |
| xai | 6 | `x` Grok 4.6 |
| moonshotai | 4 | `k` Kimi K2.7 Code, `K` Kimi K3 |
| vast | 1 | `v` self-hosted `/root/model` |
| local | 1 | `q` local `/root/model` |

`cerebras` is a supported vendor but exposes no alias: it is reachable either via an explicit `cerebras:…` spec or because certain OpenAI models route to Cerebras (`gpt-oss-120b`, `gemma-4-31b` — `CEREBRAS_MODELS`, `models.ts:221`, checked in `get_model` at `models.ts:562-564`).

Tier quirks to be aware of (from the table):

* The lowercase deepseek series skips `medium`: `d` → `high`, `d-` → `low`, `d--` → `none`, `d+` → `max`.
* `k` is the Kimi K2.7 code model at `none`; `K` tiers are `K-` low / `K` high / `K+` max.
* The `google` `i` (3.1 Pro) and `j` (3.5 Flash Lite) tiers stop at high; `l` and the openai families go up to `max`.
* Grok caps at `xhigh` for `++`; alibaba caps at `xhigh` for `++`.

## Vendor inference (`infer_vendor`, `models.ts:229-240`)

Used for single-part specs and unknown-vendor cases: `alibaba/` prefix → alibaba, `glm` → zai, `gpt`/`o\d` → openai, `claude` → anthropic, `gemini` → google, `grok` → xai, `kimi` → moonshotai, any name containing `/` → openrouter; otherwise throws.

## Dispatch (`get_model`, `models.ts:558-569`)

1. `resolve_model_spec` + thinking mapping (`resolve_reasoning` below).
2. OpenAI models that live on Cerebras are redirected to the Cerebras handler.
3. `VENDOR_HANDLERS` builds the native provider (memoized per process per effective base URL) using the injected key/URL for that vendor; `alibaba`/`zai` and any vendor without a dedicated handler go through `@ai-sdk/openai-compatible` (`get_compat_provider`, `zai` reading the `zhipu` URL slot), so future vendors only need a URL to work. Keys are looked up through `VENDOR_KEY` — note `zai` uses the **`zhipu`** key slot; `vast`/`local` never need a key but require `urls.vast`/`urls.local`. DashScope model ids may carry an `alibaba/` prefix, stripped in `handle_alibaba`.
4. Reasoning matrix (`resolve_reasoning`): the table is passthrough, except `max`, which the generic reasoning→effort map lacks — `anthropic`/`deepseek`/`moonshotai` send it explicitly (`effort`/`reasoningEffort: 'max'`, explicit options take precedence, no warning), `xai` sends `xhigh` (its enum top), `google` sends `high` (its enum top). Fast mode always resolves to `none` with no explicit options.

Base URLs all honor `SDKConfig.urls.<vendor>` via `baseURL` (`config.ts:14-27`); the `zai` default is `https://api.z.ai/api/paas/v4` (`models.ts:522`). Self-hosted `vast`/`local` have no default and throw without their URL.

Sources: `models.ts:26-181`, `models.ts:183-240`, `models.ts:325-354`, `models.ts:543-569`.