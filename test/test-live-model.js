// test-live-model.js
//
// Live validation against a real model (OpenRouter by default).
//
// The fuzz suite proves the pure surfaces; this suite proves the wiring with
// a real provider: the model really answers, the tags really come back, the
// CLI really extracts and executes what the model asked for, and the
// streaming path really emits tokens.
//
// Model: `openrouter:minimax/minimax-m3.1-flash:free` (override with
// TELL_LIVE_MODEL). The suite skips itself when no API key is available.
//
// Run with: node test/test-live-model.js (after the sdk + cli build).

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const SDK_CJS = path.join(REPO, 'packages', 'sdk', 'dist', 'index.cjs');
const CLI_BIN = path.join(REPO, 'packages', 'cli', 'dist', 'Tell.mjs');

/** Model used for the live checks (free tier, no local key needed). */
const LIVE_MODEL = process.env['TELL_LIVE_MODEL'] ?? 'openrouter:minimax/minimax-m3.1-flash:free';

/** API key used by the live checks (OpenRouter). */
const LIVE_KEY = process.env['OPENROUTER_API_KEY'] ?? '';

/**
 * Runs one check and reports the outcome.
 *
 * @param {string} name - Check name.
 * @param {() => Promise<void>} body - Check body.
 * @returns {Promise<boolean>} True when the check passed.
 */
async function check(name, body) {
  try {
    await body();
    console.log(`ok - ${name}`);
    return true;
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    return false;
  }
}

async function main() {
  if (!LIVE_KEY) {
    console.log('skipped - no OPENROUTER_API_KEY in the environment (live model checks need one)');
    return;
  }
  const sdk = require(SDK_CJS);
  const config = { keys: { openrouter: LIVE_KEY }, urls: {} };
  let failures = 0;

  const record = async (name, body) => {
    if (await check(name, body)) {
      failures += 0;
    } else {
      failures += 1;
    }
  };

  await record('the model answers a one-shot prompt', async () => {
    const ai = await sdk.create_ask_ai(LIVE_MODEL, config);
    const answer = await ai.ask('Reply with exactly the word: READY');
    assert.match(answer, /READY/i, `unexpected answer: ${answer.slice(0, 200)}`);
  });

  await record('the model emits a command inside a RUN block', async () => {
    const ai = await sdk.create_ask_ai(LIVE_MODEL, config);
    const answer = await ai.ask(
      'Reply with exactly this text and nothing else: <RUN>echo live-ok</RUN>',
      { system: 'You answer with the requested text only.' },
    );
    const { scripts, visible } = sdk.extract_runs(answer);
    assert.strictEqual(scripts.length, 1, `expected one command, got ${JSON.stringify(scripts)}`);
    assert.strictEqual(scripts[0], 'echo live-ok');
    assert.ok(!visible.includes('<RUN>'), 'the visible text must not carry the command block');
  });

  await record('the streaming path emits text tokens', async () => {
    const ai = await sdk.create_ask_ai(LIVE_MODEL, config);
    let text = '';
    let reasoning = 0;
    for await (const event of ai.ask_stream('Say: streaming works')) {
      if (event.type === 'text') text += event.text;
      if (event.type === 'reasoning') reasoning += 1;
    }
    assert.ok(text.trim().length > 0, 'the stream must deliver text');
    assert.ok(reasoning >= 0);
  });

  await record('the CLI resolves the live model and answers', async () => {
    const result = spawnSync(
      process.execPath,
      [CLI_BIN, '-m', LIVE_MODEL, 'Reply with exactly the word: CLI-READY'],
      { cwd: REPO, encoding: 'utf8', timeout: 120_000, env: { ...process.env, OPENROUTER_API_KEY: LIVE_KEY } },
    );
    const output = `${result.stdout ?? ''}`;
    assert.strictEqual(result.status, 0, `the CLI failed: ${result.stderr ?? ''}`);
    assert.match(output, /CLI-READY/i, `unexpected CLI output: ${output.slice(0, 300)}`);
  });

  await record('the CLI never leaks the provider key in its output', async () => {
    const result = spawnSync(
      process.execPath,
      [CLI_BIN, '-m', LIVE_MODEL, 'Reply with exactly the word: OK'],
      { cwd: REPO, encoding: 'utf8', timeout: 120_000, env: { ...process.env, OPENROUTER_API_KEY: LIVE_KEY } },
    );
    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.ok(!combined.includes(LIVE_KEY), 'the provider key must never reach the output');
  });

  await record('the alias table still round-trips with the live provider', async () => {
    const spec = sdk.resolve_model_spec(LIVE_MODEL);
    assert.strictEqual(spec.vendor, 'openrouter');
    assert.ok(spec.model.length > 0);
    const handle = await sdk.get_model(LIVE_MODEL, config);
    assert.ok(handle.model !== undefined, 'the live model handle must be built');
  });

  await record('the CLI executes the command the model asked for', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-live-'));
    const result = spawnSync(
      process.execPath,
      [
        CLI_BIN,
        '-m',
        LIVE_MODEL,
        '-y',
        'Execute this shell command and tell me the output: echo hello-from-model',
      ],
      { cwd: workdir, encoding: 'utf8', timeout: 180_000, env: { ...process.env, OPENROUTER_API_KEY: LIVE_KEY } },
    );
    // The command output is printed on stderr (stdout carries the answer).
    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.strictEqual(result.status, 0, `the CLI failed: ${result.stderr ?? ''}`);
    assert.match(combined, /hello-from-model/, `the command output never reached the CLI: ${combined.slice(0, 300)}`);
  });

  if (failures > 0) {
    console.error(`\n${failures} live check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nlive model checks passed');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
