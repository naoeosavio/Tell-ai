import * as fs from 'node:fs';
import * as path from 'node:path';

const PREVIEW_MAX_CHARS = 60;
const SNIPPET_MAX_CHARS = 120;
const SNIPPET_CONTEXT_CHARS = 20;
const HASH_ID_LENGTH = 16;
const SHORT_ID_LENGTH = 8;
const SESSION_NAME_PATTERN = /^conversation_(.+)\.txt$/;
const SESSION_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}/;

/** A saved context file on disk, addressable by recency index `@N`. */
export type ContextEntry = { file: string; id: string; mtimeMs: number };

/** A saved conversation log (one `tell` invocation), newest first. */
export type HistoryEntry = {
  file: string;
  mtimeMs: number;
  date: string;
  model: string;
  preview: string;
};

/** One search hit: the ref that reopens the entry plus the matched line. */
export type SearchResult = { ref: string; kind: 'context' | 'conversation'; snippet: string };

/**
 * Strips ANSI escape sequences (CSI/OSC/2-char ESC) and other control
 * characters from stored text before it is echoed. Log files contain raw
 * command stdout/stderr and model output, so a poisoned log could otherwise
 * spoof the terminal or write to the clipboard (OSC 52) via `--history`.
 *
 * Both the 7-bit (ESC-prefixed) and 8-bit C1 forms are removed: some
 * terminals interpret U+009B as CSI and U+009D as OSC, so leaving the C1
 * range (`\x7f`–`\x9f`) in place would reopen the same injection.
 */
function sanitize_text(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?<=>!]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\x1b/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

/**
 * Single-line echo of an untrusted label (context id/file name): applies
 * {@link sanitize_text} and also drops tab/newline, so a stored file name
 * cannot forge extra stderr lines. Used by `--ctx` when it announces
 * `Using context:`/`Created context:` or lists ambiguous id matches.
 */
export function sanitize_label(text: string): string {
  return sanitize_text(text).replace(/[\t\n]/g, '');
}

function read_text(file: string): string {
  try {
    return sanitize_text(fs.readFileSync(file, 'utf8').trim());
  } catch {
    return '';
  }
}

/** Shortens long random/hash ids for display; leaves human names untouched. */
export function short_id(id: string): string {
  return /^[0-9a-f]+$/i.test(id) && id.length >= HASH_ID_LENGTH ? id.slice(0, SHORT_ID_LENGTH) : id;
}

function format_age(mtimeMs: number): string {
  const MS_PER_MINUTE = 60_000;
  const MINUTES_PER_HOUR = 60;
  const HOURS_PER_DAY = 24;
  const minutes = Math.floor((Date.now() - mtimeMs) / MS_PER_MINUTE);
  if (minutes < 1) return 'just now';
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m ago`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${hours}h ago`;
  return `${Math.floor(hours / HOURS_PER_DAY)}d ago`;
}

/** `conversation_<ISO>.txt` timestamps become a `YYYY-MM-DD HH:MM` label. */
function format_session_date(timestamp: string): string {
  if (!SESSION_TIMESTAMP_PATTERN.test(timestamp)) {
    // Non-ISO suffix (renamed/copied file) — no trustworthy date to show.
    return '(unknown date)';
  }
  const date = timestamp.slice(0, 10);
  const time = timestamp.slice(11, 16).replace(/-/g, ':');
  return `${date} ${time}`;
}

function clip(text: string): string {
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS - 3)}...` : text;
}

/**
 * First user turn of a stored conversation, as a short preview. Handles both
 * the inline (`User: text`) and marker (`User:\ntext`) layouts, so a preview
 * is the actual prompt text instead of the bare `User:` marker line.
 */
function preview_from_text(text: string): string {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => /^User:/i.test(line));
  if (index === -1) {
    // No user marker (empty or corrupt store) — nothing to preview.
    return '';
  }
  const marker = lines[index] ?? '';
  const inline = marker.slice(marker.indexOf(':') + 1).trim();
  const next = index + 1 < lines.length ? (lines[index + 1] ?? '').trim() : '';
  return clip(inline || next);
}

/** Conversation log files of `dir`, newest first (mtime, then name). */
function session_files(dir: string): { file: string; mtimeMs: number }[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => SESSION_NAME_PATTERN.test(name));
  } catch {
    return [];
  }
  const files: { file: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      files.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // Entry vanished between readdir and stat (or is unreadable) — skip it.
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
  return files;
}

/**
 * Lists saved conversation logs, newest first, with model, date and a
 * short preview of the first prompt.
 *
 * @param dir - History directory (`~/.ai/tell_history`).
 */
export function list_sessions(dir: string): HistoryEntry[] {
  return session_files(dir).map((session) => {
    const name = path.basename(session.file);
    const timestamp = SESSION_NAME_PATTERN.exec(name)?.[1] ?? '';
    const text = read_text(session.file);
    const model = /^Model:\s*(.+)$/m.exec(text)?.[1]?.trim() || '(unknown)';
    return {
      file: session.file,
      mtimeMs: session.mtimeMs,
      date: format_session_date(timestamp),
      model,
      preview: preview_from_text(text),
    };
  });
}

/** First matching line of `text`, clipped around the match; null when absent. */
function find_snippet(text: string, needle: string): string | null {
  const lowered = text.toLowerCase();
  const position = lowered.indexOf(needle.toLowerCase());
  if (position === -1) {
    // No match in this entry.
    return null;
  }
  const line_start = text.lastIndexOf('\n', position) + 1;
  const line_end = text.indexOf('\n', position);
  const line = text.slice(line_start, line_end === -1 ? undefined : line_end).trim();
  if (line.length <= SNIPPET_MAX_CHARS) return line;
  const at = Math.max(0, line.toLowerCase().indexOf(needle.toLowerCase()) - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(line.length, at + SNIPPET_MAX_CHARS);
  const start_marker = at > 0 ? '...' : '';
  const end_marker = end < line.length ? '...' : '';
  return `${start_marker}${line.slice(at, end).trim()}${end_marker}`;
}

function search_files(
  term: string,
  prefix: '@' | '%',
  kind: SearchResult['kind'],
  files: { file: string }[],
): SearchResult[] {
  const results: SearchResult[] = [];
  files.forEach((entry, index) => {
    const snippet = find_snippet(read_text(entry.file), term);
    if (snippet !== null) results.push({ ref: `${prefix}${index}`, kind, snippet });
  });
  return results;
}

/**
 * Case-insensitive search over saved contexts; hits are re-addressable
 * with the returned `@N` ref.
 *
 * @param term    - Term to look for (case-insensitive).
 * @param entries - Context entries, newest first (`list_context_entries`).
 */
export function search_contexts(term: string, entries: ContextEntry[]): SearchResult[] {
  return search_files(term, '@', 'context', entries);
}

/**
 * Case-insensitive search over saved conversation logs; hits are
 * re-addressable with the returned `%N` ref.
 *
 * @param term - Term to look for (case-insensitive).
 * @param dir  - History directory (`~/.ai/tell_history`).
 */
export function search_sessions(term: string, dir: string): SearchResult[] {
  return search_files(term, '%', 'conversation', session_files(dir));
}

/** Highlights the matched term on TTY stdout; plain text elsewhere. */
function highlight(snippet: string, term: string): string {
  const at = snippet.toLowerCase().indexOf(term.toLowerCase());
  if (at === -1 || process.stdout.isTTY !== true) return snippet;
  const before = snippet.slice(0, at);
  const match = snippet.slice(at, at + term.length);
  const after = snippet.slice(at + term.length);
  return `${before}\x1b[33m${match}\x1b[0m${after}`;
}

/**
 * Prints search hits as `ref  kind  snippet` rows; each ref reopens the
 * entry via `--history @N` / `--history %N`.
 */
export function print_search_results(results: SearchResult[], term: string): void {
  const ref_width = Math.max(0, ...results.map((result) => result.ref.length));
  const kind_width = Math.max(0, ...results.map((result) => result.kind.length));
  for (const result of results) {
    const columns = `${result.ref.padEnd(ref_width)}  ${result.kind.padEnd(kind_width)}`;
    console.log(`${columns}  ${highlight(result.snippet, term)}`);
  }
}

/**
 * Prints the combined `--history` listing: the contexts table
 * (`@N | id | age | preview`) followed by the conversations table
 * (`%N | date | model | preview`), both newest first.
 */
export function print_history_list(sessions: HistoryEntry[], contexts: ContextEntry[]): void {
  if (contexts.length === 0) {
    console.log('No saved contexts.');
  } else {
    console.log('Contexts:');
    const rows = contexts.map((entry, index) => ({
      ref: `@${index}`,
      id: short_id(entry.id),
      age: format_age(entry.mtimeMs),
      preview: preview_from_text(read_text(entry.file)),
    }));
    const ref_width = Math.max(0, ...rows.map((row) => row.ref.length));
    const id_width = Math.max(0, ...rows.map((row) => row.id.length));
    const age_width = Math.max(0, ...rows.map((row) => row.age.length));
    for (const row of rows) {
      const columns = `${row.ref.padEnd(ref_width)}  ${row.id.padEnd(id_width)}  ${row.age.padEnd(age_width)}`;
      console.log(`${columns}  ${row.preview}`);
    }
  }

  console.log('');
  if (sessions.length === 0) {
    console.log('No conversations.');
  } else {
    console.log('Conversations:');
    const rows = sessions.map((session, index) => ({
      ref: `%${index}`,
      date: session.date,
      model: session.model,
      preview: session.preview,
    }));
    const ref_width = Math.max(0, ...rows.map((row) => row.ref.length));
    const date_width = Math.max(0, ...rows.map((row) => row.date.length));
    const model_width = Math.max(0, ...rows.map((row) => row.model.length));
    for (const row of rows) {
      const columns = `${row.ref.padEnd(ref_width)}  ${row.date.padEnd(date_width)}  ${row.model.padEnd(model_width)}`;
      console.log(`${columns}  ${row.preview}`);
    }
  }
}

/**
 * Reprints a context or conversation entry in full (cat to stdout).
 *
 * @param file - Entry file, addressed by `--history @N` / `--history %N`.
 */
export function show_entry(file: string): void {
  console.log(read_text(file) || '(empty)');
}
