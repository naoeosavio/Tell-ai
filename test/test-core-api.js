// Runtime API tests (contract owned by `@tell-ai/core`) — offline only, no
// provider/network calls.
// Uses node:test with a mocked ModelPort; covers defaults no-exec, completed
// status, pending approval, cancellation, callback order, missing executor,
// factory idempotence and adapter-swap invariance. `tell()` one-shot checks
// stay on `@tell-ai/sdk`.
const assert = require('node:assert');
const { describe, it } = require('node:test');

const runtime_api = require('@tell-ai/core');
const sdk = require('@tell-ai/sdk');

const {
  createTellRuntime,
  MemoryStorageAdapter,
  createLocalStorageAdapter,
  create_cancellation_token,
  cancelled_token,
} = runtime_api;

function mock_model(answer) {
  return {
    async ask() {
      return answer;
    },
  };
}

function memory_like() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

function fake_fetch() {
  return async (request) => ({
    ok: true,
    status: 200,
    url: request.url,
    async json() {
      return {};
    },
    async text() {
      return '';
    },
  });
}

function track_callbacks() {
  const order = [];
  const callbacks = {
    onThinking: () => order.push('thinking'),
    onText: () => order.push('text'),
    onCommandRequest: () => order.push('request'),
    onCommandStart: () => order.push('start'),
    onCommandOutput: () => order.push('output'),
    onCommandSkip: () => order.push('skip'),
    onStorageLoad: () => order.push('load'),
    onStorageSave: () => order.push('save'),
    onExecutorError: () => order.push('error'),
  };
  return { order, callbacks };
}

const ANSWER = '<think>reasoning here</think>\nvisible answer\n<RUN>\necho hi\n</RUN>';

describe('library runtime defaults (no-exec)', () => {
  it('denies commands with disabled/--no-exec and never calls the executor', async () => {
    let executed = false;
    const { order, callbacks } = track_callbacks();
    const runtime = createTellRuntime({
      model: mock_model(ANSWER),
      callbacks,
      executor: async () => {
        executed = true;
        return { stdout: 'x', stderr: '', exit_code: 0 };
      },
    });
    const result = await runtime.run('hello');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.text, 'visible answer');
    assert.strictEqual(result.commands.length, 1);
    assert.strictEqual(result.commands[0].script, 'echo hi');
    assert.strictEqual(result.commands[0].status, 'denied');
    assert.strictEqual(result.commands[0].reason, 'disabled');
    assert.strictEqual(result.commands[0].source, '--no-exec');
    assert.strictEqual(executed, false);
    assert.deepStrictEqual(order, ['load', 'thinking', 'text', 'request', 'skip', 'save']);
  });

  it('reports commands without executing when exec is on but no executor exists', async () => {
    const runtime = createTellRuntime({ model: mock_model(ANSWER), exec: true });
    const result = await runtime.run('hello');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.commands[0].status, 'requested');
  });
});

describe('library runtime execution', () => {
  it('executes approved commands and redacts output before callbacks', async () => {
    const seen = [];
    const runtime = createTellRuntime({
      model: mock_model(ANSWER),
      exec: true,
      executor: async () => ({ stdout: 'out SECRET end', stderr: '', exit_code: 0 }),
      approval: async () => 'approved',
      redact: (value) => value.replaceAll('SECRET', '[redacted]'),
      callbacks: {
        onCommandOutput: (event) => seen.push(event.output),
      },
    });
    const result = await runtime.run('hello');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.commands[0].status, 'executed');
    assert.strictEqual(result.commands[0].output, 'out [redacted] end');
    assert.ok(!String(result.commands[0].output).includes('SECRET'));
    assert.deepStrictEqual(seen, ['out [redacted] end']);
  });

  it('returns awaiting_approval when an executor exists but approval is missing', async () => {
    let executed = false;
    const runtime = createTellRuntime({
      model: mock_model(ANSWER),
      exec: true,
      executor: async () => {
        executed = true;
        return { stdout: '', stderr: '', exit_code: 0 };
      },
    });
    const result = await runtime.run('hello');
    assert.strictEqual(result.status, 'awaiting_approval');
    assert.strictEqual(result.commands[0].status, 'awaiting_approval');
    assert.strictEqual(executed, false);
  });

  it('never calls the executor when approval denies', async () => {
    let executed = false;
    const runtime = createTellRuntime({
      model: mock_model(ANSWER),
      exec: true,
      executor: async () => {
        executed = true;
        return { stdout: '', stderr: '', exit_code: 0 };
      },
      approval: async () => 'denied',
    });
    const result = await runtime.run('hello');
    assert.strictEqual(result.commands[0].status, 'denied');
    assert.strictEqual(executed, false);
  });
});

describe('library runtime cancellation and factory', () => {
  it('short-circuits on a cancelled token without calling the model', async () => {
    let called = false;
    const runtime = createTellRuntime({
      model: {
        async ask() {
          called = true;
          return 'never';
        },
      },
      cancellation: cancelled_token(),
    });
    const result = await runtime.run('hello');
    assert.strictEqual(result.status, 'cancelled');
    assert.strictEqual(called, false);
  });

  it('is idempotent: two runtimes from the same options behave identically', async () => {
    const options = { model: mock_model('plain answer') };
    const first = createTellRuntime(options);
    const second = createTellRuntime(options);
    assert.notStrictEqual(first, second);
    const [a, b] = await Promise.all([first.run('hi'), second.run('hi')]);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.status, 'completed');
  });

  it('supports a cancellable token that fires after creation', async () => {
    const token = create_cancellation_token();
    token.cancel();
    const runtime = createTellRuntime({ model: mock_model('x'), cancellation: token });
    const result = await runtime.run('hi');
    assert.strictEqual(result.status, 'cancelled');
  });
});

describe('library runtime adapters', () => {
  it('swapping storage/fetch adapters does not change the TellResult', async () => {
    const base = { model: mock_model('plain answer') };
    const plain = await createTellRuntime(base).run('hi');
    const swapped = await createTellRuntime({
      ...base,
      storage: createLocalStorageAdapter(memory_like()),
      fetch: fake_fetch(),
    }).run('hi');
    assert.deepStrictEqual(swapped, plain);
  });

  it('MemoryStorageAdapter round-trips through the StoragePort contract', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.save('k', 'v');
    assert.strictEqual(await storage.load('k'), 'v');
    await storage.appendLog('k', 'a');
    assert.strictEqual(await storage.load('k'), 'va');
    await storage.clear('k');
    assert.strictEqual(await storage.load('k'), '');
  });

  it('preserves tell() one-shot no-exec semantics', async () => {
    let system = '';
    const answer = await sdk.tell('hello', {
      ask: {
        async ask(_message, options) {
          system = options.system;
          return 'ok';
        },
      },
    });
    assert.strictEqual(answer, 'ok');
    assert.match(system, /do NOT have terminal access/);
  });
});
