import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {
  build_execution_options,
  DEFAULT_CONTEXT_MAX_CHARS,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_MAX_CHAIN_STEPS,
  DEFAULT_OUTPUT_MAX_BYTES,
  DEFAULT_STDIN_MAX_BYTES,
  DEFAULT_STDIN_TIMEOUT_MS,
  EXIT_CONFIG_ERROR,
  EXIT_LIMIT,
  EXIT_MODEL_ERROR,
  EXIT_TIMEOUT,
  format_command_result,
  format_command_skipped,
  MAX_CHAIN_STEPS,
  parse_runtime_limits,
  type RuntimeLimits,
  runtime_env_from_process,
  StdinLimitError,
  truncate_context,
  truncate_output,
} from '@tell-ai/core';
import {
  type AskInstance,
  create_ask_ai,
  get_system_prompt,
  list_custom_models,
  MODELS,
  resolve_model_spec,
  strip_run_tags,
  strip_think_tags,
  summarize_context,
  WIRE_APIS,
} from '@tell-ai/sdk';
import { Command } from 'commander';
import {
  type CoreConfig,
  cli_risk_port,
  create_cli_approval,
  create_cli_executor,
  create_cli_memory_storage,
  create_cli_model,
  create_core_runtime,
  type ExecMode,
  is_high_risk_script,
  lock_process_environment,
  READLINE_CONFIRM_TIMEOUT_MS,
  type RuntimeCallbacks,
  resolve_cli_core_config,
  script_touches_outside_cwd,
  type TellResult,
} from './core-adapters';
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
import { expand_mentions } from './mentions';
import {
  compose_system_prompt,
  load_system_file_text,
  load_tellrc,
  resolve_model_input,
  resolve_tellrc,
  tellrc_custom_text,
  validate_temperature,
} from './tellrc';

const DEFAULT_MODEL = process.env['TELL_MODEL'] || 'g';
const STDIN_TIMEOUT = DEFAULT_STDIN_TIMEOUT_MS;
// Chars of accumulated conversation context; beyond this the oldest part is
// summarized away (LLM windows are far below 64K chars of raw history).
// Single owner of the value lives in `@tell-ai/core`; this alias keeps
// historical references working without a second constant.
const MAX_CONTEXT_CHARS = DEFAULT_CONTEXT_MAX_CHARS;

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
  profile?: string;
  system?: string;
  systemFile?: string;
  temperature?: string;
  contextMaxChars?: string;
  stdinTimeout?: string | boolean;
  noStdinTimeout?: boolean;
  stdinMaxBytes?: string;
  execTimeout?: string;
  maxChain?: string;
  maxBuffer?: string;
  outputMaxBytes?: string;
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

// Effective execution mode lives in `./core-adapters` (single owner shared
// with the approval port); the readline prompt below only renders it.

type ConversationState = {
  firstPrompt: string;
  timeline: string[];
  autoContinue: boolean;
  execMode: ExecMode;
  saveContext: boolean;
  stream: boolean;
  think: boolean;
  coreConfig: CoreConfig;
  customSystemText?: string;
  temperature?: number;
  limits: RuntimeLimits;
};

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

function is_model_spec(value: string, custom_aliases?: Record<string, string>): boolean {
  if (custom_aliases?.[value] !== undefined) return true;
  const bare = value.startsWith('.') ? value.slice(1) : value;
  if (custom_aliases?.[bare] !== undefined) return true;
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
    process.exitCode = EXIT_MODEL_ERROR;
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

// Risk classification, the scrubbed command environment and the `exec`
// transport moved to `./core-adapters` (core-owned ports); this file keeps
// only the readline prompt, history/context UX and the response loop.

async function read_stdin(limits?: RuntimeLimits): Promise<string> {
  if (process.stdin.isTTY) return '';
  const timeout_ms = limits?.stdin_timeout_ms ?? STDIN_TIMEOUT;
  const max_bytes = limits?.stdin_max_bytes ?? DEFAULT_STDIN_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const timer =
      timeout_ms > 0
        ? setTimeout(() => {
            cleanup();
            reject(new StdinLimitError('timeout', `stdin read timed out after ${timeout_ms / 1000}s`));
          }, timeout_ms)
        : undefined;

    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      process.stdin.removeListener('data', on_data);
      process.stdin.removeListener('end', on_end);
      process.stdin.removeListener('error', on_error);
    };
    const on_data = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > max_bytes) {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new StdinLimitError('overflow', `stdin exceeded ${max_bytes} bytes`));
        } else {
          // Already settled — ignore late data.
        }
      } else {
        chunks.push(chunk);
      }
    };
    const on_end = (): void => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(Buffer.concat(chunks).toString('utf8').trimEnd());
      } else {
        // Overflow/timeout already rejected — ignore end.
      }
    };
    const on_error = (err: Error): void => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      } else {
        // Already settled — ignore error.
      }
    };
    process.stdin.on('data', on_data);
    process.stdin.on('end', on_end);
    process.stdin.on('error', on_error);
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
      process.exitCode = EXIT_MODEL_ERROR;
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
    process.exitCode = EXIT_MODEL_ERROR;
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

function limit_context(text: string, max_chars: number = MAX_CONTEXT_CHARS): string {
  return truncate_context(text, max_chars);
}

function write_context(file: string, content: string, max_chars: number = MAX_CONTEXT_CHARS): void {
  ensure_dir(path.dirname(file));
  fs.writeFileSync(file, `${limit_context(content, max_chars).trim()}\n`, { encoding: 'utf8', mode: 0o600 });
  tighten_permissions(file, 0o600);
}

function save_incremental_context(contextPath: string, previousContext: string, state: ConversationState): void {
  try {
    const turn = strip_think_tags(conversation_text(state));
    const next_context = previousContext ? `${previousContext}\n${turn}` : turn;
    write_context(contextPath, next_context, state.limits.context_max_chars);
  } catch (err) {
    process.stderr.write(
      `\x1b[33mWarning: failed to save incremental context: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`,
    );
  }
}

// Risk classification and outside-cwd path checks moved to
// `./core-adapters` (core-owned ports); the prompt below only renders them.

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

    const timer = setTimeout(() => done(false), READLINE_CONFIRM_TIMEOUT_MS);

    rl.question('\x1b[31mExecute this command? [y/N] \x1b[0m', (answer) => {
      clearTimeout(timer);
      done(answer.trim().toUpperCase() === 'YES' || answer.trim().toUpperCase() === 'Y');
    });
  });
}

// Command authorization and execution moved to the core runtime
// (`create_cli_approval` + `create_cli_executor` in `./core-adapters`);
// the readline prompt above only renders the decision, and the loop below
// only mirrors files from the runtime callbacks.

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

function parse_args(
  args: string[],
  optModel: string | undefined,
  readPipedInput = false,
  custom_aliases: Record<string, string> = {},
): ParsedInput {
  let model = optModel || DEFAULT_MODEL;
  let parts = args;
  const first_arg = args[0];
  const first_is_model = !optModel && typeof first_arg === 'string' && is_model_spec(first_arg, custom_aliases);
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
    .option('--profile <name>', 'tellrc profile (node, security, devops)')
    .option('--system <text>', 'custom instructions prepended before the safety prompt')
    .option('--system-file <path>', 'file with custom instructions (64 KB cap)')
    .option('--temperature <n>', 'sampling temperature 0..2')
    .option('--context-max-chars <n>', `max context chars (default ${DEFAULT_CONTEXT_MAX_CHARS})`)
    .option('--stdin-timeout <ms>', `stdin read deadline in ms (default ${DEFAULT_STDIN_TIMEOUT_MS})`)
    .option('--no-stdin-timeout', 'disable the stdin deadline (byte cap stays)')
    .option('--stdin-max-bytes <n>', `max stdin bytes (default ${DEFAULT_STDIN_MAX_BYTES})`)
    .option('--exec-timeout <ms>', `per-command timeout in ms (default ${DEFAULT_EXEC_TIMEOUT_MS})`)
    .option('--max-chain <n>', `max chain rounds 1..${MAX_CHAIN_STEPS} (default ${DEFAULT_MAX_CHAIN_STEPS})`)
    .option('--max-buffer <n>', `internal exec buffer bytes (default ${DEFAULT_MAX_BUFFER_BYTES})`)
    .option('--output-max-bytes <n>', `delivered output cap bytes (default ${DEFAULT_OUTPUT_MAX_BYTES})`)
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

// Prints trimmed command output dimmed on TTY, plain otherwise (legacy
// `run_script` rendering, now mirrored from the core output callback).
function print_command_output(output: string): void {
  const text = output.trim();
  if (!text) return;
  if (process.stderr.isTTY) {
    process.stderr.write(`\x1b[2m${text}\x1b[0m\n`);
  } else {
    process.stderr.write(`${text}\n`);
  }
}

// Follow-up instruction for resumed chain rounds (legacy wording, kept
// verbatim: the pinned suites match on it and forbid `Conversation so far:`).
const RESUME_INSTRUCTION = 'Request another command with <RUN> tags if needed; otherwise answer without <RUN> tags.';

// True when a finished run paused on a declined command and chain mode must
// resume it: the core loop stops on non-executed commands (confirm pauses,
// deny ends) while the legacy chain treats declines as `failed: false` and
// asks the model again. Cancelled/failed runs and runs without commands
// never resume.
function should_resume_after_decline(result: TellResult): boolean {
  if (result.status !== 'completed') {
    return false;
  } else {
    const last = result.commands[result.commands.length - 1];
    if (last === undefined) {
      return false;
    } else {
      return last.status === 'skipped' || last.status === 'denied';
    }
  }
}

// Merges a continuation run into the aggregated result (dropping the
// repeated `User:` line, like the core loop does per round).
function merge_run_result(aggregated: TellResult, next: TellResult): TellResult {
  return {
    status: next.status,
    text: next.text,
    timeline: [...aggregated.timeline, ...next.timeline.slice(1)],
    commands: [...aggregated.commands, ...next.commands],
  };
}

async function run_response_loop(
  ai: AskInstance,
  state: ConversationState,
  log: string,
  contextPath: string,
  previousContext: string,
): Promise<void> {
  // The system prompt is fixed for the run (legacy round-one wording for
  // both modes; feedback rounds only exist in chain mode, where it matches).
  // Tellrc custom instructions prepend context only — safety stays last and
  // config can never replace <RUN>, approval, injection or deny rules.
  const system = compose_system_prompt(
    get_system_prompt({ chain: state.autoContinue, cwd: process.cwd(), platform: `${os.platform()} ${os.release()}` }),
    state.customSystemText,
  );
  // The raw response of the in-flight round (captured by the model port for
  // the log/timeline mirror below; the core wiring only forwards stripped
  // text to its callbacks).
  let last_raw = '';
  const model = create_cli_model(ai, {
    stream: state.stream,
    think: state.think,
    ...(state.temperature !== undefined ? { temperature: state.temperature } : {}),
    on_raw: (response) => {
      last_raw = response;
    },
  });
  const approval = create_cli_approval(state.execMode, (pending) => confirm_command(pending, state.execMode));
  // Shared ports across runs: storage accumulates the conversation so resumed
  // runs compose follow-ups continuously; everything else is stateless.
  const storage = create_cli_memory_storage(previousContext);
  // The execution contract is built once from the resolved limits (single
  // owner in `@tell-ai/core`): timeout/buffer flow to the injected
  // executor, the output cap to delivered text, rounds to the loop budget.
  const exec_options = build_execution_options(state.limits);
  const executor = create_cli_executor({
    timeout_ms: exec_options.timeout_ms,
    max_output_bytes: exec_options.max_buffer_bytes,
  });
  const chain_budget = exec_options.max_rounds;
  const runtime_callbacks: RuntimeCallbacks = {
    onText: () => {
      remember_assistant(state, log, last_raw);
      if (state.saveContext) save_incremental_context(contextPath, previousContext, state);
    },
    onCommandOutput: (event) => {
      const capped = truncate_output(event.output, exec_options.max_output_bytes);
      const result_text = format_command_result(event.script, capped, event.exit_code);
      print_command_output(capped);
      append_log(log, result_text);
      remember_command_result(state, result_text);
      if (state.saveContext) save_incremental_context(contextPath, previousContext, state);
    },
    onCommandSkip: (event) => {
      const disabled = event.reason === 'disabled';
      const result_text = disabled
        ? `Command execution disabled — not run:\n${event.script}`
        : format_command_skipped(event.script);
      if (disabled) {
        process.stderr.write('\x1b[33mCommand execution disabled (--no-exec).\x1b[0m\n');
      } else {
        process.stderr.write('\x1b[33mCommand skipped by user.\x1b[0m\n');
      }
      append_log(log, result_text);
      remember_command_result(state, result_text);
      if (state.saveContext) save_incremental_context(contextPath, previousContext, state);
    },
    onExecutorError: (event) => {
      const result_text = format_command_result(event.script, event.error, null);
      append_log(log, result_text);
      remember_command_result(state, result_text);
      if (state.saveContext) save_incremental_context(contextPath, previousContext, state);
    },
  };
  // One runtime per budget: resumed runs get only the rounds the legacy
  // 8-command counter still allows, so chained declines can never overshoot
  // the cap the way a fresh full-budget run would.
  function create_runtime(rounds: number) {
    return create_core_runtime({
      config: state.coreConfig,
      model,
      storage,
      executor,
      approval,
      risk: cli_risk_port(),
      system,
      callbacks: runtime_callbacks,
      max_rounds: rounds,
    });
  }
  let runtime = create_runtime(state.autoContinue ? chain_budget : 1);
  let result = await runtime.run(state.firstPrompt);
  // Chain mode resumes after declined commands with the legacy feedback
  // (conversation plus instruction); executed/failed rounds already iterate
  // inside the core loop. The total stays capped like the legacy counter.
  // The resume check reads the latest run only: a clean follow-up must stop
  // even when an earlier round declined.
  let latest = result;
  while (state.autoContinue && result.commands.length < chain_budget && should_resume_after_decline(latest)) {
    const feedback = `${strip_think_tags(conversation_text(state))}\n\n${RESUME_INSTRUCTION}`;
    runtime = create_runtime(chain_budget - result.commands.length);
    latest = await runtime.run(feedback);
    result = merge_run_result(result, latest);
  }
  if (state.autoContinue && result.commands.length >= chain_budget) {
    process.stderr.write(`\x1b[33mChain limit reached (${chain_budget}); asking for final answer.\x1b[0m\n`);
    process.stderr.write(
      `\x1b[33mChain limit reached (${chain_budget}); ignoring further requested commands.\x1b[0m\n`,
    );
  } else {
    // Limit not reached — nothing to announce.
  }
  // Default-mode final answer (legacy `handle_final_answer`): commands ran
  // but the visible answer is empty — ask once more without `<RUN>`.
  if (!state.autoContinue && result.commands.length > 0 && !result.text) {
    const final_prompt = `${strip_think_tags(conversation_text(state))}`;
    const final_response = await model.ask(final_prompt, { system, stream: false });
    const final_text = strip_run_tags(strip_think_tags(final_response));
    if (final_text && !state.stream) console.log(final_text);
  } else if (result.text && !state.stream) {
    console.log(result.text);
  } else {
    // Streaming already printed live (trailing newline handled in the port).
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
    if (previousContext && previousContext.length + turn.length > state.limits.context_max_chars) {
      try {
        const summary = await summarize_context(ai, previousContext);
        write_context(contextPath, `${summary}\n${turn}`, state.limits.context_max_chars);
      } catch {
        write_context(contextPath, `${previousContext}\n${turn}`, state.limits.context_max_chars);
      }
    }
  } catch (error) {
    console.error(
      '\x1b[31mFailed to summarize context: %s\x1b[0m',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = EXIT_MODEL_ERROR;
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
  profile?: string | undefined;
  systemFile?: string | undefined;
  systemText?: string | undefined;
  temperature?: number | undefined;
  maxChainSteps?: number | undefined;
  maxBufferBytes?: number | undefined;
  contextChars?: number | undefined;
  stdinTimeoutMs?: number | undefined;
  execTimeout?: number | undefined;
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
        process.exitCode = EXIT_MODEL_ERROR;
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
  // Tellrc forwarding: model via -m (above), profile via its own flag,
  // system via --system-file, temperature via its own flag and limits via
  // numeric flags. Keys, URLs and secrets are never forwarded.
  if (opts.profile) child_args.push('--profile', opts.profile);
  if (opts.temperature !== undefined) child_args.push('--temperature', String(opts.temperature));
  let temp_system_file: string | null = null;
  try {
    if (opts.systemFile) {
      child_args.push('--system-file', opts.systemFile);
    } else if (opts.systemText) {
      temp_system_file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tell-system-')), 'system.txt');
      fs.writeFileSync(temp_system_file, opts.systemText, { mode: 0o600 });
      try {
        fs.chmodSync(temp_system_file, 0o600);
      } catch {
        // Exotic filesystems may reject chmod — the 0600 open mode already applied.
      }
      child_args.push('--system-file', temp_system_file);
    } else {
      // No custom system to forward.
    }
    if (opts.maxChainSteps !== undefined) child_args.push('--max-chain-steps', String(opts.maxChainSteps));
    if (opts.maxBufferBytes !== undefined) child_args.push('--max-buffer-bytes', String(opts.maxBufferBytes));
    if (opts.contextChars !== undefined) child_args.push('--context-chars', String(opts.contextChars));
    if (opts.stdinTimeoutMs !== undefined) child_args.push('--stdin-timeout-ms', String(opts.stdinTimeoutMs));
    if (opts.execTimeout !== undefined) child_args.push('--exec-timeout', String(opts.execTimeout));

    const child = spawn('tell-web', child_args, {
      stdio: 'inherit',
      env: { ...process.env, TELL_MODEL: opts.model, NODE_ENV: 'production' },
      cwd,
    });
    child.on('error', (err: unknown) => {
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT') {
        console.error('\x1b[31mWeb interface not installed. Install it with:\x1b[0m\n  npm install -g @tell-ai/web\n');
        process.exitCode = EXIT_MODEL_ERROR;
      } else {
        console.error(
          `\x1b[31mFailed to launch web interface: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        );
        process.exitCode = EXIT_MODEL_ERROR;
      }
    });
    await new Promise<void>((resolve) => {
      child.on('exit', (exit_code: number | null) => {
        if (exit_code !== null) process.exitCode = exit_code;
        resolve();
      });
    });
  } finally {
    if (temp_system_file) {
      try {
        fs.rmSync(path.dirname(temp_system_file), { recursive: true, force: true });
      } catch {
        // Best-effort temp cleanup — never fail the run.
      }
    } else {
      // No temp file was created.
    }
  }
}

/**
 * Reads the tellrc env layer (TELL_* scalars only, never secrets).
 *
 * @returns The env subset for `resolve_tellrc`.
 */
function tellrc_env_from_process(): {
  TELL_MODEL?: string;
  TELL_SYSTEM?: string;
  TELL_SYSTEM_FILE?: string;
  TELL_TEMPERATURE?: string;
  TELL_PROFILE?: string;
} {
  const env: Record<string, string> = {};
  const take = (name: string): void => {
    const value = process.env[name];
    if (value?.trim()) env[name] = value;
  };
  take('TELL_MODEL');
  take('TELL_SYSTEM');
  take('TELL_SYSTEM_FILE');
  take('TELL_TEMPERATURE');
  take('TELL_PROFILE');
  return env;
}

/**
 * Resolves runtime limits with `flag > env > project > user > default`.
 *
 * Reuses the tellrc file layers (no second parser) and the runtime env
 * reader; flag/env values fail with exit 2 via `parse_runtime_limits`.
 *
 * @param opts - Commander options carrying limit flags.
 * @param cwd - Working directory for the project layer.
 * @returns The resolved limits.
 */
function resolve_runtime_limits(opts: CliOptions, cwd: string): RuntimeLimits {
  const no_timeout = opts.noStdinTimeout === true || (opts.stdinTimeout as unknown) === false;
  const layers = load_tellrc(cwd, os.homedir());
  const user = layers.find((layer) => layer.rank === 1);
  const project = layers.find((layer) => layer.rank === 2);
  return parse_runtime_limits({
    flags: {
      ...(opts.contextMaxChars !== undefined ? { context_max_chars: opts.contextMaxChars } : {}),
      ...(opts.stdinTimeout !== undefined && (opts.stdinTimeout as unknown) !== false
        ? { stdin_timeout_ms: opts.stdinTimeout as string }
        : {}),
      ...(no_timeout ? { no_stdin_timeout: true } : {}),
      ...(opts.stdinMaxBytes !== undefined ? { stdin_max_bytes: opts.stdinMaxBytes } : {}),
      ...(opts.execTimeout !== undefined ? { exec_timeout_ms: opts.execTimeout } : {}),
      ...(opts.maxChain !== undefined ? { max_chain_steps: opts.maxChain } : {}),
      ...(opts.maxBuffer !== undefined ? { max_buffer_bytes: opts.maxBuffer } : {}),
      ...(opts.outputMaxBytes !== undefined ? { output_max_bytes: opts.outputMaxBytes } : {}),
    },
    env: runtime_env_from_process(process.env),
    ...(project ? { project: { source: project.source, limits: project.limits } } : {}),
    ...(user ? { user: { source: user.source, limits: user.limits } } : {}),
  });
}

/**
 * Resolves the invocation tellrc (files + env + flags) for the CLI.
 *
 * @param opts - Commander options carrying flag overrides.
 * @param cwd - Working directory for the project layer.
 * @param quiet - Skip stderr warnings (the caller re-resolves and prints).
 * @returns The resolved tellrc with provenance and warnings.
 */
function resolve_invocation_tellrc(opts: CliOptions, cwd: string, quiet = false): ReturnType<typeof resolve_tellrc> {
  const layers = load_tellrc(cwd, os.homedir());
  const flags: { model?: string; system?: string; system_file?: string; temperature?: number; profile?: string } = {};
  const flag_warnings: string[] = [];
  if (opts.model) flags.model = opts.model;
  if (opts.system) flags.system = opts.system;
  if (opts.systemFile) flags.system_file = opts.systemFile;
  if (opts.profile) flags.profile = opts.profile;
  if (opts.temperature !== undefined) {
    const value = validate_temperature(Number(opts.temperature));
    if (value !== undefined) {
      flags.temperature = value;
    } else {
      flag_warnings.push(`--temperature ${opts.temperature} invalid (expected 0..2), ignored`);
    }
  } else {
    // No flag temperature.
  }
  const resolved = resolve_tellrc(layers, flags, tellrc_env_from_process());
  for (const warning of flag_warnings) resolved.warnings.push(warning);
  if (!quiet) {
    for (const warning of resolved.warnings) process.stderr.write(`\x1b[33mWarning: ${warning}\x1b[0m\n`);
  } else {
    // Quiet: the caller re-resolves and prints warnings itself.
  }
  return resolved;
}

async function run_tell(
  model: string,
  prompt: string,
  opts: CliOptions,
  has_positional_prompt: boolean,
): Promise<void> {
  // Tellrc resolution (files + env + flags): aliases resolve without
  // mutating MODELS; temperature and custom system flow into the run;
  // deny/limits stay validated data (enforcement lives elsewhere).
  const tellrc = resolve_invocation_tellrc(opts, process.cwd());
  let limits: RuntimeLimits;
  try {
    limits = resolve_runtime_limits(opts, process.cwd());
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT_CONFIG_ERROR;
    return;
  }
  const effective_model = resolve_model_input(tellrc.model ?? model, tellrc.aliases, MODELS);
  let label = '';
  let plan: ContextPlan;
  try {
    label = model_label(effective_model);
    const entries = typeof opts.ctx === 'string' ? list_context_entries() : [];
    plan = build_context_plan(opts, effective_model, entries, has_positional_prompt);
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT_MODEL_ERROR;
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
  // Core config resolved once per invocation (exec/chain only — provider
  // keys and URLs stay in `./env` until the explicit tellkey handoff).
  // `--no-exec` wins over everything; `-y` enables the risk-gated auto mode.
  // `--require-approval` is declarative in the CLI (high-risk always asks even
  // with -y, which is already `auto-risk` behavior) and is forwarded to -w.
  const core_config = resolve_cli_core_config({
    exec: opts.exec,
    chain: opts.chain,
    exec_timeout_ms: limits.exec_timeout_ms,
  });
  const exec_mode: ExecMode = core_config.exec_enabled === false ? 'no-exec' : opts.yes ? 'auto-risk' : 'confirm-all';
  // 'create' always starts empty, even if it reuses an existing name (an explicit reset).
  const context_path = plan.$ === 'none' ? context_file(effective_model) : plan.file;
  const previous_context = plan.$ === 'default' || plan.$ === 'existing' ? read_text(plan.file) : '';
  // Tellrc system-file (64 KB cap, regular file, project gate) plus inline
  // system and profile data compose as custom instructions before safety.
  // Profile system-file follows the same gates; its origin decides the gate.
  let system_file_text: string | undefined;
  if (tellrc.system_file) {
    const from_project = (tellrc.provenance['system_file'] ?? '').endsWith(path.join(process.cwd(), '.tellrc'));
    system_file_text = load_system_file_text(tellrc.system_file, process.cwd(), os.homedir(), from_project);
  } else {
    // No system-file configured.
  }
  let profile_system_text: string | undefined;
  const profile_system_file = tellrc.profile_data?.system_file;
  if (profile_system_file) {
    const from_project = (tellrc.profile_data?.system_file_from ?? '').endsWith(path.join(process.cwd(), '.tellrc'));
    profile_system_text = load_system_file_text(profile_system_file, process.cwd(), os.homedir(), from_project);
  } else {
    // No profile system-file configured.
  }
  const resolved_for_text = {
    ...tellrc,
    ...(system_file_text !== undefined ? { system_text: system_file_text } : {}),
  };
  if (resolved_for_text.profile_data && profile_system_text !== undefined) {
    resolved_for_text.profile_data = { ...resolved_for_text.profile_data, system_text: profile_system_text };
  } else {
    // No profile file text to attach.
  }
  const custom_system_text = tellrc_custom_text(resolved_for_text);
  // The prompt stays unwrapped: the core runtime composes the identical
  // `Previous context:` wrapper from the seeded storage on round one.
  const state: ConversationState = {
    firstPrompt: full_prompt,
    timeline: [`User:\n${full_prompt}`],
    autoContinue: core_config.chain,
    execMode: exec_mode,
    saveContext: save_context,
    stream: Boolean(opts.stream),
    think: Boolean(opts.think),
    coreConfig: core_config,
    limits,
    ...(custom_system_text ? { customSystemText: custom_system_text } : {}),
    ...(tellrc.temperature !== undefined ? { temperature: tellrc.temperature } : {}),
  };
  if (plan.$ === 'none') fs.rmSync(context_path, { force: true });
  const log = log_file();
  append_log(log, `Model: ${label}\nUser:\n${full_prompt}`);

  let ai: AskInstance | null = null;
  try {
    const config = await load_sdk_config();
    ai = await create_ask_ai(effective_model, config);
    lock_process_environment();
    await run_response_loop(ai, state, log, context_path, previous_context);
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', format_model_error(error));
    process.exitCode = EXIT_MODEL_ERROR;
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
    process.exitCode = EXIT_MODEL_ERROR;
    return;
  }

  // Tellrc-aware model default: flag > env > project > user > positional >
  // built-in. Aliases resolve without mutating MODELS; a positional custom
  // alias is accepted in the same slot the parser accepts for models.
  // Quiet unless this is a web launch (run_tell re-resolves and prints).
  const early_tellrc = resolve_invocation_tellrc(opts, process.cwd(), !opts.web);
  let early_limits: RuntimeLimits;
  try {
    early_limits = resolve_runtime_limits(opts, process.cwd());
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT_CONFIG_ERROR;
    return;
  }
  const opt_model = opts.model ?? early_tellrc.model;
  const input = parse_args(positional_args, opt_model, Boolean(opts.input), early_tellrc.aliases);
  const effective_model = resolve_model_input(input.model, early_tellrc.aliases, MODELS);
  let stdin_text = '';
  if (input.readStdin) {
    try {
      stdin_text = await read_stdin(early_limits);
    } catch (error) {
      if (error instanceof StdinLimitError) {
        console.error('\x1b[31m%s\x1b[0m', error.message);
        process.exitCode = error.kind === 'timeout' ? EXIT_TIMEOUT : EXIT_LIMIT;
        return;
      } else {
        console.error('\x1b[31m%s\x1b[0m', error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_LIMIT;
        return;
      }
    }
  } else {
    // No piped input — nothing to read.
  }
  const prompt = format_prompt(input.parts.join(' '), stdin_text, opts);
  if (opts.web) {
    const web_system_file = opts.systemFile ?? early_tellrc.system_file;
    const web_system_text = opts.system ?? early_tellrc.system;
    // Limit forwarding prefers explicit CLI flags/env (already validated
    // into `early_limits`) over tellrc; absent layers stay absent so the web
    // server keeps its own defaults. `--stdin-max-bytes`/`--output-max-bytes`
    // have no web target and stay CLI-only; a disabled stdin deadline (0) is
    // omitted because the web parser drops non-positive values.
    const web_env = runtime_env_from_process(process.env);
    const web_stdin_flag_set =
      (opts.stdinTimeout !== undefined && (opts.stdinTimeout as unknown) !== false) ||
      opts.noStdinTimeout === true ||
      web_env.TELL_STDIN_TIMEOUT_MS !== undefined;
    const web_stdin_timeout = web_stdin_flag_set
      ? early_limits.stdin_timeout_ms > 0
        ? early_limits.stdin_timeout_ms
        : undefined
      : early_tellrc.limits.stdin_timeout_ms;
    await launch_web({
      model: effective_model,
      prompt,
      cwd: opts.cwd,
      noExec: opts.exec === false,
      requireApproval: opts.requireApproval,
      chain: opts.chain,
      yes: opts.yes,
      stream: opts.stream,
      think: opts.think,
      profile: opts.profile ?? early_tellrc.profile,
      systemFile: web_system_file,
      systemText: web_system_file ? undefined : web_system_text,
      maxChainSteps:
        opts.maxChain !== undefined || web_env.TELL_MAX_CHAIN_STEPS !== undefined
          ? early_limits.max_chain_steps
          : early_tellrc.limits.max_chain_steps,
      maxBufferBytes:
        opts.maxBuffer !== undefined || web_env.TELL_MAX_BUFFER_BYTES !== undefined
          ? early_limits.max_buffer_bytes
          : early_tellrc.limits.max_buffer_bytes,
      contextChars:
        opts.contextMaxChars !== undefined || web_env.TELL_CONTEXT_MAX_CHARS !== undefined
          ? early_limits.context_max_chars
          : early_tellrc.limits.context_chars,
      stdinTimeoutMs: web_stdin_timeout,
      execTimeout:
        opts.execTimeout !== undefined || web_env.TELL_EXEC_TIMEOUT_MS !== undefined
          ? early_limits.exec_timeout_ms
          : early_tellrc.limits.exec_timeout_ms,
      temperature: early_tellrc.temperature,
    });
    return;
  }
  const ctx_has_prompt = typeof opts.ctx === 'string' && ctx_value_has_prompt(opts.ctx);
  if (!prompt && !ctx_has_prompt) {
    console.error(format_missing_prompt_error(program));
    process.exitCode = EXIT_MODEL_ERROR;
    return;
  }
  // `input.parts` is the positional prompt with any leading model spec already
  // stripped, so a positional model (`tell g --ctx ola`) does not count as a
  // prompt. A bare `--ctx` token (no `%`/`@`) is prompt text only when there
  // is no positional prompt; naming a context requires `%`.
  await run_tell(effective_model, prompt, opts, input.parts.length > 0);
}

main().catch((error: unknown) => {
  console.error('\x1b[31m%s\x1b[0m', format_model_error(error));
  process.exitCode = EXIT_MODEL_ERROR;
});
