// @tell-ai/sdk unit tests — pure/local only, no external network and no LLM
// calls (the streaming-error test talks to a throwaway localhost server).
// Covers the public exports from packages/sdk/src/index.ts: model resolution,
// provider handles (constructed, never called), system prompts and tag helpers.
// create_ask_ai/tell/summarize_context success paths are intentionally not
// exercised here (they call the model); the CLI suites cover them with stubs.
const assert = require('node:assert');
const http = require('node:http');

const sdk = require('@tell-ai/sdk');

const EMPTY_CONFIG = { keys: {}, urls: {} };

(async () => {
  // Public export surface.
  for (const name of [
    'MODELS',
    'resolve_model_spec',
    'get_model',
    'create_ask_ai',
    'tell',
    'get_system_prompt',
    'extract_runs',
    'strip_run_tags',
    'strip_think_tags',
    'strip_markdown_code_blocks',
    'summarize_context',
  ]) {
    assert.strictEqual(typeof sdk[name] === 'function' || typeof sdk[name] === 'object', true, `missing export: ${name}`);
  }

  // resolve_model_spec: aliases, fast mode, thinking budgets, full specs.
  assert.deepStrictEqual(sdk.resolve_model_spec('g'), {
    vendor: 'openai',
    model: 'gpt-5.6-sol',
    thinking: 'medium',
    fast: false,
  });
  const dot = sdk.resolve_model_spec('.g');
  assert.strictEqual(dot.fast, true);
  assert.strictEqual(dot.vendor, 'openai');
  assert.strictEqual(sdk.resolve_model_spec('g+').thinking, 'high');
  assert.strictEqual(sdk.resolve_model_spec('g--').thinking, 'none');
  assert.deepStrictEqual(sdk.resolve_model_spec('deepseek:deepseek-flash:high'), {
    vendor: 'deepseek',
    model: 'deepseek-flash',
    thinking: 'high',
    fast: false,
  });
  assert.strictEqual(sdk.resolve_model_spec('d').model, 'deepseek-flash');
  assert.strictEqual(sdk.resolve_model_spec('deepseek:deepseek-v4-flash:high').model, 'deepseek-v4-flash');
  assert.strictEqual(sdk.resolve_model_spec('deepseek:deepseek-v4-flash-vision-exp:high').model, 'deepseek-v4-flash-vision-exp');
  assert.strictEqual(sdk.resolve_model_spec('openai:gpt-5.6-sol:medium:fast').fast, true);
  assert.throws(() => sdk.resolve_model_spec(''), /must be provided/);
  assert.throws(() => sdk.resolve_model_spec('notamodelatall'), /./);

  // MODELS table invariant: every alias value parses back through the resolver.
  for (const [alias, spec] of Object.entries(sdk.MODELS)) {
    if (!spec.includes(':')) continue; // thinking-level/vendor-name helpers, not model specs
    const resolved = sdk.resolve_model_spec(spec);
    assert.ok(resolved.vendor && resolved.model, `alias ${alias} resolved without vendor/model`);
  }

  // get_model: builds provider handles offline (providers are only called later).
  const handle = await sdk.get_model('g', EMPTY_CONFIG);
  assert.strictEqual(typeof handle.model, 'object');
  assert.strictEqual(typeof handle.reasoning, 'string');
  assert.strictEqual(handle.fast, false);
  const fast_handle = await sdk.get_model('.g', EMPTY_CONFIG);
  assert.strictEqual(fast_handle.fast, true);
  const local_handle = await sdk.get_model('q', { keys: {}, urls: { local: 'http://localhost:8080/v1' } });
  assert.strictEqual(local_handle.fast, false);
  await assert.rejects(sdk.get_model('v', EMPTY_CONFIG), /urls\.vast/);
  await assert.rejects(sdk.get_model('q', EMPTY_CONFIG), /urls\.local/);
  await assert.rejects(sdk.get_model('nope:whatever', EMPTY_CONFIG), /./);

  // Compat vendors (no native provider): handlers build offline via
  // OpenAI-compatible defaults, keys/URLs optional at construction.
  for (const alias of ['l', 'x', 'd', 'D', 'K', 'k', 'a', 'zf']) {
    const compat_handle = await sdk.get_model(alias, EMPTY_CONFIG);
    assert.strictEqual(typeof compat_handle.model, 'object');
    assert.strictEqual(compat_handle.fast, false);
  }

  // Reasoning mapping: `max` goes explicit where the generic map has no
  // entry, else the closest natively supported level (never warns/drops).
  // NOTE: `m++` (openrouter) is intentionally not resolved here — its
  // cached provider would pin EMPTY_CONFIG and poison the localhost test below.
  for (const [alias, expected] of [
    ['d+', 'max'],
    ['D+', 'max'],
    ['g++', 'max'],
    ['l++', 'high'],
    ['K+', 'max'],
    ['z++', 'max'],
    ['s++', 'max'],
    ['o++', 'max'],
    ['f++', 'max'],
    ['x++', 'xhigh'],
    ['a++', 'xhigh'],
  ]) {
    assert.strictEqual((await sdk.get_model(alias, EMPTY_CONFIG)).reasoning, expected, alias);
  }

  // Explicit `max` carries vendor options (generic map has no `max` entry):
  // anthropic effort+adaptive thinking, deepseek/moonshotai reasoningEffort.
  assert.deepStrictEqual((await sdk.get_model('s++', EMPTY_CONFIG)).providerOptions, {
    anthropic: { effort: 'max', thinking: { type: 'adaptive', display: 'summarized' } },
  });
  assert.deepStrictEqual((await sdk.get_model('d+', EMPTY_CONFIG)).providerOptions, {
    deepseek: { reasoningEffort: 'max' },
  });
  assert.deepStrictEqual((await sdk.get_model('K+', EMPTY_CONFIG)).providerOptions, {
    moonshotai: { reasoningEffort: 'max' },
  });
  assert.strictEqual((await sdk.get_model('s', EMPTY_CONFIG)).providerOptions, undefined);
  assert.strictEqual((await sdk.get_model('l++', EMPTY_CONFIG)).providerOptions, undefined);
  // Fast mode never carries explicit thinking: `.s++`/`.d+` must not leak reasoning.
  for (const alias of ['.s++', '.d+']) {
    const fast_max = await sdk.get_model(alias, EMPTY_CONFIG);
    assert.strictEqual(fast_max.fast, true);
    assert.strictEqual(fast_max.reasoning, 'none');
    assert.strictEqual(fast_max.providerOptions, undefined);
  }

  // create_ask_ai: constructed offline; ask_stream returns an async iterable
  // without consuming it (the provider request only starts on first next()).
  const ai = await sdk.create_ask_ai('g', EMPTY_CONFIG);
  assert.strictEqual(typeof ai.ask, 'function');
  assert.strictEqual(typeof ai.ask_stream, 'function');
  const events = ai.ask_stream('hi', { system: 'test' });
  assert.strictEqual(typeof events[Symbol.asyncIterator], 'function');
  const multi_turn = ai.ask_stream([{ role: 'user', content: 'hi' }], { system: 'test' });
  assert.strictEqual(typeof multi_turn[Symbol.asyncIterator], 'function');

  // ask_stream regression: a provider failure must propagate to the caller
  // without the AI SDK default onError dumping the raw error (request body,
  // response headers/cookies) to stderr.
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"mock provider failure"}}');
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const port = provider.address().port;
  const logged_errors = [];
  const original_error = console.error;
  console.error = (...args) => logged_errors.push(args);
  try {
    const failing = await sdk.create_ask_ai('openrouter:mock/model:free', {
      keys: { openrouter: 'test-key' },
      urls: { openrouter: `http://127.0.0.1:${port}/v1` },
    });
    await assert.rejects(async () => {
      for await (const _event of failing.ask_stream('hi', { system: 'test' })) {
        // no events expected
      }
    }, /mock provider failure/);
  } finally {
    console.error = original_error;
    provider.close();
  }
  assert.deepStrictEqual(logged_errors, [], 'streamText must not log raw provider errors by default');

  // get_system_prompt: exec vs no-exec variants.
  const exec_prompt = sdk.get_system_prompt({ chain: true });
  assert.match(exec_prompt, /terminal assistant/);
  assert.match(exec_prompt, /<RUN>/);
  assert.match(exec_prompt, /multi-step/);
  const one_shot = sdk.get_system_prompt({});
  assert.match(one_shot, /one-shot/);
  const no_exec = sdk.get_system_prompt({ exec: false });
  assert.match(no_exec, /do NOT have terminal access/);

  // Tag helpers.
  const runs = sdk.extract_runs('do this:\n<RUN>\nls -la\n</RUN>\ndone');
  assert.deepStrictEqual(runs.scripts, ['ls -la']);
  assert.strictEqual(runs.visible, 'do this:\n\ndone');
  assert.strictEqual(sdk.strip_think_tags('a<think>secret</think>b').trim(), 'ab');
  assert.strictEqual(sdk.strip_run_tags('a<RUN>x</RUN>b').trim(), 'ab');
  assert.strictEqual(sdk.strip_markdown_code_blocks('a```js\nx\n```b'), 'ab');

  console.log('sdk tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
