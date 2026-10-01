# SDK API reference

All exports come from `packages/sdk/src/index.ts` and are mirrored by the browser entry `src/browser.ts`, so the same API is available in Node, Bun, and the browser.

## `create_ask_ai(spec, config)` → `AskInstance`

`ask.ts:57`. Builds an `AskInstance` for a model spec using the injected config. The vendor provider is created lazily and memoized per process. Constructing the instance performs **no network I/O** — the request only starts when you call `ask()` or iterate `ask_stream()`.

```ts
import { create_ask_ai } from '@tell-ai/sdk';

const ai = await create_ask_ai('g', { keys: { openai: process.env.OPENAI_API_KEY } });
```

### `AskInstance` (`ask.ts:14`)

| Member | Signature | Notes |
|---|---|---|
| `ask` | `ask(message: string, options: { system: string; stream: false }): Promise<string>` | One-shot. Returns the raw response **including** a ` thinking…</think>` wrapper when the model reasoned (`ask.ts:70-71`) — strip it with `strip_think_tags` or use `tell()`. |
| `ask_stream` | `ask_stream(input, options: { system: string }): AsyncIterable<AskStreamEvent>` | Streaming completion; see [streaming.md](streaming.md). `input` is a prompt string or a multi-turn message array. |

> The `ask` signature requires `stream: false` — this is a literal leftover mirroring the AI SDK option shape; the value is unused.

## `tell(message, options)` → `Promise<string>`

`tell.ts:34`. `tell --no-exec` as a library call: builds the no-exec system prompt (unless overridden), calls the model, and returns the answer with ` thinking`/`<RUN>` tags stripped.

```ts
import { tell } from '@tell-ai/sdk';

const answer = await tell('summarize the uncommitted changes', {
  keys: { anthropic: process.env.ANTHROPIC_API_KEY },
});
```

`TellOptions` (`tell.ts:6-27`):

| Option | Default | Meaning |
|---|---|---|
| `model` | `'g'` | Alias or full spec. |
| `keys` / `urls` | `{}` | Injected credential/base-URL map (never read from env). |
| `exec` | `false` | When `true`, uses the execution-enabled system prompt (the CLI variant). |
| `cwd` / `platform` | — | Announced to the model in the system prompt. |
| `context` | — | Previous conversation prepended as `Previous context: …`. |
| `system` | built prompt | Overrides the system prompt entirely. |
| `ask` | new instance | Reuse an existing `AskInstance`. |
| `raw` | `false` | Return the raw response without stripping tags. |

`context` and the message are combined as `Previous context:\n<context>\n\nUser:\n<message>` (`tell.ts:42`).

## `get_model(spec, config)` → `ModelHandle`

`models.ts:558`. Resolves a spec and returns a `ModelHandle` backed by the vendor's AI SDK provider — useful when you want to drive `generateText()`/`streamText()` yourself (the web server does this for multi-turn chat).

```ts
const handle = await get_model('s', { keys: { anthropic: process.env.ANTHROPIC_API_KEY } });
const result = await generateText({ model: handle.model, prompt: 'hi', reasoning: handle.reasoning });
```

`ModelHandle` (`models.ts:20`): `{ model, reasoning, fast }` where `model` is a provider language-model instance, `reasoning` is the AI SDK thinking level (`none`/`low`/`medium`/`high`/`xhigh`/`max`), and `fast` reflects dot/`:fast` mode.

## `resolve_model_spec(spec)` → `ResolvedModelSpec`

`models.ts:356`. Pure parser — no network, no config required. Returns `{ vendor, model, thinking, fast }` (`models.ts:13-18`). Throws on unknown vendor/empty spec. Details in [models.md](models.md).

## `MODELS`

`models.ts:28`. The 142-entry alias table mapping short aliases to full `vendor:model:thinking` specs (e.g. `g` → `openai:gpt-6.1-sol:medium`). The table is the source of truth for the CLI's `tell -m --help` output.

## `get_system_prompt(options)` → `string`

`systemPrompt.ts:8`. Returns the shared tell system prompt in `exec` or `no-exec` form.

`PromptOptions` (`systemPrompt.ts:1-7`): `{ chain?, exec?, cwd?, platform? }`.

* `exec: false` → the no-execution variant: the model must never emit `<RUN>` tags and answers in plain text (`build_no_exec_prompt`, `systemPrompt.ts:67-92`). This is what browser `tell()` uses.
* `exec` unset/`true` → the execution variant instructing the model to request bash commands inside `<RUN>` tags, with the prompt-injection and conciseness policies of the CLI (`build_exec_prompt`, `systemPrompt.ts:14-63`).

## Tag helpers (`tags.ts`)

| Function | Behavior |
|---|---|
| `strip_markdown_code_blocks(text)` | Removes ``` fenced code blocks (so `<RUN>` tags hidden inside them are never parsed). |
| `strip_think_tags(text)` | Removes ` thinking…</think>` blocks and trims. |
| `strip_run_tags(text)` | Removes `<RUN>…</RUN>` blocks and trims. |
| `extract_runs(text)` | `{ scripts, visible }`: strips code blocks first, extracts the first `<RUN>` script, and returns visible text with every run block removed. |
| `sanitize_reasoning(text)` | Neutralizes angle brackets in model reasoning so it cannot forge `<think>`/`<RUN>` boundaries. |

## `summarize_context(ai, text)` → `Promise<string>`

`summarize.ts:27`. Uses a provided `AskInstance` to compress a conversation transcript into a `[Context summary …]`-prefixed block. This is what the CLI's incremental-context flow calls when the transcript outgrows its budget.

## Error surface

* Provider/network failures surface from `ask()`, `tell()`, and `ask_stream()` iteration as the underlying AI SDK error — callers handle them like any `async` failure.
* `ask_stream` re-throws AI SDK `error` parts verbatim (`ask.ts:48-49`).
* Bad specs (`Unsupported vendor: …`, empty spec, `vendor:model` shape mismatch) throw synchronously from `resolve_model_spec`/`get_model`.
* `vast`/`local` without a base URL throw with a clear message pointing at `urls.vast`/`urls.local` (`models.ts:531`, `models.ts:538`).

Sources: `ask.ts:14-17`, `ask.ts:57-76`, `tell.ts:6-47`, `models.ts:356-569`, `systemPrompt.ts:1-92`, `tags.ts:1-21`, `summarize.ts:27-33`.