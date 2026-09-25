import crypto from 'node:crypto';
import type http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { type IPty, spawn } from 'node-pty';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { clampTerminalSize, isAllowedHost, isAllowedOrigin, isValidPaneId, sanitizeChildEnv } from './guards';
import { getMaxScrollbackChars, safeForeground, shouldKeepPane } from './pty-policy';

/** Constant-time WS token check (sha256 both sides so lengths don't leak). */
function wsTokensEqual(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

export const GC_AFTER_MS = 5 * 60 * 1000;
export const MAX_SESSIONS = 12;
export const MAX_PANE_CLIENTS = 8;
export const MAX_WS_PAYLOAD_BYTES = 16 * 1024;
export const MAX_CLIENT_BUFFERED_BYTES = 1024 * 1024;

export interface TerminalServerOptions {
  cwd: string;
  shell?: string;
  /** When set, WS upgrades must carry ?token=<value> (mirrors TELL_TOKEN auth). */
  token?: string | undefined;
  allowedHosts?: ReadonlySet<string> | undefined;
}

interface PaneSession {
  paneId: string;
  pty: IPty;
  /** Binary the PTY spawned (compared against the foreground process). */
  shell: string;
  clients: Set<WebSocket>;
  scrollback: string[];
  scrollbackChars: number;
  lastDisconnect: number | null;
  timer: NodeJS.Timeout | null;
}

const sessions = new Map<string, PaneSession>();

/** Minimal shape needed by the scrollback buffer (exported for unit tests). */
export interface ScrollbackBuffer {
  scrollback: string[];
  scrollbackChars: number;
}

export function pushScrollback(session: ScrollbackBuffer, data: string): void {
  const maxChars = getMaxScrollbackChars();
  const bounded = data.length > maxChars ? data.slice(-maxChars) : data;
  session.scrollback.push(bounded);
  session.scrollbackChars += bounded.length;
  while (session.scrollbackChars > maxChars && session.scrollback.length > 0) {
    const dropped = session.scrollback.shift();
    if (dropped) session.scrollbackChars -= dropped.length;
  }
}

export function getScrollback(paneId: string): string {
  const session = sessions.get(paneId);
  if (!session) return '';
  return session.scrollback.join('');
}

export function getReplayData(session: Pick<ScrollbackBuffer, 'scrollback'>): string {
  const maxChars = Math.min(getMaxScrollbackChars(), MAX_CLIENT_BUFFERED_BYTES);
  return session.scrollback.join('').slice(-maxChars);
}

export function activePaneIds(): string[] {
  return [...sessions.keys()];
}

/** Minimal shape needed by the GC timer (exported for unit tests). */
export interface GcTimerState {
  timer: NodeJS.Timeout | null;
  lastDisconnect: number | null;
}

/** Arm the GC timer; fires `onExpire` after `delayMs` unless cancelled. */
export function scheduleGcTimer(state: GcTimerState, onExpire: () => void, delayMs: number = GC_AFTER_MS): void {
  cancelGcTimer(state);
  state.lastDisconnect = Date.now();
  state.timer = setTimeout(() => {
    state.timer = null;
    onExpire();
  }, delayMs);
}

/** Disarm a pending GC timer (e.g. client reconnected). */
export function cancelGcTimer(state: GcTimerState): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

function scheduleGc(paneId: string, session: PaneSession, delayMs: number = GC_AFTER_MS): void {
  if (session.clients.size > 0) return;
  scheduleGcTimer(
    session,
    () => {
      const s = sessions.get(paneId);
      if (s && s.clients.size === 0) {
        // Busy pane (foreground program or living child): re-arm instead of killing.
        if (shouldKeepPane({ foreground: safeForeground(s.pty), shellFile: s.shell, pid: s.pty.pid })) {
          scheduleGc(paneId, s, delayMs);
          return;
        }
        try {
          s.pty.kill();
        } catch {
          /* already dead */
        }
        sessions.delete(paneId);
      }
    },
    delayMs,
  );
}

function ensureSession(paneId: string, opts: TerminalServerOptions): PaneSession {
  let session = sessions.get(paneId);
  if (session) return session;

  const env = {
    ...sanitizeChildEnv(process.env),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  const shell = opts.shell || '/bin/bash';
  const pty = spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: opts.cwd,
    env,
  });

  session = {
    paneId,
    pty,
    shell,
    clients: new Set(),
    scrollback: [],
    scrollbackChars: 0,
    lastDisconnect: null,
    timer: null,
  };
  sessions.set(paneId, session);

  pty.onData((data) => {
    pushScrollback(session, data);
    for (const client of session.clients) {
      if (client.readyState !== client.OPEN) continue;
      if (client.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
        client.close(1013, 'client is too slow');
        continue;
      }
      client.send(JSON.stringify({ type: 'data', data }));
    }
  });
  pty.onExit(({ exitCode }) => {
    const payload = JSON.stringify({ type: 'exit', code: exitCode });
    for (const client of session.clients) {
      if (client.readyState !== client.OPEN) continue;
      client.send(payload);
      client.close(1000, 'terminal exited');
      setTimeout(() => client.terminate(), 1000).unref();
    }
    cancelGcTimer(session);
    if (sessions.get(paneId) === session) sessions.delete(paneId);
    session.clients.clear();
  });

  return session;
}

function attachClient(session: PaneSession, ws: WebSocket, replay: boolean): boolean {
  if (replay) {
    const payload = JSON.stringify({ type: 'data', data: getReplayData(session) });
    if (ws.bufferedAmount + Buffer.byteLength(payload) > MAX_CLIENT_BUFFERED_BYTES) {
      ws.close(1013, 'replay is too large');
      return false;
    }
    ws.send(payload);
  }
  session.clients.add(ws);
  cancelGcTimer(session);
  session.lastDisconnect = null;
  return true;
}

function detachClient(session: PaneSession, ws: WebSocket): void {
  session.clients.delete(ws);
  if (sessions.get(session.paneId) === session) scheduleGc(session.paneId, session);
}

export function attachTerminalServer(server: http.Server, opts: TerminalServerOptions): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const allowedHosts = opts.allowedHosts ?? new Set<string>();
    if (!isAllowedHost(req.headers.host, allowedHosts)) {
      socket.destroy();
      return;
    }
    const { pathname, searchParams } = new URL(req.url || '/', `http://${req.headers.host}`);

    // Leave Vite's HMR socket alone in dev; destroy anything else off-path so
    // unmatched upgrades never hang the client.
    if (pathname !== '/api/terminal') {
      const protocol = req.headers['sec-websocket-protocol'] || '';
      if (!String(protocol).includes('vite-hmr')) socket.destroy();
      return;
    }

    // Origin check: same host only (anti cross-site WS hijacking)
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, req.headers.host, allowedHosts)) {
      socket.destroy();
      return;
    }

    // Bearer token parity with the REST API (constant-time; in-memory token only)
    if (opts.token) {
      const provided = searchParams.get('token') || '';
      if (!provided || !wsTokensEqual(provided, opts.token)) {
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const { searchParams } = new URL(req.url || '/', `http://${req.headers.host}`);

    const rawPaneId = searchParams.get('paneId') || `pane-${Math.random().toString(36).slice(2)}`;
    if (!isValidPaneId(rawPaneId)) {
      ws.close(4400, 'invalid paneId');
      return;
    }
    const paneId = rawPaneId;

    const size = clampTerminalSize(Number(searchParams.get('cols')) || 80, Number(searchParams.get('rows')) || 24);

    if (!sessions.has(paneId) && sessions.size >= MAX_SESSIONS) {
      ws.close(4429, 'too many terminal sessions');
      return;
    }
    const currentSession = sessions.get(paneId);
    if (currentSession && currentSession.clients.size >= MAX_PANE_CLIENTS) {
      ws.close(4429, 'too many clients for terminal session');
      return;
    }

    const session = ensureSession(paneId, opts);
    const replay = searchParams.get('scrollback') !== '0';
    if (!attachClient(session, ws, replay)) {
      if (session.clients.size === 0) {
        cancelGcTimer(session);
        sessions.delete(paneId);
        try {
          session.pty.kill();
        } catch {}
      }
      return;
    }

    try {
      session.pty.resize(size.cols, size.rows);
    } catch {
      /* resize before spawn of underlying pts is fine to ignore */
    }

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!session || !session.pty) return;
      if (msg.type === 'input' && typeof msg.data === 'string') {
        if (msg.data.length > 4096) return;
        session.pty.write(msg.data);
      } else if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
        const clamped = clampTerminalSize(msg.cols, msg.rows);
        try {
          session.pty.resize(clamped.cols, clamped.rows);
        } catch {
          /* ignore */
        }
      } else if (msg.type === 'destroy') {
        // Client closed the pane/tab on purpose: kill the PTY immediately
        // instead of waiting for the 5min GC.
        cancelGcTimer(session);
        sessions.delete(session.paneId);
        for (const client of session.clients) {
          if (client !== ws && client.readyState === client.OPEN) {
            client.close(4404, 'pane destroyed');
          }
        }
        session.clients.clear();
        try {
          session.pty.kill();
        } catch {
          /* already dead */
        }
        try {
          ws.close(4404, 'pane destroyed');
        } catch {
          /* ignore */
        }
      }
    });

    ws.on('close', () => {
      detachClient(session, ws);
    });
    ws.on('error', () => {
      detachClient(session, ws);
      ws.close();
    });
  });
}
