import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { create_ask_ai, get_model, MODELS, resolve_model_spec, type SDKConfig } from '@tell-ai/sdk';
import { generateText } from 'ai';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { type ChatStreamEvent, encode_chat_stream_event } from '../shared/chat-stream';
import { parseCliArgs, printHelp } from './cli-args';
import { buildSystemPrompt } from './context-builder';
import {
  authFailureMessage,
  createRateLimiter,
  isHighRiskScript,
  isSensitiveRelPath,
  isValidTokenInput,
  validateTellPayload,
} from './guards';
import { resolveWithin } from './paths';
import { attachTerminalServer, getScrollback } from './pty';
import { configureScrollbackMax } from './pty-policy';
import {
  createSnapshot,
  emptySession,
  historyDir,
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
const CWD = cliArgs.cwd;
const INITIAL_PROMPT = cliArgs.initialPrompt;
const AUTO_EXECUTE = cliArgs.autoExecute;
const DEFAULT_MODEL = (cliArgs.model || process.env['TELL_MODEL'] || 'l').trim();
const CHAIN = cliArgs.chain;
const YES = cliArgs.yes;
const STREAM = cliArgs.stream;
const THINK = cliArgs.think;
const PORT = cliArgs.port ?? Number(process.env['PORT'] || 3000);
const HOST = cliArgs.host || '127.0.0.1';
const EXEC_TIMEOUT_MS = cliArgs.execTimeout ?? 120_000;
const TELL_TOKEN = process.env['TELL_TOKEN'] || '';
configureScrollbackMax(Number(process.env['TELL_SCROLLBACK_MAX']) || undefined);

// API keys / base URLs are injected into the SDK (it never reads process.env).
function load_sdk_config_from_env(): SDKConfig {
  const env = (name: string): string | undefined => {
    const value = (process.env[name] ?? '').trim();
    return value || undefined;
  };
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
    },
    urls: {
      zhipu: env('ZHIPU_BASE_URL'),
      vast: env('VAST_BASE_URL'),
      local: env('LOCAL_OPENAI_BASE_URL'),
    },
  };
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
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

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
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/auth/status' || req.path === '/api/auth/verify') return next();
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

  try {
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    const stat = fs.statSync(resolvedPath);
    if (stat.size > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large to preview (>10MB). Use download instead.' });
    }
    const content = fs.readFileSync(resolvedPath, 'utf8');
    return res.json({ content, mtime: stat.mtimeMs, size: stat.size });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
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

  try {
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    return res.download(resolvedPath);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// API: Save file content (409 when the file changed on disk since it was loaded)
app.post('/api/save-file', (req, res) => {
  const { path: filePath, content, expectedMtime } = req.body;
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'Path and content are required' });
  }

  const resolvedPath = resolveWithin(CWD, filePath);
  if (!resolvedPath) {
    return res.status(403).json({ error: 'Access denied: Directory traversal blocked' });
  }
  if (isSensitiveRelPath(path.relative(CWD, resolvedPath))) {
    return res.status(403).json({ error: 'Access denied: Sensitive file' });
  }

  try {
    if (expectedMtime != null && fs.existsSync(resolvedPath)) {
      const stat = fs.statSync(resolvedPath);
      if (stat.mtimeMs !== Number(expectedMtime)) {
        return res.status(409).json({
          error: 'File was modified externally since it was loaded. Reload before saving.',
          mtime: stat.mtimeMs,
        });
      }
    }
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, content, 'utf8');
    serverState.filesChanged.add(filePath);
    const stat = fs.statSync(resolvedPath);
    return res.json({ success: true, mtime: stat.mtimeMs });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// API: Classify a command without executing it (drives the
// Require Approval + Auto-Run combo: safe runs directly, risky needs approval)
app.post('/api/risk-check', (req, res) => {
  const { command } = req.body;
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
    google: !!(process.env['GOOGLE_API_KEY'] || process.env['GEMINI_API_KEY']),
    openai: !!process.env['OPENAI_API_KEY'],
    anthropic: !!process.env['ANTHROPIC_API_KEY'],
    xai: !!process.env['XAI_API_KEY'],
    deepseek: !!process.env['DEEPSEEK_API_KEY'],
    cerebras: !!process.env['CEREBRAS_API_KEY'],
    moonshotai: !!process.env['MOONSHOTAI_API_KEY'],
    openrouter: !!process.env['OPENROUTER_API_KEY'],
    alibaba: !!process.env['ALIBABA_API_KEY'],
    zhipu: !!process.env['ZHIPU_API_KEY'],
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
  const ip = clientIp(req);
  if (!authRateLimit.check(ip)) {
    res.setHeader('Retry-After', '900');
    res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    return;
  }
  // No token configured → login is skipped entirely.
  if (!TELL_TOKEN) {
    res.json({ ok: true, authRequired: false });
    return;
  }
  const token = (req.body as any)?.token;
  if (!isValidTokenInput(token)) {
    await delay(500);
    console.warn(`[auth] failed login attempt from ${ip} at ${new Date().toISOString()} (malformed)`);
    res.status(401).json({ error: authFailureMessage() });
    return;
  }
  if (tokensEqual(token, TELL_TOKEN)) {
    res.json({ ok: true, authRequired: true });
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
    chain: CHAIN,
    yes: YES,
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

// Streams a model response to the client as NDJSON (`--stream`). Model setup
// errors still surface as a JSON 500; once headers are sent, failures become
// an `error` event so the client can keep the partial answer it received.
async function stream_tell(
  res: express.Response,
  modelSpec: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  system: string,
): Promise<void> {
  const ai = await create_ask_ai(modelSpec, load_sdk_config_from_env());

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
    console.error('Error streaming AI text:', error);
    write_event({ type: 'error', error: error?.message || 'AI generation failed' });
  }
  res.end();
}

// API: Model execution route (using Vercel AI SDK)
app.post('/api/tell', async (req, res) => {
  const { messages, modelAlias, systemPrompt } = req.body;

  const payloadError = validateTellPayload({ messages, systemPrompt });
  if (payloadError) {
    return res.status(400).json({ error: payloadError });
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

    // Streaming mode: NDJSON events; the model is resolved before headers are sent.
    if (STREAM) {
      await stream_tell(res, modelSpec, formattedMessages, effectiveSystem);
      return;
    }

    // Resolve model spec and get AI SDK model instance (via @tell-ai/sdk)
    const handle = await get_model(modelSpec, load_sdk_config_from_env());
    const reasoning = handle.fast ? 'none' : handle.reasoning;

    // Call generateText
    const result = await generateText({
      model: handle.model,
      system: effectiveSystem,
      messages: formattedMessages,
      reasoning: reasoning as any,
    });

    return res.json({
      text: result.text,
      // Pass back other useful properties if available
      reasoning: sanitizeReasoning((result as any).reasoning),
    });
  } catch (error: any) {
    console.error('Error generating AI text:', error);
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
  const full = path.join(historyDir(CWD), name);
  if (!fs.existsSync(full)) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }
  try {
    const session = JSON.parse(fs.readFileSync(full, 'utf8'));
    return res.json({ name, session });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// API: Delete a snapshot
app.delete('/api/session/history/:name', (req, res) => {
  const name = path.basename(String(req.params.name || ''));
  if (!name.endsWith('.json')) {
    return res.status(400).json({ error: 'Invalid snapshot name' });
  }
  const full = path.join(historyDir(CWD), name);
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
    saveSession(CWD, merged);
    const name = createSnapshot(CWD, merged);
    return res.json({ success: !!name, name, gitChanges, history: listHistory(CWD) });
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
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      return res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  attachTerminalServer(server, { cwd: CWD, token: TELL_TOKEN || undefined });

  server.listen(PORT, HOST, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : PORT;
    console.log(`Tell AI custom backend running at http://${HOST}:${boundPort}`);
    if (TELL_TOKEN) console.log('API auth: TELL_TOKEN active (Bearer required on /api/*)');
    else console.log('API auth: disabled (set TELL_TOKEN to require a Bearer token)');
  });
}

startServer();
