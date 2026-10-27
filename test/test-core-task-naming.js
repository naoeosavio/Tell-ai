// test-core-task-naming.js
//
// Task-mode naming contract seen through the core's public API: kebab names,
// the three-or-more-digit numbering (never reused), and reference resolution. The
// CLI and the Web server both call these helpers, so the numbering and the
// resume rule are pinned here once.
// Run with: node --test test/test-core-task-naming.js (after the core build).

const assert = require('node:assert');
const { describe, it } = require('node:test');

const core = require('../packages/core/dist/index.cjs');

describe('task naming: kebab names', () => {
  it('lowercases and turns separators into single dashes', () => {
    assert.strictEqual(core.to_task_name('Fix the Build'), 'fix-the-build');
    assert.strictEqual(core.to_task_name('  fix___the--build  '), 'fix-the-build');
    assert.strictEqual(core.to_task_name('web: parity / CLI'), 'web-parity-cli');
  });

  it('keeps letters, digits and dashes only', () => {
    assert.strictEqual(core.to_task_name('café_nação!'), 'caf-na-o');
    assert.strictEqual(core.to_task_name('a1-b2'), 'a1-b2');
  });

  it('prefixes a leading digit with n-', () => {
    assert.strictEqual(core.to_task_name('2fa login'), 'n-2fa-login');
    assert.strictEqual(core.to_task_name('007'), 'n-007');
  });

  it('returns an empty name when nothing usable remains', () => {
    assert.strictEqual(core.to_task_name(''), '');
    assert.strictEqual(core.to_task_name('---'), '');
    assert.strictEqual(core.to_task_name('!!!'), '');
  });

  it('caps the name at 50 characters and trims a trailing dash', () => {
    const name = core.to_task_name(`${'a'.repeat(49)} tail`);
    assert.strictEqual(name, 'a'.repeat(49));
    const exact = core.to_task_name('b'.repeat(50));
    assert.strictEqual(exact, 'b'.repeat(50));
  });

  it('normalizes a reference to the name it addresses', () => {
    assert.strictEqual(core.task_name_from_ref('task-007-fix-build'), 'fix-build');
    assert.strictEqual(core.task_name_from_ref('007-fix-build'), 'fix-build');
    assert.strictEqual(core.task_name_from_ref('fix-build'), 'fix-build');
  });
});

describe('task naming: numbering', () => {
  it('starts at 001', () => {
    assert.strictEqual(core.next_task_number([]), 1);
    assert.strictEqual(core.format_task_id(1, 'first'), 'task-001-first');
    assert.strictEqual(core.format_task_id(42, 'x'), 'task-042-x');
  });

  it('takes max + 1 and ignores non-task ids', () => {
    assert.strictEqual(core.next_task_number(['task-001-a', 'task-007-b', 'abc123.txt']), 8);
    assert.strictEqual(core.next_task_number(['abc123', 'deadbeef']), 1);
  });

  it('never renumbers or reuses a number', () => {
    const ids = ['task-001-a', 'task-002-b', 'task-003-c'];
    assert.strictEqual(core.resolve_task_id(null, 'c', ids).id, 'task-003-c');
    assert.strictEqual(core.resolve_task_id(null, 'new', ids).id, 'task-004-new');
  });

  it('recognizes only well-formed task ids', () => {
    assert.strictEqual(core.is_task_id('task-001-a'), true);
    assert.strictEqual(core.is_task_id('task-1-a'), false);
    assert.strictEqual(core.is_task_id('task-001-'), false);
    assert.strictEqual(core.is_task_id('task-001'), false);
  });
});

describe('task naming: reference resolution', () => {
  const ids = ['task-001-fix-build', 'task-002-web-parity', 'abc123'];

  it('matches the exact id, with or without the task- prefix and any case', () => {
    assert.strictEqual(core.find_task_id('task-001-fix-build', ids), 'task-001-fix-build');
    assert.strictEqual(core.find_task_id('001-fix-build', ids), 'task-001-fix-build');
    assert.strictEqual(core.find_task_id('TASK-001-FIX-BUILD', ids), 'task-001-fix-build');
    assert.strictEqual(core.find_task_id('nope', ids), null);
    assert.strictEqual(core.find_task_id('', ids), null);
  });

  it('resumes a saved task by reference', () => {
    assert.deepStrictEqual(core.resolve_task_id('001-fix-build', 'anything', ids), {
      id: 'task-001-fix-build',
      resumed: true,
    });
  });

  it('resumes a saved task by its name', () => {
    assert.deepStrictEqual(core.resolve_task_id(null, 'web-parity', ids), {
      id: 'task-002-web-parity',
      resumed: true,
    });
  });

  it('creates the next id when nothing matches', () => {
    assert.deepStrictEqual(core.resolve_task_id('009-missing', 'missing', ids), {
      id: 'task-003-missing',
      resumed: false,
    });
    assert.deepStrictEqual(core.resolve_task_id(null, 'new-name', ids), {
      id: 'task-003-new-name',
      resumed: false,
    });
  });
});

describe('task naming: numbers past 999', () => {
  it('recognizes four-digit task ids and keeps counting past them', () => {
    assert.strictEqual(core.is_task_id('task-1000-foo'), true);
    assert.strictEqual(core.format_task_id(1000, 'foo'), 'task-1000-foo');
    assert.strictEqual(core.next_task_number(['task-001-a', 'task-999-z']), 1000);
    assert.strictEqual(core.next_task_number(['task-001-a', 'task-999-z', 'task-1000-foo']), 1001);
    assert.strictEqual(core.next_task_number(['task-1000-foo']), 1001);
  });

  it('strips four-digit prefixes from references', () => {
    assert.strictEqual(core.task_name_from_ref('task-1000-foo'), 'foo');
    assert.strictEqual(core.task_name_from_ref('1000-foo'), 'foo');
  });

  it('resolves four-digit ids without allocating a new number', () => {
    const ids = ['task-1000-foo'];
    assert.deepStrictEqual(core.resolve_task_id('1000-foo', 'anything', ids), {
      id: 'task-1000-foo',
      resumed: true,
    });
    assert.deepStrictEqual(core.resolve_task_id(null, 'bar', ids), {
      id: 'task-1001-bar',
      resumed: false,
    });
  });
});
