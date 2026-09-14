import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

/** Max bytes of file content injected per mention before truncation. */
export const MAX_MENTION_BYTES = 64 * 1024;
/** Prefix bytes probed for NUL when deciding a file is binary. */
export const BINARY_PROBE_BYTES = 8 * 1024;
/** Max depth of a directory tree listing (the directory itself is depth 0). */
export const TREE_MAX_DEPTH = 3;
/** Max entries listed per directory before a `[N more entries]` marker. */
export const MAX_TREE_ENTRIES_PER_DIR = 200;
/** Directories never descended into when listing a mentioned directory. */
export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', '.env', '.tell']);
/** Trailing characters stripped from a mention token (sentence punctuation). */
export const TRAILING_PUNCT_CHARS = '.,;:!?)]}';
/** Placeholder shielding an escaped `\@` from the mention regex. */
const ESCAPED_AT_PLACEHOLDER = '\u0000AT_ESCAPED\u0000';
/** Timeout for the outside-cwd read confirmation prompt. */
const CONFIRM_TIMEOUT_MS = 120_000;

/** Options for {@link expand_mentions}. */
export type ExpandMentionsOptions = {
  /** Accepted for symmetry with the CLI flags; never bypasses the outside-cwd prompt. */
  yes?: boolean;
};

/**
 * Returns true when a resolved path escapes the working directory.
 *
 * Both the lexical path and — when resolvable — its symlink target are
 * checked, so a symlink inside `cwd` pointing outside still counts as
 * outside.
 *
 * @param resolved - Lexically resolved absolute path of the mention.
 * @param cwd - Working directory mentions resolve against.
 * @returns True when the path is outside `cwd`.
 */
export function is_outside_cwd(resolved: string, cwd: string): boolean {
  const base = path.resolve(cwd);
  const relative = path.relative(base, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    try {
      const real_base = fs.realpathSync(base);
      const real_target = fs.realpathSync(resolved);
      const real_relative = path.relative(real_base, real_target);
      if (real_relative === '' || (!real_relative.startsWith('..') && !path.isAbsolute(real_relative))) {
        return false;
      } else {
        return true;
      }
    } catch {
      return false;
    }
  } else {
    return true;
  }
}

/**
 * Writes a yellow warning to stderr, matching the CLI warning style.
 *
 * @param message - Warning text without color codes.
 */
function warn_mention(message: string): void {
  process.stderr.write(`\x1b[33mWarning: ${message}\x1b[0m\n`);
}

/**
 * Asks interactively whether an outside-cwd path may be read.
 *
 * Never auto-approves: the `yes` flag and pipes do not bypass this prompt.
 * Without a TTY the read is denied.
 *
 * @param display - Mention token as typed by the user, for display.
 * @returns True when the user confirmed with `y`/`yes`.
 */
function confirm_outside_read(display: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return Promise.resolve(false);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    process.stderr.write(`External file requested:\n${display}\n`);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: boolean): void => {
        if (settled) {
          return;
        } else {
          settled = true;
          rl.close();
          resolve(value);
        }
      };
      const timer = setTimeout(() => done(false), CONFIRM_TIMEOUT_MS);
      rl.question('\x1b[31mRead this file? [y/N] \x1b[0m', (answer: string) => {
        clearTimeout(timer);
        const normalized = answer.trim().toUpperCase();
        done(normalized === 'Y' || normalized === 'YES');
      });
    });
  }
}

/**
 * Strips sentence punctuation from the end of a mention token.
 *
 * @param raw - Raw token captured by the mention regex.
 * @returns The token and the stripped suffix (suffix is re-appended after expansion).
 */
function split_trailing_punct(raw: string): { token: string; suffix: string } {
  let end = raw.length;
  while (end > 0 && TRAILING_PUNCT_CHARS.includes(raw[end - 1] ?? '')) {
    end -= 1;
  }
  if (end === raw.length) {
    return { token: raw, suffix: '' };
  } else {
    return { token: raw.slice(0, end), suffix: raw.slice(end) };
  }
}

/**
 * Reads at most `limit + 1` bytes so truncation is detectable without
 * loading huge files fully into memory.
 *
 * @param file - Absolute file path.
 * @param limit - Max bytes to keep.
 * @returns The prefix bytes and whether the file is longer than `limit`.
 */
function read_bounded_bytes(file: string, limit: number): { data: Buffer; truncated: boolean } {
  const fd = fs.openSync(file, 'r');
  try {
    const chunks: Buffer[] = [];
    const CHUNK_SIZE = 16 * 1024;
    let remaining = limit + 1;
    while (remaining > 0) {
      const size = Math.min(CHUNK_SIZE, remaining);
      const buffer = Buffer.alloc(size);
      const read = fs.readSync(fd, buffer, 0, size, null);
      if (read <= 0) {
        break;
      } else {
        chunks.push(buffer.subarray(0, read));
        remaining -= read;
      }
    }
    const data = Buffer.concat(chunks);
    if (data.length > limit) {
      return { data: data.subarray(0, limit), truncated: true };
    } else {
      return { data, truncated: false };
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Builds the injected block for a regular file, or null when the token
 * must pass through intact (a warning was already emitted).
 *
 * @param file - Absolute file path.
 * @param display - Mention token as typed, used as the block label.
 * @returns The `File:` block, or null to leave the token intact.
 */
function read_file_block(file: string, display: string): string | null {
  let probe: { data: Buffer; truncated: boolean };
  try {
    probe = read_bounded_bytes(file, Math.max(MAX_MENTION_BYTES, BINARY_PROBE_BYTES));
  } catch (error) {
    warn_mention(
      `mention "@${display}" is not readable (${error instanceof Error ? error.message : String(error)}), leaving as-is`,
    );
    return null;
  }
  if (probe.data.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    warn_mention(`mention "@${display}" looks binary, leaving as-is`);
    return null;
  } else {
    const content = probe.data.toString('utf8');
    const body = probe.truncated ? `${content}\n[truncated]` : content;
    return `File: ${display}\n\`\`\`\n${body}\n\`\`\``;
  }
}

/**
 * Recursively collects ASCII tree lines for a directory.
 *
 * @param dir - Absolute directory path.
 * @param prefix - Line prefix for the current level.
 * @param depth - Current depth (the mentioned directory is 0).
 * @param visited - Real paths already listed (symlink-loop guard).
 * @param lines - Accumulator for output lines.
 */
function collect_tree_lines(dir: string, prefix: string, depth: number, visited: Set<string>, lines: string[]): void {
  if (depth > TREE_MAX_DEPTH) {
    return;
  } else {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const visible = entries
      .filter((entry) => !SKIP_DIR_NAMES.has(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        } else {
          return a.name.localeCompare(b.name);
        }
      });
    const shown = visible.slice(0, MAX_TREE_ENTRIES_PER_DIR);
    shown.forEach((entry, index) => {
      const last = index === shown.length - 1 && visible.length <= MAX_TREE_ENTRIES_PER_DIR;
      const branch = last ? '└── ' : '├── ';
      const child_prefix = prefix + (last ? '    ' : '│   ');
      if (entry.isDirectory()) {
        lines.push(`${prefix}${branch}${entry.name}/`);
        if (depth < TREE_MAX_DEPTH) {
          const full = path.join(dir, entry.name);
          let real = full;
          try {
            real = fs.realpathSync(full);
          } catch {
            real = full;
          }
          if (!visited.has(real)) {
            visited.add(real);
            collect_tree_lines(full, child_prefix, depth + 1, visited, lines);
          } else {
            lines.push(`${child_prefix}[symlink loop]`);
          }
        } else {
          // Max depth reached — children intentionally omitted.
        }
      } else {
        lines.push(`${prefix}${branch}${entry.name}`);
      }
    });
    if (visible.length > shown.length) {
      lines.push(`${prefix}└── [${visible.length - shown.length} more entries]`);
    } else {
      // All entries listed — nothing to summarize.
    }
  }
}

/**
 * Builds the injected block for a directory, or null when the token must
 * pass through intact (a warning was already emitted).
 *
 * @param dir - Absolute directory path.
 * @param display - Mention token as typed, used as the block label.
 * @returns The `Directory:` block, or null to leave the token intact.
 */
function read_directory_block(dir: string, display: string): string | null {
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      return null;
    } else {
      const lines: string[] = [];
      const visited = new Set<string>();
      try {
        visited.add(fs.realpathSync(dir));
      } catch {
        visited.add(dir);
      }
      collect_tree_lines(dir, '', 0, visited, lines);
      return `Directory: ${display}\n${lines.join('\n')}`;
    }
  } catch (error) {
    warn_mention(
      `mention "@${display}" is not readable (${error instanceof Error ? error.message : String(error)}), leaving as-is`,
    );
    return null;
  }
}

/**
 * Expands `@path` mentions in a prompt into file contents or directory trees.
 *
 * Rules: `@file` inlines the file; `@dir/` lists the tree; missing,
 * unreadable, or binary targets emit a stderr warning and pass through
 * intact; `\@` is a literal `@`. Paths resolve against `cwd`; absolute
 * paths are accepted, but targets outside `cwd` need interactive
 * confirmation even with `yes` (denied without a TTY).
 *
 * @param prompt - User prompt text (already combined stdin/ctx text).
 * @param cwd - Working directory mentions resolve against.
 * @param options - Expansion options (`yes` never bypasses the outside-cwd prompt).
 * @returns The prompt with mention blocks injected.
 */
export async function expand_mentions(
  prompt: string,
  cwd: string,
  options: ExpandMentionsOptions = {},
): Promise<string> {
  void options.yes;
  const base = cwd || process.cwd();
  const shielded = prompt.replace(/\\@/g, ESCAPED_AT_PLACEHOLDER);
  const pattern = /(?:^|\s)@([^\s`]+)/g;
  let result = '';
  let cursor = 0;
  for (;;) {
    const match = pattern.exec(shielded);
    if (!match || match[1] === undefined || match.index === undefined) {
      break;
    } else {
      const token_raw = match[1];
      const full_match = match[0];
      const prefix = full_match.slice(0, full_match.length - token_raw.length - 1);
      const { token, suffix } = split_trailing_punct(token_raw);
      if (!token) {
      } else {
        const resolved = path.resolve(base, token);
        let stat: fs.Stats | null = null;
        try {
          stat = fs.statSync(resolved);
        } catch {
          stat = null;
        }
        if (!stat) {
          warn_mention(`mention "@${token}" not found, leaving as-is`);
        } else {
          if (!stat.isFile() && !stat.isDirectory()) {
            warn_mention(`mention "@${token}" is not a regular file or directory, leaving as-is`);
          } else {
            if (is_outside_cwd(resolved, base)) {
              const allowed = await confirm_outside_read(token);
              if (!allowed) {
                warn_mention(`mention "@${token}" is outside the working directory, leaving as-is`);
                continue;
              } else {
                // User confirmed the outside-cwd read — expand below.
              }
            } else {
              // Inside the working directory — no confirmation needed.
            }
            const block = stat.isFile() ? read_file_block(resolved, token) : read_directory_block(resolved, token);
            if (!block) {
            } else {
              result += `${shielded.slice(cursor, match.index)}${prefix}${block}${suffix}`;
              cursor = match.index + full_match.length;
            }
          }
        }
      }
    }
  }
  result += shielded.slice(cursor);
  return result.split(ESCAPED_AT_PLACEHOLDER).join('@');
}
