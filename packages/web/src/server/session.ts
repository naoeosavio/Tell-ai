import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { sanitizeChildEnv } from './guards';
import { resolveWithin } from './paths';

const execFileAsync = promisify(execFile);

export interface TerminalPaneState {
  id: string;
  title: string;
  scrollback: string;
}

export interface TerminalTabState {
  id: string;
  name: string;
  panes: TerminalPaneState[];
  activePaneId: string;
}

export interface TellSession {
  version: number;
  project: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  systemPrompt: string;
  generatedContextHash: string;
  messages: Array<{ role: string; content: string; thought?: string | null }>;
  /** Unsent chat inbox text + which server `--prompt` it came from (null = typed). */
  draft: { text: string; fromPrompt: string | null };
  terminal: { tabs: TerminalTabState[]; activeTabId: string };
  keysUsed: string[];
  filesChanged: string[];
  stats: { commandsRun: number; aiTurns: number; snapshots: number };
}

export function sessionDir(cwd: string): string {
  return path.join(cwd, '.tell');
}

export function sessionPath(cwd: string): string {
  return path.join(sessionDir(cwd), 'session.json');
}

export function historyDir(cwd: string): string {
  return path.join(sessionDir(cwd), 'history');
}

export function emptySession(cwd: string): TellSession {
  return {
    version: 1,
    project: path.basename(cwd) || cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: '',
    systemPrompt: '',
    generatedContextHash: '',
    messages: [],
    draft: { text: '', fromPrompt: null },
    terminal: { tabs: [], activeTabId: '' },
    keysUsed: [],
    filesChanged: [],
    stats: { commandsRun: 0, aiTurns: 0, snapshots: 0 },
  };
}

const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function ensurePrivateDirectory(cwd: string, relativePath: string): string {
  const full = resolveWithin(cwd, relativePath);
  if (!full) throw new Error('Session path escapes the workspace');
  fs.mkdirSync(full, { recursive: true, mode: PRIVATE_DIR_MODE });
  const safePath = resolveWithin(cwd, relativePath);
  if (!safePath || !fs.lstatSync(safePath).isDirectory()) throw new Error('Session path is not a directory');
  fs.chmodSync(safePath, PRIVATE_DIR_MODE);
  return safePath;
}

function openPrivateFile(filePath: string): number {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK,
    PRIVATE_FILE_MODE,
  );
  if (!fs.fstatSync(fd).isFile()) {
    fs.closeSync(fd);
    throw new Error('Session file is not a regular file');
  }
  fs.fchmodSync(fd, PRIVATE_FILE_MODE);
  return fd;
}

function writePrivateFile(filePath: string, content: string): void {
  const fd = openPrivateFile(filePath);
  try {
    fs.writeFileSync(fd, content, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readPrivateFile(filePath: string): string {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Session file is not a regular file');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function repairPrivateModes(cwd: string): void {
  const tell = resolveWithin(cwd, '.tell');
  if (tell && fs.lstatSync(tell).isDirectory()) fs.chmodSync(tell, PRIVATE_DIR_MODE);
  const session = resolveWithin(cwd, path.join('.tell', 'session.json'));
  if (session && fs.lstatSync(session).isFile()) fs.chmodSync(session, PRIVATE_FILE_MODE);
  const history = resolveWithin(cwd, path.join('.tell', 'history'));
  if (!history || !fs.lstatSync(history).isDirectory()) return;
  fs.chmodSync(history, PRIVATE_DIR_MODE);
  for (const name of fs.readdirSync(history)) {
    const file = resolveWithin(cwd, path.join('.tell', 'history', name));
    if (file && fs.lstatSync(file).isFile()) fs.chmodSync(file, PRIVATE_FILE_MODE);
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Coerce a partially-corrupted session object into a valid TellSession. */
function sanitizeSession(cwd: string, raw: unknown): TellSession {
  const base = emptySession(cwd);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const obj = raw as Record<string, any>;
  const terminal =
    obj['terminal'] && typeof obj['terminal'] === 'object' && !Array.isArray(obj['terminal'])
      ? {
          tabs: asArray<TerminalTabState>(obj['terminal']['tabs']).filter(
            (t) => t && typeof t === 'object' && typeof t.id === 'string',
          ),
          activeTabId: typeof obj['terminal']['activeTabId'] === 'string' ? obj['terminal']['activeTabId'] : '',
        }
      : base.terminal;
  const stats =
    obj['stats'] && typeof obj['stats'] === 'object' && !Array.isArray(obj['stats'])
      ? {
          commandsRun: Number(obj['stats']['commandsRun']) || 0,
          aiTurns: Number(obj['stats']['aiTurns']) || 0,
          snapshots: Number(obj['stats']['snapshots']) || 0,
        }
      : base.stats;
  const raw_draft = obj['draft'];
  const draft =
    raw_draft && typeof raw_draft === 'object' && !Array.isArray(raw_draft) && typeof raw_draft['text'] === 'string'
      ? {
          text: raw_draft['text'],
          fromPrompt: typeof raw_draft['fromPrompt'] === 'string' ? raw_draft['fromPrompt'] : null,
        }
      : base.draft;
  return {
    ...base,
    ...obj,
    version: Number(obj['version']) || base.version,
    messages: asArray<{ role: string; content: string; thought?: string | null }>(obj['messages']).filter(
      (m) => m && typeof m === 'object' && typeof m.role === 'string',
    ),
    keysUsed: asArray<string>(obj['keysUsed']).filter((k) => typeof k === 'string'),
    filesChanged: asArray<string>(obj['filesChanged']).filter((f) => typeof f === 'string'),
    terminal,
    stats,
    draft,
  };
}

export function loadSession(cwd: string): TellSession | null {
  try {
    repairPrivateModes(cwd);
  } catch {}
  const file = resolveWithin(cwd, path.join('.tell', 'session.json'));
  if (!file || !fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(readPrivateFile(file));
    return sanitizeSession(cwd, raw);
  } catch {
    return null;
  }
}

/** Check serialized size before writing to disk. Returns null when oversized. */
function serializeBounded(session: TellSession, label: string): string | null {
  const json = JSON.stringify(session, null, 2);
  if (Buffer.byteLength(json, 'utf8') > MAX_SESSION_BYTES) {
    console.warn(`[tell] ${label} rejected: exceeds ${MAX_SESSION_BYTES} bytes`);
    return null;
  }
  return json;
}

export function saveSession(cwd: string, session: TellSession): boolean {
  try {
    session.updatedAt = new Date().toISOString();
    const json = serializeBounded(session, 'saveSession');
    if (!json) return false;
    ensurePrivateDirectory(cwd, '.tell');
    const target = resolveWithin(cwd, path.join('.tell', 'session.json'));
    const tmp = resolveWithin(cwd, path.join('.tell', 'session.json.tmp'));
    if (!target || !tmp) return false;
    writePrivateFile(tmp, json);
    fs.renameSync(tmp, target);
    fs.chmodSync(target, PRIVATE_FILE_MODE);
    return true;
  } catch {
    return false;
  }
}

export function listHistory(cwd: string): Array<{ name: string; createdAt: string; size: number }> {
  try {
    repairPrivateModes(cwd);
  } catch {}
  repairLatestSymlink(cwd);
  const dir = resolveWithin(cwd, path.join('.tell', 'history'));
  if (!dir || !fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((name) => {
      const full = resolveWithin(cwd, path.join('.tell', 'history', name));
      if (!full) return null;
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(full);
        if (!stat.isFile()) return null;
      } catch {
        return null;
      }
      return { name, createdAt: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .filter((x): x is { name: string; createdAt: string; mtimeMs: number; size: number } => x !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ name, createdAt, size }) => ({ name, createdAt, size }));
}

export function createSnapshot(cwd: string, session: TellSession): string | null {
  try {
    session.stats.snapshots = (session.stats.snapshots || 0) + 1;
    session.updatedAt = new Date().toISOString();
    const json = serializeBounded(session, 'createSnapshot');
    if (!json) return null;
    ensurePrivateDirectory(cwd, path.join('.tell', 'history'));
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const full = resolveWithin(cwd, path.join('.tell', 'history', name));
    if (!full) return null;
    writePrivateFile(full, json);
    updateLatestSymlink(cwd, name);
    return name;
  } catch {
    return null;
  }
}

function updateLatestSymlink(cwd: string, snapshotName: string): void {
  const tell = resolveWithin(cwd, '.tell');
  if (!tell) return;
  const latest = path.join(tell, 'latest');
  try {
    fs.unlinkSync(latest);
  } catch {
    /* not present */
  }
  try {
    fs.symlinkSync(path.join('history', snapshotName), latest);
  } catch {
    /* best-effort */
  }
}

/** Drop a dangling `latest` symlink; ignore if missing or valid. */
export function repairLatestSymlink(cwd: string): void {
  const tell = resolveWithin(cwd, '.tell');
  if (!tell) return;
  const latest = path.join(tell, 'latest');
  let isSymlink = false;
  try {
    isSymlink = fs.lstatSync(latest).isSymbolicLink();
  } catch {
    return; // not present
  }
  if (!isSymlink) return;
  try {
    const target = fs.readlinkSync(latest);
    const history = resolveWithin(cwd, path.join('.tell', 'history'));
    if (!history) throw new Error('Invalid history directory');
    const targetPath = path.resolve(tell, target);
    const relative = path.relative(history, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.lstatSync(targetPath).isFile()) {
      throw new Error('Invalid snapshot target');
    }
  } catch {
    try {
      fs.unlinkSync(latest);
      console.warn('[tell] dangling `latest` symlink removed');
    } catch {
      /* best-effort */
    }
  }
}

export async function listGitChanges(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd,
      timeout: 5000,
      env: sanitizeChildEnv(process.env),
    });
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
