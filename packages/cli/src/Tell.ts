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
  MODELS,
  resolve_model_spec,
  strip_run_tags,
  strip_think_tags,
  summarize_context,
  tell,
} from '@tell-ai/sdk';
import { Command } from 'commander';
import { load_sdk_config } from './env';
import { expand_mentions } from './mentions';
import { get_system_prompt, type PromptOptions } from './systemPrompt';

const EXEC_ASYNC = promisify(exec);
const DEFAULT_MODEL = process.env['TELL_MODEL'] || 'g';
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_CHAIN_STEPS = 8;
const EXEC_TIMEOUT = 120_000;
const STDIN_TIMEOUT = 30_000;
// Chars of accumulated conversation context; beyond this the oldest part is
// summarized away (LLM windows are far below 64K chars of raw history).
const MAX_CONTEXT_CHARS = 64 * 1024;

type CliOptions = {
  model?: string;
  context?: boolean;
  ctx?: boolean | string;
  name?: boolean;
  list?: boolean;
  yes?: boolean;
  chain?: boolean;
  exec?: boolean;
  input?: boolean;
  web?: boolean;
  stream?: boolean;
  think?: boolean;
  cwd?: string;
};

type ParsedInput = { model: string; parts: string[]; readStdin: boolean };

// A saved context file on disk, addressable by recency index, hash prefix, or name.
type ContextEntry = { file: string; id: string; mtimeMs: number };

// The resolved plan for how the current invocation should read/write context:
// - 'none': no context flag was given (legacy one-shot behavior, default context is cleared).
// - 'default': `-c` or bare `--ctx` — the per-directory + model context.
// - 'existing': `--ctx <ref>` resolved to an already-saved context (by index, hash prefix, or name).
// - 'create': `--ctx <name> -n` (explicit reset) or `--ctx` on a missing name.
type ContextPlan =
  | { $: 'none' }
  | { $: 'default'; file: string; promptFromRef?: string }
  | { $: 'existing'; file: string; label: string }
  | { $: 'create'; file: string; label: string };

type ConversationState = {
  firstPrompt: string;
  timeline: string[];
  commandRounds: number;
  chainLimitReached: boolean;
  autoContinue: boolean;
  execEnabled: boolean;
  yes: boolean;
  saveContext: boolean;
  stream: boolean;
  think: boolean;
};

type CommandResult = { output: string; exitCode: number };
type ScriptsResult = { text: string; failed: boolean };

const CREATED_DIRS = new Set<string>();

function ensure_dir(dir: string): void {
  if (CREATED_DIRS.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
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

async function execute_command(script: string): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await EXEC_ASYNC(script, {
      cwd: process.cwd(),
      maxBuffer: MAX_BUFFER,
      shell: '/bin/bash',
      timeout: EXEC_TIMEOUT,
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

function log_file(): string {
  const dir = path.join(os.homedir(), '.ai', 'tell_history');
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
  const entries = names.map((name) => {
    const file = path.join(context_dir(), name);
    const mtimeMs = fs.statSync(file).mtimeMs;
    return { file, id: name.slice(0, -'.txt'.length), mtimeMs };
  });
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

// Shortens long random/hash ids for display; leaves human-readable names untouched.
function short_id(id: string): string {
  const HASH_ID_LENGTH = 16;
  const SHORT_ID_LENGTH = 8;
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

function context_preview(file: string): string {
  const PREVIEW_MAX_CHARS = 60;
  const text = read_text(file);
  const first_line = (text.split('\n').find((line) => line.trim().length > 0) || '').replace(/^User:\s*/, '').trim();
  return first_line.length > PREVIEW_MAX_CHARS ? `${first_line.slice(0, PREVIEW_MAX_CHARS - 3)}...` : first_line;
}

function print_context_list(entries: ContextEntry[]): void {
  if (entries.length === 0) {
    console.log('No saved contexts.');
    return;
  }
  const rows = entries.map((entry, index) => ({
    ref: `@${index}`,
    id: short_id(entry.id),
    age: format_age(entry.mtimeMs),
    preview: context_preview(entry.file),
  }));
  const ref_width = Math.max(...rows.map((row) => row.ref.length));
  const id_width = Math.max(...rows.map((row) => row.id.length));
  const age_width = Math.max(...rows.map((row) => row.age.length));
  for (const row of rows) {
    const columns = `${row.ref.padEnd(ref_width)}  ${row.id.padEnd(id_width)}  ${row.age.padEnd(age_width)}`;
    console.log(`${columns}  ${row.preview}`);
  }
}

// Validates a token as a human-readable context name: no whitespace, a safe
// filename charset. Ref syntax (`@N`, `#hash`) is excluded by the charset.
function sanitize_context_name(raw: string): string | null {
  const NAME_MAX_LENGTH = 100;
  const value = raw.trim();
  if (!value || /\s/.test(value)) return null;
  if (!new RegExp(`^[A-Za-z0-9._-]{1,${NAME_MAX_LENGTH}}$`).test(value)) return null;
  return value;
}

// A multi-word `--ctx` value cannot be a name or ref (both are single
// tokens), so it is prompt text for the default context (`-c` behavior).
function ctx_value_is_prompt_text(value: string): boolean {
  return /\s/.test(value.trim());
}

// Resolves a `--ctx <ref>` value into a context plan. Syntax is explicit, one
// namespace per prefix: `@N` = recency index, `#hex` = hash prefix — both must
// match an existing context. A single-token name is use-or-create (resumed
// when it exists, created when it doesn't). A multi-word value is prompt text
// for the default context — unnamed contexts are never saved.
function resolve_or_create_context_ref(raw: string, entries: ContextEntry[], model: string): ContextPlan {
  const value = raw.trim();

  const index_match = /^@(\d+)$/i.exec(value);
  if (index_match?.[1] !== undefined) {
    const index = Number(index_match[1]);
    const entry = entries[index];
    if (!entry) {
      throw new Error(
        `No context at index ${index} (have ${entries.length} saved context${entries.length === 1 ? '' : 's'})`,
      );
    }
    return { $: 'existing', file: entry.file, label: `@${index} (${short_id(entry.id)})` };
  }

  if (value.startsWith('#')) {
    const hash_prefix = value.slice(1);
    if (!/^[0-9a-f]+$/i.test(hash_prefix)) {
      throw new Error(`Invalid hash reference "${value}" — use # followed by hex digits`);
    }
    const matches = entries.filter((entry) => entry.id.toLowerCase().startsWith(hash_prefix.toLowerCase()));
    if (matches.length === 1 && matches[0]) {
      return { $: 'existing', file: matches[0].file, label: short_id(matches[0].id) };
    }
    if (matches.length > 1) {
      const ids = matches.map((entry) => short_id(entry.id)).join(', ');
      throw new Error(`Ambiguous context hash "${value}" — matches: ${ids}`);
    }
    throw new Error(`No context matches hash "${value}"`);
  }

  const name = sanitize_context_name(value);
  if (name) {
    const match = entries.find((entry) => entry.id === name);
    if (match) return { $: 'existing', file: match.file, label: name };
    return { $: 'create', file: named_context_file(name), label: name };
  }

  if (ctx_value_is_prompt_text(value)) {
    return { $: 'default', file: context_file(model), promptFromRef: value };
  }

  throw new Error(`Invalid context reference "${value}" — use @N (recency), #hash-prefix, or a name`);
}

// Builds the effective context plan for this invocation from the parsed
// `-c`/`--ctx`/`-n` options. `--ctx <name> -n` is an explicit reset: always
// starts empty, even when the name already exists.
function build_context_plan(opts: CliOptions, model: string, entries: ContextEntry[]): ContextPlan {
  if (opts.name) {
    const name = typeof opts.ctx === 'string' ? sanitize_context_name(opts.ctx) : null;
    if (!name) throw new Error('-n/--name requires a context name: --ctx <name> -n');
    return { $: 'create', file: named_context_file(name), label: name };
  }
  if (opts.ctx === true || opts.context) return { $: 'default', file: context_file(model) };
  if (typeof opts.ctx === 'string') return resolve_or_create_context_ref(opts.ctx, entries, model);
  return { $: 'none' };
}

function append_log(file: string, text: string): void {
  ensure_dir(path.dirname(file));
  fs.appendFileSync(file, `${text}\n`, 'utf8');
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
  fs.writeFileSync(file, `${limit_context(content).trim()}\n`, 'utf8');
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
    /\brm\s+(-[^\s]*[rf][^\s]*|-[^\s]*[fr][^\s]*)\b/,
    /\b(git\s+clean\s+-[^\s]*[xfd]|mkfs|shutdown|reboot)\b/,
    /\bdd\b.*\bof=/,
    /\b(chmod|chown)\s+-R\b.*\s\/(?:\s|$)/,
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

async function confirm_command(script: string, yes: boolean): Promise<boolean> {
  const high_risk = is_high_risk_script(script);
  if (yes && !high_risk) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const label = high_risk ? 'High-risk command requested' : 'Command requested';
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

async function run_script(
  script: string,
  yes: boolean,
  execEnabled: boolean,
): Promise<{ result: string; failed: boolean }> {
  if (!execEnabled) {
    process.stderr.write('\x1b[33mCommand execution disabled (--no-exec).\x1b[0m\n');
    return {
      result: `Command execution disabled — not run:\n${script}`,
      failed: false,
    };
  }
  if (!(await confirm_command(script, yes))) {
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

async function run_scripts(scripts: string[], yes: boolean, execEnabled: boolean, log: string): Promise<ScriptsResult> {
  const results: string[] = [];
  let failed = false;
  for (const script of scripts) {
    const { result, failed: script_failed } = await run_script(script, yes, execEnabled);
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
        case 'reasoning':
          reasoning += event.text;
          if (show_think) {
            clear_indicator();
            process.stderr.write(`\x1b[2m${event.text}\x1b[0m`);
            is_reasoning_open = true;
          }
          break;
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
    .option('--ctx [ref]', 'use-or-create: @N, #hash-prefix, name, or prompt text for the default context')
    .option('-n, --name', 'reset a named context (--ctx <name> -n; starts empty, even if it exists)')
    .option('-l, --list', 'list saved contexts (@N, id, age, preview)')
    .option('-y, --yes', 'execute requested commands without confirmation')
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

    const { text: result_text, failed } = await run_scripts(scripts, state.yes, state.execEnabled, log);
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

async function run_tell(model: string, prompt: string, opts: CliOptions): Promise<void> {
  let label = '';
  let plan: ContextPlan;
  try {
    label = model_label(model);
    const entries = typeof opts.ctx === 'string' ? list_context_entries() : [];
    plan = build_context_plan(opts, model, entries);
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (plan.$ === 'create') {
    process.stderr.write(`\x1b[2mCreated context: ${plan.label}\x1b[0m\n`);
  } else if (plan.$ === 'existing') {
    process.stderr.write(`\x1b[2mUsing context: ${plan.label}\x1b[0m\n`);
  } else {
    // 'none' and 'default' reuse the legacy per-directory/model context silently — nothing to announce.
  }

  // A multi-word `--ctx` value is prompt text for the fresh context it created.
  const raw_prompt = [plan.$ === 'default' ? (plan.promptFromRef ?? '') : '', prompt].filter(Boolean).join(' ');
  // `@path` mentions resolve against the working directory; the expanded
  // text is what reaches the log, the timeline, and the saved context.
  const full_prompt = await expand_mentions(raw_prompt, process.cwd(), { yes: Boolean(opts.yes) });
  const save_context = plan.$ !== 'none';
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
    execEnabled: opts.exec !== false,
    yes: Boolean(opts.yes),
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

  if (opts.list) {
    print_context_list(list_context_entries());
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
      chain: opts.chain,
      yes: opts.yes,
      stream: opts.stream,
      think: opts.think,
    });
    return;
  }
  const ctx_is_prompt = typeof opts.ctx === 'string' && ctx_value_is_prompt_text(opts.ctx);
  if (!prompt && !ctx_is_prompt) {
    console.error(format_missing_prompt_error(program));
    process.exitCode = 1;
    return;
  }
  await run_tell(input.model, prompt, opts);
}

main().catch((error: unknown) => {
  console.error('\x1b[31m%s\x1b[0m', format_model_error(error));
  process.exitCode = 1;
});
