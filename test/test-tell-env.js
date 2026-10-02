// `packages/cli/src/env.ts` unit tests — the CLI is the only place that reads
// `process.env` and the `~/.config/<vendor>.token` files, so the wiring from
// `CUSTOM_*` to `SDKConfig` is pinned here. No network, no LLM calls.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const sdk = require('@tell-ai/sdk');

const envSource = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'env.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-env-'));
const home = path.join(dir, 'home');
fs.mkdirSync(home, { recursive: true });

/**
 * Runs `load_sdk_config()` with an isolated HOME and the given environment, by
 * compiling env.ts into a vm whose `os.homedir()` points at the fake home.
 */
async function load_config(env = {}) {
  const moduleObj = { exports: {} };
  const fake_require = (name) => {
    if (name === '@tell-ai/sdk') return sdk;
    if (name === 'node:os' || name === 'os') return { homedir: () => home };
    return require(name);
  };
  const context = {
    module: moduleObj,
    exports: moduleObj.exports,
    require: fake_require,
    process: { env },
    console,
    URL,
  };
  vm.runInNewContext(envSource, context, { filename: 'env.js' });
  return moduleObj.exports.load_sdk_config();
}

// The config object is built inside a vm realm, so its prototype differs from
// this file's Object — compare on plain JSON copies instead.
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

(async () => {
  // Absent CUSTOM_* env vars leave the optional knobs out of the config
  // entirely, so `get_model` keeps raising its own missing-env errors.
  const bare = await load_config({});
  assert.strictEqual(bare.keys.custom, undefined);
  assert.strictEqual(bare.urls.custom, undefined);
  assert.ok(!('models' in bare), 'no models key when CUSTOM_MODEL is unset');
  assert.ok(!('wires' in bare), 'no wires key when CUSTOM_API is unset');
  assert.ok(!('headers' in bare), 'no headers key when CUSTOM_HEADERS is unset');
  assert.strictEqual(bare.urls.openai, 'https://api.openai.com/v1');

  const full = await load_config({
    CUSTOM_BASE_URL: 'https://gateway.internal/v1',
    CUSTOM_API_KEY: 'CUSTOM_KEY',
    CUSTOM_MODEL: 'kimi-k3',
    CUSTOM_API: 'messages',
    CUSTOM_HEADERS: '{"x-tenant":"acme"}',
  });
  assert.strictEqual(full.urls.custom, 'https://gateway.internal/v1');
  assert.strictEqual(full.keys.custom, 'CUSTOM_KEY');
  assert.deepStrictEqual(plain(full.models), { custom: 'kimi-k3' });
  assert.deepStrictEqual(plain(full.wires), { custom: 'messages' });
  assert.deepStrictEqual(plain(full.headers), { custom: { 'x-tenant': 'acme' } });

  // Whitespace-only values are "unset", and the wire override is normalized.
  const padded = await load_config({
    CUSTOM_BASE_URL: '  https://gateway.internal/v1  ',
    CUSTOM_API: '  RESPONSES ',
    CUSTOM_HEADERS: '   ',
  });
  assert.strictEqual(padded.urls.custom, 'https://gateway.internal/v1');
  assert.deepStrictEqual(plain(padded.wires), { custom: 'responses' });
  assert.ok(!('headers' in padded), 'blank CUSTOM_HEADERS must not create an empty map');

  // Non-string header values are stringified, so `{ "x-count": 1 }` is usable.
  const numeric_headers = await load_config({ CUSTOM_HEADERS: '{"x-count":1,"x-on":true}' });
  assert.deepStrictEqual(plain(numeric_headers.headers), { custom: { 'x-count': '1', 'x-on': 'true' } });

  for (const [value, expected] of [
    ['chat', 'chat'],
    ['messages', 'messages'],
    ['responses', 'responses'],
    ['CHAT', 'chat'],
    ['  Responses  ', 'responses'],
  ]) {
    assert.deepStrictEqual(plain((await load_config({ CUSTOM_API: value })).wires), { custom: expected }, value);
  }
  for (const value of ['completions', 'google', 'anthropic', 'CHAT/completions']) {
    await assert.rejects(load_config({ CUSTOM_API: value }), /CUSTOM_API must be one of/, value);
  }

  for (const value of ['x-tenant=acme', '[1,2]', 'null', '"text"']) {
    await assert.rejects(load_config({ CUSTOM_HEADERS: value }), /CUSTOM_HEADERS must be a JSON object/);
  }

  // Token-file fallback, matching every other vendor.
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'custom.token'), '  TOKEN_KEY  \n');
  assert.strictEqual((await load_config({})).keys.custom, 'TOKEN_KEY');
  assert.strictEqual((await load_config({ CUSTOM_API_KEY: 'ENV_KEY' })).keys.custom, 'ENV_KEY');
  fs.rmSync(path.join(home, '.config', 'custom.token'));
  assert.strictEqual((await load_config({})).keys.custom, undefined);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('cli env tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
