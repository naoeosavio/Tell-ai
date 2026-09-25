import { generateText, streamText } from 'ai';
import type { SDKConfig } from './config';
import { get_model } from './models';
import { sanitize_reasoning } from './tags';

/** A single event from a streaming completion, in emission order. */
export type AskStreamEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'reasoning_end' }
  | { type: 'text'; text: string };

/** Streaming input: a one-shot prompt or a full multi-turn conversation. */
export type AskStreamInput = string | Array<{ role: 'user' | 'assistant'; content: string }>;

export interface AskInstance {
  ask(message: string, options: { system: string; stream: false }): Promise<string>;
  ask_stream(input: AskStreamInput, options: { system: string }): AsyncIterable<AskStreamEvent>;
}

/**
 * Consumes `streamText`'s stream exactly once and re-emits only the
 * reasoning/text deltas as AskStreamEvents. Provider `error` parts are thrown
 * so callers keep the same error handling as `ask`.
 */
async function* stream_events(
  model: any,
  reasoning: string,
  input: AskStreamInput,
  system: string,
  provider_options?: Record<string, any>,
): AsyncGenerator<AskStreamEvent> {
  const gen_options: any = {
    model,
    instructions: system,
    reasoning,
    ...(provider_options ? { providerOptions: provider_options } : {}),
    ...(typeof input === 'string' ? { prompt: input } : { messages: input }),
  };
  const result = streamText({
    ...gen_options,
    // The AI SDK default would console.error the raw provider error, dumping
    // request bodies and response headers (cookies) to stderr/server logs.
    // Errors still propagate through the stream for the caller to format.
    onError: () => {},
  });
  for await (const part of result.stream) {
    switch (part.type) {
      case 'text-delta':
        yield { type: 'text', text: part.text };
        break;
      case 'reasoning-delta':
        yield { type: 'reasoning', text: sanitize_reasoning(part.text) };
        break;
      case 'reasoning-end':
        yield { type: 'reasoning_end' };
        break;
      case 'error':
        throw part.error;
      default:
        // Tool calls, sources and framework lifecycle parts are irrelevant here.
        break;
    }
  }
}

export async function create_ask_ai(modelSpec: string, config: SDKConfig): Promise<AskInstance> {
  const handle = await get_model(modelSpec, config);
  const reasoning = handle.fast ? 'none' : handle.reasoning;

  return {
    ask: async (message: string, options: { system: string; stream: false }) => {
      const gen_options: any = {
        model: handle.model,
        instructions: options.system,
        prompt: message,
        reasoning,
        ...(handle.providerOptions ? { providerOptions: handle.providerOptions } : {}),
      };
      const result = await generateText(gen_options);
      const model_reasoning = result.finalStep.reasoningText;
      const safe_reasoning = model_reasoning ? sanitize_reasoning(model_reasoning) : '';
      return safe_reasoning ? `<think>${safe_reasoning}</think>\n${result.text}` : result.text;
    },
    ask_stream: (input: AskStreamInput, options: { system: string }) =>
      stream_events(handle.model, reasoning, input, options.system, handle.providerOptions),
  };
}
