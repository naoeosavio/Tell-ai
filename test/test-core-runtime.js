// Core/runtime contract conformance — offline, core package owns the
// contract now (moved from `@tell-ai/sdk`). Proves the factory, ports and
// single-turn wiring behave identically through the core root, and that the
// CLI binary entrypoint is untouched.
// Run with: node test/test-core-runtime.js (after the core build).
const assert = require('node:assert');
const fs = require('node:fs');
const { describe, it } = require('node:test');

const core = require('../packages/core/dist/index.cjs');

function mock_model(answer) {
  return {
    async ask() {
      return answer;
    },
  };
}

describe('core contract conformance', () => {
  it('exposes one factory on the core root with idempotent wiring', async () => {
    assert.strictEqual(typeof core.createTellRuntime, 'function');
    const options = { model: mock_model('same answer') };
    const [a, b] = await Promise.all([
      core.createTellRuntime(options).run('hi'),
      core.createTellRuntime(options).run('hi'),
    ]);
    assert.deepStrictEqual(a, b);
  });

  it('runs Node-shaped injected ports through one model call and one executor round', async () => {
    let model_calls = 0;
    let executor_calls = 0;
    const runtime = core.createTellRuntime({
      model: {
        async ask() {
          model_calls += 1;
          return 'first:\n<RUN>\necho one\n</RUN>\nsecond:\n<RUN>\necho two\n</RUN>';
        },
      },
      exec: true,
      executor: async () => {
        executor_calls += 1;
        return { stdout: 'one', stderr: '', exit_code: 0 };
      },
      approval: async () => 'approved',
    });
    const result = await runtime.run('hi');
    // Single-turn wiring: first script only, no chain loop in the SDK.
    assert.strictEqual(model_calls, 1);
    assert.strictEqual(executor_calls, 1);
    assert.strictEqual(result.commands.length, 1);
    assert.strictEqual(result.commands[0].script, 'echo one');
    assert.strictEqual(result.commands[0].status, 'executed');
    // A fresh preset mock proves the same ports fit any host (Node/Web).
    const plain = await core.createTellRuntime({ model: mock_model('plain answer') }).run('hi');
    assert.strictEqual(plain.status, 'completed');
  });

  it('keeps the moved runtime sources free of node imports and env reads', async () => {
    for (const file of ['packages/core/src/runtime-api.ts', 'packages/core/src/browser-runtime.ts']) {
      const source = fs.readFileSync(file, 'utf8');
      assert.ok(!source.includes('node:'), `${file} must not import node builtins`);
      assert.ok(!source.includes('process.env'), `${file} must not read process.env`);
    }
    for (const file of ['packages/sdk/src/index.ts', 'packages/sdk/src/browser.ts']) {
      const source = fs.readFileSync(file, 'utf8');
      assert.ok(!source.includes('runtime-api'), `${file} must not reference the moved runtime`);
    }
    assert.ok(!fs.existsSync('packages/sdk/src/runtime.ts'), 'SDK runtime barrel must be gone');
    assert.ok(!fs.existsSync('packages/sdk/src/runtime-api.ts'), 'SDK runtime-api must be gone');
    assert.ok(!fs.existsSync('packages/sdk/src/browser-runtime.ts'), 'SDK browser-runtime must be gone');
    const tell = fs.readFileSync('packages/cli/src/Tell.ts', 'utf8');
    assert.ok(tell.includes('main().catch'), 'Tell.ts stays the binary entrypoint');
  });
});

function script_model(answers) {
  let calls = 0;
  const prompts = [];
  return {
    calls: () => calls,
    prompts: () => prompts,
    async ask(message) {
      calls += 1;
      prompts.push(message);
      return answers[Math.min(calls - 1, answers.length - 1)];
    },
  };
}

function sequence_executor(results) {
  let calls = 0;
  const seen = [];
  return {
    calls: () => calls,
    seen: () => seen,
    async run(options) {
      calls += 1;
      seen.push(options);
      return results[Math.min(calls - 1, results.length - 1)];
    },
  };
}

function core_config(overrides = {}) {
  return core.resolve_core_config({ host: 'cli', ...overrides });
}

describe('core primitive loop', () => {
  it('completes a two-round run into one aggregated TellResult', async () => {
    const model = script_model(['run it\n<RUN>\necho one\n</RUN>', 'done.']);
    const executor = sequence_executor([{ stdout: 'one', stderr: '', exit_code: 0 }]);
    const runtime = core.create_core_runtime({
      config: core_config({ flag: { exec_timeout_ms: 5000 } }),
      model,
      executor: (options) => executor.run(options),
      approval: async () => 'approved',
    });
    const result = await runtime.run('hi');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.text, 'done.');
    assert.strictEqual(result.commands.length, 1);
    assert.strictEqual(result.commands[0].status, 'executed');
    assert.strictEqual(result.commands[0].output, 'one');
    assert.strictEqual(model.calls(), 2);
    assert.strictEqual(executor.calls(), 1);
    assert.strictEqual(executor.seen()[0].timeout_ms, 5000);
    assert.strictEqual(executor.seen()[0].max_output_bytes, 32 * 1024 * 1024);
    assert.ok(result.timeline.some((line) => line.includes(core.EXECUTED_HEADER)));
  });

  it('stops on pending approval without executing', async () => {
    const model = script_model(['run it\n<RUN>\necho one\n</RUN>']);
    const executor = sequence_executor([{ stdout: 'one', stderr: '', exit_code: 0 }]);
    const runtime = core.create_core_runtime({
      config: core_config(),
      model,
      executor: (options) => executor.run(options),
    });
    const result = await runtime.run('hi');
    assert.strictEqual(result.status, 'awaiting_approval');
    assert.strictEqual(result.commands[0].status, 'awaiting_approval');
    assert.strictEqual(executor.calls(), 0);
    assert.strictEqual(model.calls(), 1);
  });

  it('represents no-exec as denied with disabled/--no-exec', async () => {
    const model = script_model(['run it\n<RUN>\necho one\n</RUN>']);
    const executor = sequence_executor([{ stdout: 'one', stderr: '', exit_code: 0 }]);
    const runtime = core.create_core_runtime({ config: core_config({ flag: { exec_enabled: false } }), model });
    const result = await runtime.run('hi');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.commands[0].status, 'denied');
    assert.strictEqual(result.commands[0].reason, 'disabled');
    assert.strictEqual(result.commands[0].source, '--no-exec');
    assert.strictEqual(executor.calls(), 0);
    assert.strictEqual(model.calls(), 1);
  });

  it('cancels before the first round and during the loop', async () => {
    const before = core.create_core_runtime({
      config: core_config(),
      model: script_model(['run it\n<RUN>\necho one\n</RUN>']),
      cancellation: core.cancelled_token(),
    });
    const cancelled = await before.run('hi');
    assert.strictEqual(cancelled.status, 'cancelled');
    assert.strictEqual(cancelled.commands.length, 0);

    let live = false;
    const token = { get cancelled() { return live; }, on_cancel: () => () => {} };
    const model = script_model(['run it\n<RUN>\necho one\n</RUN>', 'again\n<RUN>\necho two\n</RUN>']);
    const runtime = core.create_core_runtime({
      config: core_config(),
      model,
      executor: async () => {
        live = true;
        return { stdout: 'one', stderr: '', exit_code: 0 };
      },
      approval: async () => 'approved',
      cancellation: token,
    });
    const mid = await runtime.run('hi');
    assert.strictEqual(mid.status, 'cancelled');
    assert.strictEqual(model.calls(), 1);
    assert.strictEqual(mid.commands.length, 1);
  });

  it('self-heals on non-zero exit with FAILED feedback', async () => {
    const model = script_model([
      'try\n<RUN>\nrun-first\n</RUN>',
      'fix\n<RUN>\nrun-second\n</RUN>',
      'all good.',
    ]);
    const executor = sequence_executor([
      { stdout: '', stderr: 'boom', exit_code: 1 },
      { stdout: 'fixed', stderr: '', exit_code: 0 },
    ]);
    const runtime = core.create_core_runtime({
      config: core_config(),
      model,
      executor: (options) => executor.run(options),
      approval: async () => 'approved',
    });
    const result = await runtime.run('hi');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.text, 'all good.');
    assert.strictEqual(result.commands.length, 2);
    assert.strictEqual(result.commands[0].status, 'failed');
    assert.strictEqual(result.commands[1].status, 'executed');
    assert.ok(model.prompts()[1].includes('FAILED'));
    assert.ok(model.prompts()[1].includes('exit code 1'));
    assert.ok(model.prompts()[1].includes('boom'));
  });

  it('caps at eight rounds with the limit notice', async () => {
    const model = script_model(['more\n<RUN>\necho again\n</RUN>']);
    const executor = sequence_executor([{ stdout: 'again', stderr: '', exit_code: 0 }]);
    const runtime = core.create_core_runtime({
      config: core_config(),
      model,
      executor: (options) => executor.run(options),
      approval: async () => 'approved',
    });
    const result = await runtime.run('hi');
    assert.strictEqual(model.calls(), core.LOOP_MAX_ROUNDS);
    assert.strictEqual(result.commands.length, core.LOOP_MAX_ROUNDS);
    assert.ok(result.timeline.some((line) => line.includes('Chain limit reached (8)')));
  });

  it('emits request/start/output callbacks in order per round', async () => {
    const events = [];
    const runtime = core.create_core_runtime({
      config: core_config(),
      model: script_model(['go\n<RUN>\necho one\n</RUN>', 'done.']),
      executor: async () => ({ stdout: 'one', stderr: '', exit_code: 0 }),
      approval: async () => 'approved',
      callbacks: {
        onCommandRequest: () => { events.push('request'); },
        onCommandStart: () => { events.push('start'); },
        onCommandOutput: () => { events.push('output'); },
        onText: () => { events.push('text'); },
      },
    });
    await runtime.run('hi');
    assert.deepStrictEqual(events, ['text', 'request', 'start', 'output', 'text']);
  });

  it('produces identical results with streaming-capable models', async () => {
    const raw = 'go\n<RUN>\necho one\n</RUN>';
    const answers = [raw, 'done.'];
    const streaming = script_model(answers);
    streaming.ask_stream = async function* stream() {
      yield { type: 'reasoning', text: 'why' };
      yield { type: 'reasoning_end' };
      const full = answers[Math.min(streaming.calls() - 1, answers.length - 1)];
      yield { type: 'text', text: full.replace(/<think>[\s\S]*?<\/think>/g, '') };
    };
    const base = {
      config: core_config(),
      executor: async () => ({ stdout: 'one', stderr: '', exit_code: 0 }),
      approval: async () => 'approved',
    };
    const [plain, streamed] = await Promise.all([
      core.create_core_runtime({ ...base, model: script_model(answers) }).run('hi'),
      core.create_core_runtime({ ...base, model: streaming }).run('hi'),
    ]);
    assert.deepStrictEqual(streamed, plain);
  });
});
