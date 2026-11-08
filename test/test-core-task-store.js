// test-core-task-store.js
//
// Coverage for the Node-only task store (`packages/core/src/task-store.ts`):
// the prompt-hash name (D6), the directory-only id listing (F6), the
// no-prompt rule for a new task (F5), the atomic claim (F4) and the
// full-wipe reset with child records (F3). All disk work runs in a temp
// tree; no network, no model.
// Run with: node --test test/test-core-task-store.js (after the core build).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');

const core = require('../packages/core/dist/index.cjs');

function tmp_root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tell-task-store-'));
}

function write_child_record(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body === undefined ? 'child record content' : body, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/** Normalized task name of a `%ref` (the helper the hosts call directly on ref-only claims). */
function task_name_for_ref(reference) {
  return require('@tell-ai/core').task_name_from_ref(reference);
}

describe('task_name_from_prompt (D6)', () => {
  it('returns the first 8 hex characters of sha256(cwd + nl + prompt)', () => {
    const cwd = '/work/somewhere';
    const wanted = crypto.createHash('sha256').update(`${cwd}\ntell the build`).digest('hex').slice(0, 8);
    assert.strictEqual(core.task_name_from_prompt(cwd, 'tell the build'), wanted);
    assert.match(core.task_name_from_prompt(cwd, 'tell the build'), /^[0-9a-f]{8}$/);
  });

  it('differs per cwd and per prompt (the two hosts see the same id)', () => {
    const first = core.task_name_from_prompt('/work/a', 'fix');
    const second = core.task_name_from_prompt('/work/b', 'fix');
    const third = core.task_name_from_prompt('/work/a', 'fix it');
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first, third);
  });

  it('matches the hash both hosts computed before the move', () => {
    // The CLI used `createHash('sha256').update(`${process.cwd()}\n${prompt}`)`;
    // the Web used `${CWD}\n${task_prompt}` — byte-identical inputs.
    const prompt = 'obj one / obj two';
    const cwd = process.cwd();
    const legacy = crypto.createHash('sha256').update(`${cwd}\n${prompt}`).digest('hex').slice(0, 8);
    assert.strictEqual(core.task_name_from_prompt(cwd, prompt), legacy);
  });
});

describe('list_task_ids (F6)', () => {
  it('returns directories only — a task-named file never acts as an id', () => {
    const root = tmp_root();
    try {
      fs.mkdirSync(path.join(root, 'task-001-real'), { recursive: true });
      fs.writeFileSync(path.join(root, 'task-002-fake.txt'), 'a file, not a task', 'utf8');
      assert.deepStrictEqual(core.list_task_ids(root), ['task-001-real']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores non-task names and unreadable roots', () => {
    const root = tmp_root();
    try {
      fs.mkdirSync(path.join(root, 'task-003-ok'), { recursive: true });
      fs.mkdirSync(path.join(root, 'plain-dir'), { recursive: true });
      fs.writeFileSync(path.join(root, 'abc123.txt'), 'context file', 'utf8');
      assert.deepStrictEqual(core.list_task_ids(root), ['task-003-ok']);
      assert.deepStrictEqual(core.list_task_ids(path.join(root, 'missing')), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts a claimed directory without main.txt (a claim in flight)', () => {
    const root = tmp_root();
    try {
      fs.mkdirSync(path.join(root, 'task-001-claimed'), { recursive: true });
      assert.deepStrictEqual(core.list_task_ids(root), ['task-001-claimed']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolve_task_value (F5)', () => {
  const cwd = '/work/store-tests';

  it('rejects a new task without any prompt text', () => {
    const root = tmp_root();
    try {
      assert.throws(
        () => core.resolve_task_value('', '', cwd, root),
        /a new task needs an objective/,
      );
      assert.throws(
        () => core.resolve_task_value('%brand-new', '', cwd, root),
        /a new task needs an objective/,
      );
      // The failed resolution never leaves a directory behind.
      assert.deepStrictEqual(core.list_task_ids(root), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets a resume continue without a prompt', () => {
    const root = tmp_root();
    try {
      // Claim by ref name (`%alpha`); a later bare `%alpha` resumes it.
      const pointer = core.reserve_task_dir(root, 'alpha', task_name_for_ref('alpha'));
      core.init_task_context(pointer);
      const value = core.resolve_task_value('%alpha', '', '/work/store-tests', root, core.list_task_ids(root));
      assert.strictEqual(value.resumed, true);
      assert.strictEqual(value.id, pointer.id);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('splits the raw value: ref word first, prompt text after', () => {
    const root = tmp_root();
    try {
      fs.mkdirSync(path.join(root, 'task-001-alpha'), { recursive: true });
      const value = core.resolve_task_value(
        '%alpha run the checks',
        'with these notes',
        '/work/store-tests',
        root,
        core.list_task_ids(root),
      );
      assert.strictEqual(value.resumed, true);
      assert.strictEqual(value.task_prompt, 'run the checks with these notes');
      assert.strictEqual(value.reference, 'alpha');
      // A prompt-text-only value (bare flag, empty raw) hashes all of it.
      const unnamed = core.resolve_task_value('', 'step one', '/work/store-tests', root, core.list_task_ids(root));
      assert.strictEqual(unnamed.reference, null);
      assert.strictEqual(unnamed.task_prompt, 'step one');
      assert.strictEqual(unnamed.name, core.task_name_from_prompt('/work/store-tests', 'step one'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a value whose name normalizes to empty', () => {
    const root = tmp_root();
    try {
      assert.throws(
        () => core.resolve_task_value('%---', 'go', cwd, root),
        /Invalid task name/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('reserve_task_dir (F4)', () => {
  it('claims a new directory; a second claim with the same name resumes it', () => {
    const root = tmp_root();
    try {
      const first = core.reserve_task_dir(root, null, 'alpha-name');
      assert.strictEqual(first.resumed, false);
      assert.match(first.id, /^task-001-alpha-name$/);
      assert.strictEqual(first.dir, path.join(root, first.id));
      assert.strictEqual(first.file, path.join(root, first.id, 'main.txt'));
      // The claim created the anchor directory but never main.txt — the run
      // owns that file (A4: the CLI host writes it through its context plan).
      assert.strictEqual(fs.existsSync(first.file), false);
      assert.ok(fs.statSync(first.dir).isDirectory());

      const second = core.reserve_task_dir(root, null, 'alpha-name');
      assert.strictEqual(second.resumed, true);
      assert.strictEqual(second.id, first.id);
      // Different names keep claiming fresh numbers.
      assert.strictEqual(core.reserve_task_dir(root, null, 'beta-name').id, 'task-002-beta-name');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is atomic: a concurrent claim between listing and mkdir never shares an id', () => {
    const root = tmp_root();
    try {
      const real_mkdir = fs.mkdirSync;
      let hijacked = false;
      // Simulate the race of a concurrent process: when this run claims
      // `task-001-x`, the rival really claims it first and the mkdir dies
      // with EEXIST. The retry must re-resolve over the fresh listing and
      // land on the rival's directory (resumed), never a shared id.
      fs.mkdirSync = function patched(target, options) {
        if (hijacked === false && String(target).endsWith('task-001-x')) {
          hijacked = true;
          real_mkdir.call(fs, target, options);
          const deadlock = new Error('EEXIST: file already exists, mkdir');
          deadlock.code = 'EEXIST';
          deadlock.errno = -17;
          deadlock.syscall = 'mkdir';
          throw deadlock;
        }
        return real_mkdir.call(fs, target, options);
      };
      try {
        const pointer = core.reserve_task_dir(root, null, 'x');
        assert.strictEqual(pointer.resumed, true, 'the rival directory is resumed, never re-created');
        assert.strictEqual(pointer.id, 'task-001-x');
        const dirs = core.list_task_ids(root);
        assert.deepStrictEqual(dirs, ['task-001-x']);
      } finally {
        fs.mkdirSync = real_mkdir;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('claims with plain mkdir (recursive stays reserved for the context root)', () => {
    // F4 regression guard, source-level: a recursive claim would silently
    // reuse a taken directory, so only the root mkdir may say recursive.
    const src = fs.readFileSync(path.join(__dirname, '..', 'packages', 'core', 'src', 'task-store.ts'), 'utf8');
    const claim = src.match(/fs\.mkdirSync\(resolved\.dir[^;]*\)/);
    assert.ok(claim, 'the task claim mkdir exists');
    assert.ok(!claim[0].includes('recursive'), 'the task claim never mkdirs recursive');
    assert.ok(
      /mkdirSync\(context_dir, \{ recursive: true/.test(src),
      'the context root mkdir stays recursive',
    );  });
});

describe('read_task_context', () => {
  it('reads the saved text trimmed, empty when absent, capped on demand', () => {
    const root = tmp_root();
    try {
      const pointer = core.reserve_task_dir(root, null, 'reader');
      assert.strictEqual(core.read_task_context(pointer), '');
      fs.writeFileSync(pointer.file, '  saved line 1\nsaved line 2\n  ', 'utf8');
      assert.strictEqual(core.read_task_context(pointer), 'saved line 1\nsaved line 2');
      // The cap reuses the core `truncate_context` owner: marker first, then
      // the newest text that fits.
      fs.writeFileSync(pointer.file, 'x'.repeat(90), 'utf8');
      const capped = core.read_task_context(pointer, 40);
      assert.ok(capped.length <= 40, 'the char cap holds');
      assert.ok(capped.startsWith(core.CONTEXT_TRUNCATE_MARKER));
      assert.strictEqual(core.read_task_context(pointer, 5), '[olde', 'a cap below the marker keeps its prefix');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('init_task_context / wipe_task_dir / discard_unused_task (F3)', () => {
  it('seeds an empty main.txt after a claim', () => {
    const root = tmp_root();
    try {
      const pointer = core.reserve_task_dir(root, null, 'seeder');
      core.init_task_context(pointer);
      assert.strictEqual(fs.readFileSync(pointer.file, 'utf8'), '');
      assert.strictEqual(core.read_task_context(pointer), '');
      // A claimed-but-never-seeded task is released: discard removes it.
      const other = core.reserve_task_dir(root, null, 'other');
      assert.strictEqual(other.resumed, false);
      core.discard_unused_task(other);
      core.discard_unused_task(pointer);
      assert.deepStrictEqual(core.list_task_ids(root), ['task-001-seeder']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('wipes main.txt and every child record, keeps the dir and other files', () => {
    const root = tmp_root();
    try {
      const pointer = core.reserve_task_dir(root, null, 'wiper');
      core.init_task_context(pointer);
      fs.writeFileSync(pointer.file, 'old context', 'utf8');
      write_child_record(pointer.dir, 'delegate-001.txt');
      write_child_record(pointer.dir, 'delegate-002.txt');
      write_child_record(pointer.dir, 'subtask-001.txt');
      fs.writeFileSync(path.join(pointer.dir, 'notes.txt'), 'keep me', 'utf8');
      core.wipe_task_dir(pointer);
      assert.strictEqual(core.read_task_context(pointer), '');
      assert.ok(fs.existsSync(path.join(pointer.dir, 'notes.txt')), 'unrelated files stay');
      assert.ok(fs.readdirSync(pointer.dir).every((name) => !/^(delegate|subtask)-\d+\.txt$/.test(name)));
      assert.strictEqual(fs.statSync(pointer.dir).isDirectory(), true, 'the NNN anchor stays');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('releases a claimed directory when the run never persisted main.txt', () => {
    const root = tmp_root();
    try {
      // A fresh claim without main.txt is released on discard.
      const released = core.reserve_task_dir(root, null, 'released');
      assert.strictEqual(released.resumed, false);
      core.discard_unused_task(released);
      assert.deepStrictEqual(core.list_task_ids(root), []);
      // A persisted task (main.txt written) survives a discard call.
      const persisted = core.reserve_task_dir(root, null, 'released');
      assert.strictEqual(persisted.id, 'task-001-released');
      core.init_task_context(persisted);
      core.discard_unused_task(persisted);
      assert.deepStrictEqual(core.list_task_ids(root), ['task-001-released']);
      // A resumed pointer is never released.
      core.discard_unused_task({ ...persisted, resumed: true });
      assert.deepStrictEqual(core.list_task_ids(root), ['task-001-released']);
      // Discarding undefined is a no-op.
      core.discard_unused_task(undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
