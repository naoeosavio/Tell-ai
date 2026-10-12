// Core paths tests — offline, real filesystem fixtures under the OS tmpdir.
// Proves realpath fail-closed behavior: symlinks, missing bases, sibling
// prefixes and external paths never resolve; write paths allow only a
// missing final segment with a canonical parent.
// Run with: node --test test/test-core-paths.js (after the core build).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const core = require('../packages/core/dist/index.cjs');

function make_base() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'core-paths-'));
  fs.writeFileSync(path.join(base, 'inside.txt'), 'hi');
  fs.mkdirSync(path.join(base, 'sub'));
  return base;
}

describe('canonical_path', () => {
  it('resolves files inside the base', () => {
    const base = make_base();
    assert.strictEqual(core.canonical_path(base, 'inside.txt'), fs.realpathSync(path.join(base, 'inside.txt')));
    assert.strictEqual(core.canonical_path(base, 'sub'), fs.realpathSync(path.join(base, 'sub')));
  });

  it('rejects traversal, absolute escapes and sibling prefixes', () => {
    const base = make_base();
    assert.strictEqual(core.canonical_path(base, '../outside.txt'), null);
    assert.strictEqual(core.canonical_path(base, '/etc/hostname'), null);
    assert.strictEqual(core.canonical_path(`${base}-sibling`, 'inside.txt'), null);
  });

  it('fails closed on symlinks, even when they point inside', () => {
    const base = make_base();
    fs.symlinkSync(path.join(base, 'inside.txt'), path.join(base, 'link-out.txt'));
    fs.symlinkSync(path.join(base, 'inside.txt'), path.join(base, 'sub', 'link-in.txt'));
    assert.strictEqual(core.canonical_path(base, 'link-out.txt'), null);
    assert.strictEqual(core.canonical_path(base, path.join('sub', 'link-in.txt')), null);
  });

  it('fails closed on missing bases and missing targets', () => {
    const base = make_base();
    assert.strictEqual(core.canonical_path(path.join(base, 'nope'), 'inside.txt'), null);
    assert.strictEqual(core.canonical_path(base, 'missing.txt'), null);
  });

  it('never resolves through a symlinked base', () => {
    // A symlinked anchor would move the whole base outside what the caller
    // validated, so the base itself must not be a link.
    const base = make_base();
    const outside = make_base();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    const linked = path.join(base, 'root-link');
    fs.symlinkSync(outside, linked, 'dir');
    assert.strictEqual(core.canonical_path(linked, 'secret.txt'), null);
    assert.strictEqual(core.canonical_write_path(linked, 'secret.txt'), null);
    assert.strictEqual(core.canonical_write_path(linked, 'new.txt'), null);
  });
});

describe('canonical_write_path', () => {
  it('allows a missing final segment with a canonical parent', () => {
    const base = make_base();
    assert.strictEqual(
      core.canonical_write_path(base, 'new.txt'),
      path.join(fs.realpathSync(base), 'new.txt'),
    );
  });

  it('rejects escapes, missing parents and symlink segments', () => {
    const base = make_base();
    assert.strictEqual(core.canonical_write_path(base, '../evil.txt'), null);
    assert.strictEqual(core.canonical_write_path(base, path.join('nope', 'new.txt')), null);
    assert.strictEqual(core.canonical_write_path(base, ''), null);
    fs.symlinkSync(path.join(base, 'sub'), path.join(base, 'linkdir'));
    assert.strictEqual(core.canonical_write_path(base, path.join('linkdir', 'new.txt')), null);
  });

  it('anchors the leaf to the first missing parent when create_parents is set', () => {
    const base = make_base();
    assert.strictEqual(
      core.canonical_write_path(base, path.join('.tell', 'history', 'a.json'), { create_parents: true }),
      path.join(fs.realpathSync(base), '.tell', 'history', 'a.json'),
    );
    // An existing symlink on the way still fails closed.
    fs.mkdirSync(path.join(base, 'real'));
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'linkdir'));
    assert.strictEqual(
      core.canonical_write_path(base, path.join('linkdir', 'child', 'new.txt'), { create_parents: true }),
      null,
    );
  });
});
