// Pure exec-toggle persistence helpers (no React): parse/serialize the
// execution toggles (Auto-Run / Require Approval / No-Exec) from/to
// localStorage so they survive page reloads.

export const EXEC_TOGGLES_KEY = 'tell-exec-toggles-v1';

export interface ExecToggles {
  autoExecute?: boolean;
  requireApproval?: boolean;
  noExec?: boolean;
  chainMode?: boolean;
  /** Default open state for reasoning headers (seeded by `--think` on first visit). */
  reasoningExpanded?: boolean;
  /** Stream / No Stream transport for `/api/tell` (seeded by `--stream` on first visit). */
  streamMode?: boolean;
}

/** Boolean keys accepted by `loadExecToggles` (unknown/typed fields are dropped). */
const BOOLEAN_KEYS = [
  'autoExecute',
  'requireApproval',
  'noExec',
  'chainMode',
  'reasoningExpanded',
  'streamMode',
] as const;

export function loadExecToggles(): ExecToggles | null {
  try {
    const raw = localStorage.getItem(EXEC_TOGGLES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const toggles: ExecToggles = {};
    for (const key of BOOLEAN_KEYS) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'boolean') toggles[key] = value;
    }
    return Object.keys(toggles).length > 0 ? toggles : null;
  } catch {
    return null;
  }
}

export function saveExecToggles(toggles: ExecToggles): void {
  try {
    localStorage.setItem(EXEC_TOGGLES_KEY, JSON.stringify(toggles));
  } catch {
    /* storage full/blocked */
  }
}
