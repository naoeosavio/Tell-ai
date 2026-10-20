import type { AskInstance } from './ask';
import { strip_think_tags } from './tags';

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer for a terminal assistant. Your job is to compress conversation history while preserving all critical context.

INCLUDE:
- The user's original requests, goals, and questions
- Key commands that were run and their outcomes (success/failure)
- Important files created, modified, or examined (paths, purposes)
- Decisions made, conclusions reached, and rationale
- Errors encountered and how they were resolved
- Any configuration changes or system state modifications
- Code snippets the assistant provided that the user may want to reference later

OMIT:
- Redundant command output (keep only the essential parts)
- Verbose logs, full file contents, or large dumps
- Repeated questions or clarifications
- Trivial conversational filler

FORMAT:
- Use a compact, structured style with brief bullet points or short paragraphs
- Group related information by topic
- Be concise but complete — someone reading only this summary should understand the full history

Aim for 20-40 lines of text unless the conversation was extremely complex.`;

/**
 * Compresses a conversation into a summary the caller can persist.
 *
 * The summarizer's own reasoning (`<think>` block) never reaches the summary:
 * the CLI stores this text on disk and feeds it back as context, so a leaked
 * reasoning block would be replayed to the model forever.
 *
 * @param ai - Ask instance used to summarize.
 * @param text - Conversation history to compress.
 * @returns The summary, prefixed with the context marker.
 */
export async function summarize_context(ai: AskInstance, text: string): Promise<string> {
  const summary = await ai.ask(`Please summarize this conversation history:\n\n${text}`, {
    system: SUMMARY_SYSTEM_PROMPT,
    stream: false,
  });
  return `[Context summary — previous conversation condensed to save tokens]\n\n${strip_think_tags(summary)}`;
}
