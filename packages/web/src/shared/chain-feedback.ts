// Pure chain-feedback helpers (no React): shared by ChatSection rendering and tests.
// Chain-loop execution outputs are appended as role:'user' messages so the LLM
// keeps the tool output in context; the UI renders them on the LLM side.
// The wording itself is owned by @tell-ai/core (browser-safe subpath, no
// builtin imports), so the offline fallback loop can never drift from the server.

import { format_command_skipped, format_executed_command, parse_command_feedback } from '@tell-ai/core';

/** Feedback cards start minimized (collapsed) by default; the user expands per card. */
export const FEEDBACK_COLLAPSE_CHARS = 400;

export function defaultFeedbackOpen(_content: string): boolean {
  return false;
}

export type FeedbackKind = 'executed' | 'skipped';

export interface ParsedFeedback {
  kind: FeedbackKind;
  command: string;
  output: string;
}

export interface ChainMessageLike {
  id: string;
  role: string;
  content: string;
}

export function isChainFeedback(content: string): boolean {
  // The core owns the vocabulary: `parse_command_feedback` knows every
  // header it formats (executed, failed with its exit code, skipped,
  // cancelled), so the browser never hardcodes a wording the server chain
  // might not produce.
  return parse_command_feedback(content) !== null;
}

export function isChainFeedbackMessage(m: { role: string; content: string }): boolean {
  return m.role === 'user' && isChainFeedback(m.content);
}

/** Formats the `Executed command` record for the local (offline) chain loop. */
export function formatExecutedFeedback(command: string, output: string): string {
  return format_executed_command(command, output);
}

/** Formats the `Skipped by user` record for the local (offline) chain loop. */
export function formatSkippedFeedback(command: string): string {
  return format_command_skipped(command);
}

/** Split `Executed command:\n{cmd}\nOutput:\n{out}` / `Skipped by user:\n{cmd}`. */
export function parseFeedback(content: string): ParsedFeedback | null {
  if (!isChainFeedback(content)) return null;
  const parsed = parse_command_feedback(content);
  if (parsed === null) return null;
  return {
    kind: parsed.kind === 'skipped' ? 'skipped' : 'executed',
    command: parsed.script,
    output: parsed.output,
  };
}

/**
 * Find the feedback linked to the assistant message at `fromIndex`:
 * the first chain-feedback message after it, stopping at the next genuine
 * user prompt (non-feedback user message) or the end of the list.
 * Returns the message index or -1.
 */
export function findLinkedFeedbackIndex(messages: ChainMessageLike[], fromIndex: number): number {
  for (let j = fromIndex + 1; j < messages.length; j++) {
    const m = messages[j];
    if (!m) continue;
    if (m.role !== 'user') continue;
    if (isChainFeedback(m.content)) return j;
    return -1;
  }
  return -1;
}

/** Presentational side: chain feedback renders on the LLM (left) side. */
export function displaySideFor(m: { role: string; content: string }): 'user' | 'assistant' {
  if (m.role === 'user' && isChainFeedback(m.content)) return 'assistant';
  return m.role === 'user' ? 'user' : 'assistant';
}
