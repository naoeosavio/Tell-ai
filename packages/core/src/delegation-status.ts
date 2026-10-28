/**
 * Pure derivation of a delegation status (host-assigned, never model-set).
 *
 * Browser-safe (pure strings only): the browser entry re-exports this module
 * so the Web fallback loop derives the same status without the SDK growing
 * a second protocol.
 */

/** Lifecycle of one delegated child, assigned by the host. */
export type DelegationStatus = 'DONE' | 'IN PROGRESS' | 'BLOCKED';

/** Aggregate facts of a finished child run (host-observed, never model text). */
export type DelegationFacts = {
  /** How many model rounds the child ran. */
  rounds: number;
  /** How many commands the child requested (first script per round). */
  commands_requested: number;
  /** How many commands actually ran (`executed` + `failed`). */
  commands_run: number;
  /** How many commands were blocked (`denied` + `skipped` + `awaiting_approval` + `cancelled`). */
  denied: number;
  /** True when the round cap stopped the child with work pending. */
  hit_cap: boolean;
  /** True when the final answer is empty. */
  empty_answer: boolean;
};

/**
 * Derives the host status from the child facts.
 *
 * `BLOCKED` when commands were requested but none ran, or when the answer is
 * empty and nothing ran. `IN PROGRESS` when the round cap stopped the child
 * with work pending. `DONE` otherwise. `SUPERSEDED` stays reserved for v2.
 *
 * @param facts - Host-observed facts of the finished child.
 * @returns The delegation status.
 */
export function derive_delegation_status(facts: DelegationFacts): DelegationStatus {
  if (facts.commands_requested > 0 && facts.commands_run === 0) {
    return 'BLOCKED';
  } else if (facts.empty_answer && facts.commands_run === 0) {
    return 'BLOCKED';
  } else if (facts.hit_cap) {
    return 'IN PROGRESS';
  } else {
    return 'DONE';
  }
}
