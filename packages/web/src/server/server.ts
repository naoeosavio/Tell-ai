import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  build_sdk_config_from_env,
  canonical_path,
  canonical_write_path,
  collect_exec_secrets,
  create_cancellation_token,
  create_delegation_runner,
  create_node_executor,
  compose_custom_system,
  create_secret_redactor,
  DEFAULT_CONTEXT_MAX_CHARS,
  DEFAULT_EXEC_TIMEOUT_MS,
  EXEC_CANCELLED_EXIT_CODE,
  EXIT_CONFIG_ERROR,
  extract_delegation,
  HOST_DEFAULT_MODEL,
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_OUTPUT_MAX_BYTES,
  format_command_skipped,
  format_executed_command,
  has_lexical_target,
  is_path_inside_base,
  is_task_id,
  max_delegations_for_chain,
  resolve_task_id,
  split_task_value,
  strip_delegation_tags,
  task_name_from_ref,
  truncate_context,
  truncate_output,
  type CancellationToken,
  type DelegationRunner,
  validate_chain_decision_payload,
} from '@tell-ai/core';
import { create_ask_ai, extract_runs, get_model, MODELS, resolve_model_spec, strip_think_tags } from '@tell-ai/sdk';
import { generateText } from 'ai';
import { config as loadEnv } from 'dotenv';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { type ChatStreamEvent, encode_chat_stream_event } from '../shared/chat-stream';
import {
  CHAIN_MAX_ROUNDS,
  CHAIN_TTL_MS,
  type ChainConfirmError,
  type ChainRunSnapshot,
  createChainStore,
} from './chain-store';
import { parseCliArgs, printHelp } from './cli-args';
import { buildSystemPrompt } from './context-builder';
import {
  authFailureMessage,
  createRateLimiter,
  isAllowedHost,
  isAllowedOrigin,
  isHighRiskScript,
  isSensitiveRelPath,
  isValidTokenInput,
  normalizeApiPath,
  resolveStreamMode,
  validateTellPayload,
} from './guards';
import { attachTerminalServer, getScrollback } from './pty';
import { configureScrollbackMax } from './pty-policy';
import {
  createSnapshot,
  emptySession,
  listGitChanges,
  listHistory,
  loadSession,
  saveSession,
  type TellSession,
} from './session';

/** Single executor for the sandbox: the core owns shell/timeout/cap and kills the process group. */
const core_execute = create_node_executor();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// CLI args: --cwd <path>, --prompt <text>, -m/--model, --port <n>, --chain, -y/--yes, --no-exec
const cliArgs = parseCliArgs(process.argv.slice(2), process.cwd());
if (cliArgs.help) {
  printHelp();
  process.exit(0);
}
if (cliArgs.error !== undefined) {
  // A flag conflict is a boot error, never a silent deny.
  console.error(cliArgs.error);
  process.exit(EXIT_CONFIG_ERROR);
}
if (!fs.existsSync(cliArgs.cwd) || !fs.statSync(cliArgs.cwd).isDirectory()) {
  console.error(`Error: --cwd "${cliArgs.cwd}" does not exist or is not a directory.`);
  process.exit(1);
}
const CWD = fs.realpathSync(cliArgs.cwd);
const ENV_PATH = path.join(CWD, '.env');
if (process.env['TELL_TRUST_WORKSPACE_ENV'] === 'true') {
  try {
    const envStat = fs.lstatSync(ENV_PATH);
    if (envStat.isSymbolicLink() || !envStat.isFile()) throw new Error('not a regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Error: --cwd .env must be a regular file inside the workspace.`);
      process.exit(1);
    }
  }
  loadEnv({ path: ENV_PATH, quiet: true });
}
const INITIAL_PROMPT = cliArgs.initialPrompt;
const AUTO_EXECUTE = cliArgs.autoExecute;
const NO_EXEC = cliArgs.noExec;
const DEFAULT_MODEL = (cliArgs.model || process.env['TELL_MODEL'] || HOST_DEFAULT_MODEL.web).trim();
const CHAIN = cliArgs.chain;
const YES = cliArgs.yes;
const REQUIRE_APPROVAL = cliArgs.requireApproval;
const STREAM = cliArgs.stream;
const THINK = cliArgs.think;
const PORT = cliArgs.port ?? Number(process.env['PORT'] || 3000);
const HOST = cliArgs.host || '127.0.0.1';
const EXEC_TIMEOUT_MS = cliArgs.execTimeout ?? DEFAULT_EXEC_TIMEOUT_MS;
const FORWARDED_PROFILE = cliArgs.profile?.trim() || undefined;
const FORWARDED_TEMPERATURE = cliArgs.temperature;
const FORWARDED_LIMITS = {
  ...(cliArgs.maxChainSteps !== undefined ? { maxChainSteps: cliArgs.maxChainSteps } : {}),
  ...(cliArgs.maxBufferBytes !== undefined ? { maxBufferBytes: cliArgs.maxBufferBytes } : {}),
  ...(cliArgs.outputMaxBytes !== undefined ? { outputMaxBytes: cliArgs.outputMaxBytes } : {}),
  ...(cliArgs.contextChars !== undefined ? { contextChars: cliArgs.contextChars } : {}),
  ...(cliArgs.stdinTimeoutMs !== undefined ? { stdinTimeoutMs: cliArgs.stdinTimeoutMs } : {}),
} as {
  maxChainSteps?: number;
  maxBufferBytes?: number;
  outputMaxBytes?: number;
  contextChars?: number;
  stdinTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Task mode (`-t/--task`). The CLI forwards the same raw value, so both hosts
// resolve the identical `task-NNN-name` id from the same prompt and cwd. The
// task context (`main.txt`) is owned by the CLI; this host reads it as the
// prior context and only creates the anchor when the task is new.
// ---------------------------------------------------------------------------

/** Root of every saved context and task (`~/.ai/tell_context`). */
const CONTEXT_DIR = path.join(os.homedir(), '.ai', 'tell_context');

/** Effective context cap for the task section (`--context-chars` wins). */
const TASK_CONTEXT_MAX_CHARS = FORWARDED_LIMITS.contextChars ?? DEFAULT_CONTEXT_MAX_CHARS;

/** A resolved task pointer for this server (undefined when task mode is off). */
type HostTask = {
  /** The task id (`task-NNN-name`). */
  id: string;
  /** The task context file (`~/.ai/tell_context/<id>/main.txt`). */
  file: string;
  /** True when the id already existed (a resume, not a create). */
  resumed: boolean;
};

/** Saved task ids; a missing directory means that no task exists yet. */
function list_task_ids(): string[] {
  try {
    return fs.readdirSync(CONTEXT_DIR).filter((name) => is_task_id(name));
  } catch {
    return [];
  }
}

/**
 * Reads the saved task context (`main.txt`), capped.
 *
 * @param task - The resolved task pointer.
 * @returns The stored context text (empty when the file is absent).
 */
function read_task_context(task: HostTask): string {
  try {
    return truncate_context(fs.readFileSync(task.file, 'utf8').trim(), TASK_CONTEXT_MAX_CHARS);
  } catch {
    return '';
  }
}

/**
 * Creates the task directory and an empty context file.
 *
 * Anchors the task number for the CLI: a task that the Web opened must exist
 * on disk, or the CLI would allocate the same number again.
 *
 * @param task - The resolved task pointer.
 */
function init_task_context(task: HostTask): void {
  try {
    fs.mkdirSync(path.dirname(task.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(task.file, '', { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.error('Task context could not be created:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Resolves the boot `--task` value into a task pointer.
 *
 * @param raw - The `-t/--task` value ('' when the flag is bare).
 * @param prompt - The initial prompt (`--prompt`), used for the hash name.
 * @param reset - Whether `--task-reset` starts the context empty.
 * @returns The task pointer, or undefined when task mode is off.
 */
function resolve_host_task(raw: string | undefined, prompt: string, reset: boolean): HostTask | undefined {
  if (raw === undefined) {
    return undefined;
  } else {
    const { first, rest } = split_task_value(raw);
    const reference = first.startsWith('%') ? first.slice(1) : null;
    const task_prompt = [rest, prompt].filter(Boolean).join(' ').trim();
    const name =
      reference !== null
        ? task_name_from_ref(reference)
        : crypto.createHash('sha256').update(`${CWD}\n${task_prompt}`).digest('hex').slice(0, 8);
    if (name === '') {
      throw new Error('Invalid task name — use letters, digits and dashes');
    } else {
      // The name is usable; resolve it below.
    }
    const resolved = resolve_task_id(reference, name, list_task_ids());
    const task: HostTask = {
      id: resolved.id,
      file: path.join(CONTEXT_DIR, resolved.id, 'main.txt'),
      resumed: resolved.resumed,
    };
    if (!resolved.resumed || reset) {
      init_task_context(task);
    } else {
      // An existing task keeps its saved context.
    }
    return task;
  }
}

/** The task for this server, or undefined when the sandbox runs without `-t`. */
const TASK = ((): HostTask | undefined => {
  try {
    return resolve_host_task(cliArgs.task, INITIAL_PROMPT ?? '', cliArgs.taskReset);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(EXIT_CONFIG_ERROR);
  }
})();

/** Default internal exec buffer in bytes (owned by `@tell-ai/core`). */
const EXEC_DEFAULT_MAX_BUFFER =
  DEFAULT_MAX_BUFFER_BYTES; /** Effective exec buffer: the forwarded CLI override wins, default otherwise. */
const EXEC_MAX_BUFFER = FORWARDED_LIMITS.maxBufferBytes ?? EXEC_DEFAULT_MAX_BUFFER;
/**
 * Effective delivered output cap in bytes. The number and the truncation
 * (`truncate_output`, byte budget plus the core marker) belong to
 * `@tell-ai/core`; the forwarded CLI override wins, default otherwise.
 */
const EXEC_OUTPUT_MAX_BYTES = FORWARDED_LIMITS.outputMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES;

/** Combines and caps one executed result exactly like the core owner does. */
function cap_execution_output(stdout: string, stderr: string): string {
  return truncate_output(`${stdout}${stderr}`, EXEC_OUTPUT_MAX_BYTES);
}
/**
 * Effective chain round cap: the forwarded CLI override wins, clamped to the
 * server `1..CHAIN_MAX_ROUNDS` contract. The CLI accepts up to
 * `MAX_CHAIN_STEPS` (128) rounds, but the sandbox keeps the historical cap of
 * 8 — larger forwarded values clamp down here instead of failing the boot.
 * Only the number is overridden — the loop and approval state machine stay in
 * the core-owned chain store.
 */
const CHAIN_ROUND_CAP = Math.min(
  CHAIN_MAX_ROUNDS,
  Math.max(1, Math.floor(FORWARDED_LIMITS.maxChainSteps ?? CHAIN_MAX_ROUNDS)),
);
/**
 * Chain-limit notice for the effective cap (same wording family as the core,
 * with the actual cap so a forwarded `--max-chain-steps 2` reports `(2)`).
 *
 * @returns The notice recorded when the server-side rounds run out.
 */
function chain_limit_notice(): string {
  return `Chain limit reached (${CHAIN_ROUND_CAP}); ignoring further requested commands.`;
}

/** Forwarded custom instructions (CLI-resolved tellrc system, 64 KB cap, non-secret). */
function load_forwarded_system_text(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return undefined;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('\0')) return undefined;
    const trimmed = text.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}
const FORWARDED_SYSTEM_TEXT = load_forwarded_system_text(cliArgs.systemFile);

/** Composes forwarded custom instructions before the built project prompt (safety stays last in the base). */
function compose_forwarded_system(base: string): string {
  if (!FORWARDED_SYSTEM_TEXT) return base;
  return compose_custom_system(FORWARDED_SYSTEM_TEXT, base);
}

/** Host-owned task block appended after the SDK prompt (task mode only). */
function task_system_section(task: HostTask): string {
  const prior = read_task_context(task);
  const head = `\n\nTask mode (${task.id}): this session is one task with a saved context. Keep the context small; delegate research and builds instead of restating history.`;
  return prior === '' ? head : `${head}\n\nTask context so far:\n${prior}`;
}

/**
 * Builds the effective system prompt for this host.
 *
 * Delegation sections exist only in task mode: without `-t` the run keeps the
 * baseline prompt (commit 09269bb) and the tags are inert.
 *
 * @returns The project context, the SDK protocol and the task section.
 */
function build_effective_system(): string {
  const base = compose_forwarded_system(buildSystemPrompt(CWD, TASK === undefined ? undefined : 'both'));
  return TASK === undefined ? base : `${base}${task_system_section(TASK)}`;
}
const TELL_TOKEN = process.env['TELL_TOKEN'] || '';
const ALLOWED_HOSTS = new Set(
  (process.env['TELL_ALLOWED_HOSTS'] || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
if (!['0.0.0.0', '::', '[::]'].includes(HOST.toLowerCase())) ALLOWED_HOSTS.add(HOST.toLowerCase());
configureScrollbackMax(Number(process.env['TELL_SCROLLBACK_MAX']) || undefined);

// API keys / base URLs are injected into the SDK (it never reads
// process.env). The mapping is owned by `@tell-ai/core` — the server uses the
// synchronous builder (no token files, the fallback the CLI keeps) so the
// boot stays a plain module evaluation. Invalid `CUSTOM_API`/`CUSTOM_HEADERS`
// throw here, failing the boot.
const SDK_CONFIG = build_sdk_config_from_env(process.env);
// Redactor for delegation summaries: masks provider keys the process knew at
// boot (before the scrub below removes them from the child environment).
const SERVER_REDACT = create_secret_redactor([
  ...collect_exec_secrets(process.env),
  ...Object.values(SDK_CONFIG.keys ?? {}).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  ),
]);
const RETAINED_SERVER_ENV = new Set([
  'COLORTERM',
  'FORCE_COLOR',
  'HOME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NODE_ENV',
  'NO_COLOR',
  'PATH',
  'PORT',
  'SHELL',
  'TELL_ALLOWED_HOSTS',
  'TELL_MODEL',
  'TELL_SCROLLBACK_MAX',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'USER',
]);

for (const name of Object.keys(process.env)) {
  if (!RETAINED_SERVER_ENV.has(name)) delete process.env[name];
}

const EXEC_MAX_CONCURRENCY = 2;
// Poll fallback for parked delegate waits (notify() wakes immediately on
// state change; the timeout only re-checks). Local to this server like the
// concurrency cap above — not a runtime limit, so it stays out of the core
// owner (which pins the exec/buffer/output literals).
const DELEGATE_WAIT_POLL_MS = 30_000;
// Feedback tail fed back to the model after a chain command (mirrors the
// App `FEEDBACK_OUTPUT_LIMIT`: huge outputs must not explode the context).
const CHAIN_FEEDBACK_TAIL_CHARS = 4 * 1024;
// (Chain-limit notice lives in `chain_limit_notice()` so it reflects the
// effective `CHAIN_ROUND_CAP`, not just the default.)
const executeRateLimit = createRateLimiter({ max: 10, windowMs: 60_000 });
const delegateRateLimit = createRateLimiter({ max: 10, windowMs: 60_000 });
const tellRateLimit = createRateLimiter({ max: 10, windowMs: 60_000 });
const chainRateLimit = createRateLimiter({ max: 10, windowMs: 60_000 });
// Server-side chain runs: the pending script lives here, never in the client.
const chainStore = createChainStore(); // Model + system per run (kept beside the store so confirms resume context).
// Entries die with their run: every terminal snapshot drops its continuation,
// so idle/expired runs never accumulate beside the TTL-reaped store. The
// delegation runner is cached here too, so the parent's delegation budget
// (`max_delegations_for_chain`) spans the whole run instead of resetting on
// every delegation.
const chainContinuations = new Map<
  string,
  { modelSpec: string; system: string; delegationRunner?: DelegationRunner }
>();

/**
 * Pending child approvals (v2 nested): decisionId to runId + resolver.
 *
 * The chain `advanceChainRun` blocks on the promise while the client answers
 * via `POST /api/chain/:runId/confirm`. Restart drops the map (fail-closed,
 * never resumed blindly); TTL/cancel resolve outstanding waits as denied.
 */
const childResolvers = new Map<
  string,
  { runId: string; resolve: (verdict: 'approved' | 'denied' | 'skipped') => void }
>();

/**
 * Resolves outstanding child waits for a run as denied (cancel/TTL/terminal).
 *
 * @param runId - Run whose child waits must unblock without execution.
 */
function resolveChildResolversDenied(runId: string): void {
  for (const [decisionId, entry] of [...childResolvers]) {
    if (entry.runId === runId) {
      childResolvers.delete(decisionId);
      entry.resolve('denied');
    }
  }
}

/**
 * Stateless delegate tasks (v2 nested for the browser local loop).
 *
 * One task per `POST /api/delegate` build without `-y`: the background owns
 * the delegation, the client learns each child script via `awaiting` and
 * answers via `POST /api/delegate/:decisionId/confirm`. Restart drops the map
 * (fail-closed); TTL resolves outstanding waits as denied. `shortcut: one
 * task holds exactly one delegation; confirm blocks until the next pause or
 * the summary, so the browser needs no GET to poll.`
 */
type DelegateDecisionResult = { status: 'awaiting_approval'; decisionId: string; script: string } | { record: string };

type DelegateTask = {
  delegationId: string;
  createdAt: number;
  waiter: { decisionId: string; script: string; resolve: (verdict: 'approved' | 'denied' | 'skipped') => void } | null;
  decided: Map<string, { verdict: 'approve' | 'skip'; inFlight: boolean; result: DelegateDecisionResult | null }>;
  done: boolean;
  record: string | null;
  error: string | null;
  cancel: () => void;
  advancedResolvers: Array<() => void>;
};

const delegateTasks = new Map<string, DelegateTask>();
const delegateDecisionToTask = new Map<string, string>();

/**
 * Wakes confirm waiters parked on a delegate task (next pause or done).
 *
 * @param task - Task whose state just changed.
 */
function delegate_task_notify(task: DelegateTask): void {
  const resolvers = task.advancedResolvers;
  task.advancedResolvers = [];
  for (const resolve of resolvers) resolve();
}

/**
 * Waits for the next task change (pause or done), or times out.
 *
 * @param task - Task to watch.
 * @param timeoutMs - Upper bound (the model path is seconds per round).
 */
function delegate_task_wait(task: DelegateTask, timeoutMs = DELEGATE_WAIT_POLL_MS): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve();
      }
    }, timeoutMs);
    if (timer.unref !== undefined) timer.unref();
    task.advancedResolvers.push(() => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/**
 * Drops delegate tasks past the TTL (fail-closed, never resumed blindly).
 */
function pruneDelegateTasks(): void {
  const at = Date.now();
  for (const [delegationId, task] of [...delegateTasks]) {
    if (at - task.createdAt > CHAIN_TTL_MS) {
      if (task.waiter !== null) {
        const waiter = task.waiter;
        task.waiter = null;
        delegateDecisionToTask.delete(waiter.decisionId);
        waiter.resolve('denied');
      }
      task.cancel();
      delegateTasks.delete(delegationId);
      for (const [decisionId, owner] of [...delegateDecisionToTask]) {
        if (owner === delegationId) delegateDecisionToTask.delete(decisionId);
      }
      delegate_task_notify(task);
    }
  }
}

/**
 * Drops the per-run continuation once the run can no longer advance.
 *
 * @param runId - Run whose continuation may be released.
 * @param snapshot - Latest snapshot (null when the run already expired).
 */
function dropContinuationIfTerminal(runId: string, snapshot: ChainRunSnapshot | null): void {
  const terminal =
    snapshot === null ||
    snapshot.status === 'completed' ||
    snapshot.status === 'failed' ||
    snapshot.status === 'cancelled';
  if (terminal) {
    chainContinuations.delete(runId);
    resolveChildResolversDenied(runId);
  } else {
    // Still advancing — the next confirm needs the stored context.
  }
}

/**
 * Drops the continuations of runs the store no longer knows.
 *
 * A run that expired (or was reaped) without ever producing a terminal
 * snapshot would keep its model spec and system prompt alive forever.
 */
function pruneContinuations(): void {
  for (const runId of [...chainContinuations.keys()]) {
    if (chainStore.getRun(runId) === null) {
      chainContinuations.delete(runId);
      resolveChildResolversDenied(runId);
    }
  }
  for (const [decisionId, entry] of [...childResolvers]) {
    if (chainStore.getRun(entry.runId) === null) {
      childResolvers.delete(decisionId);
      entry.resolve('denied');
    }
  }
  pruneDelegateTasks();
}

// Periodic sweep: an idle server must not keep expired runs (and their
// continuations) alive between requests.
const continuationSweep = setInterval(pruneContinuations, 60_000);
continuationSweep.unref?.();
// Brute-force shield for the login page: 5 attempts per 15min per IP.
const authRateLimit = createRateLimiter({ max: 5, windowMs: 15 * 60_000 });
let activeExecutions = 0;

function clientIp(req: { ip?: string | undefined; socket: { remoteAddress?: string | undefined } }): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Constant-time token comparison (sha256 both sides first so different
 * lengths don't leak via timingSafeEqual's length check or early exit).
 */
function tokensEqual(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Same-origin guard for auth endpoints (mirrors the WS Origin check). */
function isCrossSite(req: express.Request): boolean {
  return !isAllowedOrigin(req.headers.origin, req.headers.host, ALLOWED_HOSTS);
}

app.use((req, res, next) => {
  if (!isAllowedHost(req.headers.host, ALLOWED_HOSTS)) {
    res.status(403).json({ error: 'Forbidden: Host is not allowed' });
    return;
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

// Basic security headers (hand-rolled; avoids the helmet dependency)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:",
  );
  next();
});

// Bearer token auth for the API surface (opt-in via TELL_TOKEN).
// Public (bootstrapping the isolated login page): /api/auth/status, /api/auth/verify.
// Everything else under /api/* — including /api/config (cwd/model leak) — requires auth.
app.use((req, res, next) => {
  if (!TELL_TOKEN) return next();
  const apiPath = normalizeApiPath(req.path);
  if (!apiPath.startsWith('/api/')) return next();
  if (apiPath === '/api/auth/status' || apiPath === '/api/auth/verify') return next();
  const header = req.headers.authorization || '';
  // RFC 7235: the auth scheme is case-insensitive (`bearer`, `Bearer`).
  const scheme_match = /^bearer\s+(.*)$/i.exec(header);
  const provided = scheme_match?.[1] ?? '';
  if (provided && tokensEqual(provided, TELL_TOKEN)) return next();
  res.setHeader('WWW-Authenticate', 'Bearer realm="tell-web"');
  res.status(401).json({ error: 'Unauthorized: missing or invalid token' });
});

// Friendly 413 for oversized bodies (must be registered after express.json)
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Payload too large (limit: 1mb)' });
    return;
  }
  next(err);
});

// ---------------------------------------------------------------------------
// Server-side session facts (tracked here, never stored in the client)
// ---------------------------------------------------------------------------
const serverState = {
  keysUsed: new Set<string>(),
  filesChanged: new Set<string>(),
  commandsRun: 0,
  aiTurns: 0,
};

// Recursively builds the file tree for the workspace status explorer
interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

const FILE_TREE_MAX_DEPTH = 6;
const FILE_TREE_MAX_NODES = 2000;

function getFileTree(dir: string, baseDir = dir, depth = 0, count = { nodes: 0 }): FileNode[] {
  if (!fs.existsSync(dir) || depth > FILE_TREE_MAX_DEPTH || count.nodes >= FILE_TREE_MAX_NODES) return [];
  const items = fs.readdirSync(dir);
  const nodes: FileNode[] = [];

  for (const item of items) {
    if (count.nodes >= FILE_TREE_MAX_NODES) {
      nodes.push({ name: '[truncated-tree]', path: '', isDirectory: false });
      break;
    }
    if (
      item === 'node_modules' ||
      item === '.git' ||
      item === 'temp_tell_ai' ||
      item === 'dist' ||
      item === '.env' ||
      item === '.tell' ||
      item === '.DS_Store' ||
      item === 'package-lock.json'
    ) {
      continue;
    }

    const fullPath = path.join(dir, item);
    const relPath = path.relative(baseDir, fullPath);
    // Sensitive files are never served (the file API denies them): the tree
    // must not even leak their names.
    if (isSensitiveRelPath(relPath)) {
      continue;
    }
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    count.nodes += 1;

    if (stat.isDirectory()) {
      nodes.push({
        name: item,
        path: relPath,
        isDirectory: true,
        children: getFileTree(fullPath, baseDir, depth + 1, count),
      });
    } else {
      nodes.push({
        name: item,
        path: relPath,
        isDirectory: false,
      });
    }
  }

  return nodes.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
}

// ---------------------------------------------------------------------------
// Session merge helpers
// ---------------------------------------------------------------------------
function mergePaneScrollback(session: TellSession): TellSession {
  const next = { ...session, terminal: { ...session.terminal } };
  const tabs = Array.isArray(next.terminal.tabs) ? next.terminal.tabs : [];
  next.terminal.tabs = tabs.map((tab) => {
    const panes = Array.isArray(tab?.panes) ? tab.panes : [];
    return {
      ...tab,
      panes: panes.map((pane) => {
        const live = getScrollback(pane.id);
        return { ...pane, scrollback: live || pane.scrollback || '' };
      }),
    };
  });
  return next;
}

/**
 * Validates the client-owned session payload before it is merged.
 *
 * A malformed `terminal` (tabs/panes that are not arrays) must be rejected
 * with a 400 instead of crashing the merge with a 500.
 *
 * @param body - Client payload.
 * @returns An error message, or null when the payload is usable.
 */
function validateSessionPayload(body: Partial<TellSession>): string | null {
  if (body.terminal !== undefined) {
    if (typeof body.terminal !== 'object' || body.terminal === null) {
      return 'invalid session payload';
    }
    const tabs = (body.terminal as { tabs?: unknown }).tabs;
    if (tabs !== undefined) {
      if (!Array.isArray(tabs)) return 'invalid session payload';
      for (const tab of tabs) {
        const panes = (tab as { panes?: unknown })?.panes;
        if (panes !== undefined && !Array.isArray(panes)) return 'invalid session payload';
      }
    }
  }
  return null;
}

function buildMergedSession(body: Partial<TellSession>): TellSession {
  const persisted = loadSession(CWD) || emptySession(CWD);
  const merged: TellSession = {
    ...persisted,
    ...body,
    keysUsed: [...serverState.keysUsed],
    filesChanged: [...serverState.filesChanged],
    stats: {
      ...persisted.stats,
      commandsRun: serverState.commandsRun,
      aiTurns: serverState.aiTurns,
    },
  };
  merged.messages = Array.isArray(body.messages) ? body.messages : persisted.messages || [];
  return mergePaneScrollback(merged);
}

function open_regular_file(filePath: string, flags: number, mode?: number): number {
  const fd = mode === undefined ? fs.openSync(filePath, flags) : fs.openSync(filePath, flags, mode);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Path is not a regular file');
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// API: Get workspace file tree structure
app.get('/api/status', (_req, res) => {
  try {
    const tree = getFileTree(CWD);
    return res.json({ files: tree });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// API: Read file content (returns mtime for optimistic-concurrency save checks)
app.get('/api/file', (req, res) => {
  const filePath = req.query['path'];
  if (typeof filePath !== 'string' || !filePath) {
    return res.status(400).json({ error: 'File path is required' });
  }

  const deniedPath = (res: express.Response): express.Response =>
    res.status(403).json({ error: 'Access denied: Directory traversal blocked' });

  const resolvedPath = canonical_path(CWD, filePath);
  if (!resolvedPath) {
    // `canonical_path` rejects escapes and missing targets alike. A path that
    // stays lexically inside the workspace AND has no target there is simply
    // absent (404); everything else — traversal, absolute escape, a symlink
    // pointing outside — keeps the containment denial (403).
    if (is_path_inside_base(CWD, filePath) && !has_lexical_target(CWD, filePath)) {
      return res.status(404).json({ error: 'File not found' });
    } else {
      return deniedPath(res);
    }
  }
  if (isSensitiveRelPath(path.relative(CWD, resolvedPath))) {
    return res.status(403).json({ error: 'Access denied: Sensitive file' });
  }

  let fd: number | null = null;
  try {
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    fd = open_regular_file(resolvedPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (stat.size > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large to preview (>10MB). Use download instead.' });
    }
    const content = fs.readFileSync(fd, 'utf8');
    return res.json({ content, mtime: stat.mtimeMs, size: stat.size });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
});

// API: Download raw file bytes (used for binary/large files)
app.get('/api/file/raw', (req, res) => {
  const filePath = req.query['path'];
  if (typeof filePath !== 'string' || !filePath) {
    return res.status(400).json({ error: 'File path is required' });
  }

  const resolvedPath = canonical_path(CWD, filePath);
  if (!resolvedPath) {
    // Same rule as `/api/file`: a missing file inside the workspace is 404,
    // only an escape (including a symlink pointing outside) is a denial.
    if (is_path_inside_base(CWD, filePath) && !has_lexical_target(CWD, filePath)) {
      return res.status(404).json({ error: 'File not found' });
    } else {
      return res.status(403).json({ error: 'Access denied: Directory traversal blocked' });
    }
  }
  if (isSensitiveRelPath(path.relative(CWD, resolvedPath))) {
    return res.status(403).json({ error: 'Access denied: Sensitive file' });
  }

  let fd: number | null = null;
  try {
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    fd = open_regular_file(resolvedPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    res.attachment(path.basename(resolvedPath));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(resolvedPath, { fd, autoClose: true });
    fd = null;
    res.once('close', () => stream.destroy());
    stream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy(error);
      } else {
        res.status(500).json({ error: error.message });
      }
    });
    stream.pipe(res);
    return;
  } catch (error: any) {
    if (fd !== null) fs.closeSync(fd);
    return res.status(500).json({ error: error.message });
  }
});

// API: Save file content (409 when the file changed on disk since it was loaded)
app.post('/api/save-file', (req, res) => {
  const body = req.body as { path?: unknown; content?: unknown; expectedMtime?: unknown } | undefined;
  const filePath = body?.path;
  const content = body?.content;
  const expectedMtime = body?.expectedMtime;
  if (typeof filePath !== 'string' || !filePath || typeof content !== 'string') {
    return res.status(400).json({ error: 'Path and string content are required' });
  }
  if (expectedMtime !== undefined && expectedMtime !== null && !Number.isFinite(Number(expectedMtime))) {
    return res.status(400).json({ error: 'expectedMtime must be a number' });
  }

  const resolvedPath = canonical_write_path(CWD, filePath, { create_parents: true });
  if (!resolvedPath) {
    return res.status(403).json({ error: 'Access denied: Directory traversal blocked' });
  }
  if (isSensitiveRelPath(path.relative(CWD, resolvedPath))) {
    return res.status(403).json({ error: 'Access denied: Sensitive file' });
  }

  const hasExpectedMtime = expectedMtime !== undefined && expectedMtime !== null;
  let fd: number | null = null;
  try {
    if (hasExpectedMtime && !fs.existsSync(resolvedPath)) {
      return res.status(409).json({ error: 'File was deleted since it was loaded. Reload before saving.' });
    }
    if (!hasExpectedMtime) fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    if (!canonical_write_path(CWD, filePath, { create_parents: true })) {
      return res.status(403).json({ error: 'Access denied: Directory traversal blocked' });
    }
    const writeFlags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    if (hasExpectedMtime) {
      try {
        fd = open_regular_file(resolvedPath, writeFlags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o666);
        fs.closeSync(fd);
        fd = null;
        fs.unlinkSync(resolvedPath);
        return res.status(409).json({ error: 'File was deleted since it was loaded. Reload before saving.' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      fd = open_regular_file(resolvedPath, writeFlags);
      const openedStat = fs.fstatSync(fd);
      if (openedStat.mtimeMs !== Number(expectedMtime)) {
        return res.status(409).json({
          error: 'File was modified externally since it was loaded. Reload before saving.',
          mtime: openedStat.mtimeMs,
        });
      }
    } else {
      fd = open_regular_file(resolvedPath, writeFlags | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o666);
    }
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, 'utf8');
    serverState.filesChanged.add(filePath);
    const stat = fs.fstatSync(fd);
    return res.json({ success: true, mtime: stat.mtimeMs });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
});

// API: Classify a command without executing it (drives the
// Require Approval + Auto-Run combo: safe runs directly, risky needs approval)
app.post('/api/risk-check', (req, res) => {
  const command = (req.body as { command?: unknown } | undefined)?.command;
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'Command is required' });
  }
  return res.json({ highRisk: isHighRiskScript(command) });
});

// API: Execute bash command safely
app.post('/api/execute', async (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'Command is required' });
  }
  if (NO_EXEC) {
    return res.status(403).json({ error: 'Command execution is disabled by --no-exec' });
  }

  if (!executeRateLimit.check(clientIp(req))) {
    return res.status(429).json({ error: 'Rate limit exceeded (10/min). Slow down.' });
  }

  if (isHighRiskScript(command)) {
    return res.status(400).json({
      output: `Blocked Command: "${command}"\n\nSecurity Guard: This command contains high-risk patterns (e.g. root deletion, modification of system directories, interpreter eval, curl pipe execution, or sudo privileges) and has been blocked for safety.`,
    });
  }

  if (activeExecutions >= EXEC_MAX_CONCURRENCY) {
    return res.status(429).json({ error: 'Server busy: max concurrent executions reached' });
  }

  serverState.commandsRun += 1;
  activeExecutions += 1;
  try {
    // One executor for the sandbox: the core owns the shell, the timeout and
    // the output cap, and kills the whole process group on timeout — `cmd &`
    // can no longer outlive the request.
    const result = await core_execute({
      script: command,
      cwd: CWD,
      timeout_ms: EXEC_TIMEOUT_MS,
      max_output_bytes: EXEC_MAX_BUFFER,
    });
    // The exit code travels with the output: the browser-side loop formats
    // the round feedback through the core (`format_command_result`), which
    // reports a failure as `Command failed (exit code N)`. Without it the
    // browser could not tell a failed command from a successful one.
    return res.json({ output: cap_execution_output(result.stdout, result.stderr), exit_code: result.exit_code });
  } catch (error: any) {
    // The executor only throws for spawn/cancellation failures, never for a
    // command exit status — report the message the same way the old path did.
    return res.json({
      output: truncate_output(String(error?.message ?? error), EXEC_OUTPUT_MAX_BYTES),
      exit_code: EXEC_CANCELLED_EXIT_CODE,
    });
  } finally {
    activeExecutions -= 1;
  }
});

// API: Delegation for the browser local loop (v2 nested: research always,
// build with automatic approval or via awaiting+confirm without -y).
// Stateless per call except the v2 wait: one POST serves exactly one
// delegation; without -y a build parks on `awaiting_approval` and the client
// resumes it via `POST /api/delegate/:decisionId/confirm` (single summary at
// the end, or the next awaiting when the child asks again). Same guards as
// /api/execute: concurrency cap, per-IP rate limit, abort cancels the child.
app.post('/api/delegate', async (req, res) => {
  const { kind, objective, modelAlias } = req.body ?? {};
  if ((kind !== 'research' && kind !== 'build') || typeof objective !== 'string' || objective.trim().length === 0) {
    return res.status(400).json({ error: 'kind (research|build) and non-empty objective are required' });
  }
  if (typeof objective === 'string' && objective.length > 4 * 1024) {
    return res.status(400).json({ error: 'objective limited to 4096 chars' });
  }
  if (modelAlias !== undefined && (typeof modelAlias !== 'string' || modelAlias.length > 256)) {
    return res.status(400).json({ error: 'modelAlias must be a string limited to 256 chars' });
  }
  if (NO_EXEC) {
    return res.status(403).json({ error: 'delegation disabled by --no-exec' });
  }
  if (TASK === undefined) {
    // Delegation is task-only: without `-t` the prompt never teaches the tags
    // and the host has no task context to spend them on.
    return res.status(403).json({ error: 'delegation is only available in task mode (--task)' });
  }
  if (!delegateRateLimit.check(clientIp(req))) {
    return res.status(429).json({ error: 'Rate limit exceeded (10/min). Slow down.' });
  }
  if (activeExecutions >= EXEC_MAX_CONCURRENCY) {
    return res.status(429).json({ error: 'Server busy: max concurrent executions reached' });
  }
  const modelSpec = typeof modelAlias === 'string' && modelAlias.trim() ? modelAlias : DEFAULT_MODEL;
  // Abort → cancel: if the client goes away before the response is
  // finished, cancel the child at round boundaries. This must listen on
  // the response, not the request: `req` closes as soon as its body is
  // consumed (before the handler runs), which would cancel every call
  // immediately. The model call itself carries no abort signal, same as
  // a chain cancel landing mid-flight.
  const token = create_cancellation_token();
  res.on('close', () => {
    if (!res.writableEnded) {
      token.cancel();
    }
  });
  if (kind === 'research' || AUTO_EXECUTE) {
    try {
      const outcome = await run_web_delegation(modelSpec, kind, objective, token);
      if (outcome === null) {
        return res.status(403).json({ error: `${kind} delegation not enabled on this host` });
      }
      return res.json({ record: outcome.record });
    } catch (_error) {
      return res.status(500).json({ error: 'delegation failed' });
    }
  } else {
    // v2 nested build without -y: park on awaiting, resume via confirm.
    const delegationId = crypto.randomUUID();
    const task: DelegateTask = {
      delegationId,
      createdAt: Date.now(),
      waiter: null,
      decided: new Map(),
      done: false,
      record: null,
      error: null,
      cancel: () => token.cancel(),
      advancedResolvers: [],
    };
    delegateTasks.set(delegationId, task);
    const runner = create_delegation_runner({
      model: build_delegation_model(modelSpec),
      executor: async (exec_options) => {
        activeExecutions += 1;
        try {
          return await core_execute({
            script: exec_options.script,
            cwd: CWD,
            timeout_ms: EXEC_TIMEOUT_MS,
            max_output_bytes: EXEC_MAX_BUFFER,
          });
        } finally {
          activeExecutions -= 1;
        }
      },
      approval: async (request) => {
        if (token.cancelled) {
          return 'denied';
        } else if (isHighRiskScript(request.script)) {
          return 'denied';
        } else {
          const decisionId = crypto.randomUUID();
          const verdict = await new Promise<'approved' | 'denied' | 'skipped'>((resolve) => {
            task.waiter = { decisionId, script: request.script, resolve };
            delegateDecisionToTask.set(decisionId, delegationId);
            delegate_task_notify(task);
          });
          return verdict;
        }
      },
      redact: SERVER_REDACT,
      cwd: CWD,
      exec_enabled: !NO_EXEC,
      timeout_ms: EXEC_TIMEOUT_MS,
      cancellation: token,
      max_delegations: 1,
    });
    (async () => {
      try {
        const outcome = await runner({ kind, objective });
        if (outcome === null) {
          task.error = `${kind} delegation not enabled on this host`;
        } else {
          task.record = outcome.record;
        }
      } catch (error: unknown) {
        task.error = error instanceof Error ? error.message : String(error);
      } finally {
        task.done = true;
        delegate_task_notify(task);
      }
    })().catch((error: unknown) => {
      task.error = error instanceof Error ? error.message : String(error);
      task.done = true;
      delegate_task_notify(task);
    });
    for (;;) {
      while (task.waiter === null && !task.done) {
        await delegate_task_wait(task);
      }
      if (task.waiter !== null) {
        const waiter = task.waiter;
        return res
          .status(202)
          .json({ status: 'awaiting_approval', decisionId: waiter.decisionId, script: waiter.script });
      } else if (task.record !== null) {
        return res.json({ record: task.record });
      } else {
        return res.status(500).json({ error: 'delegation failed' });
      }
    }
  }
});

// API: Answer a stateless delegate approval (v2 nested).
// Body: { decision: 'approve'|'skip' }. Same id + same verdict replays without
// re-executing (409 on conflict/unknown/cancelled, 403 on high-risk/--no-exec,
// 429 when busy). Restart drops every task (404 afterwards).
app.post('/api/delegate/:decisionId/confirm', async (req, res) => {
  const decisionId = String(req.params.decisionId || '');
  const decision = (req.body as { decision?: unknown } | undefined)?.decision;
  if (decision !== 'approve' && decision !== 'skip') {
    return res.status(400).json({ error: "decision must be 'approve' or 'skip'" });
  }
  if (!delegateRateLimit.check(clientIp(req))) {
    return res.status(429).json({ error: 'Rate limit exceeded (10/min). Slow down.' });
  }
  pruneDelegateTasks();
  const delegationId = delegateDecisionToTask.get(decisionId);
  const task = delegationId === undefined ? undefined : delegateTasks.get(delegationId);
  if (task === undefined) {
    return res.status(404).json({ error: 'Unknown or expired delegation' });
  }
  const previous = task.decided.get(decisionId);
  if (previous !== undefined) {
    if (previous.inFlight || previous.result === null) {
      return res.status(409).json({ error: 'decision_in_flight' });
    } else if (previous.verdict !== decision) {
      return res.status(409).json({ error: 'conflicting_decision' });
    } else if (previous.result !== null && 'status' in previous.result) {
      return res.status(202).json(previous.result);
    } else if (previous.result !== null && 'record' in previous.result) {
      return res.json({ record: previous.result.record });
    } else {
      return res.status(409).json({ error: 'conflicting_decision' });
    }
  }
  const waiter = task.waiter;
  if (waiter === null || waiter.decisionId !== decisionId) {
    return res.status(409).json({ error: 'no_pending_approval' });
  }
  if (decision === 'approve' && activeExecutions >= EXEC_MAX_CONCURRENCY) {
    return res.status(429).json({ error: 'Server busy: max concurrent executions reached' });
  }
  task.decided.set(decisionId, { verdict: decision, inFlight: true, result: null });
  let settled = false;
  res.on('close', () => {
    if (!res.writableEnded && !settled) {
      const entry = task.decided.get(decisionId);
      if (entry !== null && entry !== undefined && entry.result === null) {
        task.decided.delete(decisionId);
      }
    }
  });
  if (NO_EXEC) {
    task.decided.set(decisionId, { verdict: decision, inFlight: false, result: null });
    task.waiter = null;
    waiter.resolve('denied');
    delegate_task_notify(task);
    return res.status(403).json({ error: 'disabled' });
  } else if (isHighRiskScript(waiter.script)) {
    task.decided.set(decisionId, { verdict: decision, inFlight: false, result: null });
    task.waiter = null;
    waiter.resolve('denied');
    delegate_task_notify(task);
    return res.status(403).json({ error: 'high-risk script blocked without execution' });
  } else {
    task.waiter = null;
    waiter.resolve(decision === 'approve' ? 'approved' : 'skipped');
    delegate_task_notify(task);
  }
  for (;;) {
    while (task.waiter === null && !task.done) {
      await delegate_task_wait(task);
    }
    if (task.waiter !== null) {
      const next = task.waiter;
      const result = { status: 'awaiting_approval' as const, decisionId: next.decisionId, script: next.script };
      task.decided.set(decisionId, { verdict: decision, inFlight: false, result });
      settled = true;
      return res.status(202).json(result);
    } else if (task.record !== null) {
      task.decided.set(decisionId, { verdict: decision, inFlight: false, result: { record: task.record } });
      settled = true;
      return res.json({ record: task.record });
    } else {
      task.decided.set(decisionId, { verdict: decision, inFlight: false, result: null });
      settled = true;
      return res.status(500).json({ error: 'delegation failed' });
    }
  }
});

// API: List of supported models and aliases
app.get('/api/models', (_req, res) => {
  const formattedModels = Object.entries(MODELS).map(([alias, spec]) => {
    try {
      const resolved = resolve_model_spec(spec);
      return {
        alias,
        spec,
        vendor: resolved.vendor,
        model: resolved.model,
        thinking: resolved.thinking,
        fast: resolved.fast,
      };
    } catch {
      return { alias, spec, vendor: 'unknown', model: spec, thinking: 'none', fast: false };
    }
  });

  // Check which API keys are active in the environment
  const keysStatus = {
    google: Boolean(SDK_CONFIG.keys.google),
    openai: Boolean(SDK_CONFIG.keys.openai),
    anthropic: Boolean(SDK_CONFIG.keys.anthropic),
    xai: Boolean(SDK_CONFIG.keys.xai),
    deepseek: Boolean(SDK_CONFIG.keys.deepseek),
    cerebras: Boolean(SDK_CONFIG.keys.cerebras),
    moonshotai: Boolean(SDK_CONFIG.keys.moonshotai),
    openrouter: Boolean(SDK_CONFIG.keys.openrouter),
    alibaba: Boolean(SDK_CONFIG.keys.alibaba),
    zhipu: Boolean(SDK_CONFIG.keys.zhipu),
    meta: Boolean(SDK_CONFIG.keys.meta),
    xiaomi: Boolean(SDK_CONFIG.keys.xiaomi),
    custom: Boolean(SDK_CONFIG.keys.custom),
  };

  res.json({
    models: formattedModels,
    keysStatus,
  });
});

// Helper: safely convert reasoning tokens/objects to string
const REASONING_MAX_CHARS = 10 * 1024;

function truncateReasoning(text: string): string {
  return text.length > REASONING_MAX_CHARS ? `${text.slice(0, REASONING_MAX_CHARS)}\n[truncated]` : text;
}

function sanitizeReasoning(val: any, depth = 0): string | null {
  if (!val || depth > 4) return null;
  if (typeof val === 'string') return truncateReasoning(val);
  if (Array.isArray(val)) {
    const parts = val.map((item) => sanitizeReasoning(item, depth + 1)).filter(Boolean) as string[];
    return parts.length ? truncateReasoning(parts.join('\n')) : null;
  }
  if (typeof val === 'object') {
    // Nested shapes vary by SDK/provider: {text}, {reasoning}, {content}, {type, text}
    for (const key of ['text', 'reasoning', 'content']) {
      if (val[key] !== undefined && val[key] !== val) {
        const inner = sanitizeReasoning(val[key], depth + 1);
        if (inner) return inner;
      }
    }
    return null;
  }
  return truncateReasoning(String(val));
}

// API: Auth status (PUBLIC — only surface the login page needs before auth).
// Returns nothing sensitive: just whether a token is required.
app.get('/api/auth/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.json({ authRequired: Boolean(TELL_TOKEN) });
});

// API: Verify the access token (PUBLIC + strictly rate-limited).
// Body: { token: string }. Generic 401 on any failure (no oracle),
// artificial delay on failure, Retry-After on 429. Never logs the token.
app.post('/api/auth/verify', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  if (isCrossSite(req)) {
    res.status(403).json({ error: 'Forbidden: cross-site request blocked' });
    return;
  }
  // No token configured → login is skipped entirely.
  if (!TELL_TOKEN) {
    res.json({ ok: true, authRequired: false });
    return;
  }
  const ip = clientIp(req);
  const token = (req.body as any)?.token;
  if (isValidTokenInput(token) && tokensEqual(token, TELL_TOKEN)) {
    res.json({ ok: true, authRequired: true });
    return;
  }
  if (!authRateLimit.check(ip)) {
    res.setHeader('Retry-After', '900');
    res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    return;
  }
  await delay(500);
  console.warn(`[auth] failed login attempt from ${ip} at ${new Date().toISOString()}`);
  res.status(401).json({ error: authFailureMessage() });
});

// API: Server configuration (default model set via TELL_MODEL, e.g. `tell g web`)
// Requires auth when TELL_TOKEN is set (cwd/model must not leak to anonymous clients).
app.get('/api/config', (_req, res) => {
  res.json({
    defaultModel: DEFAULT_MODEL,
    autoExecute: AUTO_EXECUTE,
    noExec: NO_EXEC,
    chain: CHAIN,
    yes: YES,
    taskId: TASK?.id ?? null,
    requireApproval: REQUIRE_APPROVAL,
    stream: STREAM,
    think: THINK,
    cwd: CWD,
    initialPrompt: INITIAL_PROMPT || null,
    profile: FORWARDED_PROFILE ?? null,
    temperature: FORWARDED_TEMPERATURE ?? null,
    limits: FORWARDED_LIMITS,
    hasCustomSystem: FORWARDED_SYSTEM_TEXT !== undefined,
  });
});

// API: Auto-generated project context (tree 4 levels + README + AGENTS + protocol)
app.get('/api/context', (_req, res) => {
  try {
    const systemPrompt = build_effective_system();
    res.json({ systemPrompt, cwd: CWD });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Extracts a clean, log-safe message from provider errors: AI SDK errors often
// carry the raw response body JSON as the message and the full error object
// (request body, response headers/cookies) as properties — neither belongs in
// server logs or in the client-facing error event.
function model_error_message(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || raw;
  } catch {
    return raw;
  }
}

// Streams a model response to the client as NDJSON (`--stream`). Model setup
// errors still surface as a JSON 500; once headers are sent, failures become
// an `error` event so the client can keep the partial answer it received.
async function stream_tell(
  res: express.Response,
  modelSpec: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  system: string,
): Promise<void> {
  const ai = await create_ask_ai(modelSpec, SDK_CONFIG);

  let is_client_gone = false;
  res.on('close', () => {
    is_client_gone = true;
  });

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write_event = (event: ChatStreamEvent): void => {
    if (!is_client_gone) res.write(encode_chat_stream_event(event));
  };

  try {
    for await (const event of ai.ask_stream(messages, {
      system,
      ...(FORWARDED_TEMPERATURE !== undefined ? { temperature: FORWARDED_TEMPERATURE } : {}),
    })) {
      if (is_client_gone) break;
      switch (event.type) {
        case 'text':
          write_event({ type: 'text', text: event.text });
          break;
        case 'reasoning':
          write_event({ type: 'reasoning', text: event.text });
          break;
        default:
          // reasoning_end: forwarded so the client can freeze its timer.
          write_event({ type: 'reasoning_end' });
          break;
      }
    }
    write_event({ type: 'done' });
  } catch (error: any) {
    console.error('Error streaming AI text:', model_error_message(error));
    write_event({ type: 'error', error: model_error_message(error) || 'AI generation failed' });
  }
  res.end();
}

// Runs one model turn (shared by `/api/tell` and the `/api/chain` loop so the
// server-side chain reuses the exact same model boundary, never a second one).
async function generateOnce(
  modelSpec: string,
  formattedMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
  system: string,
): Promise<{ text: string; reasoning: string | null }> {
  // Resolve model spec and get AI SDK model instance (via @tell-ai/sdk)
  const handle = await get_model(modelSpec, SDK_CONFIG);
  const reasoning = handle.fast ? 'none' : handle.reasoning;

  // Call generateText
  const result = await generateText({
    model: handle.model,
    system,
    messages: formattedMessages,
    reasoning: reasoning as any,
    ...(FORWARDED_TEMPERATURE !== undefined ? { temperature: FORWARDED_TEMPERATURE } : {}),
    ...(handle.providerOptions ? { providerOptions: handle.providerOptions } : {}),
  });

  return { text: result.text, reasoning: sanitizeReasoning((result as any).reasoning) };
}

// Extracts the first `<RUN>` script from a model answer (single source: the
// SDK parser, never a second regex on the server).
function extractFirstScript(text: string): string | null {
  const first = extract_runs(text).scripts[0]?.trim();
  if (first === undefined || first === '') {
    return null;
  } else {
    return first;
  }
}

// Output tail fed back to the model (keeps huge outputs from exploding the context).
function truncateChainFeedbackTail(text: string): string {
  if (text.length > CHAIN_FEEDBACK_TAIL_CHARS) {
    return `…[truncated]\n${text.slice(-CHAIN_FEEDBACK_TAIL_CHARS)}`;
  } else {
    return text;
  }
}

// API: Model execution route (using Vercel AI SDK)
app.post('/api/tell', async (req, res) => {
  const payloadError = validateTellPayload(req.body);
  if (payloadError) {
    return res.status(400).json({ error: payloadError });
  }
  const { messages, modelAlias, systemPrompt } = req.body as {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    modelAlias?: unknown;
    systemPrompt?: string | null;
  };
  if (modelAlias !== undefined && (typeof modelAlias !== 'string' || modelAlias.length > 256)) {
    return res.status(400).json({ error: 'modelAlias must be a string limited to 256 chars' });
  }

  if (!tellRateLimit.check(clientIp(req))) {
    return res.status(429).json({ error: 'Rate limit exceeded (10/min). Slow down.' });
  }

  const modelSpec = modelAlias || DEFAULT_MODEL;
  serverState.aiTurns += 1;

  try {
    try {
      const resolved = resolve_model_spec(modelSpec);
      serverState.keysUsed.add(resolved.vendor);
    } catch {
      /* vendor unknown; skip */
    }

    // Convert messages to Vercel AI SDK format
    const formattedMessages = messages.map((m: any) => ({
      role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    }));

    const effectiveSystem = systemPrompt?.trim() ? systemPrompt : build_effective_system();

    // Streaming mode: per-request `stream` override wins over the boot `--stream`.
    // Streaming replies are NDJSON events; the model is resolved before headers are sent.
    if (resolveStreamMode(req.body?.stream, STREAM)) {
      await stream_tell(res, modelSpec, formattedMessages, effectiveSystem);
      return;
    }

    // Resolve model spec and get AI SDK model instance (via @tell-ai/sdk)
    const generated = await generateOnce(modelSpec, formattedMessages, effectiveSystem);

    return res.json({
      text: generated.text,
      // Pass back other useful properties if available
      reasoning: generated.reasoning,
    });
  } catch (error: any) {
    console.error('Error generating AI text:', model_error_message(error));
    return res.status(500).json({ error: 'AI generation failed. Check server logs.' });
  }
});

// ---------------------------------------------------------------------------
// Server-side chain (`/api/chain`): the model loop runs here, the client only
// renders events and answers pending approvals by decision id. The pending
// script is server-kept; confirm payloads never carry script/command/path
// (rejected by `validate_chain_decision_payload` before any transition).
// `/api/tell`, `/api/execute` and `/api/risk-check` stay stable beside it.
// ---------------------------------------------------------------------------

/** Maps a store gate rejection to its fail-closed HTTP status. */
function chainConfirmHttpStatus(error: ChainConfirmError): number {
  if (error === 'unknown_run') {
    return 404;
  } else if (error === 'run_cancelled' || error === 'no_pending_approval') {
    return 409;
  } else {
    return 409;
  }
}

/** Records a `denied` outcome for a script that must never execute. */
function denyChainScript(
  runId: string,
  decisionId: string,
  script: string,
  reason: string,
  source: string,
): ChainRunSnapshot | null {
  return chainStore.finishConfirm(runId, decisionId, {
    type: 'denied',
    script,
    text: `${reason} (${source})`,
    status: 'completed',
  });
}

/**
 * Executes one chain command inside the run (Auto-Run path).
 *
 * The command is executed with the same executor as `/api/execute`; the
 * output becomes the next model turn, and the run keeps going.
 *
 * @param runId - Server-side run to advance.
 * @param script - Approved command script.
 * @returns True when the command ran (even with a non-zero exit code).
 */
/**
 * Builds a silent child model port over generateOnce for delegation.
 *
 * @param modelSpec - Model alias or spec for the child.
 * @returns A model port that never writes to any stream.
 */
function build_delegation_model(modelSpec: string): {
  ask(message: string, options: { system: string; stream: false }): Promise<string>;
} {
  return {
    async ask(message: string, options: { system: string; stream: false }): Promise<string> {
      const generated = await generateOnce(modelSpec, [{ role: 'user', content: message }], options.system);
      return generated.text;
    },
  };
}

/**
 * Builds a Web delegation runner over the server ports.
 *
 * One host approval serves both kinds: the core wraps it with the read-only
 * gate for research and uses it raw for build. Cancellation aborts the child
 * at round boundaries (the model call itself carries no abort signal, same
 * as a chain cancel landing mid-flight).
 *
 * @param modelSpec - Model alias or spec for the child.
 * @param cancellation - Optional token (request abort on `/api/delegate`).
 * @returns A runner with the parent's delegation budget.
 */
function new_web_runner(modelSpec: string, cancellation?: CancellationToken, runId?: string): DelegationRunner {
  const build_gate = async (request: { script: string }): Promise<'approved' | 'denied' | 'skipped'> => {
    if (NO_EXEC) {
      return 'denied';
    } else if (isHighRiskScript(request.script)) {
      return 'denied';
    } else if (AUTO_EXECUTE) {
      return 'approved';
    } else if (runId === undefined) {
      return 'denied';
    } else {
      const pending = chainStore.requestApproval(runId, `[sub-tarefa] ${request.script}`, 'child');
      if (pending === null) {
        return 'denied';
      } else {
        const verdict = await new Promise<'approved' | 'denied' | 'skipped'>((resolve) => {
          childResolvers.set(pending.decisionId, { runId, resolve });
        });
        return verdict;
      }
    }
  };
  return create_delegation_runner({
    model: build_delegation_model(modelSpec),
    executor: async (exec_options) => {
      activeExecutions += 1;
      try {
        return await core_execute({
          script: exec_options.script,
          cwd: CWD,
          timeout_ms: EXEC_TIMEOUT_MS,
          max_output_bytes: EXEC_MAX_BUFFER,
        });
      } finally {
        activeExecutions -= 1;
      }
    },
    approval: build_gate,
    redact: SERVER_REDACT,
    cwd: CWD,
    exec_enabled: !NO_EXEC,
    timeout_ms: EXEC_TIMEOUT_MS,
    ...(cancellation !== undefined ? { cancellation } : {}),
    max_delegations: max_delegations_for_chain(CHAIN_ROUND_CAP),
  });
}

/**
 * Runs one Web delegation (research always, build only with automatic approval).
 *
 * v1 never creates a pending: research is read-only; build runs only when
 * approval is automatic (server -y). Otherwise the tag is denied with motive.
 *
 * @param modelSpec - Model alias or spec for the child (used only when the runner is built here).
 * @param kind - research or build.
 * @param objective - Sanitized child goal.
 * @param cancellation - Optional token (request abort on `/api/delegate`).
 * @param runner - Optional prebuilt runner (the chain passes its cached one so the budget spans the run).
 * @returns The ready record, or null when denied.
 */
async function run_web_delegation(
  modelSpec: string,
  kind: 'research' | 'build',
  objective: string,
  cancellation?: CancellationToken,
  runner?: DelegationRunner,
): Promise<{ record: string } | null> {
  if (NO_EXEC) {
    return null;
  }
  if (kind === 'build' && !AUTO_EXECUTE && runner === undefined) {
    return null;
  }
  if (activeExecutions >= EXEC_MAX_CONCURRENCY) {
    return null;
  }
  const active = runner ?? new_web_runner(modelSpec, cancellation);
  const outcome = await active({ kind, objective });
  if (outcome === null) {
    return null;
  } else {
    return { record: outcome.record };
  }
}

/**
 * Returns the cached delegation runner for a chain run, creating it on first
 * use. Sharing one runner per run is what makes the delegation budget real:
 * a fresh runner per delegation would reset the counter every time.
 *
 * @param runId - Server-side run owning the budget.
 * @param modelSpec - Model alias or spec for the child.
 * @returns The run's delegation runner.
 */
function chain_runner_for(runId: string, modelSpec: string): DelegationRunner {
  const existing = chainContinuations.get(runId)?.delegationRunner;
  if (existing !== undefined) {
    return existing;
  }
  const runner = new_web_runner(modelSpec, undefined, runId);
  const continuation = chainContinuations.get(runId);
  if (continuation !== undefined) {
    continuation.delegationRunner = runner;
  } else {
    // No continuation (defensive: callers create it before advancing).
    chainContinuations.set(runId, { modelSpec, system: '', delegationRunner: runner });
  }
  return runner;
}

async function runChainScript(runId: string, script: string): Promise<boolean> {
  serverState.commandsRun += 1;
  activeExecutions += 1;
  try {
    const result = await core_execute({
      script,
      cwd: CWD,
      timeout_ms: EXEC_TIMEOUT_MS,
      max_output_bytes: EXEC_MAX_BUFFER,
    });
    const output = cap_execution_output(result.stdout, result.stderr);
    chainStore.pushMessage(runId, {
      role: 'user',
      content: format_executed_command(script, truncateChainFeedbackTail(output)),
    });
    chainStore.appendEvent(runId, { type: 'executed', script, output, exitCode: result.exit_code });
    return true;
  } catch (error: unknown) {
    chainStore.appendEvent(runId, { type: 'failed', script, text: model_error_message(error) });
    return false;
  } finally {
    activeExecutions -= 1;
  }
}

/**
 * Advances one chain run server-side: calls the model, and either completes
 * (final answer, deny, failure, round cap) or pauses with a pending approval.
 * Every command after a confirm re-enters here, so the loop never lives in
 * the browser. Fail-closed: anything risky, disabled or undecidable stops
 * the run without executing.
 *
 * @param runId - Server-side run to advance.
 * @param modelSpec - Model alias or spec resolved for this run.
 * @param system - Effective system prompt (server-built project context).
 * @returns The fresh snapshot, or null when the run expired mid-flight.
 */
async function advanceChainRun(runId: string, modelSpec: string, system: string): Promise<ChainRunSnapshot | null> {
  for (;;) {
    const current = chainStore.getRun(runId);
    if (current === null || current.status !== 'running' || current.rounds >= CHAIN_ROUND_CAP) {
      break;
    } else {
      // Budget left — run the next model turn below.
    }
    let generated: { text: string; reasoning: string | null };
    try {
      // Turn context travels inside the store; snapshots stay replay-only.
      generated = await generateOnce(modelSpec, chainStore.messagesOf(runId), system);
    } catch (error: unknown) {
      return chainStore.failRun(runId, model_error_message(error) || 'AI generation failed');
    }
    // A cancel that landed during the model call wins: never append to a
    // run that is no longer live.
    const fresh = chainStore.getRun(runId);
    if (fresh === null || fresh.status !== 'running') {
      return fresh;
    } else {
      // Still running — record the turn below.
    }
    // The tags are inert outside task mode: the prompt never teaches them, so
    // any tag in the answer is stripped as plain text and never starts a child.
    // Tag scanning never looks inside a literal `<think>` block: reasoning is
    // data, not an instruction.
    const scan = strip_think_tags(generated.text);
    const delegation = TASK === undefined ? { kind: null, objective: '', extras: 0 } : extract_delegation(scan);
    const visible_text = strip_delegation_tags(strip_think_tags(generated.text));
    chainStore.pushMessage(runId, { role: 'assistant', content: visible_text });
    chainStore.setText(runId, visible_text);
    chainStore.appendEvent(runId, { type: 'message', text: visible_text });
    chainStore.countRound(runId);
    if (delegation.extras > 0) {
      // The host honors one tag per answer; say so instead of dropping the
      // rest in silence.
      chainStore.appendEvent(runId, {
        type: 'denied',
        text: `Only the first delegation tag runs; ${delegation.extras} extra tag${delegation.extras === 1 ? '' : 's'} ignored.`,
      });
    } else {
      // No extra tag to report.
    }
    if (delegation.kind !== null) {
      const scripts_in_delegation = extract_runs(scan)
        .scripts.map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      for (const skipped_script of scripts_in_delegation) {
        chainStore.pushMessage(runId, { role: 'user', content: format_command_skipped(skipped_script) });
        chainStore.appendEvent(runId, { type: 'skipped', script: skipped_script });
      }
      if (delegation.kind === 'build' && !AUTO_EXECUTE) {
        // v2 nested: the child approval needs HTTP, so the POST cannot block
        // waiting for it (the client learns decisionId from the snapshot).
        // Run the delegation in background; the client polls GET and answers
        // via confirm, which wakes the bridge. `shortcut: background owns the
        // parent loop from here, foreground returns early for polling.`
        const bgModelSpec = modelSpec;
        const bgSystem = system;
        const bgVisible = visible_text;
        const bgKind = delegation.kind;
        const bgObjective = delegation.objective;
        (async () => {
          try {
            const delegated = await run_web_delegation(
              bgModelSpec,
              bgKind,
              bgObjective,
              undefined,
              chain_runner_for(runId, bgModelSpec),
            );
            const live = chainStore.getRun(runId);
            if (live === null || live.status === 'cancelled') {
              return;
            } else if (delegated === null) {
              chainStore.appendEvent(runId, {
                type: 'denied',
                text: `${bgKind} delegation not enabled on this host`,
              });
              dropContinuationIfTerminal(runId, chainStore.completeRun(runId, bgVisible));
              return;
            } else {
              chainStore.pushMessage(runId, { role: 'user', content: delegated.record });
              chainStore.appendEvent(runId, { type: 'message', text: delegated.record });
              const snap = await advanceChainRun(runId, bgModelSpec, bgSystem);
              dropContinuationIfTerminal(runId, snap);
              return;
            }
          } catch (error: unknown) {
            chainStore.failRun(runId, model_error_message(error) || 'AI generation failed');
            dropContinuationIfTerminal(runId, chainStore.getRun(runId));
            return;
          }
        })().catch((error: unknown) => {
          console.error('Chain delegation background failed:', error instanceof Error ? error.message : String(error));
        });
        return chainStore.getRun(runId);
      }
      const delegated = await run_web_delegation(
        modelSpec,
        delegation.kind,
        delegation.objective,
        undefined,
        chain_runner_for(runId, modelSpec),
      );
      if (delegated === null) {
        chainStore.appendEvent(runId, {
          type: 'denied',
          text: `${delegation.kind} delegation not enabled on this host`,
        });
        return chainStore.completeRun(runId, visible_text);
      }
      chainStore.pushMessage(runId, { role: 'user', content: delegated.record });
      chainStore.appendEvent(runId, { type: 'message', text: delegated.record });
      continue;
    }
    const script = extractFirstScript(scan);
    if (script === null) {
      return chainStore.completeRun(runId, visible_text);
    } else if (NO_EXEC) {
      // Contract wording: denied/disabled with --no-exec source, never
      // reason 'no-exec', and nothing is executed.
      chainStore.appendEvent(runId, { type: 'denied', script, text: 'disabled (--no-exec)' });
      return chainStore.completeRun(runId, generated.text);
    } else if (isHighRiskScript(script)) {
      chainStore.appendEvent(runId, { type: 'denied', script, text: 'high-risk: blocked without execution' });
      return chainStore.completeRun(runId, generated.text);
    } else if (AUTO_EXECUTE) {
      // Auto-Run (`-y`): the server executes the safe command itself instead
      // of pausing for an approval the operator already granted.
      const executed = await runChainScript(runId, script);
      if (!executed) {
        return chainStore.failRun(runId, 'Chain execution failed');
      } else {
        // The command output is now the context — the loop asks the model again.
      }
    } else {
      const pending = chainStore.requestApproval(runId, script);
      if (pending === null) {
        return chainStore.failRun(runId, 'Chain approval could not be recorded');
      } else {
        return chainStore.getRun(runId);
      }
    }
  }
  const capped = chainStore.getRun(runId);
  if (capped === null || capped.status !== 'running') {
    return capped;
  } else {
    chainStore.appendEvent(runId, { type: 'completed', text: chain_limit_notice() });
    return chainStore.completeRun(runId);
  }
}

// API: Start a server-side chain run (additive; `/api/tell` stays compatible).
app.post('/api/chain', async (req, res) => {
  const payloadError = validateTellPayload(req.body);
  if (payloadError) {
    return res.status(400).json({ error: payloadError });
  }
  const { messages, modelAlias, systemPrompt } = req.body as {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    modelAlias?: unknown;
    systemPrompt?: string | null;
  };
  if (modelAlias !== undefined && (typeof modelAlias !== 'string' || modelAlias.length > 256)) {
    return res.status(400).json({ error: 'modelAlias must be a string limited to 256 chars' });
  }

  if (!chainRateLimit.check(clientIp(req))) {
    return res.status(429).json({ error: 'Rate limit exceeded (10/min). Slow down.' });
  }

  const modelSpec = modelAlias || DEFAULT_MODEL;
  serverState.aiTurns += 1;
  pruneContinuations();

  try {
    try {
      const resolved = resolve_model_spec(modelSpec);
      serverState.keysUsed.add(resolved.vendor);
    } catch {
      /* vendor unknown; skip */
    }

    // Convert messages to Vercel AI SDK format
    const formattedMessages = messages.map((m: any) => ({
      role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    }));

    const effectiveSystem = systemPrompt?.trim() ? systemPrompt : build_effective_system();

    const created = chainStore.createRun(formattedMessages);
    chainContinuations.set(created.runId, { modelSpec, system: effectiveSystem });
    const snapshot = await advanceChainRun(created.runId, modelSpec, effectiveSystem);
    dropContinuationIfTerminal(created.runId, snapshot);
    if (snapshot === null) {
      return res.status(404).json({ error: 'Unknown or expired chain run' });
    } else {
      return res.json(snapshot);
    }
  } catch (error: any) {
    console.error('Error advancing chain run:', model_error_message(error));
    return res.status(500).json({ error: 'AI generation failed. Check server logs.' });
  }
});

// API: Replay a chain run (event sequence for idempotent clients).
app.get('/api/chain/:runId', (req, res) => {
  if (!chainRateLimit.check(clientIp(req))) {
    return res.status(429).json({ error: 'Rate limit exceeded (10/min). Slow down.' });
  }
  const snapshot = chainStore.getRun(String(req.params.runId || ''));
  if (snapshot === null) {
    // Genuinely unknown ids and TTL-expired runs share this answer: a
    // restart drops every run, and nothing resumes blindly.
    return res.status(404).json({ error: 'Unknown or expired chain run' });
  } else {
    return res.json(snapshot);
  }
});

// API: Answer a pending chain approval (approve runs the server-kept script
// exactly once; skip continues without it). Any script/command/path field in
// the body is a 400 — the client never supplies free scripts.
app.post('/api/chain/:runId/confirm', async (req, res) => {
  const validation = validate_chain_decision_payload(req.body);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }
  if (!chainRateLimit.check(clientIp(req))) {
    return res.status(429).json({ error: 'Rate limit exceeded (10/min). Slow down.' });
  }
  const runId = String(req.params.runId || '');
  if (validation.value.decision === 'approve' && activeExecutions >= EXEC_MAX_CONCURRENCY) {
    return res.status(429).json({ error: 'Server busy: max concurrent executions reached' });
  }
  const gate = chainStore.tryBeginConfirm(runId, validation.value);
  if (!gate.ok) {
    return res.status(chainConfirmHttpStatus(gate.error)).json({ error: gate.error });
  } else if ('snapshot' in gate) {
    // Same decision id + same verdict replayed: stored result, no re-execution.
    return res.json(gate.snapshot);
  } else {
    // Single-flight approval below: the script runs at most once per
    // decision id, and every failure below stays fail-closed (no execution).
  }
  const script = gate.script;
  const decisionId = validation.value.decision_id;
  const isChildApproval = chainStore.getRun(runId)?.childPending?.decisionId === decisionId;
  if (isChildApproval) {
    // v2 nested approval: the child waits on a deferred promise in
    // `childResolvers`. The confirm only records approved/skipped/denied and
    // wakes the delegation; execution stays inside the delegation runner.
    const resolver = childResolvers.get(decisionId);
    if (NO_EXEC) {
      const snapshot = chainStore.finishConfirm(runId, decisionId, {
        type: 'denied',
        script,
        text: 'disabled (--no-exec)',
        status: 'running',
      });
      if (resolver !== undefined) {
        childResolvers.delete(decisionId);
        resolver.resolve('denied');
      }
      dropContinuationIfTerminal(runId, snapshot);
      return res.status(403).json({ error: 'disabled', run: snapshot });
    } else if (isHighRiskScript(script.replace(/^\[sub-tarefa\] /, ''))) {
      const snapshot = chainStore.finishConfirm(runId, decisionId, {
        type: 'denied',
        script,
        text: 'high-risk: blocked without execution',
        status: 'running',
      });
      if (resolver !== undefined) {
        childResolvers.delete(decisionId);
        resolver.resolve('denied');
      }
      dropContinuationIfTerminal(runId, snapshot);
      return res.status(403).json({ error: 'high-risk script blocked without execution', run: snapshot });
    } else if (validation.value.decision === 'skip') {
      const skipped = chainStore.finishConfirm(runId, decisionId, {
        type: 'skipped',
        script,
        status: 'running',
      });
      if (skipped === null) {
        return res.status(404).json({ error: 'Unknown or expired chain run' });
      } else {
        if (resolver !== undefined) {
          childResolvers.delete(decisionId);
          resolver.resolve('skipped');
        }
        const settled = chainStore.settleDecision(runId, decisionId);
        dropContinuationIfTerminal(runId, settled ?? skipped);
        return res.json(settled ?? skipped);
      }
    } else {
      const approved = chainStore.finishConfirm(runId, decisionId, {
        type: 'approved',
        script,
        status: 'running',
      });
      if (approved === null) {
        return res.status(404).json({ error: 'Unknown or expired chain run' });
      } else {
        if (resolver !== undefined) {
          childResolvers.delete(decisionId);
          resolver.resolve('approved');
        }
        const settled = chainStore.settleDecision(runId, decisionId);
        dropContinuationIfTerminal(runId, settled ?? approved);
        return res.json(settled ?? approved);
      }
    }
  } else if (NO_EXEC) {
    const snapshot = denyChainScript(runId, decisionId, script, 'disabled', '--no-exec');
    dropContinuationIfTerminal(runId, snapshot);
    return res.status(403).json({ error: 'disabled', run: snapshot });
  } else if (isHighRiskScript(script)) {
    const snapshot = denyChainScript(runId, decisionId, script, 'high-risk', 'risk-check');
    dropContinuationIfTerminal(runId, snapshot);
    return res.status(403).json({ error: 'high-risk script blocked without execution', run: snapshot });
  } else if (validation.value.decision === 'skip') {
    chainStore.pushMessage(runId, { role: 'user', content: format_command_skipped(script) });
    const skipped = chainStore.finishConfirm(runId, decisionId, {
      type: 'skipped',
      script,
      status: 'running',
    });
    if (skipped === null) {
      return res.status(404).json({ error: 'Unknown or expired chain run' });
    } else if (skipped.status === 'cancelled') {
      // A cancel landed mid-flight: the skip is recorded, the run stays
      // cancelled and the loop never resumes.
      const settled = chainStore.settleDecision(runId, decisionId);
      dropContinuationIfTerminal(runId, settled ?? skipped);
      return res.json(settled ?? skipped);
    } else {
      let continued: ChainRunSnapshot | null = null;
      try {
        continued = await continueChainAfterConfirm(runId);
      } catch (error: unknown) {
        // The continuation failed — the run stays answerable, but the caller
        // must learn that the chain could not advance.
        console.error('Chain continuation failed:', error instanceof Error ? error.message : String(error));
        const settled_failed = chainStore.settleDecision(runId, decisionId);
        dropContinuationIfTerminal(runId, settled_failed ?? skipped);
        return res.status(500).json({ error: 'Chain continuation failed', run: settled_failed ?? skipped });
      }
      // Settle the idempotency snapshot on the post-continuation state so a
      // retry replays exactly this answer (never a stale prefix, never a re-run).
      const settled = chainStore.settleDecision(runId, decisionId);
      dropContinuationIfTerminal(runId, settled ?? continued);
      return res.json(settled ?? continued ?? skipped);
    }
  } else {
    serverState.commandsRun += 1;
    activeExecutions += 1;
    try {
      // Same core executor as /api/execute: the exit status never throws, so
      // success and failure share one feedback path (the message keeps the
      // executed wording in both cases, the snapshot carries the real code).
      const result = await core_execute({
        script,
        cwd: CWD,
        timeout_ms: EXEC_TIMEOUT_MS,
        max_output_bytes: EXEC_MAX_BUFFER,
      });
      const output = cap_execution_output(result.stdout, result.stderr);
      chainStore.pushMessage(runId, {
        role: 'user',
        content: format_executed_command(script, truncateChainFeedbackTail(output)),
      });
      // A failing command self-heals through the next model turn (same
      // protocol as the CLI chain), it does not fail the run.
      const executed = chainStore.finishConfirm(runId, decisionId, {
        type: 'executed',
        script,
        output,
        exitCode: result.exit_code,
        status: 'running',
      });
      if (executed === null) {
        return res.status(404).json({ error: 'Unknown or expired chain run' });
      } else if (executed.status === 'cancelled') {
        const settled = chainStore.settleDecision(runId, decisionId);
        dropContinuationIfTerminal(runId, settled ?? executed);
        return res.json(settled ?? executed);
      } else {
        const continued = await continueChainAfterConfirm(runId);
        const settled = chainStore.settleDecision(runId, decisionId);
        dropContinuationIfTerminal(runId, settled ?? continued);
        return res.json(settled ?? continued ?? executed);
      }
    } catch (error: any) {
      // Spawn/cancellation failure only (exit statuses never throw): fail
      // closed without recording a fabricated execution.
      const snapshot = denyChainScript(runId, decisionId, script, 'executor-error', String(error?.message ?? error));
      dropContinuationIfTerminal(runId, snapshot);
      return res.status(500).json({ error: 'command executor failed', run: snapshot });
    } finally {
      activeExecutions -= 1;
    }
  }
});

// API: Cancel a chain run (invalidates any pending approval; idempotent).
app.post('/api/chain/:runId/cancel', (req, res) => {
  if (!chainRateLimit.check(clientIp(req))) {
    return res.status(429).json({ error: 'Rate limit exceeded (10/min). Slow down.' });
  }
  const snapshot = chainStore.cancelRun(String(req.params.runId || ''));
  dropContinuationIfTerminal(String(req.params.runId || ''), snapshot);
  if (snapshot === null) {
    return res.status(404).json({ error: 'Unknown or expired chain run' });
  } else {
    return res.json(snapshot);
  }
});

/**
 * Continues a run after a confirm decision: replays the model loop with the
 * run's own model and system prompt. Stored alongside the run so a confirm
 * resumes the same context the creation call built.
 *
 * @param runId - Run whose loop should continue.
 * @returns The fresh snapshot, or null when the run expired mid-flight.
 */
async function continueChainAfterConfirm(runId: string): Promise<ChainRunSnapshot | null> {
  const continuation = chainContinuations.get(runId);
  if (continuation === undefined) {
    return chainStore.getRun(runId);
  } else {
    return advanceChainRun(runId, continuation.modelSpec, continuation.system);
  }
}

// ---------------------------------------------------------------------------
// Session persistence API (.tell/)
// ---------------------------------------------------------------------------

// API: Get current session (persisted + live server facts + live scrollbacks)
app.get('/api/session', (_req, res) => {
  const session = mergePaneScrollback(loadSession(CWD) || emptySession(CWD));
  // NOTE: INITIAL_PROMPT is intentionally NOT injected into messages — the
  // client fills the chat inbox with it instead (see /api/config).
  session.keysUsed = [...serverState.keysUsed];
  session.filesChanged = [...serverState.filesChanged];
  session.stats = { ...session.stats, commandsRun: serverState.commandsRun, aiTurns: serverState.aiTurns };
  return res.json({ session });
});

// API: Save session state (client sends client-owned fields; server merges facts)
app.put('/api/session', (req, res) => {
  const body = req.body?.session as Partial<TellSession> | undefined;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'session object is required' });
  }
  const invalid = validateSessionPayload(body);
  if (invalid !== null) {
    return res.status(400).json({ error: invalid });
  }
  const merged = buildMergedSession(body);
  const ok = saveSession(CWD, merged);
  return res.json({ success: ok, session: merged });
});

// API: List session history snapshots
app.get('/api/session/history', (_req, res) => {
  return res.json({ history: listHistory(CWD) });
});

// API: Read a single snapshot (used for restore and download)
app.get('/api/session/history/:name', (req, res) => {
  const name = path.basename(String(req.params.name || ''));
  if (!name.endsWith('.json')) {
    return res.status(400).json({ error: 'Invalid snapshot name' });
  }
  const full = canonical_path(CWD, path.join('.tell', 'history', name));
  if (!full) {
    return res.status(400).json({ error: 'Invalid snapshot name' });
  }
  if (!fs.existsSync(full)) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }
  let fd: number | null = null;
  try {
    fd = open_regular_file(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const session = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return res.json({ name, session });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
});

// API: Delete a snapshot
app.delete('/api/session/history/:name', (req, res) => {
  const name = path.basename(String(req.params.name || ''));
  if (!name.endsWith('.json')) {
    return res.status(400).json({ error: 'Invalid snapshot name' });
  }
  const full = canonical_path(CWD, path.join('.tell', 'history', name));
  if (!full) {
    return res.status(400).json({ error: 'Invalid snapshot name' });
  }
  if (!fs.existsSync(full)) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }
  try {
    fs.unlinkSync(full);
    return res.json({ success: true, history: listHistory(CWD) });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// API: Force a snapshot (and refresh git changes before persisting)
app.post('/api/session/snapshot', async (req, res) => {
  try {
    const gitChanges = await listGitChanges(CWD);
    for (const line of gitChanges) serverState.filesChanged.add(line);
    const body = req.body?.session as Partial<TellSession> | undefined;
    const merged = buildMergedSession(body || {});
    const name = createSnapshot(CWD, merged);
    const saved = saveSession(CWD, merged);
    return res.json({ success: Boolean(name && saved), name, gitChanges, history: listHistory(CWD) });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// A rejected promise in one request must never take the whole sandbox down
// (every PTY pane and every in-flight run would die with it). Express 4 does
// not catch async handler rejections, so the guard lives here.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason instanceof Error ? reason.message : String(reason));
});

// Setup Vite dev server middleware in development, and static file serving in production
async function startServer() {
  const server = http.createServer(app);

  if (process.env['NODE_ENV'] !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: { server } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = __dirname;
    app.use('/assets', express.static(path.join(distPath, 'assets')));
    app.get('/server.js', (_req, res) => res.status(404).end());
    app.get('*', (_req, res) => {
      return res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  attachTerminalServer(server, { cwd: CWD, token: TELL_TOKEN || undefined, allowedHosts: ALLOWED_HOSTS });

  server.listen(PORT, HOST, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : PORT;
    console.log(`Tell AI custom backend running at http://${HOST}:${boundPort}`);
    if (TELL_TOKEN) console.log('API auth: TELL_TOKEN active (Bearer required on /api/*)');
    else console.log('API auth: disabled (set TELL_TOKEN to require a Bearer token)');
  });
}

startServer();
