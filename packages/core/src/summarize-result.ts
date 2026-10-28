import type { ModelPort, Redactor } from './runtime-api';

/** Which text won the repost rule. */
export type SummarizeUsed = 'summary' | 'original';

/** Result of one summarize attempt (target is a goal, never a hard cut). */
export type SummarizeResult = {
  /** Redacted text to climb (`summary` when it beats the target, else the redacted original). */
  text: string;
  /** Whether the summary or the original won. */
  used: SummarizeUsed;
};

/**
 * Builds the summarize prompt for one delegation result.
 *
 * Pure on purpose (test-pinned wording lives here, not in the runner): the
 * model must return plain findings, never new tags or commands.
 *
 * @param target - Character target for the summary.
 * @returns The user message sent to the model.
 */
export function build_summarize_message(text: string, target: number): string {
  return (
    `Summarize the delegation result below concisely in at most ${target} characters. ` +
    `Keep facts, names and numbers; drop repetition. Answer in plain text, no tags, no commands.\n\nResult:\n${text}`
  );
}

/** System prompt of the one-shot summarizer (no delegation, no tools). */
export const SUMMARIZE_SYSTEM = 'You are a concise summarizer. Summarize only, never act.';

/**
 * Summarizes one delegation result with a single model call.
 *
 * The target is a goal, not a cap: the summary wins only when it is
 * non-empty and strictly shorter than the target; otherwise (too long,
 * empty, failure) the redacted original climbs — even when the original is
 * larger than the target. Redaction runs before any length check, so a
 * secret cut mid-cap never leaks.
 *
 * @param model - Silent model port for the single summarize call.
 * @param text - Raw child final text.
 * @param target - Character target (e.g. 2 KiB).
 * @param redact - Single redactor (runs before the target check).
 * @returns The climbing text plus which side won.
 */
export async function summarize_result(
  model: ModelPort,
  text: string,
  target: number,
  redact: Redactor,
): Promise<SummarizeResult> {
  const original = redact(text);
  if (original.length <= target) {
    return { text: original, used: 'original' };
  } else {
    // Over target — one summarize attempt below.
  }
  let summary_raw: string;
  try {
    summary_raw = await model.ask(build_summarize_message(original, target), {
      system: SUMMARIZE_SYSTEM,
      stream: false,
    });
  } catch {
    return { text: original, used: 'original' };
  }
  const summary = redact(summary_raw).trim();
  if (summary.length === 0 || summary.length >= target) {
    return { text: original, used: 'original' };
  } else {
    return { text: summary, used: 'summary' };
  }
}
