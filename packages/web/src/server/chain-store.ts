/**
 * Stateful server-side chain runs for `POST /api/chain`.
 *
 * Pure in-memory store (only `node:crypto`), deliberately dependency-light
 * like `guards.ts` so `test/test-web-backend.js` loads it directly. The
 * server keeps the pending script: confirm payloads carry only a
 * `decisionId`/`approvalId`, `expectedVersion` and `approve`|`skip` (validated
 * by `validate_chain_decision_payload` from `@tell-ai/core` before any
 * transition here runs). Same `decisionId` + same verdict replays the stored
 * result without re-executing; a concurrent different verdict is a 409;
 * cancel invalidates the pending approval; entries expire after a TTL and a
 * restart drops every run (fail-closed, never resumed blindly).
 */

import crypto from 'node:crypto';

/** How long an idle run survives before reads report it as unknown. */
export const CHAIN_TTL_MS = 15 * 60 * 1000;

/** Max model turns per run (mirrors the CLI/Web eight-round chain). */
export const CHAIN_MAX_ROUNDS = 8;

/** Run ids are server-generated UUIDs, never client-supplied paths. */
export const CHAIN_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Lifecycle of one chain run. `denied` is folded into `completed` events. */
export type ChainRunStatus = 'running' | 'awaiting_approval' | 'completed' | 'cancelled' | 'failed';

/** Observable event kinds kept per run (replay source for `GET /api/chain/:runId`). */
export type ChainEventType =
  | 'message'
  | 'approval_requested'
  | 'approved'
  | 'skipped'
  | 'denied'
  | 'executed'
  | 'failed'
  | 'cancelled'
  | 'completed'
  | 'error';

/** One sequenced fact inside a run (monotonic `seq`, never reused). */
export type ChainEvent = {
  seq: number;
  type: ChainEventType;
  at: string;
  text?: string;
  script?: string;
  output?: string;
  exitCode?: number;
  decisionId?: string;
};

/** Server-kept pending approval (the client never supplies the script). */
export type ChainPending = {
  decisionId: string;
  script: string;
  scriptHash: string;
  expectedVersion: number;
  createdAt: number;
};

/** Stored verdict for one decided approval (idempotency + conflict source). */
export type ChainVerdict = 'approve' | 'skip';

/** Chat turn kept inside the run (model context, server-side only). */
export type ChainMessage = {
  role: 'user' | 'assistant';
  content: string;
};

/** Public snapshot served by `GET /api/chain/:runId` (replay-friendly). */
export type ChainRunSnapshot = {
  runId: string;
  status: ChainRunStatus;
  version: number;
  rounds: number;
  text: string;
  events: ChainEvent[];
  pending: { decisionId: string; script: string; expectedVersion: number } | null;
};

/** Machine-readable reason for a rejected confirm transition. */
export type ChainConfirmError =
  | 'unknown_run'
  | 'run_cancelled'
  | 'no_pending_approval'
  | 'unknown_decision'
  | 'stale_version'
  | 'script_changed'
  | 'conflicting_decision'
  | 'decision_in_flight';

/** Outcome of the atomic confirm gate (runs before any execution). */
export type ChainConfirmGate =
  | { ok: true; script: string }
  | { ok: true; idempotent: true; snapshot: ChainRunSnapshot }
  | { ok: false; error: ChainConfirmError };

/** Options for `createChainStore` (all optional, test-injectable clock). */
export type ChainStoreOptions = {
  /** Idle TTL in ms (defaults to `CHAIN_TTL_MS`). */
  ttlMs?: number;
  /** Clock in ms (defaults to `Date.now`, injectable for TTL tests). */
  now?: () => number;
};

type DecidedEntry = {
  verdict: ChainVerdict;
  expectedVersion: number;
  inFlight: boolean;
  snapshot: ChainRunSnapshot | null;
};

type ChainRun = {
  runId: string;
  status: ChainRunStatus;
  version: number;
  rounds: number;
  text: string;
  messages: ChainMessage[];
  events: ChainEvent[];
  pending: ChainPending | null;
  decided: Record<string, DecidedEntry>;
  createdAt: number;
  updatedAt: number;
};

/**
 * Hashes a pending script (TOCTOU guard: the hash at request time must match
 * the hash at confirm time, otherwise the run changed under the client).
 *
 * @param script - Server-kept pending script.
 * @returns Hex sha256 of the script.
 */
export function hashChainScript(script: string): string {
  return crypto.createHash('sha256').update(script, 'utf8').digest('hex');
}

/**
 * Creates an independent in-memory chain store (no globals, no singletons).
 *
 * @param options - Idle TTL and clock overrides (tests inject `now`).
 * @returns The store handle (create/get/transition/cancel/snapshot).
 */
export function createChainStore(options: ChainStoreOptions = {}): {
  createRun(messages: ChainMessage[]): ChainRunSnapshot;
  getRun(runId: string): ChainRunSnapshot | null;
  /** Internal turn context for the server loop (snapshots stay replay-only). */
  messagesOf(runId: string): Array<{ role: 'user' | 'assistant'; content: string }>;
  appendEvent(runId: string, event: Omit<ChainEvent, 'seq' | 'at'>): ChainEvent | null;
  pushMessage(runId: string, message: ChainMessage): boolean;
  setText(runId: string, text: string): boolean;
  countRound(runId: string): boolean;
  requestApproval(runId: string, script: string): ChainPending | null;
  tryBeginConfirm(
    runId: string,
    validated: { decision_id: string; expected_version: number; decision: ChainVerdict },
  ): ChainConfirmGate;
  finishConfirm(
    runId: string,
    decisionId: string,
    outcome: Omit<ChainEvent, 'seq' | 'at' | 'decisionId'> & { status: ChainRunStatus },
  ): ChainRunSnapshot | null;
  /**
   * Refreshes the stored idempotency snapshot after the post-confirm
   * continuation appended its own events (so a retry replays exactly what
   * the first confirm answered, never a stale prefix and never a re-run).
   */
  settleDecision(runId: string, decisionId: string): ChainRunSnapshot | null;
  completeRun(runId: string, text?: string): ChainRunSnapshot | null;
  failRun(runId: string, text: string): ChainRunSnapshot | null;
  cancelRun(runId: string): ChainRunSnapshot | null;
  size(): number;
} {
  const ttlMs = options.ttlMs ?? CHAIN_TTL_MS;
  const now = options.now ?? Date.now;
  const runs = new Map<string, ChainRun>();

  function isExpired(run: ChainRun, at: number): boolean {
    return at - run.updatedAt > ttlMs;
  }

  function takeSnapshot(run: ChainRun): ChainRunSnapshot {
    return {
      runId: run.runId,
      status: run.status,
      version: run.version,
      rounds: run.rounds,
      text: run.text,
      events: run.events.map((event) => ({ ...event })),
      pending: run.pending
        ? {
            decisionId: run.pending.decisionId,
            script: run.pending.script,
            expectedVersion: run.pending.expectedVersion,
          }
        : null,
    };
  }

  function live(runId: string): ChainRun | null {
    if (!CHAIN_RUN_ID_PATTERN.test(runId)) {
      return null;
    } else {
      const run = runs.get(runId);
      if (run === undefined) {
        return null;
      } else if (isExpired(run, now())) {
        runs.delete(runId);
        return null;
      } else {
        return run;
      }
    }
  }

  function stamp(run: ChainRun, event: Omit<ChainEvent, 'seq' | 'at'>): ChainEvent {
    const stamped: ChainEvent = {
      ...event,
      seq: run.events.length,
      at: new Date(now()).toISOString(),
    };
    run.events.push(stamped);
    run.version += 1;
    run.updatedAt = now();
    return { ...stamped };
  }

  return {
    createRun(messages: ChainMessage[]): ChainRunSnapshot {
      const at = now();
      const run: ChainRun = {
        runId: crypto.randomUUID(),
        status: 'running',
        version: 0,
        rounds: 0,
        text: '',
        messages: messages.map((message) => ({ ...message })),
        events: [],
        pending: null,
        decided: {},
        createdAt: at,
        updatedAt: at,
      };
      runs.set(run.runId, run);
      return takeSnapshot(run);
    },

    getRun(runId: string): ChainRunSnapshot | null {
      const run = live(runId);
      if (run === null) {
        return null;
      } else {
        return takeSnapshot(run);
      }
    },

    messagesOf(runId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
      const run = live(runId);
      if (run === null) {
        return [];
      } else {
        return run.messages.map((message) => ({ ...message }));
      }
    },

    appendEvent(runId: string, event: Omit<ChainEvent, 'seq' | 'at'>): ChainEvent | null {
      const run = live(runId);
      if (run === null) {
        return null;
      } else {
        return stamp(run, event);
      }
    },

    pushMessage(runId: string, message: ChainMessage): boolean {
      const run = live(runId);
      if (run === null) {
        return false;
      } else {
        run.messages.push({ ...message });
        run.updatedAt = now();
        return true;
      }
    },

    setText(runId: string, text: string): boolean {
      const run = live(runId);
      if (run === null) {
        return false;
      } else {
        run.text = text;
        run.updatedAt = now();
        return true;
      }
    },

    countRound(runId: string): boolean {
      const run = live(runId);
      if (run === null) {
        return false;
      } else {
        run.rounds += 1;
        run.updatedAt = now();
        return true;
      }
    },

    requestApproval(runId: string, script: string): ChainPending | null {
      const run = live(runId);
      if (run === null || run.status !== 'running' || run.pending !== null) {
        return null;
      } else {
        stamp(run, { type: 'approval_requested', script });
        const pending: ChainPending = {
          decisionId: crypto.randomUUID(),
          script,
          scriptHash: hashChainScript(script),
          expectedVersion: run.version,
          createdAt: now(),
        };
        run.pending = pending;
        run.status = 'awaiting_approval';
        run.updatedAt = now();
        return { ...pending };
      }
    },

    tryBeginConfirm(
      runId: string,
      validated: { decision_id: string; expected_version: number; decision: ChainVerdict },
    ): ChainConfirmGate {
      const run = live(runId);
      if (run === null) {
        return { ok: false, error: 'unknown_run' };
      } else if (run.status === 'cancelled') {
        return { ok: false, error: 'run_cancelled' };
      } else {
        const previous = run.decided[validated.decision_id];
        if (previous !== undefined) {
          if (previous.inFlight) {
            return { ok: false, error: 'decision_in_flight' };
          } else if (previous.verdict !== validated.decision) {
            return { ok: false, error: 'conflicting_decision' };
          } else if (previous.snapshot === null) {
            return { ok: false, error: 'conflicting_decision' };
          } else {
            return { ok: true, idempotent: true, snapshot: previous.snapshot };
          }
        } else {
          const pending = run.pending;
          if (pending === null || run.status !== 'awaiting_approval') {
            return { ok: false, error: 'no_pending_approval' };
          } else if (pending.decisionId !== validated.decision_id) {
            return { ok: false, error: 'unknown_decision' };
          } else if (
            pending.expectedVersion !== validated.expected_version ||
            run.version !== validated.expected_version
          ) {
            return { ok: false, error: 'stale_version' };
          } else if (pending.scriptHash !== hashChainScript(pending.script)) {
            return { ok: false, error: 'script_changed' };
          } else {
            run.decided[validated.decision_id] = {
              verdict: validated.decision,
              expectedVersion: validated.expected_version,
              inFlight: true,
              snapshot: null,
            };
            run.updatedAt = now();
            return { ok: true, script: pending.script };
          }
        }
      }
    },

    finishConfirm(
      runId: string,
      decisionId: string,
      outcome: Omit<ChainEvent, 'seq' | 'at' | 'decisionId'> & { status: ChainRunStatus },
    ): ChainRunSnapshot | null {
      const run = live(runId);
      const entry = run?.decided[decisionId];
      if (run === undefined || run === null || entry === undefined || !entry.inFlight) {
        return null;
      } else {
        // A cancel that landed mid-flight wins: the outcome is recorded for
        // the audit trail, but a cancelled run never flips back to running.
        const wasCancelled = run.status === 'cancelled';
        stamp(run, { ...outcome, decisionId });
        if (run.pending?.decisionId === decisionId) {
          run.pending = null;
        } else {
          // Pending already moved on — keep the stored outcome only.
        }
        run.status = wasCancelled ? 'cancelled' : outcome.status;
        run.updatedAt = now();
        const snapshot = takeSnapshot(run);
        entry.inFlight = false;
        entry.snapshot = snapshot;
        return snapshot;
      }
    },

    settleDecision(runId: string, decisionId: string): ChainRunSnapshot | null {
      const run = live(runId);
      const entry = run?.decided[decisionId];
      if (run === undefined || run === null || entry === undefined || entry.inFlight) {
        return null;
      } else {
        const snapshot = takeSnapshot(run);
        entry.snapshot = snapshot;
        return snapshot;
      }
    },

    completeRun(runId: string, text?: string): ChainRunSnapshot | null {
      const run = live(runId);
      if (run === null) {
        return null;
      } else {
        if (text !== undefined) {
          run.text = text;
        } else {
          // Keep the last assistant text.
        }
        stamp(run, { type: 'completed' });
        run.status = 'completed';
        run.pending = null;
        run.updatedAt = now();
        return takeSnapshot(run);
      }
    },

    failRun(runId: string, text: string): ChainRunSnapshot | null {
      const run = live(runId);
      if (run === null) {
        return null;
      } else {
        run.text = text;
        stamp(run, { type: 'error', text });
        run.status = 'failed';
        run.pending = null;
        run.updatedAt = now();
        return takeSnapshot(run);
      }
    },

    cancelRun(runId: string): ChainRunSnapshot | null {
      const run = live(runId);
      if (run === null) {
        return null;
      } else if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        return takeSnapshot(run);
      } else {
        stamp(run, { type: 'cancelled' });
        run.status = 'cancelled';
        run.pending = null;
        run.updatedAt = now();
        return takeSnapshot(run);
      }
    },

    size(): number {
      return runs.size;
    },
  };
}
