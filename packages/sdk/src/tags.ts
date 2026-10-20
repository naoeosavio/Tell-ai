/** One `<RUN>` block found in a model answer. */
type RunBlock = {
  /** Index of the opening tag. */
  start: number;
  /** Index just after the closing tag. */
  end: number;
  /** Raw command body between the tags. */
  body: string;
};

/** Opening tag matcher (case-insensitive, keeps the original indices). */
const RUN_OPENER = /<RUN>/gi;
/** Closing tag matcher (case-insensitive, keeps the original indices). */
const RUN_CLOSER = /<\/RUN>/gi;

/**
 * Finds every `<RUN>` block in a text.
 *
 * A block ends at the **last** closing tag before the next opening tag, so a
 * command whose body contains the literal `</RUN>` (e.g. `echo "</RUN>"`) is
 * not truncated mid-script. An unterminated block is ignored.
 *
 * @param text - Text to scan.
 * @returns The blocks in order.
 */
function find_run_blocks(text: string): RunBlock[] {
  const blocks: RunBlock[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    RUN_OPENER.lastIndex = cursor;
    const opener = RUN_OPENER.exec(text);
    if (opener === null) {
      break;
    }
    const body_start = opener.index + opener[0].length;
    RUN_OPENER.lastIndex = body_start;
    const next_opener = RUN_OPENER.exec(text);
    const limit = next_opener === null ? text.length : next_opener.index;
    RUN_CLOSER.lastIndex = body_start;
    let last_closer: RegExpExecArray | null = null;
    for (;;) {
      const closer = RUN_CLOSER.exec(text);
      if (closer === null || closer.index >= limit) {
        break;
      }
      last_closer = closer;
    }
    if (last_closer === null) {
      cursor = body_start;
    } else {
      blocks.push({
        start: opener.index,
        end: last_closer.index + last_closer[0].length,
        body: text.slice(body_start, last_closer.index),
      });
      cursor = last_closer.index + last_closer[0].length;
    }
  }
  return blocks;
}

/**
 * Removes every markdown code fence from a text.
 *
 * @param text - Text to clean.
 * @returns The text without fenced blocks.
 */
export function strip_markdown_code_blocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

/**
 * Removes every balanced `<think>` block from a text.
 *
 * @param text - Text to clean.
 * @returns The text without reasoning blocks.
 */
export function strip_think_tags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Removes every `<RUN>` block from a text.
 *
 * @param text - Text to clean.
 * @returns The text without command blocks.
 */
export function strip_run_tags(text: string): string {
  let out = '';
  let cursor = 0;
  for (const block of find_run_blocks(text)) {
    out += text.slice(cursor, block.start);
    cursor = block.end;
  }
  return `${out}${text.slice(cursor)}`.trim();
}

/**
 * Neutralizes angle brackets inside reasoning text.
 *
 * @param text - Reasoning text.
 * @returns The text with `‹`/`›` instead of `<`/`>`.
 */
export function sanitize_reasoning(text: string): string {
  return text.replace(/</g, '‹').replace(/>/g, '›');
}

/**
 * Extracts every command a model asked to run.
 *
 * Fenced code blocks are ignored (a command inside a fence is documentation,
 * not an instruction). Every `<RUN>` block yields one script — the array is
 * empty only when the answer asked for no command at all.
 *
 * @param text - Model answer.
 * @returns The requested scripts and the answer without them.
 */
export function extract_runs(text: string): { scripts: string[]; visible: string } {
  const sanitized = strip_markdown_code_blocks(text);
  const scripts = find_run_blocks(sanitized)
    .map((block) => block.body.trim())
    .filter((body) => body.length > 0);
  return { scripts, visible: strip_run_tags(text) };
}
