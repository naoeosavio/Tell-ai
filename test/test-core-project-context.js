// Core project-context tests — offline, real fixtures under the OS tmpdir.
// Proves the bounded port of the Web context builder: depth, skip dirs,
// symlink guards, README/AGENTS lookup and doc caps — without any system
// prompt (the core never persists it).
// Run with: node --test test/test-core-project-context.js (after the core build).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const core = require('../packages/core/dist/index.cjs');

function make_project(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'core-context-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(cwd, name), content);
  }
  return cwd;
}

describe('build_project_context', () => {
  it('reports an empty project without docs', () => {
    const context = core.build_project_context(fs.mkdtempSync(path.join(os.tmpdir(), 'core-empty-')));
    assert.strictEqual(context.tree, '(empty project)');
    assert.strictEqual(context.readme, null);
    assert.strictEqual(context.agents, null);
  });

  it('lists sources, inlines README/AGENTS and skips denylisted dirs', () => {
    const cwd = make_project({ 'README.md': '# demo', 'AGENTS.md': 'be kind', 'main.ts': 'x' });
    fs.mkdirSync(path.join(cwd, 'node_modules'));
    fs.writeFileSync(path.join(cwd, 'node_modules', 'evil.js'), 'x');
    fs.mkdirSync(path.join(cwd, '.git'));
    const context = core.build_project_context(cwd);
    assert.match(context.tree, /main\.ts/);
    assert.match(context.tree, /README\.md/);
    assert.doesNotMatch(context.tree, /node_modules/);
    assert.doesNotMatch(context.tree, /\.git/);
    assert.strictEqual(context.readme, '# demo');
    assert.strictEqual(context.agents, 'be kind');
  });

  it('never follows symlinked directories', () => {
    const cwd = make_project({ 'real.txt': 'x' });
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'core-external-'));
    fs.writeFileSync(path.join(external, 'secret.txt'), 'x');
    fs.symlinkSync(external, path.join(cwd, 'linked'));
    const context = core.build_project_context(cwd);
    assert.doesNotMatch(context.tree, /linked/);
    assert.doesNotMatch(context.tree, /secret\.txt/);
  });

  it('caps oversized docs with a byte-total marker', () => {
    const cwd = make_project({ 'README.md': `x`.repeat(70 * 1024) });
    const context = core.build_project_context(cwd);
    assert.match(context.readme, /\[truncated \d+ bytes total\]/);
  });
});
