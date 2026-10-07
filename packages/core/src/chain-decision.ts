/** Approval verdict carried by a chain confirm payload. */
export type ChainDecision = 'approve' | 'skip';

/** Validated chain confirm payload (identifiers only, never a script). */
export type ChainDecisionPayload = {
  /** The pending approval this decision answers (exactly one id kind). */
  decision_id: string;
  /** Monotonic version the client saw; transitions reject stale versions. */
  expected_version: number;
  /** The verdict: run the server-kept script, or skip it. */
  decision: ChainDecision;
};

/** Fail-closed validation result for a chain confirm payload. */
export type ChainDecisionValidation = { ok: true; value: ChainDecisionPayload } | { ok: false; error: string };

/** Payload keys the confirm endpoint accepts (identifiers, version, verdict). */
const ALLOWED_KEYS = new Set(['decisionId', 'approvalId', 'expectedVersion', 'decision']);

/**
 * Validates a `POST /api/chain/:runId/confirm` body, fail-closed.
 *
 * Accepts exactly one identifier (`decisionId` or `approvalId`), a numeric
 * `expectedVersion` and `decision: 'approve'|'skip'`. Any `script`, `command`
 * or `path` field — or any other extra field — is rejected: the client never
 * supplies free scripts, the server keeps the pending command. Auth, rate
 * limit, replay, idempotency and TOCTOU live server-side (Phase 6) on top of
 * this helper.
 *
 * @param body - Raw request body (unknown JSON).
 * @returns The validated payload, or an error reason when rejected.
 */
export function validate_chain_decision_payload(body: unknown): ChainDecisionValidation {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  } else {
    const record = body as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!ALLOWED_KEYS.has(key)) {
        return { ok: false, error: `unexpected field: ${key}` };
      } else {
      }
    }
    const decision_id = record['decisionId'];
    const approval_id = record['approvalId'];
    const has_decision_id = typeof decision_id === 'string' && decision_id !== '';
    const has_approval_id = typeof approval_id === 'string' && approval_id !== '';
    if (has_decision_id === has_approval_id) {
      return { ok: false, error: 'exactly one of decisionId or approvalId is required' };
    } else {
      const expected_version = record['expectedVersion'];
      if (typeof expected_version !== 'number' || !Number.isInteger(expected_version) || expected_version < 0) {
        return { ok: false, error: 'expectedVersion must be a non-negative integer' };
      } else {
        const decision = record['decision'];
        if (decision !== 'approve' && decision !== 'skip') {
          return { ok: false, error: "decision must be 'approve' or 'skip'" };
        } else {
          return {
            ok: true,
            value: {
              decision_id: has_decision_id ? (decision_id as string) : (approval_id as string),
              expected_version,
              decision,
            },
          };
        }
      }
    }
  }
}
