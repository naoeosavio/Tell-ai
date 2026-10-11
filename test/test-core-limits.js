// test-core-limits.js
//
// The runtime-limits contract seen through the core's public API — this
// module is the single owner of every limit value (defaults, ranges,
// precedence, turn-atomic truncation). Covers the contract itself, the
// public aliases kept for the port API, and guards that no host restates a
// limit literal of its own.
// Run with: node --test test/test-core-limits.js (after the core build).

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const core = require('../packages/core/dist/index.cjs');

const REPO = path.join(__dirname, '..');
const source = (relative) => fs.readFileSync(path.join(REPO, relative), 'utf8');

describe('runtime limits: defaults preserve the CLI baseline', () => {
  it('keeps 64 Ki context, 30 s/1 Mi stdin, 120 s exec, 8 rounds, 32 Mi buffer, 200 Ki output', () => {
    assert.strictEqual(core.DEFAULT_CONTEXT_MAX_CHARS, 64 * 1024);
    assert.strictEqual(core.DEFAULT_STDIN_TIMEOUT_MS, 30_000);
    assert.strictEqual(core.DEFAULT_STDIN_MAX_BYTES, 1_048_576);
    assert.strictEqual(core.DEFAULT_EXEC_TIMEOUT_MS, 120_000);
    assert.strictEqual(core.DEFAULT_MAX_CHAIN_STEPS, 8);
    assert.strictEqual(core.MAX_CHAIN_STEPS, 128);
    assert.strictEqual(core.DEFAULT_MAX_BUFFER_BYTES, 32 * 1024 * 1024);
    assert.strictEqual(core.DEFAULT_OUTPUT_MAX_BYTES, 204_800);
  });

  it('resolves the same defaults with no layers at all', () => {
    const limits = core.parse_runtime_limits();
    assert.strictEqual(limits.context_max_chars, core.DEFAULT_CONTEXT_MAX_CHARS);
    assert.strictEqual(limits.stdin_timeout_ms, core.DEFAULT_STDIN_TIMEOUT_MS);
    assert.strictEqual(limits.stdin_max_bytes, core.DEFAULT_STDIN_MAX_BYTES);
    assert.strictEqual(limits.exec_timeout_ms, core.DEFAULT_EXEC_TIMEOUT_MS);
    assert.strictEqual(limits.max_chain_steps, core.DEFAULT_MAX_CHAIN_STEPS);
    assert.strictEqual(limits.max_buffer_bytes, core.DEFAULT_MAX_BUFFER_BYTES);
    assert.strictEqual(limits.output_max_bytes, core.DEFAULT_OUTPUT_MAX_BYTES);
  });
});

describe('runtime limits: precedence flag > env > project > user > default', () => {
  it('lets every layer win in turn', () => {
    const layers = (winner) => ({
      flags: { max_chain_steps: winner === 'flag' ? 3 : undefined },
      env: { TELL_MAX_CHAIN_STEPS: winner === 'env' ? '5' : undefined },
      project: { source: 'proj', limits: { max_chain_steps: winner === 'project' ? 6 : undefined } },
      user: { source: 'user', limits: { max_chain_steps: winner === 'user' ? 7 : undefined } },
    });
    assert.strictEqual(core.parse_runtime_limits(layers('flag')).max_chain_steps, 3);
    assert.strictEqual(core.parse_runtime_limits(layers('env')).max_chain_steps, 5);
    assert.strictEqual(core.parse_runtime_limits(layers('project')).max_chain_steps, 6);
    assert.strictEqual(core.parse_runtime_limits(layers('user')).max_chain_steps, 7);
    assert.strictEqual(core.parse_runtime_limits(layers('default')).max_chain_steps, 8);
  });

  it('treats no-stdin-timeout as zero and keeps every other limit untouched', () => {
    const limits = core.parse_runtime_limits({ flags: { no_stdin_timeout: true, stdin_max_bytes: '2048' } });
    assert.strictEqual(limits.stdin_timeout_ms, 0);
    assert.strictEqual(limits.stdin_max_bytes, 2048);
  });
});

describe('runtime limits: validation fails loudly with the host status', () => {
  it('rejects an out-of-range flag with EXIT_CONFIG_ERROR', () => {
    assert.throws(
      () => core.parse_runtime_limits({ flags: { max_chain_steps: '129' } }),
      (error) => {
        assert.ok(error instanceof core.RuntimeLimitError);
        assert.strictEqual(error.exit_code, core.EXIT_CONFIG_ERROR);
        assert.strictEqual(error.limit, 'max_chain_steps');
        assert.strictEqual(error.source, 'flag');
        return true;
      },
    );
  });

  it('rejects a non-integer env value and names the variable', () => {
    assert.throws(
      () => core.parse_runtime_limits({ env: { TELL_EXEC_TIMEOUT_MS: '1' } }),
      (error) => {
        assert.strictEqual(error.source, 'env:TELL_EXEC_TIMEOUT_MS');
        return true;
      },
    );
  });

  it('names the tellrc file that carried the bad value', () => {
    assert.throws(
      () => core.parse_runtime_limits({ project: { source: '/repo/.tellrc', limits: { context_chars: 5 } } }),
      (error) => {
        assert.strictEqual(error.source, '/repo/.tellrc');
        return true;
      },
    );
  });

  it('exposes the exec timeout clamp read from the spec table', () => {
    assert.strictEqual(core.MIN_EXEC_TIMEOUT_MS, 1000);
    assert.strictEqual(core.MAX_EXEC_TIMEOUT_MS, 600_000);
  });
});

describe('runtime limits: tellrc schema is published, not reimplemented', () => {
  it('publishes every tellrc limit key, including the three the CLI never accepted', () => {
    assert.deepStrictEqual(core.TELLRC_LIMIT_KEYS.slice().sort(), [
      'context_chars',
      'exec_timeout_ms',
      'max_buffer_bytes',
      'max_chain_steps',
      'output_max_bytes',
      'stdin_max_bytes',
      'stdin_timeout_ms',
    ]);
  });

  it('validates a tellrc value against the same range, without throwing', () => {
    assert.strictEqual(core.validate_tellrc_limit_value('max_chain_steps', 99), 99);
    assert.strictEqual(core.validate_tellrc_limit_value('stdin_timeout_ms', 0), 0);
    assert.strictEqual(core.validate_tellrc_limit_value('max_chain_steps', 129), undefined);
    assert.strictEqual(core.validate_tellrc_limit_value('exec_timeout_ms', 'nope'), undefined);
    assert.strictEqual(core.validate_tellrc_limit_value('not_a_limit', 1), undefined);
  });
});

describe('runtime limits: execution options handed to the injected executor', () => {
  it('maps timeout, caps and rounds without creating an executor', () => {
    const options = core.build_execution_options({
      context_max_chars: 8192,
      stdin_timeout_ms: 1000,
      stdin_max_bytes: 2048,
      exec_timeout_ms: 5000,
      max_chain_steps: 3,
      max_buffer_bytes: 4096,
      output_max_bytes: 1024,
    });
    assert.deepStrictEqual(options, {
      timeout_ms: 5000,
      max_output_bytes: 1024,
      max_buffer_bytes: 4096,
      max_rounds: 3,
    });
  });
});

describe('runtime limits: turn-atomic context truncation', () => {
  it('drops whole old turns with an explicit marker and never splits one', () => {
    const turns = [];
    for (let index = 0; index < 40; index += 1) {
      turns.push(`User:\nmensagem ${index} ${'x'.repeat(200)}`);
      // Every third assistant turn carries a full RUN block.
      turns.push(`Assistant:\nresposta ${index}\n${index % 3 === 0 ? '<RUN>ls -la</RUN>' : ''}${'y'.repeat(200)}`);
    }
    const out = core.truncate_context(turns.join('\n'), 4096);
    assert.ok(out.startsWith(core.CONTEXT_TRUNCATE_MARKER));
    assert.ok(out.length <= 4096);
    // Kept turns are complete: markers stay balanced and the text starts on a
    // boundary line (no half line carried over from a dropped turn).
    assert.ok(core.has_balanced_tags(out));
    const kept = out.slice(core.CONTEXT_TRUNCATE_MARKER.length + 1).split('\n');
    assert.ok(/^(User:|Assistant:)$/.test(kept[0]), 'first kept line must start a turn');
    assert.ok(!/<RUN>[^<]*$/.test(out), 'no half-opened RUN block may survive');
    assert.ok(!/<think>[^<]*$/.test(out), 'no half-opened think block may survive');
  });

  it('keeps balanced RUN blocks and never leaves a dangling opener', () => {
    const text = `${'z'.repeat(3000)}\nUser:\n<think>x</think>\n<run>ls</run>`;
    const out = core.truncate_context(text, 1200);
    assert.ok(core.has_balanced_tags(out));
  });

  it('caps delivered output by bytes with a marker', () => {
    const out = core.truncate_output('q'.repeat(1000), 200);
    assert.ok(Buffer.byteLength(out, 'utf8') <= 200);
    assert.ok(out.includes(core.OUTPUT_TRUNCATE_MARKER_PREFIX));
  });

  it('returns the input untouched when it fits', () => {
    assert.strictEqual(core.truncate_context('User:\ncurto', 4096), 'User:\ncurto');
    assert.strictEqual(core.truncate_output('curto', 200), 'curto');
  });
});

describe('runtime limits: env keys are published, never read here', () => {
  it('publishes exactly the seven TELL_* limit keys', () => {
    assert.deepStrictEqual(core.TELL_LIMIT_ENV_KEYS.slice().sort(), [
      'TELL_CONTEXT_MAX_CHARS',
      'TELL_EXEC_TIMEOUT_MS',
      'TELL_MAX_BUFFER_BYTES',
      'TELL_MAX_CHAIN_STEPS',
      'TELL_OUTPUT_MAX_BYTES',
      'TELL_STDIN_MAX_BYTES',
      'TELL_STDIN_TIMEOUT_MS',
    ]);
  });

  it('never binds process.env itself (reading is host-side)', () => {
    // The CLI needs the reader inside vm sandboxes with a fake `process`, so
    // the owner exports key names only.
    assert.strictEqual(core.runtime_env_from_process, undefined);
  });

  it('still validates an env layer passed by the host', () => {
    const limits = core.parse_runtime_limits({ env: { TELL_MAX_CHAIN_STEPS: '4' } });
    assert.strictEqual(limits.max_chain_steps, 4);
  });
});

describe('runtime limits: public aliases stay equal to the owner', () => {
  it('exec/loop/runtime defaults are the same values, not copies', () => {
    assert.strictEqual(core.EXEC_DEFAULT_TIMEOUT_MS, core.DEFAULT_EXEC_TIMEOUT_MS);
    assert.strictEqual(core.EXEC_MAX_OUTPUT_BYTES, core.DEFAULT_MAX_BUFFER_BYTES);
    assert.strictEqual(core.CORE_MAX_OUTPUT_BYTES, core.DEFAULT_MAX_BUFFER_BYTES);
    assert.strictEqual(core.LOOP_MAX_ROUNDS, core.DEFAULT_MAX_CHAIN_STEPS);
  });
});

describe('runtime limits: no host restates a limit literal', () => {
  const forbidden = [
    ['120_000', 'exec timeout'],
    ['32 * 1024 * 1024', '32 Mi buffer'],
    ['1_048_576', '1 Mi stdin'],
    ['204_800', '200 Ki output'],
  ];

  it('keeps the numbers inside core/runtime-limits.ts', () => {
    const owner = source('packages/core/src/runtime-limits.ts');
    for (const [literal] of forbidden) {
      assert.ok(owner.includes(literal), `owner must declare ${literal}`);
    }
  });

  it('leaves the rest of the core importing the owner', () => {
    for (const file of ['exec.ts', 'runtime.ts', 'runtime-api.ts', 'config.ts']) {
      const text = source(`packages/core/src/${file}`);
      for (const [literal] of forbidden) {
        assert.ok(!text.includes(literal), `${file} must not restate ${literal}`);
      }
      assert.ok(!/LOOP_MAX_ROUNDS\s*=\s*8\b/.test(text), `${file} must not pin the round cap`);
    }
  });

  it('leaves the web server and its parser importing the owner', () => {
    for (const file of ['packages/web/src/server/server.ts', 'packages/web/src/server/cli-args.ts']) {
      const text = source(file);
      assert.ok(!text.includes('120_000'), `${file} must not restate the exec timeout`);
      assert.ok(!text.includes('32 * 1024 * 1024'), `${file} must not restate the 32 Mi buffer`);
      assert.ok(!/Math\.max\(1_000/.test(text), `${file} must not restate the exec clamp`);
      assert.ok(!/Math\.min\(600_000/.test(text), `${file} must not restate the exec clamp`);
    }
  });

  it('leaves the CLI module a pure facade over the core owner', () => {
    const facade = source('packages/cli/src/runtime-limits.ts');
    for (const [literal] of forbidden) {
      assert.ok(!facade.includes(literal), `CLI facade must not restate ${literal}`);
    }
    assert.ok(facade.includes("from '@tell-ai/core'"), 'facade must re-export the core owner');
  });
});