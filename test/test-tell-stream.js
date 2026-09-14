// test-tell-stream.js
//
// Coverage for `tell --stream` / `--think`. Uses the same approach as the
// other CLI suites: transpile Tell.ts with the real TypeScript compiler, run
// it inside a sandboxed vm context with a mocked "@tell-ai/sdk" (including
// `ask_stream`), and assert on stdout/stderr/exec calls/context and log files.
//
// Invariant under test: streaming only changes *when* the text appears —
// stdout gets the text once (no duplicate final print), the raw response kept
// for log/context/`<RUN>` extraction is byte-identical to the non-stream path.

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const util = require('node:util');
const vm = require('node:vm');

const sdk = require('@tell-ai/sdk');

const tell_source = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'Tell.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;

// `./mentions` is required by Tell.js at load time; compile it into the same
// vm sandbox on demand so it binds to the faked process/fs view per test.
const mentions_source = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'mentions.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;

function fake_stdin(text) {
  const stdin = new EventEmitter();
  stdin.isTTY = false;
  setImmediate(() => {
    if (text) stdin.emit('data', Buffer.from(text));
    stdin.emit('end');
  });
  return stdin;
}

async function wait_for_main() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function run_block(script) {
  return `<RUN>\n${script}\n</RUN>`;
}

// Splits text into small deltas so tests exercise progressive writes.
function chunk_text(text) {
  return (text.match(/[\s\S]{1,4}/g) || []).map((chunk) => ({ type: 'text', text: chunk }));
}

function log_dir_path(home) {
  return path.join(home, '.ai', 'tell_history');
}

function latest_log(home) {
  const files = fs.readdirSync(log_dir_path(home)).sort();
  return fs.readFileSync(path.join(log_dir_path(home), files[files.length - 1]), 'utf8');
}

function context_dir_path(home) {
  return path.join(home, '.ai', 'tell_context');
}

function saved_context(home) {
  const files = fs.readdirSync(context_dir_path(home)).sort();
  assert.strictEqual(files.length, 1, 'expected exactly one saved context file');
  return fs.readFileSync(path.join(context_dir_path(home), files[0]), 'utf8');
}

function assert_includes(text, substring, message) {
  assert.ok(text.includes(substring), message || `expected to find ${JSON.stringify(substring)} in:\n${text}`);
}

function assert_not_includes(text, substring, message) {
  assert.ok(!text.includes(substring), message || `did not expect to find ${JSON.stringify(substring)} in:\n${text}`);
}

async function run_tell(args, response, opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'tell-stream-'));
  const home = path.join(dir, 'home');
  const work = path.join(dir, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });

  let stdout = '';
  let stderr = '';
  const tell_messages = [];
  const tell_calls = [];
  const stream_calls = [];
  const exec_calls = [];
  const responses = Array.isArray(response) ? response.slice() : [response];
  const write_stdout = (text) => {
    stdout += String(text);
    return true;
  };
  const write_stderr = (text) => {
    stderr += String(text);
    return true;
  };
  const log = (...items) => {
    stdout += `${items.join(' ')}\n`;
  };
  const error = (...items) => {
    stderr += `${util.format(...items)}\n`;
  };
  const fake_process = {
    argv: ['node', 'Tell.js', ...args],
    env: { ...process.env, HOME: home },
    stdin: fake_stdin(opts.stdin || ''),
    stdout: { isTTY: false, write: write_stdout },
    stderr: { isTTY: false, write: write_stderr },
    cwd: () => work,
    platform: process.platform,
    exitCode: undefined,
  };

  function mock_exec() {}
  mock_exec[util.promisify.custom] = async (script) => {
    exec_calls.push(script);
    return { stdout: opts.execStdout || '', stderr: opts.execStderr || '' };
  };

  const spawn_calls = [];
  function mock_spawn(cmd, args, options) {
    const child = new EventEmitter();
    spawn_calls.push({ cmd, args, options });
    setImmediate(() => {
      if (opts.spawnError) child.emit('error', opts.spawnError);
      else child.emit('exit', opts.spawnExitCode ?? 0);
    });
    return child;
  }

  const module_obj = { exports: {} };
  let active_context = null;
  function mock_require(name) {
    if (name === './mentions') {
      const mentions_module = { exports: {} };
      const factory = vm.runInContext(`(function(require, module, exports) {${mentions_source}\n})`, active_context);
      factory(mock_require, mentions_module, mentions_module.exports);
      return mentions_module.exports;
    }
    if (name === '@tell-ai/sdk') {
      return {
        ...sdk,
        create_ask_ai: async () => ({
          ask: async (message, options = {}) => {
            tell_messages.push(message);
            tell_calls.push({ message, options });
            return responses.length > 1 ? responses.shift() : responses[0];
          },
          ask_stream: (message, options = {}) => {
            tell_messages.push(message);
            tell_calls.push({ message, options });
            stream_calls.push({ message, options });
            const scripted = opts.streamEvents?.[stream_calls.length - 1];
            const events =
              scripted ?? chunk_text(responses.length > 1 ? responses.shift() : responses[0]);
            return (async function* () {
              for (const event of events) yield event;
            })();
          },
        }),
      };
    }
    if (name === './env') {
      return { load_sdk_config: async () => ({ keys: {}, urls: {} }) };
    }
    if (name === './systemPrompt') {
      return { get_system_prompt: (options) => sdk.get_system_prompt(options) };
    }
    if (name === 'child_process' || name === 'node:child_process') return { exec: mock_exec, spawn: mock_spawn };
    if (name === 'os' || name === 'node:os') return { ...require('node:os'), homedir: () => home };
    return require(name);
  }
  mock_require.main = module_obj;

  const context = {
    Buffer,
    process: fake_process,
    setTimeout,
    clearTimeout,
    exports: {},
    module: module_obj,
    console: { log, error },
    require: mock_require,
  };

  try {
    active_context = context;
    vm.runInNewContext(tell_source, context, { filename: 'Tell.js' });
    await wait_for_main();
    return {
      stdout,
      stderr,
      execCalls: exec_calls,
      tellMessages: tell_messages,
      tellCalls: tell_calls,
      streamCalls: stream_calls,
      spawnCalls: spawn_calls,
      exitCode: fake_process.exitCode,
      dir,
      home,
      work,
    };
  } finally {
    if (!opts.dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------
// Streaming output
// ---------------------------------------------------------------------

async function test_stream_prints_text_to_stdout_once() {
  const result = await run_tell(['d', '--stream', 'hello'], 'ignored', {
    streamEvents: [
      [
        { type: 'reasoning', text: 'hidden reasoning' },
        { type: 'reasoning_end' },
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
      ],
    ],
  });
  assert.strictEqual(result.stdout, 'Hello\n');
  assert_includes(result.stderr, 'Thinking...');
  // Reasoning is hidden by default — not on stdout, not echoed on stderr.
  assert_not_includes(result.stdout, 'hidden reasoning');
  assert_not_includes(result.stderr, 'hidden reasoning');
}

async function test_stream_think_prints_reasoning_to_stderr() {
  const result = await run_tell(['d', '--stream', '--think', 'hello'], 'ignored', {
    streamEvents: [
      [
        { type: 'reasoning', text: 'because reasons' },
        { type: 'reasoning_end' },
        { type: 'text', text: 'Hello' },
      ],
    ],
  });
  assert.strictEqual(result.stdout, 'Hello\n');
  assert_includes(result.stderr, 'because reasons');
  assert_not_includes(result.stdout, 'because reasons');
}

async function test_stream_appends_single_newline() {
  const result = await run_tell(['d', '--stream', 'hello'], 'ignored', {
    streamEvents: [[{ type: 'text', text: 'already\nterminated\n' }]],
  });
  assert.strictEqual(result.stdout, 'already\nterminated\n');
}

async function test_stream_keeps_full_response_in_log_and_context() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-stream-'));
  try {
    const result = await run_tell(['d', '--stream', '-c', 'hello'], 'ignored', {
      dir,
      streamEvents: [
        [
          { type: 'reasoning', text: 'deep thought' },
          { type: 'reasoning_end' },
          { type: 'text', text: 'the answer' },
        ],
      ],
    });
    const log_text = latest_log(result.home);
    assert_includes(log_text, '<think>deep thought</think>');
    assert_includes(log_text, 'the answer');
    const context_text = saved_context(result.home);
    assert_includes(context_text, 'the answer');
    assert_not_includes(context_text, 'deep thought');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function test_stream_chain_streams_each_round() {
  const result = await run_tell(['d', '--stream', '--chain', 'check'], 'ignored', {
    streamEvents: [
      [
        { type: 'text', text: 'Checking now.\n' },
        { type: 'text', text: run_block('echo hi') },
      ],
      [{ type: 'text', text: 'All good.' }],
    ],
  });
  assert.strictEqual(result.streamCalls.length, 2);
  assert_includes(result.stdout, 'Checking now.');
  assert_includes(result.stdout, 'All good.');
  // The final visible answer is not printed twice.
  const occurrences = result.stdout.split('All good.').length - 1;
  assert.strictEqual(occurrences, 1, 'final streamed answer must appear exactly once');
  assert_includes(result.stderr, 'Command skipped by user.');
  assert.deepStrictEqual(result.execCalls, []);
}

async function test_stream_commands_still_detected_and_run() {
  const result = await run_tell(['d', '--stream', '-y', 'run it'], 'ignored', {
    streamEvents: [
      [{ type: 'text', text: run_block('echo hi') }],
      [{ type: 'text', text: 'Done.' }],
    ],
  });
  assert.deepStrictEqual(result.execCalls, ['echo hi']);
  // The raw stream shows the <RUN> markup, and the final answer only once.
  assert_includes(result.stdout, run_block('echo hi'));
  const occurrences = result.stdout.split('Done.').length - 1;
  assert.strictEqual(occurrences, 1, 'final answer must be streamed exactly once');
}

// ---------------------------------------------------------------------
// Reasoning without streaming (`--think` alone)
// ---------------------------------------------------------------------

async function test_think_without_stream_prints_reasoning_on_stderr() {
  const result = await run_tell(['d', '--think', 'hello'], '<think>reasoned here</think>\nanswer');
  assert.strictEqual(result.stdout, 'answer\n');
  assert_includes(result.stderr, 'reasoned here');
  assert_not_includes(result.stdout, 'reasoned here');
}

async function test_without_think_reasoning_stays_hidden() {
  const result = await run_tell(['d', 'hello'], '<think>silent thought</think>\nanswer');
  assert.strictEqual(result.stdout, 'answer\n');
  assert_not_includes(result.stderr, 'silent thought');
  assert_not_includes(result.stdout, 'silent thought');
}

async function test_without_stream_prints_answer_once() {
  const result = await run_tell(['d', 'hello'], 'plain answer');
  assert.strictEqual(result.stdout, 'plain answer\n');
  assert_includes(result.stderr, 'Thinking...');
}

// ---------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------

const TESTS = [
  test_stream_prints_text_to_stdout_once,
  test_stream_think_prints_reasoning_to_stderr,
  test_stream_appends_single_newline,
  test_stream_keeps_full_response_in_log_and_context,
  test_stream_chain_streams_each_round,
  test_stream_commands_still_detected_and_run,
  test_think_without_stream_prints_reasoning_on_stderr,
  test_without_think_reasoning_stays_hidden,
  test_without_stream_prints_answer_once,
];

(async () => {
  let failures = 0;
  for (const test_fn of TESTS) {
    try {
      await test_fn();
      console.log(`ok - ${test_fn.name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${test_fn.name}`);
      console.error(error);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\ntell stream tests passed');
  }
})();
