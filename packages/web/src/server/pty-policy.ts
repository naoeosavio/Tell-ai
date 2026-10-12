/**
 * GC keep/kill policy + scrollback budget for Tell Web terminal panes.
 * Pure server-side helpers (only `fs`); `pty.ts` only wires them in.
 * Linux-first: procfs child-probe, degrades to "idle" where /proc is absent.
 */

import fs from 'fs';

// ---------------------------------------------------------------------------
// Child-probe: /proc/<pid>/task/<pid>/children + /proc/<pid>/stat
// ---------------------------------------------------------------------------

/** Proc states that keep a pane alive (R/S/D running; T/t suspended via Ctrl-Z). */
const ACTIVE_PROC_STATES = new Set(['R', 'S', 'D', 'T', 't']);

/**
 * True when a proc state letter means "still alive".
 *
 * @param state - Single-letter state from /proc/<pid>/stat.
 * @returns False for zombies (Z), dead (X/x) and kernel-idle (I).
 */
export function isActiveChildState(state: string): boolean {
  return ACTIVE_PROC_STATES.has(state);
}

/**
 * Extract the state letter from a /proc/<pid>/stat line.
 * Parses after the last ')' because comm may contain parens/spaces.
 *
 * @param stat - Raw content of /proc/<pid>/stat.
 * @returns The state letter, or null when unparseable.
 */
export function childStateOfLine(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  if (!state) return null;
  return state;
}

/**
 * True when at least one child state is alive.
 *
 * @param states - State letters collected from the shell's children.
 */
export function shouldKeepSession(states: string[]): boolean {
  return states.some((state) => isActiveChildState(state));
}

/** Minimal procfs surface (injectable so unit tests avoid touching /proc). */
export interface ProcFs {
  readText(path: string): string;
}

const nodeProcFs: ProcFs = {
  readText: (path) => fs.readFileSync(path, 'utf8'),
};

/**
 * Collect state letters of the shell's direct children.
 * Never throws: missing /proc (mac/Windows) or a reaped shell yields [].
 *
 * @param shellPid - PID of the PTY shell process.
 * @param procFs - Procfs accessor (defaults to the real one).
 */
export function readChildStates(shellPid: number, procFs: ProcFs = nodeProcFs): string[] {
  try {
    const raw = procFs.readText(`/proc/${shellPid}/task/${shellPid}/children`).trim();
    if (!raw) return [];
    const states: string[] = [];
    for (const token of raw.split(/\s+/)) {
      const childPid = Number(token);
      if (!Number.isInteger(childPid) || childPid <= 0) continue;
      try {
        const state = childStateOfLine(procFs.readText(`/proc/${childPid}/stat`));
        if (state) states.push(state);
      } catch {
        // Child exited between listing and read — nothing to keep.
      }
    }
    return states;
  } catch {
    // No /proc (mac/Windows) or shell already gone — degrade to idle.
    return [];
  }
}

/**
 * True when the shell has at least one living child (htop, vim, sleep & …).
 * Transient commands (ls, pwd) are already reaped at GC time, so they read idle.
 *
 * @param shellPid - PID of the PTY shell process.
 * @param procFs - Procfs accessor (defaults to the real one).
 */
export function hasActiveChild(shellPid: number, procFs?: ProcFs): boolean {
  return shouldKeepSession(readChildStates(shellPid, procFs));
}

// ---------------------------------------------------------------------------
// Foreground signal: node-pty `pty.process`
// ---------------------------------------------------------------------------

/**
 * Basename of a process path/argv0, tolerant to Windows separators.
 * Strips a leading '-' (login shells exec as `-bash`).
 *
 * @param processPath - Full path, bare name or argv[0].
 */
export function shellBasename(processPath: string): string {
  const normalized = processPath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const base = slash === -1 ? normalized : normalized.slice(slash + 1);
  return base.startsWith('-') ? base.slice(1) : base;
}

/**
 * True when the PTY foreground process is something other than the shell
 * itself (htop, opencode, vim …). Unknown/empty foreground defers to the
 * child-probe instead of guessing.
 *
 * @param foreground - `pty.process` (argv[0] of the foreground process).
 * @param shellFile - Binary the PTY spawned (stored per session).
 */
export function isBusyForeground(foreground: string | undefined, shellFile: string): boolean {
  if (!foreground) return false;
  const fg = shellBasename(foreground).toLowerCase();
  const shell = shellBasename(shellFile).toLowerCase();
  if (!fg || !shell) return false;
  return fg !== shell;
}

/** Minimal shape needed to read the foreground process (exported for unit tests). */
export interface ForegroundPty {
  readonly process?: unknown;
}

/**
 * Read `pty.process` without ever throwing (native getter on a dead PTY).
 *
 * @param pty - The node-pty handle.
 */
export function safeForeground(pty: ForegroundPty): string | undefined {
  try {
    const value = pty.process;
    if (typeof value === 'string' && value.length > 0) return value;
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Combined GC decision
// ---------------------------------------------------------------------------

/** Inputs for the keep/kill decision (all are best-effort, never throw). */
export interface KeepPaneInput {
  foreground: string | undefined;
  shellFile: string;
  pid: number | undefined;
}

/**
 * True when the pane must survive GC: a foreign process owns the foreground
 * OR a child is still alive. Background jobs (`sleep 300 &`) are caught by
 * the child-probe even with an idle prompt.
 */
export function shouldKeepPane(input: KeepPaneInput, procFs?: ProcFs): boolean {
  if (isBusyForeground(input.foreground, input.shellFile)) return true;
  if (typeof input.pid === 'number' && Number.isInteger(input.pid) && input.pid > 0) {
    return shouldKeepSession(readChildStates(input.pid, procFs));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scrollback budget
// ---------------------------------------------------------------------------

/** Default scrollback budget per pane (chars). */
export const DEFAULT_MAX_SCROLLBACK_CHARS = 256 * 1024;

/** Hard ceiling for overrides (avoids unbounded memory per pane). */
const SCROLLBACK_MAX_CAP = 16 * 1024 * 1024;

let maxScrollbackChars = DEFAULT_MAX_SCROLLBACK_CHARS;

/**
 * Override the per-pane scrollback budget (e.g. from TELL_SCROLLBACK_MAX).
 * Invalid values (undefined, NaN, <= 0) reset to the default.
 *
 * @param bytes - Budget in chars; clamped to the hard ceiling.
 */
export function configureScrollbackMax(bytes?: number): void {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
    maxScrollbackChars = DEFAULT_MAX_SCROLLBACK_CHARS;
    return;
  }
  maxScrollbackChars = Math.min(Math.floor(bytes), SCROLLBACK_MAX_CAP);
}

/** Effective per-pane scrollback budget in chars. */
export function getMaxScrollbackChars(): number {
  return maxScrollbackChars;
}
