// Pure NDJSON codec for the streaming `/api/tell` response, shared by the
// server (encode) and the browser client (decode) so both sides pin the same
// wire format. No React/DOM/node dependencies — unit-tested directly.

export type ChatStreamEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'reasoning_end' }
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: string };

export const CHAT_STREAM_MALFORMED_ERROR = 'Malformed stream event';

function parse_chat_stream_event(value: unknown): ChatStreamEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  switch (event['type']) {
    case 'reasoning':
    case 'text':
      return typeof event['text'] === 'string' ? { type: event['type'], text: event['text'] } : null;
    case 'reasoning_end':
      return { type: 'reasoning_end' };
    case 'done':
      return { type: 'done' };
    case 'error':
      return {
        type: 'error',
        error: typeof event['error'] === 'string' ? event['error'] : 'AI generation failed',
      };
    default:
      return null;
  }
}

/** Serializes one event as a single NDJSON line (trailing newline included). */
export function encode_chat_stream_event(event: ChatStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Splits a decoded network chunk into complete events, returning the trailing
 * partial line as `rest` for the caller to prepend to the next chunk. Empty
 * lines are skipped; malformed lines surface as an `error` event instead of
 * silently dropping answer text.
 */
export function decode_chat_stream_chunk(buffer: string): { events: ChatStreamEvent[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const events: ChatStreamEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      events.push({ type: 'error', error: CHAT_STREAM_MALFORMED_ERROR });
      continue;
    }
    events.push(parse_chat_stream_event(parsed) ?? { type: 'error', error: CHAT_STREAM_MALFORMED_ERROR });
  }
  return { events, rest };
}

/** Accumulated answer/reasoning text while a stream is being consumed. */
export type ChatStreamProgress = { text: string; reasoning: string };

/**
 * Reads an NDJSON streaming Response to completion, invoking `on_event` for
 * every event with the accumulated progress. Throws on `error` events and on
 * transport failures (including abort). The underlying stream is cancelled if
 * the consumer throws or the response is aborted.
 */
export async function consume_chat_stream(
  response: Response,
  on_event: (event: ChatStreamEvent, progress: ChatStreamProgress) => void,
): Promise<ChatStreamProgress> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Streaming response has no body');

  const decoder = new TextDecoder();
  const progress: ChatStreamProgress = { text: '', reasoning: '' };
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = decode_chat_stream_chunk(buffer);
      buffer = rest;
      for (const event of events) {
        switch (event.type) {
          case 'text':
            progress.text += event.text;
            on_event(event, progress);
            break;
          case 'reasoning':
            progress.reasoning += event.text;
            on_event(event, progress);
            break;
          case 'error':
            throw new Error(event.error);
          default:
            // reasoning_end / done: forwarded as-is for timer/state handling.
            on_event(event, progress);
            break;
        }
      }
    }
    return progress;
  } finally {
    // Abort the response on early exit (error event or consumer exception).
    await reader.cancel().catch(() => {
      /* already closed/aborted */
    });
  }
}
