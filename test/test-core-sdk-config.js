// Core sdk-config tests — offline, fake environments only.
// Proves one owner for the vendor → key/url mapping: the CLI (`token_files:
// true`) and the Web server (`token_files: false`) build the same `SDKConfig`
// from the same environment, every vendor honors its `*_BASE_URL` override,
// and the `CUSTOM_*` knobs fail loudly instead of degrading silently.
// Run with: node --test test/test-core-sdk-config.js (after the core build).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const core = require('../packages/core/dist/index.cjs');

const cli_source = { token_files: true, home_dir: path.join(os.tmpdir(), 'core-sdk-config-no-home') };
const web_source = { token_files: false };

describe('load_sdk_config_from_env parity', () => {
  it('builds the same config for the CLI and the Web from one environment', async () => {
    const env = {
      OPENAI_API_KEY: 'sk-openai',
      GOOGLE_API_KEY: 'sk-google',
      MIMO_API_KEY: 'sk-xiaomi',
      CUSTOM_API_KEY: 'sk-custom',
      CUSTOM_BASE_URL: 'https://gateway.internal/v1',
      CUSTOM_MODEL: 'kimi-k3',
      CUSTOM_API: 'messages',
      CUSTOM_HEADERS: '{"x-tenant":"acme"}',
    };
    const cli = await core.load_sdk_config_from_env(env, cli_source);
    const web = await core.load_sdk_config_from_env(env, web_source);
    assert.deepStrictEqual(cli, web);
    // The sync builder (what the Web server runs) matches the async loader
    // over the same env when no token file is involved.
    assert.deepStrictEqual(core.build_sdk_config_from_env(env), web);
    assert.strictEqual(cli.keys.openai, 'sk-openai');
    assert.strictEqual(cli.keys.google, 'sk-google');
    assert.strictEqual(cli.keys.xiaomi, 'sk-xiaomi');
    assert.strictEqual(cli.urls.custom, 'https://gateway.internal/v1');
    assert.deepStrictEqual(cli.models, { custom: 'kimi-k3' });
    assert.deepStrictEqual(cli.wires, { custom: 'messages' });
    assert.deepStrictEqual(cli.headers, { custom: { 'x-tenant': 'acme' } });
  });

  it('honors every *_BASE_URL override, not just five vendors', async () => {
    const config = await core.load_sdk_config_from_env(
      {
        OPENAI_BASE_URL: 'https://proxy.internal/v1',
        GOOGLE_BASE_URL: 'https://google-proxy.internal/',
        OPENROUTER_BASE_URL: 'https://or-proxy.internal/api/v1',
        VAST_BASE_URL: 'https://vast.internal/v1',
        LOCAL_OPENAI_BASE_URL: 'http://localhost:11434/v1',
      },
      web_source,
    );
    assert.strictEqual(config.urls.openai, 'https://proxy.internal/v1');
    assert.strictEqual(config.urls.google, 'https://google-proxy.internal/');
    assert.strictEqual(config.urls.openrouter, 'https://or-proxy.internal/api/v1');
    assert.strictEqual(config.urls.vast, 'https://vast.internal/v1');
    assert.strictEqual(config.urls.local, 'http://localhost:11434/v1');
  });

  it('keeps the documented defaults when no override is set', async () => {
    const config = await core.load_sdk_config_from_env({}, web_source);
    assert.strictEqual(config.urls.openai, 'https://api.openai.com/v1');
    assert.strictEqual(config.urls.anthropic, 'https://api.anthropic.com/v1');
    assert.strictEqual(config.keys.openai, undefined);
    assert.strictEqual(config.urls.custom, undefined);
    assert.strictEqual(config.urls.vast, undefined);
    assert.ok(!('models' in config));
    assert.ok(!('wires' in config));
    assert.ok(!('headers' in config));
  });

  it('tries key aliases in order and trims whitespace', async () => {
    const config = await core.load_sdk_config_from_env(
      { GEMINI_API_KEY: '  sk-gemini  ', GOOGLE_API_KEY: '' },
      web_source,
    );
    assert.strictEqual(config.keys.google, 'sk-gemini');
  });
});

describe('load_sdk_config_from_env token files', () => {
  it('falls back to ~/.config/<vendor>.token only when enabled', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'core-sdk-config-home-'));
    fs.mkdirSync(path.join(home, '.config'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'openai.token'), '  sk-file  \n');
    try {
      const cli = await core.load_sdk_config_from_env({}, { token_files: true, home_dir: home });
      assert.strictEqual(cli.keys.openai, 'sk-file');
      const web = await core.load_sdk_config_from_env({}, { token_files: false, home_dir: home });
      assert.strictEqual(web.keys.openai, undefined);
      const env_wins = await core.load_sdk_config_from_env(
        { OPENAI_API_KEY: 'sk-env' },
        { token_files: true, home_dir: home },
      );
      assert.strictEqual(env_wins.keys.openai, 'sk-env');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('load_sdk_config_from_env custom knobs', () => {
  it('normalizes the wire override and stringifies header values', async () => {
    const config = await core.load_sdk_config_from_env(
      { CUSTOM_API: '  RESPONSES ', CUSTOM_HEADERS: '{"x-count":1}' },
      web_source,
    );
    assert.deepStrictEqual(config.wires, { custom: 'responses' });
    assert.deepStrictEqual(config.headers, { custom: { 'x-count': '1' } });
  });

  it('fails loudly on an invalid CUSTOM_API or CUSTOM_HEADERS', async () => {
    await assert.rejects(core.load_sdk_config_from_env({ CUSTOM_API: 'completions' }, web_source), /CUSTOM_API must be one of/);
    await assert.rejects(core.load_sdk_config_from_env({ CUSTOM_HEADERS: 'x=1' }, web_source), /CUSTOM_HEADERS must be a JSON object/);
    await assert.rejects(core.load_sdk_config_from_env({ CUSTOM_HEADERS: '[1]' }, web_source), /CUSTOM_HEADERS must be a JSON object/);
  });
});
