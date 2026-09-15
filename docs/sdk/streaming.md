# AskStream — streaming completions

`AskInstance.ask_stream(input, { system })` streams a completion token by token, backed by the `ai` SDK's `streamText()` (`ask.ts:73`). It is built on the same resolved model handle and reasoning budget as `ask()`, so a given alias behaves identically in both paths — only the delivery timing differs.

## Events

`ask_stream` yields `AskStreamEvent` (`ask.ts:6-9`) in emission order:

| Event | Shape | Meaning |
|---|---|---|
| `reasoning` | `{ type: 'reasoning', text: string }` | A delta of the model's thinking. Emitted repeatedly during reasoning. |
| `reasoning_end` | `{ type: 'reasoning_end' }` | Marks the end of reasoning. **Not every provider sends one — always handle its absence.** |
| `text` | `{ type: 'text', text: string }` | A delta of the answer text. |

The underlying `streamText()` `stream` is consumed exactly once; tool calls, sources, and framework lifecycle parts are ignored (`ask.ts:37-53`). AI SDK `error` parts are re-thrown so callers keep the same error handling as `ask()`.

## Emit-time guarantees

* A provider with no reasoning (fast/*none* thinking modes) emits only `text` deltas — no `reasoning`, no `reasoning_end`.
* Some reasoning providers never emit `reasoning_end` either. Consumers that need to render a "thinking…" state should treat the **first `text` delta as the reasoning boundary** (both the CLI and the web client do this).
* Delta sizes and boundaries vary by provider; accumulate `event.text` yourself.

## Input forms

`AskStreamInput` (`ask.ts:12`) accepts a single prompt string **or** a multi-turn message array:

```ts
type AskStreamInput = string | Array<{ role: 'user' | 'assistant'; content: string }>;
```

A string input becomes `prompt`; the array becomes `messages` (`ask.ts:30-35`). There is no `context` option — prepend a synthetic `user` message if you need prior conversation.

## Laziness

`ask_stream` returns a **lazy** `AsyncIterable`: constructing it never starts the provider request. The request only begins on the first `next()`:

```ts
const stream = ai.ask_stream('hi', { system: 'be brief' }); // no network yet
for await (const event of stream) {
  // provider call has started
}
```

Iterating to completion always yields the full response; a partial iteration leaves the request mid-flight (the underlying `streamText` surface handles cancellation, but you cannot resume — create a new stream).

## Consuming in Node

```ts
import { create_ask_ai } from '@tell-ai/sdk';

const ai = await create_ask_ai('s', { keys: { anthropic: process.env.ANTHROPIC_API_KEY } });
let text = '';
let reasoning = '';
for await (const event of ai.ask_stream('why does this race?', { system: 'be concise' })) {
  switch (event.type) {
    case 'reasoning':
      reasoning += event.text;
      process.stderr.write('\x1b[2m' + event.text + '\x1b[0m');
      break;
    case 'reasoning_end': // provider finished reasoning
      break;
    case 'text':
      text += event.text;
      process.stdout.write(event.text); // stream to the terminal
      break;
  }
}
if (text && !text.endsWith('\n')) process.stdout.write('\n');
```

This is exactly what `tell --stream` does (`packages/cli/src/Tell.ts`, `tell_streaming`).

## Consuming in the browser

The same `ask_stream` runs in the browser bundles because the SDK never touches Node-only APIs. Pair it with a plain fetch to a CORS proxy that forwards `/vendor/*` calls and injects keys server-side (see [config.md](config.md) and `examples/web/proxy.ts`).

## Who uses it

* **CLI `--stream`** — prints `text` deltas to stdout as they arrive, reasoning dimmed on stderr with `--think`, and reassembles the full ` thinking… response` wrapper before returning the raw response so log/context/`<RUN>` extraction stay identical to the non-stream path.
* **Web sandbox `--stream`** — `/api/tell` encodes each event as one NDJSON line (`reasoning`, `reasoning_end`, `text`, `done`, `error`); the browser decodes it and drives a collapsible reasoning header with a live `Thinking… Ns` timer that freezes on the first `text` if no `reasoning_end` arrives (codec: `packages/web/src/shared/chat-stream.ts`).

Both consumers rely on the **first-`text`-freezes-reasoning** rule because `reasoning_end` is not universal.

Sources: `ask.ts:5-55`, `ask.ts:73-75`.