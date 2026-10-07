// Core config tests — offline, no provider, no filesystem reads.
// Covers host defaults (CLI `g`, Web `l`), `flag > env > project > user`
// precedence, deny-wins for `exec_enabled`, timeout clamps, and the tellkey
// boundary (`TELL_KEY`/`TELL_BASE_URL` are never read here).
// Run with: node --test test/test-core-config.js (after the core build).
const assert = require('node:assert');
const { describe, it } = require('node:test');

const core = require('../packages/core/dist/index.cjs');

describe('resolve_core_config defaults', () => {
  it('keeps per-host model defaults without a global value', () => {
    assert.strictEqual(core.resolve_core_config({ host: 'cli' }).model, 'g');
    assert.strictEqual(core.resolve_core_config({ host: 'web' }).model, 'l');
  });

  it('falls back to the host default on blank models', () => {
    assert.strictEqual(core.resolve_core_config({ host: 'cli', flag: { model: '  ' } }).model, 'g');
  });

  it('defaults to exec enabled, no chain and the base timeout', () => {
    const config = core.resolve_core_config({ host: 'cli' });
    assert.strictEqual(config.exec_enabled, true);
    assert.strictEqual(config.chain, false);
    assert.strictEqual(config.exec_timeout_ms, core.DEFAULT_EXEC_TIMEOUT_MS);
  });
});

describe('resolve_core_config precedence', () => {
  it('resolves flag > env > project > user > default', () => {
    const input = { host: 'cli', flag: {}, env: {}, project: {}, user: { model: 'u' } };
    assert.strictEqual(core.resolve_core_config(input).model, 'u');
    assert.strictEqual(core.resolve_core_config({ ...input, project: { model: 'p' } }).model, 'p');
    assert.strictEqual(core.resolve_core_config({ ...input, project: { model: 'p' }, env: { model: 'e' } }).model, 'e');
    const full = { ...input, project: { model: 'p' }, env: { model: 'e' }, flag: { model: 'f' } };
    assert.strictEqual(core.resolve_core_config(full).model, 'f');
  });

  it('lets the most restrictive deny win across every layer', () => {
    const allowed = { host: 'cli', flag: { exec_enabled: true }, user: { exec_enabled: true } };
    assert.strictEqual(core.resolve_core_config(allowed).exec_enabled, true);
    const denied = { ...allowed, project: { exec_enabled: false } };
    assert.strictEqual(core.resolve_core_config(denied).exec_enabled, false);
  });

  it('clamps timeouts and falls back on garbage', () => {
    assert.strictEqual(core.resolve_core_config({ host: 'cli', flag: { exec_timeout_ms: 1 } }).exec_timeout_ms, 1_000);
    assert.strictEqual(
      core.resolve_core_config({ host: 'cli', flag: { exec_timeout_ms: 9_999_999 } }).exec_timeout_ms,
      600_000,
    );
    assert.strictEqual(
      core.resolve_core_config({ host: 'cli', flag: { exec_timeout_ms: Number.NaN } }).exec_timeout_ms,
      core.DEFAULT_EXEC_TIMEOUT_MS,
    );
  });
});

describe('load_env_layer', () => {
  it('honors TELL_MODEL only when non-blank', () => {
    assert.deepStrictEqual(core.load_env_layer({}), {});
    assert.deepStrictEqual(core.load_env_layer({ TELL_MODEL: '  ' }), {});
    assert.deepStrictEqual(core.load_env_layer({ TELL_MODEL: ' l ' }), { model: 'l' });
  });

  it('never reads TELL_KEY or TELL_BASE_URL (tellkey handoff owns them)', () => {
    const layer = core.load_env_layer({ TELL_KEY: 'sk-secret', TELL_BASE_URL: 'https://x.example' });
    assert.deepStrictEqual(layer, {});
  });
});
