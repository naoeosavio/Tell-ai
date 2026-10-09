// test-tell-tellrc.js
//
// Coverage for `.tellrc` (packages/cli/src/tellrc.ts): INI-only schema,
// precedence, profiles, aliases, temperature and limits. No network, no
// secrets in config/log. The web forwarding layer is covered through
// `cli-args` parsing (pure) plus launch_web arg assertions.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const sdk = require('@tell-ai/sdk');

const COMMON_COMPILER_OPTIONS = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020,
  esModuleInterop: true,
};

function load_tellrc_module() {
  const source = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'tellrc.ts'), 'utf8'),
    { compilerOptions: COMMON_COMPILER_OPTIONS },
  ).outputText;
  const module = { exports: {} };
  const fn = new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', source);
  fn(require, module, module.exports, path.join(__dirname, '..', 'packages', 'cli', 'src'), 'tellrc.ts', process);
  return module.exports;
}

function load_cli_args_module() {
  const source = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '..', 'packages', 'web', 'src', 'server', 'cli-args.ts'), 'utf8'),
    { compilerOptions: COMMON_COMPILER_OPTIONS },
  ).outputText;
  const module = { exports: {} };
  const fn = new Function('require', 'module', 'exports', source);
  fn(require, module, module.exports);
  return module.exports;
}

const tellrc = load_tellrc_module();
const cli_args = load_cli_args_module();

function test_missing_file_is_silent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tellrc-'));
  const layers = tellrc.load_tellrc(path.join(dir, 'cwd'), path.join(dir, 'home'));
  assert.deepStrictEqual(layers, []);
  const resolved = tellrc.resolve_tellrc(layers, {}, {});
  assert.deepStrictEqual(resolved.aliases, {});
  assert.deepStrictEqual(resolved.deny_commands, []);
  assert.strictEqual(resolved.model, undefined);
}

function test_comments_duplicates_unknown_section() {
  const parsed = tellrc.parse_tellrc(
    '# full line comment\n; another comment\nmodel = g\nmodel = s\n[aliases]\nmyalias = openai:gpt-6.1-sol:high\n[unknown]\nfoo = bar\n',
    'test',
  );
  assert.strictEqual(parsed.model, 's');
  assert.strictEqual(parsed.aliases['myalias'], 'openai:gpt-6.1-sol:high');
  assert.ok(parsed.warnings.some((w) => w.includes('unknown section')));
  assert.ok(!parsed.warnings.some((w) => w.includes('openai')));
}

function test_hash_semicolon_preserved_in_values() {
  const parsed = tellrc.parse_tellrc('system = hello # not a comment ; still value\n', 'test');
  assert.strictEqual(parsed.system, 'hello # not a comment ; still value');
}

function test_tilde_expands_only_in_paths() {
  assert.strictEqual(tellrc.expand_tilde_path('~/docs', '/home/u'), path.join('/home/u', 'docs'));
  assert.strictEqual(tellrc.expand_tilde_path('~', '/home/u'), '/home/u');
  const parsed = tellrc.parse_tellrc('system = ~/not-a-path-value\n', 'test');
  assert.strictEqual(parsed.system, '~/not-a-path-value');
}

function test_nul_rejected() {
  const parsed = tellrc.parse_tellrc('model = g\0\n', 'test');
  assert.ok(parsed.warnings.length > 0);
}

function test_size_cap_ignored() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tellrc-'));
  const file = path.join(dir, '.tellrc');
  fs.writeFileSync(file, 'x'.repeat(tellrc.TELLRC_MAX_BYTES + 1));
  const parsed = tellrc.load_tellrc_file(file);
  assert.ok(parsed && parsed.warnings.some((w) => w.includes('256 KB')));
  assert.strictEqual(parsed.model, undefined);
}

function test_directory_rejected_for_system_file() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tellrc-'));
  const text = tellrc.load_system_file_text(dir, dir, os.homedir(), true);
  assert.strictEqual(text, undefined);
}

function test_system_file_cap_and_symlink_gate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tellrc-'));
  const big = path.join(dir, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(tellrc.SYSTEM_FILE_MAX_BYTES + 1));
  assert.strictEqual(tellrc.load_system_file_text(big, dir, os.homedir(), false), undefined);
  const outside = path.join(os.tmpdir(), `tellrc-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'secret-ish content');
  try {
    const link = path.join(dir, 'link.txt');
    try {
      fs.symlinkSync(outside, link);
    } catch {
      return;
    }
    assert.strictEqual(tellrc.load_system_file_text(link, dir, os.homedir(), true), undefined);
  } finally {
    fs.rmSync(outside, { force: true });
  }
}

function test_system_file_ok() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tellrc-'));
  const file = path.join(dir, 'sys.txt');
  fs.writeFileSync(file, 'Be concise.');
  assert.strictEqual(tellrc.load_system_file_text(file, dir, os.homedir(), true), 'Be concise.');
}

function test_precedence_matrix() {
  const user = { ...tellrc.empty_parsed_tellrc('user'), rank: 1, model: 'g' };
  const project = { ...tellrc.empty_parsed_tellrc('project'), rank: 2, model: 's' };
  let resolved = tellrc.resolve_tellrc([user, project], {}, {});
  assert.strictEqual(resolved.model, 's');
  assert.strictEqual(resolved.provenance['model'], 'project');
  resolved = tellrc.resolve_tellrc([user, project], {}, { TELL_MODEL: 'o' });
  assert.strictEqual(resolved.model, 'o');
  resolved = tellrc.resolve_tellrc([user, project], { model: 'f' }, { TELL_MODEL: 'o' });
  assert.strictEqual(resolved.model, 'f');
  assert.strictEqual(resolved.provenance['model'], 'flag');
}

function test_deny_union_monotonic() {
  const user = { ...tellrc.empty_parsed_tellrc('user'), rank: 1, deny_commands: ['rm -rf /'] };
  const project = { ...tellrc.empty_parsed_tellrc('project'), rank: 2, deny_commands: ['mkfs'] };
  const resolved = tellrc.resolve_tellrc([user, project], {}, {});
  assert.deepStrictEqual(resolved.deny_commands, ['rm -rf /', 'mkfs']);
  assert.strictEqual(resolved.provenance['deny_commands'], 'union');
}

function test_profiles_data() {
  const layer = tellrc.empty_parsed_tellrc('user');
  layer.profile = 'node';
  const resolved = tellrc.resolve_tellrc([{ ...layer, rank: 1 }], {}, {});
  assert.strictEqual(resolved.profile, 'node');
  assert.ok(resolved.profile_data && resolved.profile_data.prompt);
  const security = tellrc.resolve_tellrc([], { profile: 'security' }, {});
  assert.strictEqual(security.profile_data.name, 'security');
  const unknown = tellrc.resolve_tellrc([], { profile: 'nope' }, {});
  assert.strictEqual(unknown.profile_data, undefined);
  assert.ok(unknown.warnings.some((w) => w.includes('selected but not defined')));
  const invalid = tellrc.resolve_tellrc([], { profile: 'Bad Name!' }, {});
  assert.strictEqual(invalid.profile_data, undefined);
  assert.ok(invalid.warnings.some((w) => w.includes('invalid profile name')));
}

function test_custom_profile_name_accepted() {
  const parsed = tellrc.parse_tellrc(
    '[profiles.backend]\nprompt = Backend reviewer.\nstyle = thorough\nmodel = s\ntemperature = 0.3\ndeny = mkfs\nmax_chain_steps = 3\n',
    'test',
  );
  assert.ok(parsed.warnings.length === 0);
  assert.strictEqual(parsed.profiles['backend'].prompt, 'Backend reviewer.');
  const resolved = tellrc.resolve_tellrc([{ ...parsed, source: 'user', rank: 1 }], {}, {});
  assert.strictEqual(resolved.profile, undefined);
  const selected = tellrc.resolve_tellrc([{ ...parsed, source: 'user', rank: 1 }], { profile: 'backend' }, {});
  assert.strictEqual(selected.profile, 'backend');
  assert.strictEqual(selected.profile_data.prompt, 'Backend reviewer.');
  assert.strictEqual(selected.profile_data.style, 'thorough');
  assert.strictEqual(selected.model, 's');
  assert.strictEqual(selected.temperature, 0.3);
  assert.deepStrictEqual(selected.deny_commands, ['mkfs']);
  assert.strictEqual(selected.limits.max_chain_steps, 3);
}

function test_invalid_profile_section_name() {
  const parsed = tellrc.parse_tellrc('[profiles.Bad Name!]\nprompt = x\n[profiles.]\nprompt = y\n[profiles]\nprompt = z\n', 'test');
  assert.ok(parsed.warnings.some((w) => w.includes('unknown section [profiles.bad name!]')));
  assert.ok(parsed.warnings.some((w) => w.includes('unknown section [profiles.]')));
  assert.ok(parsed.warnings.some((w) => w.includes('unknown section [profiles]')));
  assert.deepStrictEqual(Object.keys(parsed.profiles), []);
}

function test_profile_system_fill_and_precedence() {
  const parsed = tellrc.parse_tellrc('[profiles.backend]\nsystem = Profile system.\n', 'test');
  const filled = tellrc.resolve_tellrc([{ ...parsed, source: 'user', rank: 1 }], { profile: 'backend' }, {});
  assert.strictEqual(filled.system, 'Profile system.');
  assert.strictEqual(filled.provenance['system'], 'profile:backend');
  const filled_text = tellrc.tellrc_custom_text({ ...filled, system_text: undefined });
  assert.strictEqual(filled_text.split('Profile system.').length - 1, 1);
  const explicit = tellrc.resolve_tellrc([{ ...parsed, source: 'user', rank: 1 }], { profile: 'backend', system: 'Flag system.' }, {});
  assert.strictEqual(explicit.system, 'Flag system.');
  assert.strictEqual(explicit.provenance['system'], 'flag');
  const custom = tellrc.tellrc_custom_text({ ...explicit, system_text: undefined });
  assert.ok(custom.includes('Flag system.'));
  assert.ok(!custom.includes('Profile system.'));
}

function test_profile_system_file_resolved() {
  const parsed = tellrc.parse_tellrc('[profiles.backend]\nsystem-file = ./docs/SYS.md\n', 'test');
  const resolved = tellrc.resolve_tellrc([{ ...parsed, source: '/home/u/.tellrc', rank: 1 }], { profile: 'backend' }, {});
  assert.strictEqual(resolved.system_file, './docs/SYS.md');
  assert.strictEqual(resolved.profile_data.system_file_from, '/home/u/.tellrc');
  const with_text = tellrc.tellrc_custom_text({
    ...resolved,
    profile_data: { ...resolved.profile_data, system_text: 'File payload.' },
  });
  assert.ok(with_text.startsWith('File payload.'));
}

function test_profile_aliases_subsection_and_order() {
  const before = JSON.parse(JSON.stringify(sdk.MODELS));
  const user = tellrc.parse_tellrc('[profiles.backend.aliases]\nrev = s+\n', 'user');
  assert.strictEqual(user.profiles['backend'].aliases['rev'], 's+');
  const project = tellrc.parse_tellrc('[aliases]\nrev = o\n[profiles.backend.aliases]\nship = g\n', 'project');
  const resolved = tellrc.resolve_tellrc(
    [{ ...user, source: 'user', rank: 1 }, { ...project, source: 'project', rank: 2 }],
    { profile: 'backend' },
    {},
  );
  // File-level aliases win over profile aliases (project > user > profile).
  assert.strictEqual(resolved.aliases['rev'], 'o');
  assert.strictEqual(resolved.aliases['ship'], 'g');
  assert.strictEqual(tellrc.resolve_model_input('ship', resolved.aliases, sdk.MODELS), 'g');
  assert.deepStrictEqual(sdk.MODELS, before);
}

function test_profile_alias_subsection_invalid_name() {
  const parsed = tellrc.parse_tellrc('[profiles.??.aliases]\nrev = s+\n', 'test');
  assert.ok(parsed.warnings.some((w) => w.includes('unknown section')));
  assert.deepStrictEqual(Object.keys(parsed.profiles), []);
}

function test_alias_resolution_no_mutation() {
  const before = JSON.parse(JSON.stringify(sdk.MODELS));
  const aliases = { work: 'openai:gpt-6.1-sol:high' };
  assert.strictEqual(tellrc.resolve_model_input('work', aliases, sdk.MODELS), 'openai:gpt-6.1-sol:high');
  assert.strictEqual(tellrc.resolve_model_input('g', aliases, sdk.MODELS), 'g');
  assert.strictEqual(tellrc.resolve_model_input('.g', aliases, sdk.MODELS), '.g');
  assert.strictEqual(
    tellrc.resolve_model_input('openai:gpt-6.1-sol:high', aliases, sdk.MODELS),
    'openai:gpt-6.1-sol:high',
  );
  assert.deepStrictEqual(sdk.MODELS, before);
}

function test_temperature_validation() {
  assert.strictEqual(tellrc.validate_temperature(0.7), 0.7);
  assert.strictEqual(tellrc.validate_temperature('1.5'), 1.5);
  assert.strictEqual(tellrc.validate_temperature(99), undefined);
  assert.strictEqual(tellrc.validate_temperature('hot'), undefined);
  const resolved = tellrc.resolve_tellrc([], { temperature: 1 }, {});
  assert.strictEqual(resolved.temperature, 1);
}

function test_limits_validated() {
  assert.strictEqual(tellrc.validate_limit_value('max_chain_steps', 4), 4);
  assert.strictEqual(tellrc.validate_limit_value('max_chain_steps', 99), undefined);
  assert.strictEqual(tellrc.validate_limit_value('max_buffer_bytes', 1024), 1024);
  const parsed = tellrc.parse_tellrc('[limits]\nmax_chain_steps = 3\ncontext_chars = 999999999\n', 'test');
  assert.strictEqual(parsed.limits.max_chain_steps, 3);
  assert.strictEqual(parsed.limits.context_chars, undefined);
}

function test_compose_system_safety_last() {
  const safety = 'safety <RUN> approval injection deny';
  const composed = tellrc.compose_system_prompt(safety, 'Be concise.');
  assert.ok(composed.startsWith('Custom instructions:'));
  assert.ok(composed.endsWith(safety));
  assert.strictEqual(tellrc.compose_system_prompt(safety, ''), safety);
  const custom = tellrc.tellrc_custom_text({ aliases: {}, deny_commands: [], limits: {}, provenance: {}, warnings: [] });
  assert.strictEqual(custom, '');
}

async function test_sdk_temperature_propagates() {
  const ai = await sdk.create_ask_ai('g', { keys: {}, urls: {} });
  let threw = false;
  try {
    await ai.ask('hi', { system: 'sys', stream: false, temperature: 99 });
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assert.ok(threw);
}

function test_web_cli_args_forwarding() {
  const parsed = cli_args.parseCliArgs(
    ['--cwd', '/tmp', '--profile', 'node', '--system-file', '/tmp/sys.txt', '--max-chain-steps', '4'],
    '/tmp',
  );
  assert.strictEqual(parsed.profile, 'node');
  assert.strictEqual(parsed.systemFile, '/tmp/sys.txt');
  assert.strictEqual(parsed.maxChainSteps, 4);
  const plain = cli_args.parseCliArgs(['--cwd', '/tmp', '--prompt', 'hi', '--port', '3000'], '/tmp');
  assert.strictEqual(plain.profile, undefined);
  assert.strictEqual(plain.model, '');
}

const TESTS = [
  test_missing_file_is_silent,
  test_comments_duplicates_unknown_section,
  test_hash_semicolon_preserved_in_values,
  test_tilde_expands_only_in_paths,
  test_nul_rejected,
  test_size_cap_ignored,
  test_directory_rejected_for_system_file,
  test_system_file_cap_and_symlink_gate,
  test_system_file_ok,
  test_precedence_matrix,
  test_deny_union_monotonic,
  test_profiles_data,
  test_custom_profile_name_accepted,
  test_invalid_profile_section_name,
  test_profile_system_fill_and_precedence,
  test_profile_system_file_resolved,
  test_profile_aliases_subsection_and_order,
  test_profile_alias_subsection_invalid_name,
  test_alias_resolution_no_mutation,
  test_temperature_validation,
  test_limits_validated,
  test_compose_system_safety_last,
  test_sdk_temperature_propagates,
  test_web_cli_args_forwarding,
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
    console.log('\ntell tellrc tests passed');
  }
})();
