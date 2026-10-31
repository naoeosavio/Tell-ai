/**
 * Pure security guards for Tell Web.
 * No runtime dependencies — loaded directly by test/test-web-backend.js.
 * Confinement policies that both hosts share (child-environment scrubbing,
 * payload caps) are owned by `@tell-ai/core` and only re-exported here.
 */

import {
  assess_base_risk,
  is_sensitive_rel_path,
  PAYLOAD_MAX_CONTENT_CHARS,
  PAYLOAD_MAX_MESSAGES,
  PAYLOAD_MAX_SYSTEM_CHARS,
} from '@tell-ai/core';

// ---------------------------------------------------------------------------
// Sensitive paths (read/write deny regardless of traversal state)
// ---------------------------------------------------------------------------

/**
 * True when a workspace-relative path points at secrets we never expose:
 * `.env*`, `.tell/**` (session persistence), `*.key`, `*.pem`, `.git/**`.
 *
 * Owned by `@tell-ai/core` (`is_sensitive_rel_path`); re-exported here under
 * the pinned public name so both hosts share one predicate.
 */
export function isSensitiveRelPath(relPath: string): boolean {
  return is_sensitive_rel_path(relPath);
}

// ---------------------------------------------------------------------------
// Rate limiting (per-key token timestamps, in memory)
// ---------------------------------------------------------------------------

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
      if (hits.size >= RATE_LIMIT_MAX_KEYS) {
        purge(now);
        // The map is a hard cap: when every tracked key is still inside the
        // window, the oldest entry is evicted (the flood is bounded).
        if (hits.size >= RATE_LIMIT_MAX_KEYS) {
          const oldest = hits.keys().next();
          if (!oldest.done) hits.delete(oldest.value);
        }
      }
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

/** Max items accepted in one `/api/tell` message list (owned by the core). */
export const TELL_MAX_MESSAGES = PAYLOAD_MAX_MESSAGES;
/** Max characters per message content (owned by the core). */
export const TELL_MAX_CONTENT_CHARS = PAYLOAD_MAX_CONTENT_CHARS;
/** Max characters for the `/api/tell` system prompt (owned by the core). */
export const TELL_MAX_SYSTEM_CHARS = PAYLOAD_MAX_SYSTEM_CHARS;

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
// Command risk assessment (owned by @tell-ai/core)
// ---------------------------------------------------------------------------

/**
 * True when the script matches the core's strict risk profile.
 *
 * The sandbox uses the core owner (`assess_base_risk(script, 'strict')`) —
 * the Web profile is the strict one (any interpreter eval, bare `env`,
 * `base64 -d`, shell expansions, credential-file reads — the last one now
 * shared with the CLI, which prompts instead of blocking), so the rules
 * live in a single place and can never drift from the CLI's matrix.
 *
 * @param script - Command script to classify.
 * @returns Whether the script must be blocked.
 */
export function isHighRiskScript(script: string): boolean {
  return assess_base_risk(script, 'strict').risky;
}
