import type { ApprovalPort } from './runtime-api';

/**
 * Read-only gate for research delegation (`<DELEGATE>`).
 *
 * Pure module on purpose: no builtins, no environment, no I/O — the browser
 * entry can re-export it and the Web can reuse the same predicate it already
 * pins in `guards.ts`.
 */

/** Commands a research child may run (deny-by-default, nothing else passes). */
const READ_ONLY_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'ls',
  'dir',
  'stat',
  'file',
  'wc',
  'diff',
  'grep',
  'rg',
  'ag',
  'git',
  'find',
  'sort',
  'tree',
  'pwd',
]);

/** Read-only `git` subcommands (everything else, e.g. `checkout`, is denied). */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'log',
  'diff',
  'show',
  'status',
  'blame',
  'ls-files',
  'rev-parse',
  'shortlog',
  'grep',
]);

/**
 * Returns true when a workspace-relative path points at secrets we never
 * expose: `.env*` (except `.env.example`), `.tell/**`, `.git/**`, `*.key`,
 * `*.pem`. Ported from the Web `guards.ts` so both hosts share one owner.
 *
 * @param rel_path - Workspace-relative path (forward slashes).
 * @returns True when the path is sensitive.
 */
export function is_sensitive_rel_path(rel_path: string): boolean {
  const normalized = rel_path.replace(/\\/g, '/').toLowerCase();
  if (normalized.startsWith('/') || normalized.includes('\0')) {
    return true;
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '.env.example') {
      continue;
    }
    if (segment === '.env' || segment.startsWith('.env.')) {
      return true;
    }
    if (segment === '.tell' || segment === '.git') {
      return true;
    }
    if (segment === 'id_rsa' || segment === 'id_dsa' || segment === 'id_ecdsa' || segment === 'id_ed25519') {
      return true;
    }
  }
  const base = segments[segments.length - 1] ?? '';
  if (base.endsWith('.key') || base.endsWith('.pem') || base.endsWith('.p12') || base.endsWith('.pfx')) {
    return true;
  }
  return false;
}

/**
 * Extracts path-like tokens from a shell script.
 *
 * Splits on whitespace and shell separators but keeps `:` (so
 * `HEAD:.env` stays one token and the deny-list can see the `.env`
 * inside it). Flags are kept — `--output=.env` must still match.
 *
 * @param script - Command script to tokenize.
 * @returns The candidate path tokens.
 */
export function script_path_tokens(script: string): string[] {
  const tokens: string[] = [];
  const parts = script.split(/[\s;&|()"'`=<>]+/);
  for (const part of parts) {
    const cleaned = part.trim().replace(/^[([{]+|[)\]}.,:;!?]+$/g, '');
    if (cleaned.length === 0) {
      continue;
    }
    tokens.push(cleaned);
    // Also keep the raw part: `HEAD:.env` cleaned keeps the colon half.
    if (cleaned !== part.trim() && part.trim().length > 0) {
      tokens.push(part.trim());
    }
  }
  return tokens;
}

/**
 * Normalizes a posix path lexically (no filesystem access, no builtins).
 *
 * Resolves `.`/`..` segments so an absolute token can be compared against
 * the host cwd without I/O. Symlinks are NOT resolved here — the host
 * approval still enforces the realpath outside-cwd gate afterwards.
 *
 * @param value - Posix path to normalize.
 * @returns The normalized absolute path.
 */
function normalize_posix_path(value: string): string {
  const parts = value.split('/');
  const kept: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') {
    } else if (part === '..') {
      kept.pop();
    } else {
      kept.push(part);
    }
  }
  return `/${kept.join('/')}`;
}

/**
 * Returns true when an absolute token stays inside the host cwd (lexically).
 *
 * Models are told the absolute cwd, so they emit absolute paths for files
 * right inside it. Denying those as "sensitive" would cripple research
 * children in the common case; the host approval still resolves the real
 * path afterwards, so outside-cwd escapes stay denied.
 *
 * @param token - Absolute path-like token from the command text.
 * @param cwd - Host working directory.
 * @returns True when the token is lexically inside the cwd.
 */
function is_token_inside_cwd(token: string, cwd: string): boolean {
  const base = normalize_posix_path(cwd);
  const target = normalize_posix_path(token);
  if (base === '/') {
    return true;
  } else if (target === base || target.startsWith(`${base}/`)) {
    return true;
  } else {
    return false;
  }
}

/**
 * Returns true when any token of a script touches a sensitive path.
 *
 * The check is substring-based on purpose: `git show HEAD:.env` never
 * resolves a path, so only the command text can catch it. `.env.example`
 * is never sensitive. This is a speed bump, not a guarantee (see task 050
 * Invariante 3): `grep -r "sk-" .` still passes.
 *
 * Absolute tokens fail closed without a cwd (they cannot be proven inside
 * the workspace). With a cwd, absolute tokens lexically inside it are left
 * to the allowlist and the host approval (which resolves the real path);
 * the `.env*`/`.tell`/`.git`/`*.key`/`*.pem` rules still apply inside.
 *
 * @param script - Command script to inspect.
 * @param cwd - Host working directory for absolute-token scope (optional).
 * @returns True when the script reads a known-sensitive path.
 */
export function script_touches_sensitive_path(script: string, cwd?: string): boolean {
  const lowered = script.toLowerCase();
  if (lowered.includes('.tell') || lowered.includes('.git')) {
    // Bare words like `tell`/`git` alone are not paths — require a separator.
    for (const token of script_path_tokens(script)) {
      const low = token.toLowerCase();
      if (low === '.tell' || low === '.git' || low.includes('.tell/') || low.includes('.git/')) {
        return true;
      }
      if (low.includes('/.tell') || low.includes('/.git')) {
        return true;
      }
    }
  }
  for (const token of script_path_tokens(script)) {
    const low = token.toLowerCase().replace(/^["']|["']$/g, '');
    if (low === '.env.example') {
      continue;
    }
    if (low.endsWith('.key') || low.endsWith('.pem') || low.endsWith('.p12') || low.endsWith('.pfx')) {
      return true;
    }
    // Bare private-key filenames apply everywhere, including in-cwd absolute
    // paths — otherwise the scope skip below would let `/cwd/id_rsa` through
    // while `id_rsa` stays denied.
    const base = low.split('/').pop() ?? '';
    if (base === 'id_rsa' || base === 'id_dsa' || base === 'id_ecdsa' || base === 'id_ed25519') {
      return true;
    }
    // Scope check on the original case: lowercasing above is for
    // case-insensitive secret names, but absolute paths are case-sensitive
    // on Linux — comparing a lowered token against the raw cwd would deny
    // every in-cwd absolute path containing an uppercase letter (e.g. a
    // `mktemp` dir), which is the common case since models are told the cwd.
    const bare = token.replace(/^["']|["']$/g, '');
    if (bare.startsWith('/') && cwd !== undefined && is_token_inside_cwd(bare, cwd)) {
      // Lexically inside the host cwd: the deny-list names above (extensions,
      // key basenames) already applied, but `.env*`/`.tell`/`.git` live in
      // the check below — re-run it on the cwd-relative remainder so
      // `/cwd/.env` still denies while `/cwd/notes.envelope.txt` allows.
      const base_norm = normalize_posix_path(cwd);
      const target_norm = normalize_posix_path(bare);
      const rel = target_norm.slice(base_norm.length).replace(/^\//, '');
      if (rel.length > 0 && is_sensitive_rel_path(rel)) {
        return true;
      }
      continue;
    }
    if (is_sensitive_rel_path(low)) {
      return true;
    }
    // Colon-joined references (`git show HEAD:.env`) never resolve a path,
    // so the whole token misses the deny-list: check the part after the
    // last colon too. Leading slashes are stripped so URL remainders
    // (`http://example.com`) stay allowed.
    // shortcut: colon-suffix only; `my.env.backup`-style substrings without a
    // colon stay allowed (documented gap, same family as the grep gaps).
    const colon_at = low.lastIndexOf(':');
    if (colon_at !== -1) {
      const suffix = low.slice(colon_at + 1).replace(/^\/+/, '');
      if (suffix.length > 0 && is_sensitive_rel_path(suffix)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Splits a script into whitespace-separated words (quotes kept simple).
 *
 * @param script - Command script.
 * @returns The words in order.
 */
function script_words(script: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(script)) !== null) {
    words.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return words.filter((word) => word.length > 0);
}

/**
 * Returns the base command of a script (`/bin/ls` → `ls`).
 *
 * @param script - Command script.
 * @returns The lowercase basename, or empty when absent.
 */
function base_command(script: string): string {
  const words = script_words(script.trim());
  const first = words[0] ?? '';
  if (first.length === 0) {
    return '';
  }
  const base = first.split('/').pop() ?? '';
  return base.toLowerCase();
}

/**
 * Returns true when a script redirects to a file or backgrounds a job.
 *
 * Fd duplication (`2>&1`, `1>&2`, `>&2`, `2>&-`) only merges already-open
 * descriptors — no file is created — so it stays allowed: models append
 * `2>&1` to almost every command. Anything else with `>`/`&` (`>file`,
 * `>>file`, `2>file`, `&>file`, `>&file`, trailing `&`, `&&`) still denies.
 *
 * @param script - Command script to inspect.
 * @returns True when the script writes a file or backgrounds.
 */
function has_file_redirect(script: string): boolean {
  for (let i = 0; i < script.length; i++) {
    if (script[i] === '>') {
      const next = script[i + 1] ?? '';
      const after = script[i + 2] ?? '';
      if (next === '&' && (after === '' || /[0-9-]/.test(after))) {
        i += 2;
      } else {
        return true;
      }
    } else if (script[i] === '&') {
      const prev = script[i - 1] ?? '';
      const next = script[i + 1] ?? '';
      if (prev === '>' && /[0-9-]/.test(next)) {
        // Fd-duplication target (`2>&1`) — vetted at the `>` above.
      } else {
        return true;
      }
    } else {
      // Not a redirect character — keep scanning.
    }
  }
  return false;
}

/**
 * Returns true when a script is read-only under the delegation allowlist.
 *
 * Order: sensitive paths deny first (even when the command would be
 * allowed), then metacharacter/write rules, then the command allowlist.
 * `ENV=.env; cat $ENV` denies on `;` (not a gap); `cat ${ENV}` passes
 * here (the `${}` gap, later caught by the strict risk profile on the Web).
 * Fd duplication (`2>&1`) is not a file redirect and stays allowed; every
 * other `>`/`&` still denies.
 *
 * @param script - Command script to classify.
 * @param cwd - Host working directory for absolute-token scope (optional).
 * @returns True when the script may run inside a research child.
 */
export function is_read_only_script(script: string, cwd?: string): boolean {
  const trimmed = script.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (script_touches_sensitive_path(trimmed, cwd)) {
    return false;
  }
  if (
    has_file_redirect(trimmed) ||
    trimmed.includes('|') ||
    trimmed.includes(';') ||
    trimmed.includes('&&') ||
    trimmed.includes('||') ||
    trimmed.includes('$(') ||
    trimmed.includes('`') ||
    trimmed.includes('<(')
  ) {
    return false;
  }
  const words = script_words(trimmed);
  const first = words[0] ?? '';
  if (first.includes('=')) {
    return false;
  }
  const base = base_command(trimmed);
  if (!READ_ONLY_COMMANDS.has(base)) {
    return false;
  }
  if (base === 'git') {
    const sub = (words[1] ?? '').toLowerCase().replace(/^-+/, '');
    if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) {
      return false;
    } else {
      // Allowed subcommand — fall through to flag checks below.
    }
  }
  if (base === 'find') {
    const lowered = ` ${trimmed.toLowerCase()} `;
    for (const flag of ['-delete', '-exec', '-execdir', '-ok', '-fprint', '-fls']) {
      if (lowered.includes(` ${flag}`) || lowered.includes(` ${flag}dir`)) {
        return false;
      }
    }
  }
  if (base === 'sort') {
    const lowered_words = words.map((word) => word.toLowerCase());
    if (lowered_words.includes('-o') || lowered_words.some((word) => word.startsWith('--output'))) {
      return false;
    } else {
      // Read-only sort — allowed.
    }
  }
  return true;
}

/**
 * Creates an approval port that enforces read-only research before the host.
 *
 * Denies sensitive paths first, then anything outside the allowlist, and only
 * then delegates to the host approval (so outside-cwd and high-risk gates
 * keep working). With no inner approval, allowed scripts are approved.
 * Absolute tokens are scoped by the host cwd when given (lexically; the
 * host still resolves the real path).
 *
 * @param inner - Host approval to consult for allowed scripts.
 * @param cwd - Host working directory for absolute-token scope (optional).
 * @returns An `ApprovalPort` for a research child.
 */
export function create_read_only_approval(inner?: ApprovalPort, cwd?: string): ApprovalPort {
  return async (request: { script: string }): Promise<'approved' | 'denied' | 'skipped'> => {
    if (script_touches_sensitive_path(request.script, cwd)) {
      return 'denied';
    }
    if (!is_read_only_script(request.script, cwd)) {
      return 'denied';
    }
    if (inner === undefined) {
      return 'approved';
    } else {
      return inner(request);
    }
  };
}
