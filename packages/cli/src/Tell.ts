import { exec, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { promisify } from 'node:util';
import {
  type AskInstance,
  create_ask_ai,
  extract_runs,
  list_custom_models,
  MODELS,
  resolve_model_spec,
  sanitize_reasoning,
  strip_run_tags,
  strip_think_tags,
  summarize_context,
  tell,
  WIRE_APIS,
} from '@tell-ai/sdk';
import { Command } from 'commander';
import { load_sdk_config } from './env';
import {
  type ContextEntry,
  list_sessions,
  print_history_list,
  print_search_results,
  sanitize_label,
  search_contexts,
  search_sessions,
  short_id,
  show_entry,
} from './history';
import { expand_mentions, is_outside_cwd } from './mentions';
import { get_system_prompt, type PromptOptions } from './systemPrompt';

const EXEC_ASYNC = promisify(exec);
const DEFAULT_MODEL = process.env['TELL_MODEL'] || 'g';
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_CHAIN_STEPS = 8;
const EXEC_TIMEOUT = 120_000;
const STDIN_TIMEOUT = 30_000;
const SENSITIVE_ENV_NAMES = new Set([
  'BASH_ENV',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ENV',
  'GPG_AGENT_INFO',
  'GPG_KEY',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'PERL5LIB',
  'PYTHONPATH',
  'RUBYLIB',
  'SSH_AUTH_SOCK',
  'TELL_KEY',
  'TELL_TOKEN',
]);
const SENSITIVE_ENV_SUFFIX =
  /(?:^|_)(?:ACCESS_KEY(?:_ID)?|API_KEY|AUTH_TOKEN|CREDENTIALS?|PASSWORD|PASSWD|PRIVATE_KEY|SECRET(?:_KEY)?|TOKEN)$/;
// Chars of accumulated conversation context; beyond this the oldest part is
// summarized away (LLM windows are far below 64K chars of raw history).
const MAX_CONTEXT_CHARS = 64 * 1024;

type CliOptions = {
  model?: string;
  context?: boolean;
  ctx?: boolean | string;
  name?: boolean;
  history?: boolean | string;
  yes?: boolean;
  chain?: boolean;
  exec?: boolean;
  input?: boolean;
  web?: boolean;
  stream?: boolean;
  think?: boolean;
  cwd?: string;
  models?: boolean;
  requireApproval?: boolean;
};

type ParsedInput = { model: string; parts: string[]; readStdin: boolean };

// The resolved plan for how the current invocation should read/write context:
// - 'none': no context flag was given (legacy one-shot behavior, default context is cleared).
// - 'default': `-c`, bare `--ctx`, or prompt text supplied through `--ctx` — the
//   per-directory + model context (its file name is the sha256 hash, so `%<hash>` addresses it too).
// - 'existing': `--ctx @N` or `--ctx %id` resolved to an already-saved context.
// - 'create': `--ctx %id -n` (explicit reset) or a `%id` with no saved match.
// `promptFromRef` carries the text after a ref (or the whole bare value) so it
// is prepended to the positional prompt without ever reaching `expand_mentions`
// as a mention token.
type ContextPlan =
  | { $: 'none' }
  | { $: 'default'; file: string; promptFromRef?: string }
  | { $: 'existing'; file: string; label: string; promptFromRef?: string }
  | { $: 'create'; file: string; label: string; promptFromRef?: string };

// Effective execution mode, resolved once from the flags (fail-closed):
// - 'no-exec': never execute — `--no-exec` wins over everything.
// - 'confirm-all': every command needs manual confirmation (default, and
//   `--require-approval` without `-y`).
// - 'auto-risk': safe commands run directly (`-y`); high-risk ones always ask.
type ExecMode = 'no-exec' | 'confirm-all' | 'auto-risk';

type ConversationState = {
  firstPrompt: string;
  timeline: string[];
  commandRounds: number;
  chainLimitReached: boolean;
  autoContinue: boolean;
  execMode: ExecMode;
  saveContext: boolean;
  stream: boolean;
  think: boolean;
};

type CommandResult = { output: string; exitCode: number };
type ScriptsResult = { text: string; failed: boolean };

const CREATED_DIRS = new Set<string>();

// Best-effort tightening of a store's permissions. `mkdir`/`open` only apply
// `mode` at creation, so a store written by an older version (or with a lax
// umask) would otherwise stay group/other readable forever.
function tighten_permissions(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Exotic filesystems (and some Windows setups) reject chmod — never let
    // the permission repair fail the actual write.
  }
}

function ensure_dir(dir: string): void {
  if (CREATED_DIRS.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  tighten_permissions(dir, 0o700);
  CREATED_DIRS.add(dir);
}

function model_label(model: string): string {
  const spec = resolve_model_spec(model);
  return `${spec.vendor}:${spec.model}:${spec.thinking}${spec.fast ? ':fast' : ''}`;
}

function is_model_spec(value: string): boolean {
  const bare = value.startsWith('.') ? value.slice(1) : value;
  if (MODELS[bare]) return true;
  if (!bare.includes(':')) return false;
  try {
    resolve_model_spec(bare);
    return true;
  } catch {
    return false;
  }
}
function print_model_help(): void {
  const rows: [string, string][] = Object.entries(MODELS).map(([alias, spec]) => [alias, model_label(spec)]);
  const alias_width = Math.max('Alias'.length, ...rows.map(([alias]) => alias.length));
  console.log('Usage: tell -m <model> "message"\n');
  console.log(`${'Alias'.padEnd(alias_width)}  Model`);
  console.log(`${'-'.repeat(alias_width)}  ${'-'.repeat(48)}`);
  for (const [alias, spec] of rows) console.log(`${alias.padEnd(alias_width)}  ${spec}`);
  console.log('\nFull specs are also accepted: vendor:model[:thinking]');
}

/**
 * Prints every model the configured custom endpoint exposes, grouped by the wire
 * it would be called with, so `tell -m custom:<model>` can be copied straight
 * from the listing.
 */
async function print_custom_models(): Promise<void> {
  let models: Awaited<ReturnType<typeof list_custom_models>>;
  let endpoint = '';
  try {
    const config = await load_sdk_config();
    models = await list_custom_models(config);
    endpoint = config.urls.custom ?? '';
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', format_model_error(error));
    process.exitCode = 1;
    return;
  }
  console.log('Usage: tell -m custom:<model> "message"\n');
  console.log(`${models.length} models at ${endpoint}\n`);
  const wire_width = Math.max('Wire'.length, ...WIRE_APIS.map((wire) => wire.length));
  console.log(`${'Wire'.padEnd(wire_width)}  Model`);
  console.log(`${'-'.repeat(wire_width)}  ${'-'.repeat(40)}`);
  for (const wire of WIRE_APIS) {
    for (const model of models.filter((entry) => entry.wire === wire)) {
      console.log(`${wire.padEnd(wire_width)}  custom:${model.id}`);
    }
  }
  if (models.length === 0) console.log('(the endpoint returned no models)');
  console.log('\nSet CUSTOM_MODEL to use "tell -m custom" without a model id.');
  console.log('Set CUSTOM_API to pin the wire when the endpoint routes one id differently.');
}

function lock_process_environment(): void {
  for (const name of Object.keys(process.env)) {
    if (SENSITIVE_ENV_NAMES.has(name) || SENSITIVE_ENV_SUFFIX.test(name)) delete process.env[name];
  }
}

function sanitized_command_env(): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || SENSITIVE_ENV_NAMES.has(name) || SENSITIVE_ENV_SUFFIX.test(name)) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

async function execute_command(script: string): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await EXEC_ASYNC(script, {
      cwd: process.cwd(),
      maxBuffer: MAX_BUFFER,
      shell: '/bin/bash',
      timeout: EXEC_TIMEOUT,
      env: sanitized_command_env(),
    });
    return { output: stdout + stderr, exitCode: 0 };
  } catch (error) {
    const err = error as any;
    const exit_code = typeof err.code === 'number' ? err.code : 1;
    if (err.killed && err.signal === 'SIGTERM') {
      return {
        output: `Command timed out after ${EXEC_TIMEOUT / 1000}s:\n${script}`,
        exitCode: 124,
      };
    }
    const output = [
      typeof err.stdout === 'string' ? err.stdout : '',
      typeof err.stderr === 'string' ? err.stderr : '',
      error instanceof Error ? error.message : String(error),
    ]
      .filter(Boolean)
      .join('\n');
    return { output, exitCode: exit_code };
  }
}

async function read_stdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`stdin read timed out after ${STDIN_TIMEOUT / 1000}s`));
    }, STDIN_TIMEOUT);

    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8').trimEnd());
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function history_dir(): string {
  return path.join(os.homedir(), '.ai', 'tell_history');
}

function log_file(): string {
  const dir = history_dir();
  ensure_dir(dir);
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  return path.join(dir, `conversation_${timestamp}.txt`);
}

function context_dir(): string {
  return path.join(os.homedir(), '.ai', 'tell_context');
}

function context_file(model: string): string {
  const label = model_label(model);
  const hash = createHash('sha256').update(`${process.cwd()}\n${label}`).digest('hex');
  return path.join(context_dir(), `${hash}.txt`);
}

// Path for a context addressed by a human-readable name or a freshly
// generated random id (used by named/-C contexts, as opposed to the
// legacy per-directory + model hash used by bare `-c`).
function named_context_file(name: string): string {
  return path.join(context_dir(), `${name}.txt`);
}

// Every saved context file, newest first (index 0 == `@0`,
// mirroring `git stash@{0}`).
function list_context_entries(): ContextEntry[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(context_dir()).filter((name) => name.endsWith('.txt'));
  } catch {
    return [];
  }
  const entries: ContextEntry[] = [];
  for (const name of names) {
    const file = path.join(context_dir(), name);
    try {
      entries.push({ file, id: name.slice(0, -'.txt'.length), mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // Entry vanished between readdir and stat (or is unreadable) — skip it.
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
  return entries;
}

// Handles `-l/--history`: bare lists both stores; `@N` reprints a context,
// `%N` reprints a conversation (errors name the namespace total); any other
// value searches contexts + conversations. Runs before prompt/stdin handling,
// so it needs neither a prompt nor an API key — everything stays local.
function run_history_dispatch(ref: boolean | string): void {
  const entries = list_context_entries();
  if (ref === true) {
    print_history_list(list_sessions(history_dir()), entries);
    return;
  }

  if (typeof ref === 'boolean') {
    // Unreachable: commander only yields `true` for the bare flag and there
    // is no `--no-history` negation. Kept for exhaustiveness.
    return;
  }

  const value = ref.trim();
  const index_match = /^([@%])(\d+)$/.exec(value);
  if (index_match?.[1] && index_match[2] !== undefined) {
    const index = Number(index_match[2]);
    const is_context = index_match[1] === '@';
    const sessions = is_context ? [] : list_sessions(history_dir());
    const target = is_context ? entries[index] : sessions[index];
    if (!target) {
      const total = is_context ? entries.length : sessions.length;
      const message = is_context
        ? `No context at index ${index} (have ${total} saved context${total === 1 ? '' : 's'})`
        : `No conversation at index ${index} (have ${total} conversation${total === 1 ? '' : 's'})`;
      console.error('\x1b[31m%s\x1b[0m', message);
      process.exitCode = 1;
      return;
    }
    show_entry(target.file);
    return;
  }

  if (!value) {
    console.log('Empty search term — pass a term, @N (context), or %N (conversation).');
    return;
  }

  const results = [...search_contexts(value, entries), ...search_sessions(value, history_dir())];
  if (results.length === 0) {
    console.error('\x1b[31m%s\x1b[0m', `No matches for "${value}" in contexts or conversations.`);
    process.exitCode = 1;
    return;
  }
  print_search_results(results, value);
}

// Validates a token as a context id: no whitespace, a safe filename charset.
// `%id` is use-or-create over this single namespace (ids ARE the context
// filenames, so a saved id and its file name are the same thing).
function sanitize_context_name(raw: string): string | null {
  const NAME_MAX_LENGTH = 100;
  const value = raw.trim();
  if (!value || /\s/.test(value)) return null;
  if (!new RegExp(`^[A-Za-z0-9._-]{1,${NAME_MAX_LENGTH}}$`).test(value)) return null;
  return value;
}

// Splits a `--ctx` value into its first word and the remaining text. The
// first word is the ref only when it is `@N` or starts with `%`; the rest is
// prompt text for that context.
function split_ctx_value(value: string): { first: string; rest: string } {
  const trimmed = value.trim();
  const separator = trimmed.search(/\s/);
  if (separator === -1) return { first: trimmed, rest: '' };
  return { first: trimmed.slice(0, separator), rest: trimmed.slice(separator + 1).trim() };
}

// True when a token opens a context ref: `@N` (recency index) or `%id`
// (use-or-create). A bare `@path` token is NOT a ref — it stays prompt text
// and is expanded by `expand_mentions` afterwards.
function is_context_ref_token(token: string): boolean {
  return /^@\d+$/i.test(token) || token.startsWith('%');
}

// True when the `--ctx` value itself carries prompt text: any text after a
// ref, or a value whose first word is not a ref at all. `main()` uses this to
// decide whether `--ctx` alone satisfies the missing-prompt check.
function ctx_value_has_prompt(value: string): boolean {
  const { first, rest } = split_ctx_value(value);
  if (!first) return false;
  return rest.length > 0 || !is_context_ref_token(first);
}

// Resolves a `%id` use-or-create ref over the unique id namespace: an exact
// id or a unique hex prefix resumes the saved context, anything else creates
// `<id>.txt`. The id charset is validated by the caller.
function resolve_percent_context_ref(
  id: string,
  entries: ContextEntry[],
): { $: 'existing' | 'create'; file: string; label: string } {
  const exact = entries.find((entry) => entry.id === id);
  if (exact) return { $: 'existing', file: exact.file, label: id };

  if (/^[0-9a-f]+$/i.test(id)) {
    const matches = entries.filter((entry) => entry.id.toLowerCase().startsWith(id.toLowerCase()));
    if (matches.length === 1 && matches[0]) {
      return { $: 'existing', file: matches[0].file, label: short_id(matches[0].id) };
    }
    if (matches.length > 1) {
      const ids = matches.map((entry) => sanitize_label(short_id(entry.id))).join(', ');
      throw new Error(`Ambiguous context id "%${id}" — matches: ${ids}`);
    }
  }
  return { $: 'create', file: named_context_file(id), label: id };
}

// Resolves a `--ctx <ref>` value into a context plan. The first word is the
// ref when it is `@N` or `%id`; the rest is prompt text carried into the
// prompt (never into `expand_mentions`). `@N` must exist; `%id` is
// use-or-create. Without a ref, a single token followed by a positional
// prompt is a hard error (naming requires `%`); multi-word text and a lone
// token with no positional prompt are prompt text for the default context.
function resolve_context_ref(
  raw: string,
  entries: ContextEntry[],
  model: string,
  has_positional_prompt: boolean,
): ContextPlan {
  const value = raw.trim();
  const { first, rest } = split_ctx_value(value);

  if (/^@\d+$/i.test(first)) {
    const index = Number(first.slice(1));
    const entry = entries[index];
    if (!entry) {
      throw new Error(
        `No context at index ${index} (have ${entries.length} saved context${entries.length === 1 ? '' : 's'})`,
      );
    }
    const label = `@${index} (${short_id(entry.id)})`;
    return rest
      ? { $: 'existing', file: entry.file, label, promptFromRef: rest }
      : { $: 'existing', file: entry.file, label };
  }

  if (first.startsWith('%')) {
    const id = sanitize_context_name(first.slice(1));
    if (!id) {
      throw new Error(`Invalid context reference "${sanitize_label(first)}" — use % followed by a context id`);
    }
    const resolved = resolve_percent_context_ref(id, entries);
    return rest ? { $: resolved.$, file: resolved.file, label: resolved.label, promptFromRef: rest } : resolved;
  }

  if (has_positional_prompt && !/\s/.test(value)) {
    throw new Error(
      `Invalid context reference "${sanitize_label(value)}" — naming a context requires %: use --ctx %<id>`,
    );
  }
  return { $: 'default', file: context_file(model), promptFromRef: value };
}

// Whether a resolved plan carries prompt text to prepend to the positional
// prompt (the text after a ref, or the whole bare `--ctx` value).
function plan_prompt_from_ref(plan: ContextPlan): string {
  return plan.$ !== 'none' && plan.promptFromRef ? plan.promptFromRef : '';
}

// Builds the effective context plan for this invocation from the parsed
// `-c`/`--ctx`/`-n` options. `--ctx %id -n` is an explicit reset: starts
// empty even when the id exists. `-n` requires `%id` — bare tokens are prompt
// text for the default context, never a name.
function build_context_plan(
  opts: CliOptions,
  model: string,
  entries: ContextEntry[],
  has_positional_prompt: boolean,
): ContextPlan {
  if (opts.name) {
    const { first, rest } = split_ctx_value(typeof opts.ctx === 'string' ? opts.ctx : '');
    const id = first.startsWith('%') ? sanitize_context_name(first.slice(1)) : null;
    if (!id) throw new Error('-n/--name requires a context id: --ctx %<id> -n');
    return rest
      ? { $: 'create', file: named_context_file(id), label: id, promptFromRef: rest }
      : { $: 'create', file: named_context_file(id), label: id };
  }
  if (opts.ctx === true || opts.context) return { $: 'default', file: context_file(model) };
  if (typeof opts.ctx === 'string') {
    return resolve_context_ref(opts.ctx, entries, model, has_positional_prompt);
  }
  return { $: 'none' };
}

function append_log(file: string, text: string): void {
  ensure_dir(path.dirname(file));
  fs.appendFileSync(file, `${text}\n`, { encoding: 'utf8', mode: 0o600 });
  tighten_permissions(file, 0o600);
}

function read_text(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function limit_context(text: string): string {
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return `[older context truncated]\n${text.slice(-MAX_CONTEXT_CHARS)}`;
}

function write_context(file: string, content: string): void {
  ensure_dir(path.dirname(file));
  fs.writeFileSync(file, `${limit_context(content).trim()}\n`, { encoding: 'utf8', mode: 0o600 });
  tighten_permissions(file, 0o600);
}

function save_incremental_context(contextPath: string, previousContext: string, state: ConversationState): void {
  try {
    const turn = strip_think_tags(conversation_text(state));
    const next_context = previousContext ? `${previousContext}\n${turn}` : turn;
    write_context(contextPath, next_context);
  } catch (err) {
    process.stderr.write(
      `\x1b[33mWarning: failed to save incremental context: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`,
    );
  }
}

function is_high_risk_script(script: string): boolean {
  const compact = script.replace(/\\\n/g, ' ').replace(/\s+/g, ' ').trim();
  const privileged_path = [
    String.raw`(?:/(?:etc|boot|dev|proc|sys|usr|bin|sbin|lib|lib64)(?:\b|/)|`,
    String.raw`/(?:var/(?:spool/cron|cron)|etc/cron(?:\.(?:d|daily|hourly|monthly|weekly))?)(?:\b|/)|`,
    String.raw`(?:~|\$HOME)/(?:\.config/(?:autostart|systemd/user)|\.local/share/systemd/user)(?:\b|/))`,
  ].join('');
  return [
    /\b(?:sudo|doas|pkexec)\b/,
    /(?:^|[\s;&|(])(?:[^\s;&|()]*\/)?(?:ba|z|da|k)?sh\b[^;&|]*\s-c(?:\s|$)/,
    /(?:^|[\s;&|(])(?:[^\s;&|()]*\/)?(?:curl|wget|nc|ncat|netcat|telnet|ssh|scp|sftp|ftp)\b/,
    /(?:^|[\s;&|(])(?:[^\s;&|()]*\/)?printenv\b/,
    /\/proc(?:\/|\b)/,
    /\brm\s+(?:-[^\s]*[rRfF][^\s]*)(?:\s|$)/,
    /\bgit\s+clean\b[^;&|]*(?:--force\b|-[^-][^\s]*[fdx])/,
    /\b(?:mkfs|shutdown|reboot)\b/,
    /\bdd\b.*\bof=/,
    /\b(chmod|chown)\s+-R\b.*\s\/(?:\s|$)/,
    // Non-recursive permission/ownership changes on privileged paths
    // (`chmod 777 /etc/passwd`) — recursive -R anywhere is covered above.
    new RegExp(String.raw`\b(?:chmod|chown)\b[^;&|]*\s["']?${privileged_path}`),
    // Download piped straight into an interpreter (curl|sh, wget|bash,
    // curl|python3, base64 -d|sh, …).
    /(?:curl|wget|base64)\b[^|;&]*\|\s*(?:(?:ba|z|da|k)?sh|python3?|perl|ruby|php|node)\b/,
    // Process substitution feeding a download into anything: x <(curl …),
    // or feeding anything into a shell: bash <(…).
    /<\(\s*(?:curl|wget|base64)\b/,
    /(?:^|[\s;&|])(?:ba|z|da|k)?sh\b[^;&|]*<\(/,
    // Interpreters with inline code strings ONLY when they touch the network
    // or decode payloads (local one-liners stay allowed by design): remote
    // code fetch via node/python/php -e/-c/-r, semicolon-chained downloads.
    /(?:^|[\s;&|])(?:node|deno|bun|python3?|perl|ruby|php|lua)\b[^;&|]*\s-{1,2}(?:e|c|r|eval|exec|command)\b[^;&|]*(?:https?:\/\/|require\(\s*['"]https?|import\(\s*['"]https?|urllib|requests\.|ftplib|socket|base64|eval\(|exec\(|system\(|popen\()/,
    /(?:curl|wget|base64)\b[^;&|]*[;&|]\s*(?:node|python3?|perl|ruby|php)\b/,
    /(?:^|[\s;&|])(?:crontab|systemctl\s+--user\s+enable)\b/,
    new RegExp(String.raw`(?:^|[\s;&|])(?:cp|mv|ln)\b[^;&|]*\s["']?${privileged_path}`),
    new RegExp(String.raw`(?:^|[\s;&|])sed\b[^;&|]*\s-i[^\s;&|]*[^;&|]*\s["']?${privileged_path}`),
    new RegExp(String.raw`(?:^|[\s;&|])tee\b[^;&|]*\s["']?${privileged_path}`),
    new RegExp(String.raw`(?:^|[\s;&|])\d*(?:>>?|>\||&>)\s*["']?${privileged_path}`),
  ].some((pattern) => pattern.test(compact));
}

// Matches path-like tokens inside a command script: absolute (`/x`), home
// (`~/x`, `$HOME/x`, bare `$HOME`), relative with traversal (`../x`, `./x`,
// bare `..`), optionally after `=` (`--output=/x`) and inside quotes. The
// token body stops at whitespace or shell separators.
const OUTSIDE_PATH_TOKEN =
  /(?:^|[\s;&|("'=`])((?:\/|~\/|(?:\$\{HOME\}|\$HOME)\/?|\.{1,2}\/)[^\s;&|'"]*|\$\{HOME\}|\$HOME|[~.]{1,2})(?=$|[\s;&|'")=])/g;
const FILE_ARGUMENT_TOKEN =
  /(?:^|[\s;&|])(?:cat|head|tail|less|more|file|stat|cp|mv|rm|ln|chmod|chown|truncate|tar)\b([^;&|]*)/g;
const SHELL_ARGUMENT_TOKEN = /"([^"]*)"|'([^']*)'|([^\s]+)/g;

// True when the script references any path that resolves outside `cwd` —
// reads included, mirroring the `@path` mention read gate. Resolution is
// delegated to `is_outside_cwd` (lexical + symlink/realpath, mentions.ts);
// `~`/`$HOME` expand via `os.homedir()`, so when cwd IS `$HOME` a `~/x`
// reference resolves inside and stays allowed.
function script_touches_outside_cwd(script: string, cwd: string): boolean {
  const home = os.homedir();
  const compact = script
    .replace(/\\\n/g, ' ')
    .replace(/\\\//g, '/')
    .replace(/\$\{PWD\}|\$PWD/g, cwd);
  if (/\$\{(?:PWD|HOME)(?::[-=+?]|\+)/.test(compact)) return true;
  for (const match of compact.matchAll(OUTSIDE_PATH_TOKEN)) {
    const token = match[1];
    if (!token) continue;
    const expanded = token
      .replace(/^\$\{HOME\}/, home)
      .replace(/^\$HOME/, home)
      .replace(/^~(?=\/|$)/, home);
    const resolved = path.resolve(cwd, expanded);
    if (is_outside_cwd(resolved, cwd)) return true;
  }
  for (const match of compact.matchAll(FILE_ARGUMENT_TOKEN)) {
    const args = match[1];
    if (!args) continue;
    for (const argument of args.matchAll(SHELL_ARGUMENT_TOKEN)) {
      const token = argument[1] ?? argument[2] ?? argument[3];
      if (!token || token.startsWith('-')) continue;
      const resolved = path.resolve(cwd, token);
      if (is_outside_cwd(resolved, cwd)) return true;
    }
  }
  return false;
}

async function confirm_command(script: string, mode: ExecMode): Promise<boolean> {
  const high_risk = is_high_risk_script(script);
  const touches_outside = mode === 'auto-risk' && !high_risk && script_touches_outside_cwd(script, process.cwd());
  if (mode === 'auto-risk' && !high_risk && !touches_outside) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const label = high_risk
    ? 'High-risk command requested'
    : touches_outside
      ? 'Command touches paths outside the working directory'
      : 'Command requested';
  process.stderr.write(`${label}:\n${script}\n`);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };

    const timer = setTimeout(() => done(false), EXEC_TIMEOUT);

    rl.question('\x1b[31mExecute this command? [y/N] \x1b[0m', (answer) => {
      clearTimeout(timer);
      done(answer.trim().toUpperCase() === 'YES' || answer.trim().toUpperCase() === 'Y');
    });
  });
}

async function run_script(script: string, mode: ExecMode): Promise<{ result: string; failed: boolean }> {
  if (mode === 'no-exec') {
    process.stderr.write('\x1b[33mCommand execution disabled (--no-exec).\x1b[0m\n');
    return {
      result: `Command execution disabled — not run:\n${script}`,
      failed: false,
    };
  }
  if (!(await confirm_command(script, mode))) {
    process.stderr.write('\x1b[33mCommand skipped by user.\x1b[0m\n');
    return { result: `Skipped by user:\n${script}`, failed: false };
  }
  const { output, exitCode } = await execute_command(script);
  const text = output.trim();
  if (text) process.stderr.write(process.stderr.isTTY ? `\x1b[2m${text}\x1b[0m\n` : `${text}\n`);
  const failed = exitCode > 0;
  const result = failed
    ? `Command failed (exit code ${exitCode}):\n${script}\nOutput:\n${output}`
    : `Executed command:\n${script}\nOutput:\n${output}`;
  return { result, failed };
}

async function run_scripts(scripts: string[], mode: ExecMode, log: string): Promise<ScriptsResult> {
  const results: string[] = [];
  let failed = false;
  for (const script of scripts) {
    const { result, failed: script_failed } = await run_script(script, mode);
    failed = failed || script_failed;
    append_log(log, result);
    results.push(result);
  }
  return { text: results.join('\n\n'), failed };
}

// Pulls the reasoning text out of a raw `<think>...</think>` response.
function extract_think(response: string): string {
  return /<think>([\s\S]*?)<\/think>/i.exec(response)?.[1]?.trim() ?? '';
}

function sanitize_wrapped_reasoning(response: string): string {
  const lower = response.toLowerCase();
  const start = lower.indexOf('<think>');
  const end = lower.lastIndexOf('</think>');
  if (start < 0 || end < start + '<think>'.length) return response;
  const reasoning = response.slice(start + '<think>'.length, end);
  return `${response.slice(0, start)}<think>${sanitize_reasoning(reasoning)}</think>${response.slice(end + '</think>'.length)}`;
}

function print_reasoning(reasoning: string): void {
  if (!reasoning) return;
  process.stderr.write(`\x1b[2m${reasoning}\x1b[0m\n`);
}

async function tell_silently(
  ai: AskInstance,
  message: string,
  options: PromptOptions = {},
  show_think = false,
): Promise<string> {
  process.stderr.write('\x1b[2mThinking...\x1b[0m');
  let response: string;
  try {
    response = await tell(message, {
      ask: ai,
      raw: true,
      system: get_system_prompt(options),
    });
  } finally {
    process.stderr.write('\r\x1b[K');
  }
  response = sanitize_wrapped_reasoning(response);
  if (show_think) print_reasoning(extract_think(response));
  return response;
}

// Streams the response as it is generated: text goes to stdout as it arrives
// and reasoning (only with `--think`) is printed dim on stderr. Returns the
// same raw `<think>...</think>`-wrapped response the non-streaming path
// returns, so log/context/`<RUN>` extraction stay identical.
async function tell_streaming(
  ai: AskInstance,
  message: string,
  options: PromptOptions = {},
  show_think = false,
): Promise<string> {
  process.stderr.write('\x1b[2mThinking...\x1b[0m');
  let is_indicator_active = true;
  let is_reasoning_open = false;
  let text = '';
  let reasoning = '';

  const clear_indicator = (): void => {
    if (!is_indicator_active) return;
    process.stderr.write('\r\x1b[K');
    is_indicator_active = false;
  };

  // Reasoning is a dim stderr block; close its line before text or at the end.
  const close_reasoning_line = (): void => {
    if (!is_reasoning_open) return;
    if (!reasoning.endsWith('\n')) process.stderr.write('\n');
    is_reasoning_open = false;
  };

  try {
    for await (const event of ai.ask_stream(message, { system: get_system_prompt(options) })) {
      switch (event.type) {
        case 'reasoning': {
          const safe_reasoning = sanitize_reasoning(event.text);
          reasoning += safe_reasoning;
          if (show_think) {
            clear_indicator();
            process.stderr.write(`\x1b[2m${safe_reasoning}\x1b[0m`);
            is_reasoning_open = true;
          }
          break;
        }
        case 'text':
          clear_indicator();
          close_reasoning_line();
          text += event.text;
          process.stdout.write(event.text);
          break;
        default:
          // reasoning_end: nothing to print, just close the dim block.
          close_reasoning_line();
          break;
      }
    }
  } finally {
    clear_indicator();
    close_reasoning_line();
  }

  if (text && !text.endsWith('\n')) process.stdout.write('\n');
  return reasoning ? `<think>${reasoning}</think>\n${text}` : text;
}

// Dispatch to the streaming or silent path — `--think` applies to both.
function respond(
  ai: AskInstance,
  state: ConversationState,
  message: string,
  options: PromptOptions = {},
): Promise<string> {
  return state.stream
    ? tell_streaming(ai, message, options, state.think)
    : tell_silently(ai, message, options, state.think);
}

function format_model_error(error: unknown): string {
  const value = error as any;
  const status = typeof value?.status === 'number' ? value.status : undefined;
  let message = typeof value?.message === 'string' ? value.message : String(error);
  try {
    const parsed = JSON.parse(message);
    message = parsed?.error?.message || parsed?.message || message;
  } catch {}
  return status ? `Model error (${status}): ${message}` : `Model error: ${message}`;
}

function parse_args(args: string[], optModel: string | undefined, readPipedInput = false): ParsedInput {
  let model = optModel || DEFAULT_MODEL;
  let parts = args;
  const first_arg = args[0];
  const first_is_model = !optModel && typeof first_arg === 'string' && is_model_spec(first_arg);
  if (first_is_model) {
    model = first_arg;
    parts = args.slice(1);
  }
  return {
    model,
    parts,
    readStdin: !process.stdin.isTTY && (readPipedInput || parts.length === 0),
  };
}

function format_prompt(userText: string, stdinText: string, opts: CliOptions): string {
  const trimmed_user_text = userText.trim();
  const trimmed_stdin_text = stdinText.trim();
  if (!opts.input) return [trimmed_user_text, trimmed_stdin_text].filter(Boolean).join('\n').trim();

  if (!trimmed_stdin_text) return trimmed_user_text;
  if (!trimmed_user_text) return trimmed_stdin_text;
  return [`User request:\n${trimmed_user_text}`, `Input:\n${trimmed_stdin_text}`].filter(Boolean).join('\n\n');
}

function conversation_text(state: ConversationState): string {
  return state.timeline.join('\n');
}

function continuation_instruction(state: ConversationState): string {
  const instruction = state.chainLimitReached
    ? `The chain limit of ${MAX_CHAIN_STEPS} command rounds has been reached. Answer now without <RUN> tags.`
    : 'Request another command with <RUN> tags if needed; otherwise answer without <RUN> tags.';
  return instruction;
}

function wants_model_help(argv: string[]): boolean {
  return argv.some((arg, index) => (arg === '-m' || arg === '--model') && argv[index + 1] === '--help');
}

function build_program(argv: string[]): Command {
  return new Command()
    .name('tell')
    .description('One-shot terminal assistant')
    .argument('[input...]', 'optional model followed by the prompt, or just the prompt')
    .option('-m, --model <model>', 'model shortcode or full model spec (use -m --help to list)')
    .option('-c, --context', 'use the default context for this directory and model')
    .option(
      '--ctx [ref]',
      'context ref (@N recency, %id use-or-create) + prompt, or prompt text alone (default context)',
    )
    .option('-n, --name', 'reset a context (--ctx %id -n; starts empty, even if it exists)')
    .option('-l, --history [ref]', 'list contexts + conversations; @N/%N show an entry; any other value searches both')
    .option('--models', 'list the models the custom endpoint exposes (CUSTOM_BASE_URL)')
    .option('-y, --yes', 'execute requested commands without confirmation')
    .option('--require-approval', 'with -y: safe commands run directly, high-risk ones still ask for confirmation')
    .option('--chain', 'continue after command output until the assistant gives a final answer')
    .option('--stream', 'stream the response as it is generated')
    .option('--think', 'show the model reasoning on stderr (works with and without --stream)')
    .option('-i, --input', 'read stdin and include it with the prompt')
    .option('-w, --web', 'launch the interactive Tell Web sandbox')
    .option('--cwd <path>', 'working directory for the sandbox (created if missing)')
    .option('--no-exec', 'do not execute requested commands')
    .parse(argv);
}

function format_missing_prompt_error(program: Command): string {
  return `error: missing prompt\n\n${program.helpInformation().trimEnd()}`;
}

function remember_assistant(state: ConversationState, log: string, response: string): void {
  append_log(log, `Assistant:\n${response}`);
  state.timeline.push(`Assistant:\n${response}`);
}

function remember_command_result(state: ConversationState, result: string): void {
  state.timeline.push(result);
}

function remember_command_round(state: ConversationState): void {
  state.commandRounds += 1;
  state.chainLimitReached = state.commandRounds >= MAX_CHAIN_STEPS;
  if (state.chainLimitReached) {
    process.stderr.write(`\x1b[33mChain limit reached (${MAX_CHAIN_STEPS}); asking for final answer.\x1b[0m\n`);
  }
}

function should_finish(scripts: string[], state: ConversationState): boolean {
  return scripts.length === 0 || state.chainLimitReached;
}

function finish_round(state: ConversationState, visible: string): void {
  if (state.chainLimitReached) {
    process.stderr.write(
      `\x1b[33mChain limit reached (${MAX_CHAIN_STEPS}); ignoring further requested commands.\x1b[0m\n`,
    );
  }
  // Streaming already printed the text as it was generated; only the
  // non-streaming path needs to print the final visible answer.
  if (visible && !state.stream) console.log(visible);
}

async function handle_final_answer(ai: AskInstance, state: ConversationState, visible: string): Promise<void> {
  if (visible) {
    if (!state.stream) console.log(visible);
    return;
  }
  const final_prompt = `${strip_think_tags(conversation_text(state))}`;
  const final_response = await respond(ai, state, final_prompt, {
    chain: false,
  });
  const final_text = strip_run_tags(strip_think_tags(final_response));
  if (final_text && !state.stream) console.log(final_text);
}

function build_feedback(state: ConversationState, failed: boolean): string {
  const base = `${strip_think_tags(conversation_text(state))}\n\n${continuation_instruction(state)}`;
  return failed ? `The command above FAILED. Analyze the error output and try a corrected approach.\n\n${base}` : base;
}

async function run_response_loop(
  ai: AskInstance,
  state: ConversationState,
  log: string,
  contextPath: string,
  previousContext: string,
): Promise<void> {
  let response = await respond(ai, state, state.firstPrompt, {
    chain: state.autoContinue,
  });

  for (;;) {
    remember_assistant(state, log, response);
    if (state.saveContext) save_incremental_context(contextPath, previousContext, state);
    response = strip_think_tags(response);
    const { scripts, visible } = extract_runs(response);
    if (should_finish(scripts, state)) {
      finish_round(state, visible);
      break;
    }

    const { text: result_text, failed } = await run_scripts(scripts, state.execMode, log);
    remember_command_result(state, result_text);
    if (state.saveContext) save_incremental_context(contextPath, previousContext, state);
    if (!state.autoContinue) {
      await handle_final_answer(ai, state, visible);
      break;
    }

    remember_command_round(state);
    response = await respond(ai, state, build_feedback(state, failed), {
      chain: true,
    });
  }
}

async function maybe_summarize_context(
  ai: AskInstance,
  state: ConversationState,
  previousContext: string,
  contextPath: string,
): Promise<void> {
  try {
    const turn = strip_think_tags(conversation_text(state));
    if (previousContext && previousContext.length + turn.length > MAX_CONTEXT_CHARS) {
      try {
        const summary = await summarize_context(ai, previousContext);
        write_context(contextPath, `${summary}\n${turn}`);
      } catch {
        write_context(contextPath, `${previousContext}\n${turn}`);
      }
    }
  } catch (error) {
    console.error(
      '\x1b[31mFailed to summarize context: %s\x1b[0m',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
}

async function launch_web(opts: {
  model: string;
  prompt: string;
  cwd?: string | undefined;
  noExec?: boolean | undefined;
  requireApproval?: boolean | undefined;
  chain?: boolean | undefined;
  yes?: boolean | undefined;
  stream?: boolean | undefined;
  think?: boolean | undefined;
}): Promise<void> {
  let cwd = process.cwd();
  if (opts.cwd) {
    cwd = path.resolve(opts.cwd);
    if (!fs.existsSync(cwd)) {
      try {
        fs.mkdirSync(cwd, { recursive: true });
        process.stderr.write(`\x1b[33mWarning: '${opts.cwd}' did not exist; created it.\x1b[0m\n`);
      } catch (err) {
        console.error(
          '\x1b[31mFailed to create working directory ' +
            `${JSON.stringify(opts.cwd)}: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        );
        process.exitCode = 1;
        return;
      }
    }
  }

  const child_args = ['-m', opts.model, '--cwd', cwd];
  if (opts.noExec) child_args.push('--no-exec');
  if (opts.requireApproval) child_args.push('--require-approval');
  if (opts.chain) child_args.push('--chain');
  if (opts.yes) child_args.push('--yes');
  if (opts.stream) child_args.push('--stream');
  if (opts.think) child_args.push('--think');
  if (opts.prompt) child_args.push('--prompt', opts.prompt);

  const child = spawn('tell-web', child_args, {
    stdio: 'inherit',
    env: { ...process.env, TELL_MODEL: opts.model, NODE_ENV: 'production' },
    cwd,
  });
  child.on('error', (err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') {
      console.error('\x1b[31mWeb interface not installed. Install it with:\x1b[0m\n  npm install -g @tell-ai/web\n');
      process.exitCode = 1;
    } else {
      console.error(
        `\x1b[31mFailed to launch web interface: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
      );
      process.exitCode = 1;
    }
  });
  await new Promise<void>((resolve) => {
    child.on('exit', (exit_code: number | null) => {
      if (exit_code !== null) process.exitCode = exit_code;
      resolve();
    });
  });
}

async function run_tell(
  model: string,
  prompt: string,
  opts: CliOptions,
  has_positional_prompt: boolean,
): Promise<void> {
  let label = '';
  let plan: ContextPlan;
  try {
    label = model_label(model);
    const entries = typeof opts.ctx === 'string' ? list_context_entries() : [];
    plan = build_context_plan(opts, model, entries, has_positional_prompt);
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (plan.$ === 'create') {
    process.stderr.write(`\x1b[2mCreated context: ${sanitize_label(plan.label)}\x1b[0m\n`);
  } else if (plan.$ === 'existing') {
    process.stderr.write(`\x1b[2mUsing context: ${sanitize_label(plan.label)}\x1b[0m\n`);
  } else {
    // 'none' and 'default' reuse the legacy per-directory/model context silently — nothing to announce.
  }

  // Prompt text carried by the `--ctx` value (after a ref, or a bare value
  // with no positional prompt) is prepended to the positional prompt. Refs
  // themselves never reach `expand_mentions`.
  const ctx_prompt = plan_prompt_from_ref(plan);
  const raw_prompt = [ctx_prompt, prompt].filter(Boolean).join(' ').trim();
  // `@path` mentions resolve against the working directory; the expanded
  // text is what reaches the log, the timeline, and the saved context.
  const full_prompt = await expand_mentions(raw_prompt, process.cwd(), { yes: Boolean(opts.yes) });
  const save_context = plan.$ !== 'none';
  // `--no-exec` wins over everything; `-y` enables the risk-gated auto mode.
  // `--require-approval` is declarative in the CLI (high-risk always asks even
  // with -y, which is already `auto-risk` behavior) and is forwarded to -w.
  const exec_mode: ExecMode = opts.exec === false ? 'no-exec' : opts.yes ? 'auto-risk' : 'confirm-all';
  // 'create' always starts empty, even if it reuses an existing name (an explicit reset).
  const context_path = plan.$ === 'none' ? context_file(model) : plan.file;
  const previous_context = plan.$ === 'default' || plan.$ === 'existing' ? read_text(plan.file) : '';
  const first_prompt = previous_context
    ? `Previous context:\n${previous_context}\n\nUser:\n${full_prompt}`
    : full_prompt;
  const state: ConversationState = {
    firstPrompt: first_prompt,
    timeline: [`User:\n${full_prompt}`],
    commandRounds: 0,
    chainLimitReached: false,
    autoContinue: Boolean(opts.chain),
    execMode: exec_mode,
    saveContext: save_context,
    stream: Boolean(opts.stream),
    think: Boolean(opts.think),
  };
  if (plan.$ === 'none') fs.rmSync(context_path, { force: true });
  const log = log_file();
  append_log(log, `Model: ${label}\nUser:\n${full_prompt}`);

  let ai: AskInstance | null = null;
  try {
    const config = await load_sdk_config();
    ai = await create_ask_ai(model, config);
    lock_process_environment();
    await run_response_loop(ai, state, log, context_path, previous_context);
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', format_model_error(error));
    process.exitCode = 1;
    return;
  }

  // Summarize if context grew too large; otherwise incremental saves already handled it
  if (save_context) {
    await maybe_summarize_context(ai, state, previous_context, context_path);
  }
}

async function main() {
  if (wants_model_help(process.argv)) {
    print_model_help();
    return;
  }

  const program = build_program(process.argv);
  const opts = program.opts<CliOptions>();

  if (opts.history !== undefined) {
    run_history_dispatch(opts.history);
    return;
  }

  if (opts.models) {
    await print_custom_models();
    return;
  }

  const positional_args = program.args;
  if (opts.ctx !== undefined && opts.context) {
    console.error('\x1b[31merror: --ctx cannot be combined with -c\x1b[0m');
    process.exitCode = 1;
    return;
  }

  const input = parse_args(positional_args, opts.model, Boolean(opts.input));
  const stdin_text = input.readStdin ? await read_stdin().catch(() => '') : '';
  const prompt = format_prompt(input.parts.join(' '), stdin_text, opts);
  if (opts.web) {
    await launch_web({
      model: input.model,
      prompt,
      cwd: opts.cwd,
      noExec: opts.exec === false,
      requireApproval: opts.requireApproval,
      chain: opts.chain,
      yes: opts.yes,
      stream: opts.stream,
      think: opts.think,
    });
    return;
  }
  const ctx_has_prompt = typeof opts.ctx === 'string' && ctx_value_has_prompt(opts.ctx);
  if (!prompt && !ctx_has_prompt) {
    console.error(format_missing_prompt_error(program));
    process.exitCode = 1;
    return;
  }
  // `input.parts` is the positional prompt with any leading model spec already
  // stripped, so a positional model (`tell g --ctx ola`) does not count as a
  // prompt. A bare `--ctx` token (no `%`/`@`) is prompt text only when there
  // is no positional prompt; naming a context requires `%`.
  await run_tell(input.model, prompt, opts, input.parts.length > 0);
}

main().catch((error: unknown) => {
  console.error('\x1b[31m%s\x1b[0m', format_model_error(error));
  process.exitCode = 1;
});
