import { strip_markdown_code_blocks } from '@tell-ai/sdk/pure';

/**
 * Tag scanner + delegation protocol for sub-tell delegation.
 *
 * Browser-safe on purpose (pure strings only): the browser entry re-exports
 * this module so the Web fallback loop detects tags without the SDK growing
 * a second protocol. Direction is CLI → core → SDK: the SDK stays a leaf and
 * only lends its pre-existing `strip_markdown_code_blocks` here.
 */

/** One tag block found in a model answer. */
type TagBlock = {
  /** Index of the opening tag. */
  start: number;
  /** Index just after the closing tag. */
  end: number;
  /** Raw body between the tags. */
  body: string;
};

/** Kind of delegation a model can request. */
export type DelegationKind = 'research' | 'build';

/** One delegation block found in a model answer. */
export type DelegationBlock = {
  /** Whether the block is `<DELEGATE>` (research) or `<SUBTASK>` (build). */
  kind: DelegationKind;
  /** Index of the opening tag. */
  start: number;
  /** Index just after the closing tag. */
  end: number;
  /** Raw objective body between the tags. */
  body: string;
};

/**
 * Escapes a literal tag for a case-insensitive regex.
 *
 * @param tag - Literal tag text (e.g. `<RUN>`).
 * @returns The escaped pattern source.
 */
function escape_tag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds every `open`…`close` block in a text.
 *
 * A block ends at the **last** closing tag before the next opening tag, so a
 * body containing the literal closer (e.g. `echo "</RUN>"`) is not truncated
 * mid-script. Matching is case-insensitive and strict: the opener must equal
 * `open` exactly (no space before `>`). An unterminated block is ignored.
 *
 * @param text - Text to scan.
 * @param open - Opening tag literal (e.g. `<RUN>`).
 * @param close - Closing tag literal (e.g. `</RUN>`).
 * @returns The blocks in order.
 */
export function find_blocks(text: string, open: string, close: string): TagBlock[] {
  const opener_re = new RegExp(escape_tag(open), 'gi');
  const closer_re = new RegExp(escape_tag(close), 'gi');
  const blocks: TagBlock[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    opener_re.lastIndex = cursor;
    const opener = opener_re.exec(text);
    if (opener === null) {
      break;
    }
    const body_start = opener.index + opener[0].length;
    opener_re.lastIndex = body_start;
    const next_opener = opener_re.exec(text);
    const limit = next_opener === null ? text.length : next_opener.index;
    closer_re.lastIndex = body_start;
    let last_closer: RegExpExecArray | null = null;
    for (;;) {
      const closer = closer_re.exec(text);
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
 * Maps a delegation tag name to its kind.
 *
 * @param tag - Tag name with or without brackets (e.g. `DELEGATE`).
 * @returns `research` for `<DELEGATE>`, `build` for `<SUBTASK>`, null otherwise.
 */
export function delegation_kind(tag: string): DelegationKind | null {
  const bare = tag
    .trim()
    .toLowerCase()
    .replace(/[<>/\s]/g, '');
  if (bare === 'delegate') {
    return 'research';
  } else if (bare === 'subtask') {
    return 'build';
  } else {
    return null;
  }
}

/**
 * Finds every delegation block (`<DELEGATE>` or `<SUBTASK>`) in a text.
 *
 * The scan is strict like `<RUN>`: `<DELEGATE >` (space before `>`) does not
 * open a block, and matching is case-insensitive. A body containing the
 * literal closer (e.g. `echo "</RUN>"` inside `<DELEGATE>`) still ends at the
 * last closer before the next opener of the same kind.
 *
 * @param text - Text to scan (already stripped of fenced code by the caller).
 * @returns The blocks in document order.
 */
function find_delegation_blocks(text: string): DelegationBlock[] {
  const delegate_blocks = find_blocks(text, '<DELEGATE>', '</DELEGATE>').map((block) => ({
    kind: 'research' as DelegationKind,
    start: block.start,
    end: block.end,
    body: block.body,
  }));
  const subtask_blocks = find_blocks(text, '<SUBTASK>', '</SUBTASK>').map((block) => ({
    kind: 'build' as DelegationKind,
    start: block.start,
    end: block.end,
    body: block.body,
  }));
  const all = [...delegate_blocks, ...subtask_blocks];
  all.sort((left, right) => left.start - right.start);
  return all;
}

/**
 * Extracts the first delegation request from a model answer.
 *
 * Fenced code blocks and empty bodies are ignored; at most one tag per answer
 * is honored (the first in document order). `<RUN>` inside the objective is
 * kept verbatim here — the delegation runner sanitizes it before it becomes
 * a child prompt.
 *
 * At most one request is honored (the first in document order). `extras`
 * counts the further non-empty tags so the host can warn instead of dropping
 * them in silence.
 *
 * @param text - Model answer.
 * @returns The kind, the trimmed objective, the answer without the tags and
 *   how many further tags were ignored.
 */
export function extract_delegation(text: string): {
  kind: DelegationKind | null;
  objective: string;
  visible: string;
  extras: number;
} {
  const sanitized = strip_markdown_code_blocks(text);
  const blocks = find_delegation_blocks(sanitized)
    .map((block) => ({ kind: block.kind, objective: block.body.trim(), start: block.start }))
    .filter((entry) => entry.objective.length > 0);
  const first = blocks[0];
  const visible = strip_delegation_tags(text);
  if (first === undefined) {
    return { kind: null, objective: '', visible, extras: 0 };
  } else {
    return { kind: first.kind, objective: first.objective, visible, extras: blocks.length - 1 };
  }
}

/**
 * Removes every `<DELEGATE>` and `<SUBTASK>` block from a text.
 *
 * Fenced code blocks are kept verbatim (documentation, not instructions) —
 * the same rule detection uses in `extract_delegation`. Without this, a
 * fenced example would be detected as nothing but still deleted here.
 *
 * @param text - Text to clean.
 * @returns The text without delegation blocks outside fences.
 */
export function strip_delegation_tags(text: string): string {
  const fence_re = /(```[\s\S]*?```)/g;
  let out = '';
  let cursor = 0;
  for (;;) {
    fence_re.lastIndex = cursor;
    const fence = fence_re.exec(text);
    const segment_end = fence === null ? text.length : fence.index;
    const segment = text.slice(cursor, segment_end);
    let segment_out = '';
    let segment_cursor = 0;
    for (const block of find_delegation_blocks(segment)) {
      segment_out += segment.slice(segment_cursor, block.start);
      segment_cursor = block.end;
    }
    segment_out += segment.slice(segment_cursor);
    out += segment_out;
    if (fence === null) {
      break;
    }
    out += fence[0];
    cursor = fence.index + fence[0].length;
  }
  return out.trim();
}
