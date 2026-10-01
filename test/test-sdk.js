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
  const browserSdk = await import('@tell-ai/sdk/browser');
  await import('@tell-ai/sdk/browser-global');
  assert.strictEqual(typeof browserSdk.sanitize_reasoning, 'function');
  assert.strictEqual(typeof globalThis.TellSDK.sanitize_reasoning, 'function');

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
    'sanitize_reasoning',
    'summarize_context',
  ]) {
    assert.strictEqual(typeof sdk[name] === 'function' || typeof sdk[name] === 'object', true, `missing export: ${name}`);
  }

  // resolve_model_spec: aliases, fast mode, thinking budgets, full specs.
  assert.deepStrictEqual(sdk.resolve_model_spec('g'), {
    vendor: 'openai',
    model: 'gpt-6.1-sol',
    thinking: 'medium',
    fast: false,
  });
  const dot = sdk.resolve_model_spec('.g');
  assert.strictEqual(dot.fast, true);
  assert.strictEqual(dot.vendor, 'openai');
  assert.strictEqual(sdk.resolve_model_spec('g+').thinking, 'high');
  assert.strictEqual(sdk.resolve_model_spec('g--').thinking, 'low');
  for (const [alias, vendor, model] of [
    ['g', 'openai', 'gpt-6.1-sol'],
    ['p', 'openai', 'gpt-6.1-sol-pro'],
    ['e', 'openai', 'gpt-6-astra'],
    ['r', 'openai', 'gpt-6-astra-pro'],
    ['c', 'openai', 'gpt-6-luna'],
    ['s', 'anthropic', 'claude-sonnet-5-5'],
    ['o', 'anthropic', 'claude-opus-5-5'],
    ['f', 'anthropic', 'claude-fable-5-1'],
    ['h', 'anthropic', 'claude-haiku-4-5'],
    ['i', 'google', 'gemini-3.1-pro'],
    ['x', 'xai', 'grok-4.7'],
    ['at', 'alibaba', 'qwen3.8-27b'],
    ['m', 'meta', 'muse-spark-1.3'],
    ['mc', 'meta', 'muse-spark-1.3-contributor'],
    ['mi', 'xiaomi', 'mimo-v2.6-pro'],
    ['mif', 'xiaomi', 'mimo-v2.6-flash'],
  ]) {
    const resolved = sdk.resolve_model_spec(alias);
    assert.strictEqual(resolved.vendor, vendor, alias);
    assert.strictEqual(resolved.model, model, alias);
  }

  for (const [prefix, expected] of [
    ['m', ['none', 'low', 'medium', 'high', 'max']],
    ['mc', ['none', 'low', 'medium', 'high', 'max']],
    ['mi', ['none', 'low', 'medium', 'high', 'max']],
    ['mif', ['none', 'low', 'medium', 'high', 'max']],
  ]) {
    const suffixes = [
      ['--', expected[0]],
      ['-', expected[1]],
      ['', expected[2]],
      ['+', expected[3]],
      ['++', expected[4]],
    ];
    for (const [suffix, thinking] of suffixes) {
      assert.strictEqual(sdk.resolve_model_spec(`${prefix}${suffix}`).thinking, thinking, `${prefix}${suffix}`);
    }
    assert.strictEqual(sdk.resolve_model_spec(prefix.toUpperCase()).thinking, 'high', `${prefix} (uppercase)`);
  }
  assert.strictEqual(sdk.resolve_model_spec('meta:muse-spark-1.3:high').vendor, 'meta');
  assert.strictEqual(sdk.resolve_model_spec('mimo-v2.6-pro:low').vendor, 'xiaomi');
  for (const raw of [
    'meta/muse-spark-1.3',
    'meta/muse-spark-1.3-contributor',
    'mimo/mimo-v2.6-pro',
    'mimo/mimo-v2.6-flash',
  ]) {
    const resolved = sdk.resolve_model_spec(raw);
    assert.strictEqual(resolved.vendor, 'openrouter', raw);
    assert.strictEqual(resolved.model, raw, raw);
  }
  assert.strictEqual(sdk.resolve_model_spec('openrouter:meta/muse-spark-1.3').vendor, 'openrouter');
  assert.deepStrictEqual(sdk.resolve_model_spec('deepseek:deepseek-flash:high'), {
    vendor: 'deepseek',
    model: 'deepseek-flash',
    thinking: 'high',
    fast: false,
  });
  assert.strictEqual(sdk.resolve_model_spec('d').model, 'deepseek-flash');
  assert.strictEqual(sdk.resolve_model_spec('deepseek:deepseek-v4-flash:high').model, 'deepseek-v4-flash');
  assert.strictEqual(sdk.resolve_model_spec('deepseek:deepseek-v4-flash-vision-exp:high').model, 'deepseek-v4-flash-vision-exp');
  assert.strictEqual(sdk.resolve_model_spec('openai:gpt-6.1-sol:medium:fast').fast, true);
  assert.throws(() => sdk.resolve_model_spec(''), /must be provided/);
  assert.throws(() => sdk.resolve_model_spec('notamodelatall'), /./);

  // MODELS table invariant: every alias value parses back through the resolver.
  assert.strictEqual(Object.keys(sdk.MODELS).length, 142);
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
  const ambient_base = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = 'http://ambient.invalid/v1';
  try {
    const no_ambient_url = await sdk.get_model('g', EMPTY_CONFIG);
    assert.match(String(no_ambient_url.model.config.url({ path: '/models' })), /api\.openai\.com/);
  } finally {
    if (ambient_base === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = ambient_base;
  }
  const local_handle = await sdk.get_model('q', { keys: {}, urls: { local: 'http://localhost:8080/v1' } });
  assert.strictEqual(local_handle.fast, false);
  await assert.rejects(sdk.get_model('v', EMPTY_CONFIG), /urls\.vast/);
  await assert.rejects(sdk.get_model('q', EMPTY_CONFIG), /urls\.local/);
  await assert.rejects(sdk.get_model('nope:whatever', EMPTY_CONFIG), /./);

  // Compat vendors (no native provider): handlers build offline via
  // OpenAI-compatible defaults, keys/URLs optional at construction.
  for (const alias of ['l', 'x', 'd', 'D', 'K', 'k', 'a', 'at', 'af', 'zf', 'h', 'm', 'mc', 'mi', 'mif']) {
    const compat_handle = await sdk.get_model(alias, EMPTY_CONFIG);
    assert.strictEqual(typeof compat_handle.model, 'object');
    assert.strictEqual(compat_handle.fast, false);
  }

  // Reasoning mapping: `max` goes explicit where the generic map has no
  // entry, else the closest natively supported level (never warns/drops).
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
    ['m++', 'max'],
    ['mc++', 'max'],
    ['mi++', 'max'],
    ['mif++', 'max'],
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
  for (const [alias, effort] of [
    ['K-', 'low'],
    ['K', 'high'],
    ['K+', 'max'],
  ]) {
    assert.deepStrictEqual((await sdk.get_model(alias, EMPTY_CONFIG)).providerOptions, {
      moonshotai: { reasoningEffort: effort },
    });
  }
  for (const alias of ['m', 'm+', 'm++', 'mc']) {
    assert.deepStrictEqual((await sdk.get_model(alias, EMPTY_CONFIG)).providerOptions, {
      openai: { forceReasoning: true },
    }, alias);
  }
  for (const alias of ['mi', 'mif', 'mif++']) {
    assert.strictEqual((await sdk.get_model(alias, EMPTY_CONFIG)).providerOptions, undefined, alias);
  }
  assert.strictEqual((await sdk.get_model('s', EMPTY_CONFIG)).providerOptions, undefined);
  assert.strictEqual((await sdk.get_model('l++', EMPTY_CONFIG)).providerOptions, undefined);
  // Fast mode never carries explicit thinking: `.s++`/`.d+` must not leak reasoning.
  for (const alias of ['.s++', '.d+', '.m++', '.mi++']) {
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

  // Compat cache is per vendor+URL: two configs for one vendor hit their own
  // endpoint (guards against a stale cached provider across configs).
  const chat_server = (text) =>
    http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'mock',
            object: 'chat.completion',
            created: 0,
            model: 'mock',
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
  const server_a = chat_server('answer-a');
  const server_b = chat_server('answer-b');
  await new Promise((resolve) => server_a.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => server_b.listen(0, '127.0.0.1', resolve));
  try {
    const ai_a = await sdk.create_ask_ai('deepseek:mock-a:high', {
      keys: {},
      urls: { deepseek: `http://127.0.0.1:${server_a.address().port}/v1` },
    });
    const ai_b = await sdk.create_ask_ai('deepseek:mock-b:high', {
      keys: {},
      urls: { deepseek: `http://127.0.0.1:${server_b.address().port}/v1` },
    });
    assert.strictEqual(await ai_a.ask('hi', { system: 'test', stream: false }), 'answer-a');
    assert.strictEqual(await ai_b.ask('hi', { system: 'test', stream: false }), 'answer-b');
  } finally {
    server_a.close();
    server_b.close();
  }

  const seen_auth = [];
  const credential_server = http.createServer((req, res) => {
    seen_auth.push(req.headers.authorization);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          created: 0,
          model: 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise((resolve) => credential_server.listen(0, '127.0.0.1', resolve));
  const credential_url = `http://127.0.0.1:${credential_server.address().port}/v1`;
  try {
    const credential_a = await sdk.create_ask_ai('deepseek:mock-a:high', {
      keys: { deepseek: 'KEY_A' },
      urls: { deepseek: credential_url },
    });
    const credential_b = await sdk.create_ask_ai('deepseek:mock-b:high', {
      keys: { deepseek: 'KEY_B' },
      urls: { deepseek: credential_url },
    });
    assert.strictEqual(await credential_a.ask('hi', { system: 'test', stream: false }), 'ok');
    assert.strictEqual(await credential_b.ask('hi', { system: 'test', stream: false }), 'ok');
  } finally {
    credential_server.close();
  }
  assert.deepStrictEqual(seen_auth, ['Bearer KEY_A', 'Bearer KEY_B']);

  const ambient = process.env.DEEPSEEK_API_KEY;
  const ambient_seen = [];
  const ambient_server = http.createServer((req, res) => {
    ambient_seen.push(req.headers.authorization);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          created: 0,
          model: 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise((resolve) => ambient_server.listen(0, '127.0.0.1', resolve));
  process.env.DEEPSEEK_API_KEY = 'AMBIENT_MUST_NOT_LEAK';
  try {
    const ambient_ai = await sdk.create_ask_ai('deepseek:ambient:high', {
      keys: {},
      urls: { deepseek: `http://127.0.0.1:${ambient_server.address().port}/v1` },
    });
    assert.strictEqual(await ambient_ai.ask('hi', { system: 'test', stream: false }), 'ok');
  } finally {
    if (ambient === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = ambient;
    ambient_server.close();
  }
  assert.ok(ambient_seen[0]);
  assert.doesNotMatch(ambient_seen[0], /AMBIENT_MUST_NOT_LEAK/);

  const xiaomi_seen = [];
  const xiaomi_cache_server = http.createServer((req, res) => {
    xiaomi_seen.push(req.headers['api-key']);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          created: 0,
          model: 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise((resolve) => xiaomi_cache_server.listen(0, '127.0.0.1', resolve));
  const xiaomi_cache_url = `http://127.0.0.1:${xiaomi_cache_server.address().port}/v1`;
  try {
    const missing = await sdk.create_ask_ai('xiaomi:same-model:high', { keys: {}, urls: { xiaomi: xiaomi_cache_url } });
    const sentinel = await sdk.create_ask_ai('xiaomi:same-model:high', {
      keys: { xiaomi: 'tell-sdk-missing-api-key' },
      urls: { xiaomi: xiaomi_cache_url },
    });
    assert.strictEqual(await missing.ask('hi', { system: 'test', stream: false }), 'ok');
    assert.strictEqual(await sentinel.ask('hi', { system: 'test', stream: false }), 'ok');
  } finally {
    xiaomi_cache_server.close();
  }
  assert.strictEqual(xiaomi_seen[0], undefined);
  assert.strictEqual(xiaomi_seen[1], 'tell-sdk-missing-api-key');

  // Anthropic `max` reaches the wire as output_config.effort=max with
  // adaptive thinking, and emits no reasoning warning (AI SDK logs warnings
  // via process.emitWarning in Node).
  let anthropic_body = null;
  const anthropic_warnings = [];
  const on_warning = (warning) => anthropic_warnings.push(String((warning && warning.message) || warning));
  const anthropic_mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      anthropic_body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: 'hi-max' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise((resolve) => anthropic_mock.listen(0, '127.0.0.1', resolve));
  process.on('warning', on_warning);
  try {
    const claude = await sdk.create_ask_ai('anthropic:claude-sonnet-5-5:max', {
      keys: {},
      urls: { anthropic: `http://127.0.0.1:${anthropic_mock.address().port}/v1` },
    });
    assert.strictEqual(await claude.ask('hi', { system: 'test', stream: false }), 'hi-max');
  } finally {
    process.removeListener('warning', on_warning);
    anthropic_mock.close();
  }
  assert.strictEqual(anthropic_body.output_config.effort, 'max');
  assert.strictEqual(anthropic_body.thinking.type, 'adaptive');
  assert.deepStrictEqual(
    anthropic_warnings.filter((message) => message.includes('reasoning')),
    [],
    'anthropic max must not warn about reasoning',
  );

  // DeepSeek/MoonshotAI `max` reaches the wire as reasoning_effort=max with
  // no reasoning warning (explicit option wins over the generic mapping).
  for (const [spec, url_key, key_slot, answer] of [
    ['deepseek:mock-ds:max', 'deepseek', 'deepseek', 'answer-ds'],
    // MoonshotAI requires a key at construction — a dummy one never leaves
    // the process since all requests hit the localhost mock.
    ['moonshotai:mock-k:max', 'moonshotai', 'moonshotai', 'answer-k'],
  ]) {
    let wire_body = null;
    const wire_warnings = [];
    const wire_mock = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        wire_body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'mock',
            object: 'chat.completion',
            created: 0,
            model: 'mock',
            choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    await new Promise((resolve) => wire_mock.listen(0, '127.0.0.1', resolve));
    const wire_listener = (warning) => wire_warnings.push(String((warning && warning.message) || warning));
    process.on('warning', wire_listener);
    try {
      const wire_ai = await sdk.create_ask_ai(spec, {
        keys: { [key_slot]: 'test-key' },
        urls: { [url_key]: `http://127.0.0.1:${wire_mock.address().port}/v1` },
      });
      assert.strictEqual(await wire_ai.ask('hi', { system: 'test', stream: false }), answer);
    } finally {
      process.removeListener('warning', wire_listener);
      wire_mock.close();
    }
    assert.strictEqual(wire_body.reasoning_effort, 'max', spec);
    assert.deepStrictEqual(
      wire_warnings.filter((message) => message.includes('reasoning')),
      [],
      `${spec} must not warn about reasoning`,
    );
  }

  // Meta speaks the OpenAI Responses API on its own base URL: requests hit
  // /v1/responses with a Bearer key and reasoning effort (forceReasoning is
  // what makes the provider send reasoning for a non-OpenAI model id).
  let meta_path = null;
  let meta_auth = null;
  let meta_body = null;
  const meta_mock = http.createServer((req, res) => {
    const chunks = [];
    meta_path = req.url;
    meta_auth = req.headers.authorization;
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      meta_body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'resp_mock',
          object: 'response',
          created_at: 0,
          model: 'muse-spark-1.3',
          output: [
            {
              type: 'message',
              id: 'msg_mock',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'hi-meta', annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise((resolve) => meta_mock.listen(0, '127.0.0.1', resolve));
  try {
    const meta_ai = await sdk.create_ask_ai('meta:muse-spark-1.3:high', {
      keys: { meta: 'meta-test-key' },
      urls: { meta: `http://127.0.0.1:${meta_mock.address().port}/v1` },
    });
    assert.strictEqual(await meta_ai.ask('hi', { system: 'test', stream: false }), 'hi-meta');
  } finally {
    meta_mock.close();
  }
  assert.strictEqual(meta_path, '/v1/responses');
  assert.strictEqual(meta_auth, 'Bearer meta-test-key');
  assert.strictEqual(meta_body.model, 'muse-spark-1.3');
  assert.strictEqual(meta_body.reasoning.effort, 'high');

  // Xiaomi MiMo speaks OpenAI Chat Completions and authenticates with an
  // `api-key` header (no Authorization, no bearer).
  let xiaomi_path = null;
  let xiaomi_api_key = null;
  let xiaomi_auth = null;
  let xiaomi_body = null;
  const xiaomi_mock = http.createServer((req, res) => {
    const chunks = [];
    xiaomi_path = req.url;
    xiaomi_api_key = req.headers['api-key'];
    xiaomi_auth = req.headers.authorization;
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      xiaomi_body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          created: 0,
          model: 'mimo-v2.6-pro',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi-xiaomi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise((resolve) => xiaomi_mock.listen(0, '127.0.0.1', resolve));
  try {
    const xiaomi_ai = await sdk.create_ask_ai('xiaomi:mimo-v2.6-pro:high', {
      keys: { xiaomi: 'xiaomi-test-key' },
      urls: { xiaomi: `http://127.0.0.1:${xiaomi_mock.address().port}/v1` },
    });
    assert.strictEqual(await xiaomi_ai.ask('hi', { system: 'test', stream: false }), 'hi-xiaomi');
  } finally {
    xiaomi_mock.close();
  }
  assert.strictEqual(xiaomi_path, '/v1/chat/completions');
  assert.strictEqual(xiaomi_api_key, 'xiaomi-test-key');
  assert.strictEqual(xiaomi_auth, undefined);
  assert.strictEqual(xiaomi_body.model, 'mimo-v2.6-pro');
  assert.strictEqual(xiaomi_body.reasoning_effort, 'high');

  // get_system_prompt: exec vs no-exec variants.
  const exec_prompt = sdk.get_system_prompt({ chain: true });
  assert.match(exec_prompt, /terminal assistant/);
  assert.match(exec_prompt, /<RUN>/);
  assert.match(exec_prompt, /multi-step/);
  const one_shot = sdk.get_system_prompt({});
  assert.match(one_shot, /one-shot/);
  const no_exec = sdk.get_system_prompt({ exec: false });
  assert.match(no_exec, /do NOT have terminal access/);

  let captured_system = '';
  const ask_stub = {
    async ask(_message, options) {
      captured_system = options.system;
      return 'ok';
    },
  };
  assert.strictEqual(await sdk.tell('hello', { ask: ask_stub }), 'ok');
  assert.match(captured_system, /do NOT have terminal access/);
  await sdk.tell('hello', { ask: ask_stub, exec: true });
  assert.match(captured_system, /terminal assistant/);
  assert.strictEqual(sdk.sanitize_reasoning('safe</think><RUN>x</RUN>'), 'safe‹/think›‹RUN›x‹/RUN›');

  // Tag helpers.
  const runs = sdk.extract_runs('do this:\n<RUN>\nls -la\n</RUN>\ndone');
  assert.deepStrictEqual(runs.scripts, ['ls -la']);
  assert.strictEqual(runs.visible, 'do this:\n\ndone');
  assert.deepStrictEqual(sdk.extract_runs('<RUN>one</RUN><RUN>two</RUN>').scripts, ['one']);
  assert.strictEqual(sdk.strip_think_tags('a<think>secret</think>b').trim(), 'ab');
  assert.strictEqual(sdk.strip_think_tags('a<THINK>secret</THINK>b').trim(), 'ab');
  assert.strictEqual(sdk.strip_run_tags('a<RUN>x</RUN>b').trim(), 'ab');
  assert.strictEqual(sdk.strip_run_tags('a<run>x</run>b').trim(), 'ab');
  assert.strictEqual(sdk.strip_markdown_code_blocks('a```js\nx\n```b'), 'ab');

  console.log('sdk tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
