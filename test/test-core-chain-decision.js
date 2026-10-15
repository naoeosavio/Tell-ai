// Chain decision-payload tests — offline, pure helper, no server state.
// Proves `validate_chain_decision_payload` accepts exactly one identifier
// (`decisionId` or `approvalId`) plus `expectedVersion` and
// `decision: 'approve'|'skip'`, and rejects scripts, commands, paths and any
// extra field. Auth, rate limit, replay, idempotency, cancel and TOCTOU are
// server-side concerns covered by the Phase 6 chain-store/routes work.
// Run with: node --test test/test-core-chain-decision.js (after the core build).
const assert = require('node:assert');
const { describe, it } = require('node:test');

const core = require('../packages/core/dist/index.cjs');

describe('validate_chain_decision_payload accepts', () => {
  it('a decisionId approval', () => {
    assert.deepStrictEqual(
      core.validate_chain_decision_payload({ decisionId: 'd1', expectedVersion: 2, decision: 'approve' }),
      { ok: true, value: { decision_id: 'd1', expected_version: 2, decision: 'approve' } },
    );
  });

  it('an approvalId skip', () => {
    const result = core.validate_chain_decision_payload({ approvalId: 'a1', expectedVersion: 0, decision: 'skip' });
    assert.strictEqual(result.ok, true);
  });
});

describe('validate_chain_decision_payload rejects', () => {
  it('missing, doubled or blank identifiers', () => {
    for (const body of [
      { expectedVersion: 0, decision: 'approve' },
      { decisionId: 'd', approvalId: 'a', expectedVersion: 0, decision: 'approve' },
      { decisionId: '', expectedVersion: 0, decision: 'approve' },
    ]) {
      assert.strictEqual(core.validate_chain_decision_payload(body).ok, false);
    }
  });

  it('free scripts, commands, paths and any extra field', () => {
    const base = { decisionId: 'd', expectedVersion: 0, decision: 'approve' };
    for (const body of [
      { ...base, script: 'rm -rf /' },
      { ...base, command: 'id' },
      { ...base, path: '/etc/passwd' },
      { ...base, extra: true },
    ]) {
      const result = core.validate_chain_decision_payload(body);
      assert.strictEqual(result.ok, false);
    }
  });

  it('bad versions, bad verdicts and non-objects', () => {
    const base = { decisionId: 'd', decision: 'approve' };
    for (const body of [
      { ...base },
      { ...base, expectedVersion: -1 },
      { ...base, expectedVersion: 1.5 },
      { ...base, expectedVersion: '0' },
      { decisionId: 'd', expectedVersion: 0, decision: 'run' },
      { decisionId: 'd', expectedVersion: 0 },
      null,
      [],
      'approve',
    ]) {
      assert.strictEqual(core.validate_chain_decision_payload(body).ok, false);
    }
  });
});
