// Core loop-feedback tests — offline, pure strings.
// Proves one owner for the command-feedback protocol: the record wording, the
// round feedback (preamble + continuation) and the parser, plus a round-trip
// format → parse for every variant the hosts emit.
// Run with: node --test test/test-core-loop-feedback.js (after the core build).
const assert = require('node:assert');
const { describe, it } = require('node:test');

const core = require('../packages/core/dist/index.cjs');

describe('format_command_result', () => {
  it('reports an executed command with its output', () => {
    assert.strictEqual(
      core.format_command_result('ls -la', 'total 0', 0),
      'Executed command:\nls -la\nOutput:\ntotal 0',
    );
  });

  it('reports a failed command with its exit code', () => {
    assert.strictEqual(
      core.format_command_result('ls missing', 'no such file', 2),
      'Command failed (exit code 2):\nls missing\nOutput:\nno such file',
    );
  });

  it('drops the exit code when no status is known', () => {
    assert.strictEqual(
      core.format_command_result('ls', 'spawn failed', null),
      'Command failed:\nls\nOutput:\nspawn failed',
    );
  });

  it('keeps the executed wording available on its own', () => {
    assert.strictEqual(core.format_executed_command('ls', 'out'), 'Executed command:\nls\nOutput:\nout');
    assert.strictEqual(core.format_failed_command('ls', 'out', 3), 'Command failed (exit code 3):\nls\nOutput:\nout');
    assert.strictEqual(core.format_failed_command('ls', 'out', null), 'Command failed:\nls\nOutput:\nout');
  });

  it('is byte-identical to what the core loop feeds back', () => {
    const with_instruction = core.format_command_feedback('ls', 'out', 0, { with_instruction: true });
    assert.strictEqual(
      with_instruction,
      `Executed command:\nls\nOutput:\nout\n\n${core.COMMAND_FEEDBACK_INSTRUCTION}`,
    );
    assert.strictEqual(
      core.format_command_feedback('ls', 'boom', 2, { with_instruction: true }),
      `${core.COMMAND_FEEDBACK_FAILED_PREAMBLE}\n\nCommand failed (exit code 2):\nls\nOutput:\nboom\n\n${core.COMMAND_FEEDBACK_INSTRUCTION}`,
    );
  });
});

describe('format_denied_feedback', () => {
  it('names the denial reason and leaves skipped unchanged', () => {
    assert.strictEqual(
      core.format_denied_feedback('bash <(ls)', 'shell-process-substitution'),
      `Command denied:\nbash <(ls)\nReason: shell-process-substitution\n\n${core.COMMAND_DENIED_PREAMBLE}\n${core.COMMAND_DENIED_INSTRUCTION}`,
    );
    assert.ok(!core.format_denied_feedback('bash <(ls)').includes('Reason:'), 'no reason, no line');
    assert.strictEqual(core.format_command_skipped('bash <(ls)'), 'Skipped by user:\nbash <(ls)');
  });
});

describe('format_command_skipped', () => {
  it('reports a user-declined command', () => {
    assert.strictEqual(core.format_command_skipped('rm -rf build'), 'Skipped by user:\nrm -rf build');
  });
});

describe('parse_command_feedback', () => {
  it('splits an executed record into script and raw output', () => {
    assert.deepStrictEqual(core.parse_command_feedback('Executed command:\nls\nOutput:\na\nb'), {
      kind: 'executed',
      script: 'ls',
      output: 'a\nb',
      exit_code: 0,
    });
  });

  it('reads a failed record with and without an exit code', () => {
    assert.deepStrictEqual(core.parse_command_feedback('Command failed (exit code 7):\nls\nOutput:\nboom'), {
      kind: 'failed',
      script: 'ls',
      output: 'boom',
      exit_code: 7,
    });
    assert.deepStrictEqual(core.parse_command_feedback('Command failed:\nls\nOutput:\nboom'), {
      kind: 'failed',
      script: 'ls',
      output: 'boom',
      exit_code: null,
    });
  });

  it('reads a skipped record with no output', () => {
    assert.deepStrictEqual(core.parse_command_feedback('Skipped by user:\nls'), {
      kind: 'skipped',
      script: 'ls',
      output: '',
      exit_code: null,
    });
  });

  it('strips the round preamble and the continuation line', () => {
    const text = core.format_command_feedback('ls', 'boom', 2, { with_instruction: true });
    const parsed = core.parse_command_feedback(text);
    assert.strictEqual(parsed.kind, 'failed');
    assert.strictEqual(parsed.script, 'ls');
    assert.strictEqual(parsed.output, 'boom');
    assert.strictEqual(parsed.exit_code, 2);
  });

  it('tolerates a record with no output separator', () => {
    assert.deepStrictEqual(core.parse_command_feedback('Executed command:\nls'), {
      kind: 'executed',
      script: 'ls',
      output: '',
      exit_code: 0,
    });
  });

  it('returns null for anything that is not feedback', () => {
    for (const text of ['', 'hello', 'User:\nls', 'Executed commands list', 'Output:\nls']) {
      assert.strictEqual(core.parse_command_feedback(text), null, `must reject ${JSON.stringify(text)}`);
    }
  });
});

describe('command feedback round-trip', () => {
  it('parses back every record the hosts emit', () => {
    const records = [
      core.format_executed_command('ls -la', 'total 0'),
      core.format_command_skipped('rm -rf build'),
      core.format_failed_command('ls missing', 'no such file', 2),
      core.format_failed_command('ls', 'spawn failed', null),
      core.format_command_feedback('echo hi', 'hi', 0, { with_instruction: true }),
      core.format_command_feedback('false', 'boom', 1, { with_instruction: true }),
    ];
    for (const record of records) {
      assert.notStrictEqual(core.parse_command_feedback(record), null, `must parse ${JSON.stringify(record)}`);
    }
    const skipped = core.parse_command_feedback(records[1]);
    assert.strictEqual(skipped.script, 'rm -rf build');
    const missing = core.parse_command_feedback(records[2]);
    assert.strictEqual(missing.exit_code, 2);
    const no_status = core.parse_command_feedback(records[3]);
    assert.strictEqual(no_status.exit_code, null);
  });

  it('keeps the instruction as an alias of the loop constant', () => {
    assert.strictEqual(core.CONTINUE_INSTRUCTION, core.COMMAND_FEEDBACK_INSTRUCTION);
  });

  it('owns every record header the runtime timeline can emit', () => {
    assert.strictEqual(core.EXECUTED_HEADER, 'Executed command:');
    assert.strictEqual(core.SKIPPED_HEADER, 'Skipped by user:');
    assert.strictEqual(core.CANCELLED_HEADER, 'Command cancelled:');
    assert.strictEqual(core.OUTPUT_SEPARATOR, '\nOutput:\n');
    const cancelled = core.format_cancelled_command('sleep 10');
    assert.strictEqual(cancelled, `Command cancelled:\nsleep 10`);
    const parsed_cancelled = core.parse_command_feedback(cancelled);
    if (parsed_cancelled === null) {
      assert.fail('a cancelled record must stay recognizable as feedback');
    } else {
      assert.strictEqual(parsed_cancelled.script, 'sleep 10');
    }
  });
});

describe('split_context_turns over a runtime timeline', () => {
  it('never merges two command records into one turn', () => {
    const timeline = [
      core.format_executed_command('ls -la', 'total 0'),
      core.format_executed_command('whoami', 'root'),
      core.format_cancelled_command('sleep 10'),
      core.format_failed_command('false', 'boom', 2),
      core.format_command_skipped('rm -rf build'),
      'Command execution disabled — not run.',
    ].join('\n\n');
    const turns = core.split_context_turns(timeline);
    assert.strictEqual(turns.length, 6, `one turn per record, got ${turns.length}`);
  });
});
