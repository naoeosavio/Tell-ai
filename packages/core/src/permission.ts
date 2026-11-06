/**
 * Graded permission verdict for command execution.
 *
 * Pure module: no builtins, no environment, no I/O. The browser entry can
 * re-export it. `assess_base_risk` stays as the observer; this layer owns
 * the class and the effect. Hosts only realize `ask`.
 *
 * The low class is the readonly set: research allows low and denies medium
 * and above through `is_read_only_script` in `read-only.ts`. No new set
 * lives here for delegation. The `strict` flag adds the Web-only system
 * reads (`/etc`, `/boot`).
 */

import { has_file_redirect, is_token_inside_cwd, script_path_tokens } from './read-only';

/** Graded class of one script (maximum over its parts). */
export type PermissionClass = 'low' | 'medium' | 'high' | 'forbidden';

/** What the host must do with one script. */
export type PermissionEffect = 'allow' | 'ask' | 'deny' | 'block';

/** Verdict for one script: class, effect and the rule that set it. */
export type PermissionVerdict = {
  /** Graded class of the script. */
  class: PermissionClass;
  /** Host action for the class and flags. */
  effect: PermissionEffect;
  /** Stable rule id (for example `git-force-push`). */
  rule: string;
};

/** Options for `classify_script`. */
export type ClassifyPermissionOptions = {
  /** Working directory for the scope check (absent means no scope check). */
  cwd?: string | undefined;
  /** When true, system reads (`/etc`, `/boot`) are forbidden (Web). */
  strict?: boolean | undefined;
};

/** Input for `decide_permission`. */
export type DecidePermissionInput = {
  /** Command script to decide about. */
  script: string;
  /** True when `-y` is present (low and medium run). */
  auto?: boolean | undefined;
  /** True when `--require-approval` is present (high asks). */
  approve_high?: boolean | undefined;
  /** False when `--no-exec` is present (blocks every class first). */
  enabled?: boolean | undefined;
  /** Working directory for the scope check. */
  cwd?: string | undefined;
  /** When true, system reads are forbidden (Web). */
  strict?: boolean | undefined;
};

/** Rank of each class (higher means more dangerous). */
const CLASS_RANK: Record<PermissionClass, number> = { low: 0, medium: 1, high: 2, forbidden: 3 };

/** Read-only base commands (no side effect). */
const LOW_BASE_COMMANDS = new Set([
  'ls',
  'tree',
  'pwd',
  'echo',
  'printf',
  'which',
  'type',
  'stat',
  'file',
  'wc',
  'du',
  'df',
  'head',
  'tail',
  'diff',
  'grep',
  'rg',
  'ag',
  'jq',
  'fd',
  'dir',
  'cat',
  'less',
  'more',
  'nl',
  'tac',
  'date',
  'whoami',
  'hostname',
  'uname',
  'id',
  'uptime',
]);

/** Read-only `git` subcommands. */
const LOW_GIT_SUBCOMMANDS = new Set([
  'log',
  'diff',
  'show',
  'status',
  'blame',
  'ls-files',
  'rev-parse',
  'shortlog',
  'grep',
  'fetch',
]);

/** Build directories whose `rm` stays reversible (medium). */
const BUILD_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', '__pycache__', '.venv', 'tmp']);

/** Interpreters with an eval flag. */
const INTERPRETER_COMMANDS = new Set(['node', 'deno', 'bun', 'python', 'python3', 'perl', 'ruby', 'php', 'lua']);

/** Eval flags that run a code string. */
const EVAL_FLAGS = new Set(['-e', '-c', '-r', '--eval', 'eval']);

/** Substrings that make eval code forbidden (network, decode, exec). */
const EVAL_FORBIDDEN_SUBSTRINGS = [
  'http://',
  'https://',
  "'https'",
  '"https"',
  'urllib',
  'requests.',
  'ftplib',
  'socket',
  'base64',
  'eval(',
  'exec(',
  'system(',
  'popen(',
];

/** Network upload flags (curl and wget). */
const UPLOAD_FLAGS = new Set([
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-ascii',
  '-F',
  '--form',
  '-T',
  '--upload-file',
  '--upload',
]);

/** Mutating verbs for cloud CLIs. */
const AWS_MUTATING_VERBS = new Set([
  'rm',
  'delete',
  'put',
  'create',
  'update',
  'apply',
  'destroy',
  'terminate',
  'remove',
]);
const GCLOUD_MUTATING_VERBS = new Set(['create', 'update', 'delete', 'apply', 'deploy', 'add', 'remove', 'rm']);

/** Medium `git` subcommands (reversible writes). */
const MEDIUM_GIT_SUBCOMMANDS = new Set([
  'add',
  'commit',
  'switch',
  'stash',
  'pull',
  'merge',
  'tag',
  'push',
  'checkout',
  'clone',
]);

/** System paths whose write is forbidden. */
const SYSTEM_PATH_PATTERN = /\/(etc|usr|boot)(?:\/|$)/;

/** System paths whose read is forbidden when `strict` is set (Web). */
const STRICT_SYSTEM_READ_PATTERN = /\/(etc|boot)(?:\/|$)/;

/** Exfiltration tools and reverse-shell markers (whole script). */
const WHOLE_EXFIL_PATTERN = /(?:^|[\s;&|(){}<>])(?:nc|ncat|netcat|socat)\b|\/dev\/tcp\b|\bbash\s+-i\b/;

/** Remote-code shapes over the whole script (pipe, process swap, shell string). */
const WHOLE_REMOTE_PATTERNS = [
  /(?:curl|wget|base64)\b[^|;&]*\|\s*(?:sh|bash|dash|zsh|ksh|python3?|python|perl|ruby|php|node)\b/,
  /<\(\s*(?:curl|wget|base64)\b/,
  /(?:^|[\s;&|])(?:sh|bash|dash|zsh|ksh)\b[^;&|]*\s-c\b[^;&|]*(?:curl|wget|https?:\/\/)/,
  /\beval\b[^;&|]*(?:\$\(|https?:\/\/)/,
];

/** Privileged container shapes (whole or part). */
const PRIVILEGED_DOCKER_PATTERN = /--privileged\b/;

/** Docker host-root mount (`-v /...:...`). */
const DOCKER_ROOT_MOUNT_PATTERN = /(?:-v|--volume)\s*\/[^:]*:/;

/** OS destroy markers. */
const DESTROY_BINARIES_PATTERN = /\b(?:mkfs|shutdown|reboot|halt|poweroff)\b/;

/** Max passes for nested substitution removal (bounds the loop). */
const MAX_SUBSTITUTION_PASSES = 10;

/**
 * Splits words like a shell (quotes kept simple).
 *
 * @param statement - Single statement text.
 * @returns The words in order.
 */
function statement_words(statement: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(statement)) !== null) {
    words.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return words.filter((word) => word.length > 0);
}

/**
 * Returns the base command of a statement (`/bin/ls` becomes `ls`).
 *
 * @param statement - Single statement text.
 * @returns The lowercase basename, or empty when absent or env-prefixed.
 */
function base_command_of(statement: string): string {
  const words = statement_words(statement.trim());
  const first = words[0] ?? '';
  if (first === '' || first.includes('=')) {
    return '';
  }
  return (first.split('/').pop() ?? '').toLowerCase();
}

/**
 * Splits a script into statements without running it.
 *
 * Splits on `;`, `&&`, `||`, `|`, `&` and newline when unquoted and outside
 * `$(...)`, backticks and `<(...)`. Reports an opaque parse on unterminated
 * quotes, backticks, substitutions and on heredoc (`<<`).
 *
 * @param script - Raw command script.
 * @returns The trimmed non-empty parts plus the opaque flag.
 */
export function split_statements(script: string): { parts: string[]; opaque: boolean } {
  const normalized = script.replace(/\r\n/g, '\n');
  const parts: string[] = [];
  let current = '';
  let in_single = false;
  let in_double = false;
  let in_backtick = false;
  let depth = 0;
  let opaque = false;
  let index = 0;
  const size = normalized.length;

  function push_part(): void {
    const trimmed = current.trim();
    if (trimmed !== '') {
      parts.push(trimmed);
    }
    current = '';
  }

  while (index < size) {
    const ch = normalized[index] ?? '';
    const next = normalized[index + 1] ?? '';
    if (ch === '\\' && next === '\n') {
      current += ' ';
      index += 2;
    } else if (ch === '\\' && !in_single && next !== '') {
      current += ch + next;
      index += 2;
    } else if (in_single) {
      current += ch;
      if (ch === "'") {
        in_single = false;
      }
      index += 1;
    } else if (in_backtick) {
      current += ch;
      if (ch === '`') {
        in_backtick = false;
      }
      index += 1;
    } else if (in_double) {
      current += ch;
      if (ch === '"') {
        in_double = false;
      } else if (ch === '`') {
        in_backtick = true;
      } else if (ch === '$' && next === '(') {
        depth += 1;
        current += next;
        index += 1;
      } else if (ch === ')' && depth > 0) {
        depth -= 1;
      }
      index += 1;
    } else if (ch === "'") {
      in_single = true;
      current += ch;
      index += 1;
    } else if (ch === '"') {
      in_double = true;
      current += ch;
      index += 1;
    } else if (ch === '`') {
      in_backtick = true;
      current += ch;
      index += 1;
    } else if (ch === '$' && next === '(') {
      depth += 1;
      current += ch + next;
      index += 2;
    } else if ((ch === '<' || ch === '>') && next === '(') {
      depth += 1;
      current += ch + next;
      index += 2;
    } else if (ch === '<' && next === '<') {
      opaque = true;
      current += ch + next;
      index += 2;
    } else if (ch === ')' && depth > 0) {
      depth -= 1;
      current += ch;
      index += 1;
    } else if (depth > 0) {
      current += ch;
      index += 1;
    } else if (ch === '\n' || ch === ';') {
      push_part();
      index += 1;
    } else if (ch === '&' && next === '&') {
      push_part();
      index += 2;
    } else if (ch === '|' && next === '|') {
      push_part();
      index += 2;
    } else if (ch === '|' || ch === '&') {
      push_part();
      index += 1;
    } else {
      current += ch;
      index += 1;
    }
  }
  push_part();
  if (in_single || in_double || in_backtick || depth > 0) {
    opaque = true;
  }
  return { parts, opaque };
}

/**
 * Extracts nested commands from substitutions.
 *
 * Removes `$(...)`, `<(...)`, `>(...)` and backticks (arithmetic `$((...))`
 * is blanked, not classified). Leftover openers mean an opaque parse.
 *
 * @param statement - Single statement text.
 * @returns The outer text plus the inner bodies and the opaque flag.
 */
function extract_substitutions(statement: string): { outer: string; inners: string[]; opaque: boolean } {
  let outer = statement.replace(/\$\(\([^()]*\)\)/g, ' ');
  const inners: string[] = [];
  for (let pass = 0; pass < MAX_SUBSTITUTION_PASSES; pass += 1) {
    let found = false;
    outer = outer.replace(/\$\(([^()]*)\)/g, (_whole: string, inner: string): string => {
      found = true;
      inners.push(inner);
      return ' ';
    });
    outer = outer.replace(/[<>]\(([^()]*)\)/g, (_whole: string, inner: string): string => {
      found = true;
      inners.push(inner);
      return ' ';
    });
    outer = outer.replace(/`([^`]*)`/g, (_whole: string, inner: string): string => {
      found = true;
      inners.push(inner);
      return ' ';
    });
    if (!found) {
      break;
    }
  }
  let opaque = false;
  if (outer.includes('$(') || outer.includes('<(') || outer.includes('`')) {
    opaque = true;
  }
  return { outer, inners, opaque };
}

/**
 * Returns true when a basename names a credential file.
 *
 * Covers `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` and the `id_*`
 * glob, plus `*.pem`, `*.key` and `*.p12` endings (globs included).
 *
 * @param base - Lowercase basename.
 * @returns True when the name is a credential.
 */
function is_credential_basename(base: string): boolean {
  if (base.startsWith('id_')) {
    return true;
  } else {
    return base.endsWith('.pem') || base.endsWith('.key') || base.endsWith('.p12');
  }
}

/**
 * Returns true when a basename matches a known credential name or glob.
 *
 * Exact names (`id_rsa`, `x.pem`) match directly. Patterns with glob
 * characters (`id_*`, `i?_rsa`, `*.pem`) match when they accept a known
 * credential name or a `x.pem`, `x.key`, `x.p12` shape.
 *
 * @param base - Lowercase basename (may hold glob characters).
 * @returns True when the name is a credential.
 */
function matches_credential_basename(base: string): boolean {
  if (is_credential_basename(base)) {
    return true;
  }
  if (!/[*?[]/.test(base)) {
    return false;
  }
  const source = base
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  let pattern: RegExp;
  try {
    pattern = new RegExp(`^(?:${source})$`, 'i');
  } catch {
    return false;
  }
  if (['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'].some((name) => pattern.test(name))) {
    return true;
  } else {
    return pattern.test('x.pem') || pattern.test('x.key') || pattern.test('x.p12');
  }
}

/**
 * Returns true when one token names a credential path.
 *
 * Task-exact list: `.env` (except `.env.example`), `id_*` basenames,
 * `.aws/credentials`, `*.pem`, `*.key` and `.tell/**`. A leading `@`
 * names an upload file (`curl -d @.env`). A colon suffix is checked too
 * (`git show HEAD:.env`). Quote splicing (`'.en'v`) is removed by the
 * caller before the check.
 *
 * @param token - Lowercase token.
 * @returns True when the token is a credential path.
 */
function is_credential_token(token: string): boolean {
  const candidate = token.startsWith('@') && token.length > 1 ? token.slice(1) : token;
  if (candidate === '.env.example') {
    return false;
  }
  if (
    candidate === '.env' ||
    candidate.startsWith('.env.') ||
    candidate.startsWith('.env*') ||
    candidate.startsWith('.env?')
  ) {
    return true;
  }
  const base = candidate.split('/').pop() ?? '';
  if (base !== '' && matches_credential_basename(base)) {
    return true;
  }
  if (candidate.includes('.aws/credentials')) {
    return true;
  }
  if (token === '.tell' || token.startsWith('.tell/') || token.includes('/.tell/') || token.endsWith('/.tell')) {
    return true;
  }
  const colon_at = token.lastIndexOf(':');
  if (colon_at !== -1) {
    const suffix = token.slice(colon_at + 1).replace(/^\/+/, '');
    if (suffix !== '' && suffix !== token && is_credential_token(suffix)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when a script names a credential path anywhere.
 *
 * Credential reads are forbidden even inside the workspace. Unlike the
 * read-only gate, plain absolute paths never count: only task names do.
 * Otherwise every outside read would collapse to forbidden instead of
 * medium.
 *
 * @param script - Command script to inspect.
 * @returns True when the script names a credential.
 */
function touches_credential_path(script: string): boolean {
  const dequoted = script.replace(/['"]/g, '');
  for (const raw of script_path_tokens(dequoted)) {
    const token = raw.toLowerCase();
    if (token === '') {
    } else if (is_credential_token(token)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when a path token escapes the working directory.
 *
 * `/tmp` counts as inside. `~` and `$HOME` count as outside (fail-closed).
 * Tokens with globs or variables are skipped, except `~` and `$HOME`.
 *
 * @param statement - Statement text without substitutions.
 * @param cwd - Working directory.
 * @returns True when any path token resolves outside `cwd`.
 */
function touches_outside_cwd(statement: string, cwd: string): boolean {
  const base = cwd.trim().replace(/\/+$/, '') || '/';
  if (base === '') {
    return false;
  }
  for (const raw of script_path_tokens(statement)) {
    const token = raw.replace(/^["']|["']$/g, '');
    if (token === '' || token.startsWith('-')) {
      continue;
    }
    if (token.includes('://')) {
      continue;
    }
    if (/[*?$[\]{}()|;&<>"'`]/.test(token)) {
      if (/^(~|\$HOME|\$\{HOME\})/.test(token)) {
        return true;
      } else {
        continue;
      }
    }
    if (/^(~|\$HOME|\$\{HOME\})(\/|$)/.test(token)) {
      return true;
    }
    const absolute = token.startsWith('/') ? token : `${base}/${token}`;
    if (is_token_inside_cwd(absolute, '/tmp')) {
      continue;
    }
    if (is_token_inside_cwd(absolute, base)) {
    } else {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when a statement names an absolute path outside `/tmp`.
 *
 * Without a working directory the scope check cannot run, but an absolute
 * path outside `/tmp` is never inside an unknown workspace. URLs and flags
 * never count.
 *
 * @param statement - Statement text without substitutions.
 * @returns True when an absolute non-tmp path is present.
 */
function touches_absolute_path(statement: string): boolean {
  for (const raw of script_path_tokens(statement)) {
    const token = raw.replace(/^["']|["']$/g, '');
    if (token === '' || token.startsWith('-') || token.includes('://')) {
      continue;
    } else if (!token.startsWith('/')) {
      continue;
    }
    if (!is_token_inside_cwd(token, '/tmp')) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when `rm` removes only build directories.
 *
 * @param words - Statement words.
 * @returns True when every path arg is a build directory name.
 */
function is_build_only_rm(words: string[]): boolean {
  let seen_path = false;
  for (const word of words.slice(1)) {
    if (word.startsWith('-')) {
      continue;
    }
    if (word === '--') {
      continue;
    }
    seen_path = true;
    const cleaned = word.replace(/\/+$/, '');
    const base = (cleaned.split('/').pop() ?? '').toLowerCase();
    if (!BUILD_DIRS.has(base)) {
      return false;
    }
  }
  return seen_path;
}

/**
 * Returns the eval code after the flag, or null when no eval flag exists.
 *
 * @param words - Statement words.
 * @returns The code text, or null.
 */
function eval_code_of(words: string[]): string | null {
  for (let index = 1; index < words.length; index += 1) {
    if (EVAL_FLAGS.has(words[index] ?? '')) {
      return words.slice(index + 1).join(' ');
    }
  }
  return null;
}

/**
 * Tests one low (read-only) statement.
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the statement is read-only.
 */
function is_low_read(statement: string, words: string[]): boolean {
  if (words.length === 0 || (words[0] ?? '').includes('=')) {
    return false;
  }
  const base = base_command_of(statement);
  if (LOW_BASE_COMMANDS.has(base)) {
    return true;
  }
  if (base === 'find') {
    return !/\s-(delete|exec|execdir|ok|fprint|fls)\b/.test(` ${statement} `);
  }
  if (base === 'sort') {
    return !words.some((word) => word === '-o' || word.startsWith('--output'));
  }
  if (base === 'git') {
    const sub = (words[1] ?? '').replace(/^-+/, '').toLowerCase();
    return LOW_GIT_SUBCOMMANDS.has(sub);
  }
  if (base === 'gh') {
    return (words[1] ?? '').toLowerCase() === 'pr' && (words[2] ?? '').toLowerCase() === 'view';
  }
  if (base === 'docker') {
    const sub = (words[1] ?? '').toLowerCase();
    return sub === 'ps' || sub === 'images';
  }
  if (base === 'npm') {
    const sub = (words[1] ?? '').toLowerCase();
    return sub === 'ls' || sub === 'list';
  }
  if (base === 'pip' || base === 'pip3') {
    return (words[1] ?? '').toLowerCase() === 'list';
  }
  if (base === 'node') {
    return words.some((word) => word === '-v' || word === '--version');
  }
  if (base === 'make') {
    return words.some((word) => word === '-n');
  }
  if (base === 'base64') {
    return true;
  } else {
    return false;
  }
}

/**
 * Tests one medium local-write statement.
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the write is local and reversible.
 */
function is_medium_write(statement: string, words: string[]): boolean {
  const base = base_command_of(statement);
  if (['mkdir', 'touch', 'cp', 'mv', 'ln', 'tee', 'install'].includes(base)) {
    return true;
  }
  if (base === 'sed' && words.slice(1).some((word) => word === '-i' || word.startsWith('-i'))) {
    return true;
  }
  if ((base === 'chmod' || base === 'chown') && !words.slice(1).some((word) => word === '-R' || word === '-r')) {
    return true;
  }
  if (base === 'sort' && words.some((word) => word === '-o' || word.startsWith('--output'))) {
    return true;
  }
  if (base === 'rm' && is_build_only_rm(words)) {
    return true;
  } else {
    return false;
  }
}

/**
 * Tests one medium VCS statement (reversible history writes).
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the VCS write is reversible.
 */
function is_medium_vcs(statement: string, words: string[]): boolean {
  if (base_command_of(statement) !== 'git') {
    return false;
  }
  const sub = (words[1] ?? '').replace(/^-+/, '').toLowerCase();
  if (!MEDIUM_GIT_SUBCOMMANDS.has(sub)) {
    return false;
  }
  const args = words.slice(2).join(' ');
  if (sub === 'commit' && /--amend\b/.test(args)) {
    return false;
  }
  if (sub === 'push' && /--force\b|\s-f(?:\s|$)/.test(` ${args} `)) {
    return false;
  }
  if (sub === 'checkout' && /(?:^|\s)--(?:\s|$)/.test(` ${args} `)) {
    return false;
  }
  if (sub === 'stash' && /\b(drop|clear)\b/.test(args)) {
    return false;
  } else {
    return true;
  }
}

/**
 * Tests one medium install statement (registry code).
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the install names registry code only.
 */
function is_medium_install(statement: string, words: string[]): boolean {
  const base = base_command_of(statement);
  const args = words.slice(2).join(' ');
  const has_remote = /git\+|:\/\//.test(args);
  if (base === 'npm' || base === 'bun') {
    const sub = (words[1] ?? '').toLowerCase();
    if ((sub === 'install' || sub === 'ci') && !has_remote) {
      return true;
    }
    return sub === 'run';
  }
  if (base === 'pip' || base === 'pip3') {
    return (words[1] ?? '').toLowerCase() === 'install' && !has_remote;
  }
  if (base === 'cargo') {
    return (words[1] ?? '').toLowerCase() === 'add';
  }
  if (base === 'go') {
    return (words[1] ?? '').toLowerCase() === 'get';
  }
  if (base === 'tsc') {
    return true;
  } else {
    return false;
  }
}

/**
 * Tests one medium network-read statement (plain GET).
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the client downloads without upload flags.
 */
function is_medium_network_read(statement: string, words: string[]): boolean {
  const base = base_command_of(statement);
  if (base !== 'curl' && base !== 'wget') {
    return false;
  }
  const args = words.slice(1);
  for (const word of args) {
    if (UPLOAD_FLAGS.has(word)) {
      return false;
    }
  }
  const joined = ` ${args.join(' ')} `;
  if (/\s-X\s+(POST|PUT|DELETE|PATCH)\b/i.test(joined) || /\s--request\s+(POST|PUT|DELETE|PATCH)\b/i.test(joined)) {
    return false;
  } else {
    return true;
  }
}

/**
 * Tests one medium process statement (env readout or plain export).
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the statement only reads or sets plain env.
 */
function is_medium_process(statement: string, words: string[]): boolean {
  const base = base_command_of(statement);
  if (base === 'env' || base === 'printenv') {
    return true;
  }
  if (/\bLD_PRELOAD\b/.test(statement)) {
    return false;
  }
  if (base === 'export') {
    return true;
  }
  return words.length > 0 && (words[0] ?? '').includes('=');
}

/**
 * Tests one medium eval statement (clean code string).
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when eval code names no network, decode or exec primitive.
 */
function is_medium_eval(statement: string, words: string[]): boolean {
  if (!INTERPRETER_COMMANDS.has(base_command_of(statement))) {
    return false;
  }
  const code = eval_code_of(words);
  if (code === null) {
    return false;
  }
  const lowered = code.toLowerCase();
  return !EVAL_FORBIDDEN_SUBSTRINGS.some((marker) => lowered.includes(marker));
}

/**
 * Tests one high destructive statement.
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the statement destroys beyond a build directory.
 */
function is_high_destructive(statement: string, words: string[]): boolean {
  const base = base_command_of(statement);
  if (base === 'rm') {
    return !is_build_only_rm(words);
  }
  if (base === 'find') {
    return /\s-(delete|exec|execdir|ok)\b/.test(` ${statement} `);
  }
  if (base !== 'git') {
    return false;
  }
  const sub = (words[1] ?? '').replace(/^-+/, '').toLowerCase();
  const args = words.slice(2).join(' ');
  if (sub === 'clean') {
    return true;
  }
  if (sub === 'reset' && /--hard\b/.test(args)) {
    return true;
  }
  if (sub === 'checkout' && /(?:^|\s)--(?:\s|$)/.test(` ${args} `)) {
    return true;
  }
  if (sub === 'restore' || sub === 'rebase') {
    return true;
  }
  if (sub === 'branch' && /(?:^|\s)-D\b/.test(` ${args} `)) {
    return true;
  }
  if (sub === 'commit' && /--amend\b/.test(args)) {
    return true;
  }
  if (sub === 'push' && /--force\b|\s-f(?:\s|$)/.test(` ${args} `)) {
    return true;
  }
  if (sub === 'stash' && /\b(drop|clear)\b/.test(args)) {
    return true;
  } else {
    return false;
  }
}

/**
 * Tests one high network-write statement.
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the client uploads or copies to a remote host.
 */
function is_high_network_write(statement: string, words: string[]): boolean {
  const base = base_command_of(statement);
  if (base === 'curl' || base === 'wget') {
    const args = words.slice(1);
    if (args.some((word) => UPLOAD_FLAGS.has(word))) {
      return true;
    }
    const joined = ` ${args.join(' ')} `;
    return /\s-X\s+(POST|PUT|DELETE|PATCH)\b/i.test(joined) || /\s--request\s+(POST|PUT|DELETE|PATCH)\b/i.test(joined);
  }
  if (base === 'scp') {
    return true;
  }
  if (base === 'rsync') {
    return words.slice(1).some((word) => word.includes(':'));
  } else {
    return false;
  }
}

/**
 * Tests one high privilege statement.
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the statement needs privilege or acts outside the run.
 */
function is_high_privilege(statement: string, words: string[]): boolean {
  const base = base_command_of(statement);
  if (base === 'sudo' || base === 'doas' || base === 'pkexec') {
    return true;
  }
  if (base === 'systemctl' || base === 'service' || base === 'crontab' || base === 'at') {
    return true;
  }
  if ((base === 'chmod' || base === 'chown') && words.slice(1).some((word) => word === '-R' || word === '-r')) {
    return true;
  }
  if (base === 'kill' || base === 'pkill' || base === 'killall' || base === 'ssh') {
    return true;
  }
  if (base === 'exec' || base === 'xargs') {
    return true;
  } else {
    return false;
  }
}

/**
 * Tests one high container statement.
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the statement changes external container state.
 */
function is_high_container(statement: string, words: string[]): boolean {
  if (base_command_of(statement) !== 'docker') {
    return false;
  }
  const sub = (words[1] ?? '').toLowerCase();
  if (sub === 'run' || sub === 'push') {
    return true;
  } else {
    return sub === 'system' && (words[2] ?? '').toLowerCase() === 'prune';
  }
}

/**
 * Tests one high publish statement.
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the statement publishes a package.
 */
function is_high_publish(statement: string, words: string[]): boolean {
  return base_command_of(statement) === 'npm' && (words[1] ?? '').toLowerCase() === 'publish';
}

/**
 * Tests one high orchestrator statement.
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the statement mutates shared infrastructure.
 */
function is_high_orchestrator(statement: string, words: string[]): boolean {
  const base = base_command_of(statement);
  if (base === 'kubectl') {
    const sub = (words[1] ?? '').toLowerCase();
    return sub === 'apply' || sub === 'delete';
  }
  if (base === 'terraform') {
    const sub = (words[1] ?? '').toLowerCase();
    return sub === 'apply' || sub === 'destroy';
  }
  if (base === 'aws') {
    return words.slice(1).some((word) => AWS_MUTATING_VERBS.has(word.toLowerCase()));
  }
  if (base === 'gcloud') {
    return words.slice(1).some((word) => GCLOUD_MUTATING_VERBS.has(word.toLowerCase()));
  } else {
    return false;
  }
}

/**
 * Tests one high remote-install statement.
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the install fetches code outside the registry.
 */
function is_high_remote_install(statement: string, words: string[]): boolean {
  const base = base_command_of(statement);
  const args = words.slice(2).join(' ');
  const has_remote = /git\+|:\/\//.test(args);
  if (!has_remote) {
    return false;
  }
  if (base === 'pip' || base === 'pip3') {
    return (words[1] ?? '').toLowerCase() === 'install';
  }
  if (base === 'npm' || base === 'bun') {
    const sub = (words[1] ?? '').toLowerCase();
    return sub === 'install' || sub === 'ci';
  } else {
    return false;
  }
}

/**
 * Tests one high system statement.
 *
 * @param statement - Outer statement text.
 * @returns True when the statement touches low-level system state.
 */
function is_high_system(statement: string): boolean {
  const base = base_command_of(statement);
  if (base === 'truncate') {
    return true;
  } else {
    return /\bLD_PRELOAD\b/.test(statement);
  }
}

/**
 * Tests one forbidden eval statement.
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when eval code names network, decode, exec or secrets.
 */
function is_forbidden_eval(statement: string, words: string[]): boolean {
  if (!INTERPRETER_COMMANDS.has(base_command_of(statement))) {
    return false;
  }
  const code = eval_code_of(words);
  if (code === null) {
    return false;
  }
  const lowered = code.toLowerCase();
  if (EVAL_FORBIDDEN_SUBSTRINGS.some((marker) => lowered.includes(marker))) {
    return true;
  } else {
    return touches_credential_path(code);
  }
}

/**
 * Tests one forbidden privileged-container statement.
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when docker escapes the container or mounts host root.
 */
function is_forbidden_container(statement: string, words: string[]): boolean {
  if (base_command_of(statement) !== 'docker' || (words[1] ?? '').toLowerCase() !== 'run') {
    return false;
  }
  if (PRIVILEGED_DOCKER_PATTERN.test(` ${words.slice(2).join(' ')} `)) {
    return true;
  } else {
    return DOCKER_ROOT_MOUNT_PATTERN.test(statement);
  }
}

/**
 * Tests one forbidden destroy statement.
 *
 * @param statement - Outer statement text.
 * @param words - Statement words.
 * @returns True when the statement destroys the OS or its root.
 */
function is_forbidden_destroy(statement: string, words: string[]): boolean {
  const base = base_command_of(statement);
  if (base === 'rm') {
    const targets = words.slice(1).filter((word) => word !== '--' && !word.startsWith('-'));
    return targets.some((target) => {
      const cleaned = target.replace(/\/+$/, '') || '/';
      return cleaned === '/' || cleaned === '~' || cleaned.toLowerCase() === '$home';
    });
  }
  if (base === 'dd') {
    return /\bof=\/dev\//.test(statement);
  }
  if (DESTROY_BINARIES_PATTERN.test(` ${statement} `)) {
    return true;
  }
  if ((base === 'chmod' || base === 'chown') && words.slice(1).some((word) => word === '-R' || word === '-r')) {
    return words.slice(1).some((word) => (word.replace(/\/+$/, '') || '/') === '/');
  } else {
    return false;
  }
}

/**
 * Tests one forbidden system-write statement.
 *
 * @param statement - Outer statement text.
 * @returns True when the statement writes into a system path.
 */
function is_forbidden_system_write(statement: string): boolean {
  if (!SYSTEM_PATH_PATTERN.test(statement)) {
    return false;
  }
  if (has_file_redirect(statement)) {
    return true;
  }
  const base = base_command_of(statement);
  return ['tee', 'cp', 'mv', 'ln', 'sed', 'install', 'chmod', 'chown', 'rm', 'truncate', 'dd'].includes(base);
}

/** One ordered rule family (last match wins, as in opencode). */
type PermissionRule = {
  /** Stable rule id. */
  id: string;
  /** Class this family grants. */
  class: PermissionClass;
  /** Tests one outer statement. */
  test: (statement: string, words: string[]) => boolean;
};

/** Ordered rule families (general first, specific last). */
const PERMISSION_RULES: readonly PermissionRule[] = [
  { id: 'low-read', class: 'low', test: (statement, words) => is_low_read(statement, words) },
  { id: 'medium-write', class: 'medium', test: (statement, words) => is_medium_write(statement, words) },
  { id: 'medium-vcs', class: 'medium', test: (statement, words) => is_medium_vcs(statement, words) },
  { id: 'medium-install', class: 'medium', test: (statement, words) => is_medium_install(statement, words) },
  {
    id: 'medium-network-read',
    class: 'medium',
    test: (statement, words) => is_medium_network_read(statement, words),
  },
  { id: 'medium-process', class: 'medium', test: (statement, words) => is_medium_process(statement, words) },
  { id: 'medium-eval', class: 'medium', test: (statement, words) => is_medium_eval(statement, words) },
  { id: 'high-destructive', class: 'high', test: (statement, words) => is_high_destructive(statement, words) },
  {
    id: 'high-network-write',
    class: 'high',
    test: (statement, words) => is_high_network_write(statement, words),
  },
  { id: 'high-privilege', class: 'high', test: (statement, words) => is_high_privilege(statement, words) },
  { id: 'high-container', class: 'high', test: (statement, words) => is_high_container(statement, words) },
  { id: 'high-publish', class: 'high', test: (statement, words) => is_high_publish(statement, words) },
  {
    id: 'high-orchestrator',
    class: 'high',
    test: (statement, words) => is_high_orchestrator(statement, words),
  },
  {
    id: 'high-remote-install',
    class: 'high',
    test: (statement, words) => is_high_remote_install(statement, words),
  },
  { id: 'high-system', class: 'high', test: (statement) => is_high_system(statement) },
  { id: 'forbidden-eval', class: 'forbidden', test: (statement, words) => is_forbidden_eval(statement, words) },
  {
    id: 'forbidden-privileged-container',
    class: 'forbidden',
    test: (statement, words) => is_forbidden_container(statement, words),
  },
  {
    id: 'forbidden-destroy',
    class: 'forbidden',
    test: (statement, words) => is_forbidden_destroy(statement, words),
  },
  {
    id: 'forbidden-system-write',
    class: 'forbidden',
    test: (statement) => is_forbidden_system_write(statement),
  },
];

/**
 * Classifies one outer statement with the ordered rule table.
 *
 * @param outer - Statement text without substitutions.
 * @returns The class and the last matching rule id.
 */
function classify_outer(outer: string): { class: PermissionClass; rule: string } {
  const words = statement_words(outer);
  let found: { class: PermissionClass; rule: string } = { class: 'medium', rule: 'medium-unknown' };
  for (const rule of PERMISSION_RULES) {
    if (rule.test(outer, words)) {
      found = { class: rule.class, rule: rule.id };
    }
  }
  return found;
}

/**
 * Classifies one script with depth bound (inner substitutions recurse).
 *
 * @param script - Script text.
 * @param options - Scope and strict flags.
 * @param depth - Current substitution depth.
 * @returns The class and the rule id.
 */
function classify_script_depth(
  script: string,
  options: ClassifyPermissionOptions | undefined,
  depth: number,
): { class: PermissionClass; rule: string } {
  const cwd = options?.cwd;
  const strict = options?.strict ?? false;
  const trimmed = script.trim();
  if (trimmed === '') {
    return { class: 'medium', rule: 'medium-unknown' };
  }
  if (touches_credential_path(script)) {
    return { class: 'forbidden', rule: 'forbidden-credential' };
  }
  if (WHOLE_EXFIL_PATTERN.test(` ${script} `)) {
    return { class: 'forbidden', rule: 'forbidden-exfil' };
  }
  for (const pattern of WHOLE_REMOTE_PATTERNS) {
    if (pattern.test(script)) {
      return { class: 'forbidden', rule: 'forbidden-remote-code' };
    }
  }
  const split = split_statements(script);
  if (split.opaque) {
    return { class: 'high', rule: 'opaque-parse' };
  }
  if (split.parts.length === 0) {
    return { class: 'medium', rule: 'medium-unknown' };
  }
  let best: PermissionClass = 'low';
  let best_rule = 'low-read';
  let seen = false;
  for (const part of split.parts) {
    const sub = extract_substitutions(part);
    if (sub.opaque) {
      if (!seen || CLASS_RANK.high >= CLASS_RANK[best]) {
        best = 'high';
        best_rule = 'opaque-parse';
        seen = true;
      }
      continue;
    }
    for (const inner of sub.inners) {
      if (depth >= MAX_SUBSTITUTION_PASSES) {
        if (!seen || CLASS_RANK.high >= CLASS_RANK[best]) {
          best = 'high';
          best_rule = 'opaque-parse';
          seen = true;
        }
      } else {
        const inner_found = classify_script_depth(inner, options, depth + 1);
        if (!seen || CLASS_RANK[inner_found.class] >= CLASS_RANK[best]) {
          best = inner_found.class;
          best_rule = inner_found.rule;
          seen = true;
        }
      }
    }
    let outer_found = classify_outer(sub.outer);
    if (outer_found.class === 'low' && has_file_redirect(sub.outer)) {
      outer_found = { class: 'medium', rule: 'medium-write' };
    }
    if (cwd !== undefined && cwd.trim() !== '' && touches_outside_cwd(sub.outer, cwd)) {
      if (outer_found.class === 'low') {
        outer_found = { class: 'medium', rule: 'medium-outside-read' };
      } else if (outer_found.class === 'medium') {
        outer_found = { class: 'high', rule: 'high-outside-write' };
      }
    } else if ((cwd === undefined || cwd.trim() === '') && touches_absolute_path(sub.outer)) {
      if (outer_found.class === 'low') {
        outer_found = { class: 'medium', rule: 'medium-outside-read' };
      } else if (outer_found.class === 'medium') {
        outer_found = { class: 'high', rule: 'high-outside-write' };
      }
    }
    if (strict && STRICT_SYSTEM_READ_PATTERN.test(sub.outer)) {
      outer_found = { class: 'forbidden', rule: 'strict-system-read' };
    }
    if (!seen || CLASS_RANK[outer_found.class] >= CLASS_RANK[best]) {
      best = outer_found.class;
      best_rule = outer_found.rule;
      seen = true;
    }
  }
  return { class: best, rule: best_rule };
}

/**
 * Classifies one script into low, medium, high or forbidden.
 *
 * The class is the maximum over statements and nested substitutions. An
 * unknown command is medium. A write outside `cwd` is high, a read outside
 * is medium. `/tmp` counts as inside. With `strict`, system reads are
 * forbidden.
 *
 * @param script - Command script to classify.
 * @param options - Scope check and strict flag.
 * @returns The class and the rule id.
 */
export function classify_script(
  script: string,
  options?: ClassifyPermissionOptions,
): { class: PermissionClass; rule: string } {
  return classify_script_depth(script, options, 0);
}

/**
 * Decides the host effect for one script.
 *
 * `--no-exec` (`enabled: false`) blocks every class first. Forbidden always
 * denies. Low and medium ask in base and allow with `auto`. High denies
 * unless `approve_high` is set, then it asks. No flag grants forbidden.
 *
 * @param input - Script plus the effective flags.
 * @returns The verdict with class, effect and rule id.
 */
export function decide_permission(input: DecidePermissionInput): PermissionVerdict {
  const found = classify_script(input.script, { cwd: input.cwd, strict: input.strict });
  if (input.enabled === false) {
    return { class: found.class, effect: 'block', rule: found.rule };
  }
  if (found.class === 'forbidden') {
    return { class: found.class, effect: 'deny', rule: found.rule };
  }
  if (found.class === 'low' || found.class === 'medium') {
    return { class: found.class, effect: input.auto === true ? 'allow' : 'ask', rule: found.rule };
  } else {
    return { class: found.class, effect: input.approve_high === true ? 'ask' : 'deny', rule: found.rule };
  }
}
