import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  create_ask_ai,
  get_model,
  is_wire_api,
  MODELS,
  resolve_model_spec,
  type SDKConfig,
  WIRE_APIS,
  type WireApi,
} from '@tell-ai/sdk';
import { generateText } from 'ai';
import { config as loadEnv } from 'dotenv';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { type ChatStreamEvent, encode_chat_stream_event } from '../shared/chat-stream';
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
  sanitizeChildEnv,
  validateTellPayload,
} from './guards';
import { resolveWithin } from './paths';
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

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// CLI args: --cwd <path>, --prompt <text>, -m/--model, --port <n>, --chain, -y/--yes, --no-exec
const cliArgs = parseCliArgs(process.argv.slice(2), process.cwd());
if (cliArgs.help) {
  printHelp();
  process.exit(0);
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
const DEFAULT_MODEL = (cliArgs.model || process.env['TELL_MODEL'] || 'l').trim();
const CHAIN = cliArgs.chain;
const YES = cliArgs.yes;
const REQUIRE_APPROVAL = cliArgs.requireApproval;
const STREAM = cliArgs.stream;
const THINK = cliArgs.think;
const PORT = cliArgs.port ?? Number(process.env['PORT'] || 3000);
const HOST = cliArgs.host || '127.0.0.1';
const EXEC_TIMEOUT_MS = cliArgs.execTimeout ?? 120_000;
const TELL_TOKEN = process.env['TELL_TOKEN'] || '';
const ALLOWED_HOSTS = new Set(
  (process.env['TELL_ALLOWED_HOSTS'] || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
if (!['0.0.0.0', '::', '[::]'].includes(HOST.toLowerCase())) ALLOWED_HOSTS.add(HOST.toLowerCase());
configureScrollbackMax(Number(process.env['TELL_SCROLLBACK_MAX']) || undefined);

// Trimmed env value, empty/missing as undefined.
function env(name: string): string | undefined {
  const value = (process.env[name] ?? '').trim();
  return value || undefined;
}

// API keys / base URLs are injected into the SDK (it never reads process.env).
function load_sdk_config_from_env(): SDKConfig {
  return {
    keys: {
      openai: env('OPENAI_API_KEY'),
      anthropic: env('ANTHROPIC_API_KEY'),
      google: env('GOOGLE_API_KEY') || env('GEMINI_API_KEY'),
      xai: env('XAI_API_KEY'),
      deepseek: env('DEEPSEEK_API_KEY'),
      cerebras: env('CEREBRAS_API_KEY'),
      moonshotai: env('MOONSHOTAI_API_KEY'),
      openrouter: env('OPENROUTER_API_KEY'),
      alibaba: env('ALIBABA_API_KEY'),
      zhipu: env('ZHIPU_API_KEY'),
      meta: env('META_API_KEY'),
      xiaomi: env('MIMO_API_KEY'),
      custom: env('CUSTOM_API_KEY'),
    },
    urls: {
      openai: env('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
      anthropic: env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com/v1',
      google: env('GOOGLE_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta',
      xai: env('XAI_BASE_URL') || 'https://api.x.ai/v1',
      deepseek: env('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com',
      cerebras: env('CEREBRAS_BASE_URL') || 'https://api.cerebras.ai/v1',
      moonshotai: env('MOONSHOTAI_BASE_URL') || 'https://api.moonshot.ai/v1',
      openrouter: env('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1',
      alibaba: env('ALIBABA_BASE_URL') || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      zhipu: env('ZHIPU_BASE_URL') || 'https://api.z.ai/api/paas/v4',
      meta: env('META_BASE_URL') || 'https://api.meta.ai/v1',
      xiaomi: env('MIMO_BASE_URL') || 'https://api.xiaomimimo.com/v1',
      custom: env('CUSTOM_BASE_URL'),
      vast: env('VAST_BASE_URL'),
      local: env('LOCAL_OPENAI_BASE_URL'),
    },
  };
}

const SDK_CONFIG = load_sdk_config_from_env();

// `custom` knobs are optional: each one only reaches the SDK when set, so an
// invalid value fails loudly on the request instead of silently falling back.
// Mirrors `load_sdk_config` in the CLI (`packages/cli/src/env.ts`).
function custom_wire_from_env(): WireApi | undefined {
  const value = env('CUSTOM_API');
  if (!value) return undefined;
  if (!is_wire_api(value)) {
    throw new Error(`CUSTOM_API must be one of: ${WIRE_APIS.join(', ')} (got "${value}")`);
  }
  return value;
}

function custom_headers_from_env(): Record<string, string> {
  const value = env('CUSTOM_HEADERS');
  if (!value) return {};
  const hint = 'CUSTOM_HEADERS must be a JSON object, e.g. \'{"x-tenant":"acme"}\'';
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(hint);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(hint);
  return Object.fromEntries(Object.entries(parsed).map(([name, header]) => [name, String(header)]));
}

const custom_model = env('CUSTOM_MODEL');
if (custom_model) SDK_CONFIG.models = { custom: custom_model };
const custom_wire = custom_wire_from_env();
if (custom_wire) SDK_CONFIG.wires = { custom: custom_wire };
const custom_headers = custom_headers_from_env();
if (Object.keys(custom_headers).length > 0) SDK_CONFIG.headers = { custom: custom_headers };
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
const EXEC_OUTPUT_LIMIT = 200 * 1024;
const executeRateLimit = createRateLimiter({ max: 10, windowMs: 60_000 });
const tellRateLimit = createRateLimiter({ max: 10, windowMs: 60_000 });
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
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
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
  next.terminal.tabs = next.terminal.tabs.map((tab) => ({
    ...tab,
    panes: tab.panes.map((pane) => {
      const live = getScrollback(pane.id);
      return { ...pane, scrollback: live || pane.scrollback || '' };
    }),
  }));
  return next;
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
  const filePath = req.query['path'] as string;
  if (!filePath) {
    return res.status(400).json({ error: 'File path is required' });
  }

  const resolvedPath = resolveWithin(CWD, filePath);
  if (!resolvedPath) {
    return res.status(403).json({ error: 'Access denied: Directory traversal blocked' });
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
  const filePath = req.query['path'] as string;
  if (!filePath) {
    return res.status(400).json({ error: 'File path is required' });
  }

  const resolvedPath = resolveWithin(CWD, filePath);
  if (!resolvedPath) {
    return res.status(403).json({ error: 'Access denied: Directory traversal blocked' });
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

  const resolvedPath = resolveWithin(CWD, filePath);
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
    if (!resolveWithin(CWD, filePath)) {
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
    const { stdout, stderr } = await execAsync(command, {
      cwd: CWD,
      maxBuffer: 32 * 1024 * 1024,
      shell: '/bin/bash',
      timeout: EXEC_TIMEOUT_MS,
      env: sanitizeChildEnv(process.env),
    });
    const truncate = (text: string) =>
      text.length > EXEC_OUTPUT_LIMIT ? `${text.slice(0, EXEC_OUTPUT_LIMIT)}\n[truncated]` : text;
    return res.json({ output: truncate(stdout) + truncate(stderr) });
  } catch (error: any) {
    const output = [
      error.stdout || '',
      error.stderr || '',
      error.killed ? `Process timed out after ${EXEC_TIMEOUT_MS}ms` : error.message || '',
    ]
      .filter(Boolean)
      .join('\n');
    return res.json({ output: output.slice(0, EXEC_OUTPUT_LIMIT + 32) });
  } finally {
    activeExecutions -= 1;
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
    requireApproval: REQUIRE_APPROVAL,
    stream: STREAM,
    think: THINK,
    cwd: CWD,
    initialPrompt: INITIAL_PROMPT || null,
  });
});

// API: Auto-generated project context (tree 4 levels + README + AGENTS + protocol)
app.get('/api/context', (_req, res) => {
  try {
    const systemPrompt = buildSystemPrompt(CWD);
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
    for await (const event of ai.ask_stream(messages, { system })) {
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

    const effectiveSystem = systemPrompt?.trim() ? systemPrompt : buildSystemPrompt(CWD);

    // Streaming mode: per-request `stream` override wins over the boot `--stream`.
    // Streaming replies are NDJSON events; the model is resolved before headers are sent.
    if (resolveStreamMode(req.body?.stream, STREAM)) {
      await stream_tell(res, modelSpec, formattedMessages, effectiveSystem);
      return;
    }

    // Resolve model spec and get AI SDK model instance (via @tell-ai/sdk)
    const handle = await get_model(modelSpec, SDK_CONFIG);
    const reasoning = handle.fast ? 'none' : handle.reasoning;

    // Call generateText
    const result = await generateText({
      model: handle.model,
      system: effectiveSystem,
      messages: formattedMessages,
      reasoning: reasoning as any,
      ...(handle.providerOptions ? { providerOptions: handle.providerOptions } : {}),
    });

    return res.json({
      text: result.text,
      // Pass back other useful properties if available
      reasoning: sanitizeReasoning((result as any).reasoning),
    });
  } catch (error: any) {
    console.error('Error generating AI text:', model_error_message(error));
    return res.status(500).json({ error: 'AI generation failed. Check server logs.' });
  }
});

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
  const full = resolveWithin(CWD, path.join('.tell', 'history', name));
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
  const full = resolveWithin(CWD, path.join('.tell', 'history', name));
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
