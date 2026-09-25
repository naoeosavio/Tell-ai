/**
 * Pure security guards for Tell Web.
 * No runtime dependencies — loaded directly by test/test-web-backend.js.
 */

// ---------------------------------------------------------------------------
// Sensitive paths (read/write deny regardless of traversal state)
// ---------------------------------------------------------------------------

/**
 * True when a workspace-relative path points at secrets we never expose:
 * `.env*`, `.tell/**` (session persistence), `*.key`, `*.pem`, `.git/**`.
 */
export function isSensitiveRelPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.startsWith('/') || normalized.includes('\0')) return true;
  const segments = normalized.split('/');
  for (const segment of segments) {
    // `.env.example` is a committed template, not a secret — never block it.
    if (segment === '.env.example') continue;
    if (segment === '.env' || segment.startsWith('.env.')) return true;
    if (segment === '.tell' || segment === '.git') return true;
  }
  const base = segments[segments.length - 1] ?? '';
  if (base.endsWith('.key') || base.endsWith('.pem')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Rate limiting (per-key token timestamps, in memory)
// ---------------------------------------------------------------------------

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

export function sanitizeChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || SENSITIVE_ENV_NAMES.has(name) || SENSITIVE_ENV_SUFFIX.test(name)) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

export function normalizeApiPath(pathname: string): string {
  const normalized = pathname.toLowerCase();
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function normalized_host(host: string): string | null {
  if (!host || host.length > 255 || /[\s/?#\\@]/.test(host)) return null;
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    const hostname = parsed.hostname.toLowerCase();
    const bracketed = hostname.includes(':') ? `[${hostname.replace(/^\[|\]$/g, '')}]` : hostname;
    const expected = parsed.port ? `${bracketed}:${parsed.port}` : bracketed;
    return host.toLowerCase() === expected ? hostname.replace(/^\[|\]$/g, '') : null;
  } catch {
    return null;
  }
}

function is_ip_host(hostname: string): boolean {
  if (hostname.includes(':')) return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function isAllowedHost(host: string | undefined, allowedHosts: ReadonlySet<string>): boolean {
  if (!host) return false;
  const raw = host.toLowerCase();
  if (allowedHosts.has(raw)) return true;
  const hostname = normalized_host(host);
  if (!hostname) return false;
  return hostname === 'localhost' || is_ip_host(hostname) || allowedHosts.has(hostname);
}

export function isAllowedOrigin(
  origin: string | undefined,
  requestHost: string | undefined,
  allowedHosts: ReadonlySet<string>,
): boolean {
  if (!origin) return true;
  if (!requestHost || !isAllowedHost(requestHost, allowedHosts)) return false;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    return parsed.host.toLowerCase() === requestHost.toLowerCase();
  } catch {
    return false;
  }
}

export interface RateLimiterOptions {
  max: number;
  windowMs: number;
}

export interface RateLimiter {
  /** Returns true when allowed, false when the key exceeded `max` in the window. */
  check(key: string, now?: number): boolean;
  /** Current number of tracked keys (for tests/observability). */
  size(): number;
}

const RATE_LIMIT_MAX_KEYS = 10_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { max, windowMs } = options;
  const hits = new Map<string, number[]>();

  function purge(now: number): void {
    for (const [key, stamps] of hits) {
      const alive = stamps.filter((t) => now - t < windowMs);
      if (alive.length === 0) hits.delete(key);
      else hits.set(key, alive);
    }
  }

  return {
    check(key: string, now: number = Date.now()): boolean {
      if (!key) return false;
      if (hits.size >= RATE_LIMIT_MAX_KEYS) purge(now);
      const stamps = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (stamps.length >= max) {
        hits.set(key, stamps);
        return false;
      }
      stamps.push(now);
      hits.set(key, stamps);
      return true;
    },
    size(): number {
      return hits.size;
    },
  };
}

// ---------------------------------------------------------------------------
// PTY guards
// ---------------------------------------------------------------------------

const PANE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export function isValidPaneId(paneId: string): boolean {
  return PANE_ID_PATTERN.test(paneId);
}

export const TERMINAL_MIN_COLS = 20;
export const TERMINAL_MIN_ROWS = 5;
export const TERMINAL_MAX_COLS = 500;
export const TERMINAL_MAX_ROWS = 200;

export function clampTerminalSize(cols: number, rows: number): { cols: number; rows: number } {
  const c = Number.isFinite(cols) ? Math.round(cols) : TERMINAL_MIN_COLS;
  const r = Number.isFinite(rows) ? Math.round(rows) : TERMINAL_MIN_ROWS;
  return {
    cols: Math.min(TERMINAL_MAX_COLS, Math.max(TERMINAL_MIN_COLS, c)),
    rows: Math.min(TERMINAL_MAX_ROWS, Math.max(TERMINAL_MIN_ROWS, r)),
  };
}

// ---------------------------------------------------------------------------
// Auth guards (login page — pure, testable, no runtime deps)
// ---------------------------------------------------------------------------

/** Max raw token length accepted by POST /api/auth/verify (also enforced client-side). */
export const AUTH_TOKEN_MAX_LENGTH = 256;

/**
 * True when the supplied value is a plausible token candidate.
 * Deliberately strict: non-empty string, bounded length, no NUL/CR/LF
 * (prevents log injection, header splitting and oversized-body abuse).
 * Wrong-but-plausible tokens still get a generic 401 upstream (no oracle).
 */
export function isValidTokenInput(token: unknown): boolean {
  if (typeof token !== 'string') return false;
  if (token.length < 1 || token.length > AUTH_TOKEN_MAX_LENGTH) return false;
  if (token.includes('\0') || token.includes('\n') || token.includes('\r')) return false;
  if (token.trim().length === 0) return false;
  return true;
}

/**
 * Client-side backoff after consecutive failed logins (progressive throttle).
 * 0-2 fails: no wait; 3-4 fails: 5s; 5+ fails: 30s. Server rate-limit is authoritative.
 */
export function loginBackoffMs(failCount: number): number {
  if (failCount >= 5) return 30_000;
  if (failCount >= 3) return 5_000;
  return 0;
}

/** Generic auth failure message — never reveals whether the token was malformed or wrong. */
export function authFailureMessage(): string {
  return 'Invalid token';
}

// ---------------------------------------------------------------------------
// /api/tell payload validation
// ---------------------------------------------------------------------------

export const TELL_MAX_MESSAGES = 200;
export const TELL_MAX_CONTENT_CHARS = 50 * 1024;
export const TELL_MAX_SYSTEM_CHARS = 30 * 1024;

/** Returns an error message when the payload is invalid, null when acceptable. */
export function validateTellPayload(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'messages array is required';
  const { messages, systemPrompt } = body as { messages?: unknown; systemPrompt?: unknown };
  if (!Array.isArray(messages)) return 'messages array is required';
  if (messages.length > TELL_MAX_MESSAGES) {
    return `messages limited to ${TELL_MAX_MESSAGES} items`;
  }
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return 'each message needs string content';
    }
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (typeof content !== 'string') return 'each message needs string content';
    if (role !== 'user' && role !== 'assistant') return 'each message role must be user or assistant';
    if (content.length > TELL_MAX_CONTENT_CHARS) {
      return `message content limited to ${TELL_MAX_CONTENT_CHARS} chars`;
    }
  }
  if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt !== 'string') {
    return 'systemPrompt must be a string';
  }
  if (typeof systemPrompt === 'string' && systemPrompt.length > TELL_MAX_SYSTEM_CHARS) {
    return `systemPrompt limited to ${TELL_MAX_SYSTEM_CHARS} chars`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// /api/tell transport override (Stream / No Stream)
// ---------------------------------------------------------------------------

/**
 * Resolves the response transport for a `/api/tell` request.
 *
 * An explicit boolean `stream` in the body wins; anything else (absent,
 * `'yes'`, `1`, `null`) falls back to the server's boot `--stream` default,
 * so curl/API clients keep the old behavior. Both directions overridable:
 * a stream-off server can stream a single request and vice versa.
 *
 * @param requestValue - Raw `body.stream` value, unvalidated.
 * @param serverDefault - `--stream` as parsed at boot.
 * @returns Whether this request replies as NDJSON instead of one JSON body.
 */
export function resolveStreamMode(requestValue: unknown, serverDefault: boolean): boolean {
  return typeof requestValue === 'boolean' ? requestValue : serverDefault;
}

// ---------------------------------------------------------------------------
// Command risk assessment (moved from server.ts, extended)
// ---------------------------------------------------------------------------

function highRiskPatterns(): RegExp[] {
  const privilegedPath = [
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
    /(?:curl|wget)\b[^|;&]*\|\s*(?:ba)?sh\b/,
    /(?:^|[\s;&|])(?:crontab|systemctl\s+--user\s+enable)\b/,
    new RegExp(String.raw`(?:^|[\s;&|])(?:cp|mv|ln)\b[^;&|]*\s["']?${privilegedPath}`),
    new RegExp(String.raw`(?:^|[\s;&|])sed\b[^;&|]*\s-i[^\s;&|]*[^;&|]*\s["']?${privilegedPath}`),
    new RegExp(String.raw`(?:^|[\s;&|])tee\b[^;&|]*\s["']?${privilegedPath}`),
    new RegExp(String.raw`(?:^|[\s;&|])\d*(?:>>?|>\||&>)\s*["']?${privilegedPath}`),
    // Interpreter eval: python|python3|node|perl|ruby with -c/-e (RCE via stdin of the exec shell)
    /\b(?:python3?|node|perl|ruby)\b[^;&|]*\s(?:-c|-e|--eval)\b/,
    // `env` used to launch commands (bypasses alias/scope expectations)
    /\benv\b/,
    // Payload de-obfuscation
    /\bbase64\s+(?:-[a-zA-Z]+\s+)*(?:-d\b|--decode\b)/,
    // Shell expansion / substitution
    /\$\{[^}]*\}/,
    /\$\([^)]*\)/,
    /`[^`]*\|[^`]*`/,
  ];
}

/** True when the script matches high-risk patterns and must be blocked. */
export function isHighRiskScript(script: string): boolean {
  const compact = script.replace(/\\\n/g, ' ').replace(/\s+/g, ' ').trim();
  return highRiskPatterns().some((pattern) => pattern.test(compact));
}
