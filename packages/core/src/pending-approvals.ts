/**
 * Pending approvals for delegated children (browser-safe, no builtins).
 *
 * The core `ApprovalPort` already parks by returning a promise. What every
 * host reimplements is the lifecycle around the park: decision ids, idempotent
 * confirm (same id + same verdict replays), and fail-closed cancel. This helper
 * owns exactly that. Transport stays in the host: HTTP status, TTL sweeps,
 * rate limits and concurrency caps never move here.
 */

import type { ApprovalDecision, ApprovalPort } from './runtime-api';

/** Idempotent confirm outcome (replay never re-executes). */
export type PendingConfirmResult = { ok: true; replay: boolean } | { ok: false; reason: 'unknown' | 'conflict' };

/** Outstanding approval (for host TTL/debug surfaces). */
export type PendingApproval = {
  /** Stable decision id for this park. */
  decision_id: string;
  /** Script waiting for a verdict. */
  script: string;
};

/** Parking approval port with idempotent confirm (created by `create_pending_approvals`). */
export type PendingApprovals = {
  /** Parks one script until `confirm` (or `cancel_all`) resolves it. */
  approval: ApprovalPort;
  /** Outstanding parks (for host TTL/debug surfaces). */
  pending: () => PendingApproval[];
  /** Resolves one park; same id + same verdict replays. */
  confirm: (decision_id: string, verdict: ApprovalDecision) => PendingConfirmResult;
  /** Denies every outstanding park (TTL/cancel/restart, fail-closed). */
  cancel_all: () => void;
};

/** Options for `create_pending_approvals` (all optional). */
export type PendingApprovalsOptions = {
  /** Id factory (default `pending-N`; keeps the browser bundle global-free). */
  make_id?: (() => string) | undefined;
  /** Observer for a fresh park (host returns 202/asks from here). */
  on_request?: ((event: { decision_id: string; script: string }) => void) | undefined;
};

/**
 * Creates a parking approval port with idempotent confirm.
 *
 * Each call parks until `confirm` (or `cancel_all`) resolves it. Confirming an
 * unknown id is `unknown`; confirming a decided id with another verdict is
 * `conflict`; the same verdict replays without touching the waiter.
 *
 * @param options - Optional id factory and request observer.
 * @returns The parking approval plus its lifecycle.
 */
export function create_pending_approvals(options: PendingApprovalsOptions = {}): PendingApprovals {
  const make_id = options.make_id;
  const on_request = options.on_request;
  let counter = 0;
  const waiters = new Map<string, { script: string; resolve: (verdict: ApprovalDecision) => void }>();
  const decided = new Map<string, ApprovalDecision>();

  function next_id(): string {
    if (make_id !== undefined) {
      return make_id();
    } else {
      counter += 1;
      return `pending-${counter}`;
    }
  }

  async function approval(request: { script: string }): Promise<ApprovalDecision> {
    const decision_id = next_id();
    const parked = new Promise<ApprovalDecision>((resolve) => {
      waiters.set(decision_id, { script: request.script, resolve });
    });
    if (on_request !== undefined) {
      on_request({ decision_id, script: request.script });
    } else {
      // No observer — the host polls `pending()` instead.
    }
    return parked;
  }

  function pending(): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const [decision_id, waiter] of waiters) {
      out.push({ decision_id, script: waiter.script });
    }
    return out;
  }

  function confirm(decision_id: string, verdict: ApprovalDecision): PendingConfirmResult {
    const prior = decided.get(decision_id);
    if (prior !== undefined) {
      if (prior === verdict) {
        return { ok: true, replay: true };
      } else {
        return { ok: false, reason: 'conflict' };
      }
    } else {
      const waiter = waiters.get(decision_id);
      if (waiter === undefined) {
        return { ok: false, reason: 'unknown' };
      } else {
        waiters.delete(decision_id);
        decided.set(decision_id, verdict);
        waiter.resolve(verdict);
        return { ok: true, replay: false };
      }
    }
  }

  function cancel_all(): void {
    for (const [decision_id, waiter] of [...waiters]) {
      waiters.delete(decision_id);
      decided.set(decision_id, 'denied');
      waiter.resolve('denied');
    }
  }

  return { approval, pending, confirm, cancel_all };
}
