// test-tell-runtime-limits.js
//
// Coverage for the runtime-limits owner (`packages/core/src/runtime-limits.ts`)
// plus its CLI wiring in `packages/cli/src/Tell.ts`: defaults, precedence
// flag > env > project > user > default, zero-timeout disable, invalid values
// (exit 2), stdin timeout/bytes (124/125), output caps/markers, exit status
// and turn/tag-atomic `truncate_context`.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load_module(rel, export_names) {
  // Recursively compiles from source so relative imports (e.g. the
  // loop-feedback headers runtime-limits.ts imports) resolve against the
  // importing file, not this harness. Bare specifiers keep Node resolution.
  const compiled = new Map();
  function compile_source(abs_path) {
    if (compiled.has(abs_path)) {
      return compiled.get(abs_path);
    } else {
      // Not compiled yet — transpile and evaluate below.
    }
    const source = ts.transpileModule(fs.readFileSync(abs_path, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const mod = new module.constructor();
    mod.paths = module.paths;
    const local_require = (spec) => {
      if (spec.startsWith('.')) {
        let resolved = path.normalize(path.join(path.dirname(abs_path), spec));
        if (!/\.[a-z]+$/i.test(resolved)) {
          resolved += '.ts';
        } else {
          // Explicit extension — use as resolved.
        }
        return compile_source(resolved);
      } else {
        return require(spec);
      }
    };
    new Function('module', 'exports', 'require', source)(mod, mod.exports, local_require);
    compiled.set(abs_path, mod.exports);
    return mod.exports;
  }
  const exports = compile_source(path.join(__dirname, '..', rel));
  const out = {};
  for (const name of export_names) out[name] = exports[name];
  return out;
}

const rl = load_module('packages/core/src/runtime-limits.ts', [
  'parse_runtime_limits',
  'truncate_context',
  'truncate_output',
  'build_execution_options',
  'split_context_turns',
  'has_balanced_tags',
  'runtime_env_from_process',
  'StdinLimitError',
  'RuntimeLimitError',
  'DEFAULT_CONTEXT_MAX_CHARS',
  'DEFAULT_STDIN_TIMEOUT_MS',
  'DEFAULT_STDIN_MAX_BYTES',
  'DEFAULT_EXEC_TIMEOUT_MS',
  'DEFAULT_MAX_CHAIN_STEPS',
  'MAX_CHAIN_STEPS',
  'DEFAULT_MAX_BUFFER_BYTES',
  'DEFAULT_OUTPUT_MAX_BYTES',
  'TELLRC_LIMIT_KEYS',
  'EXIT_CONFIG_ERROR',
  'EXIT_TIMEOUT',
  'EXIT_LIMIT',
]);

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// --- defaults preserve the real CLI baseline (64 Ki / 30 s / 120 s / 8 / 32 Mi) ---
check('defaults match Tell.ts baseline', () => {
  assert.equal(rl.DEFAULT_CONTEXT_MAX_CHARS, 64 * 1024);
  assert.equal(rl.DEFAULT_STDIN_TIMEOUT_MS, 30_000);
  assert.equal(rl.DEFAULT_STDIN_MAX_BYTES, 1_048_576);
  assert.equal(rl.DEFAULT_EXEC_TIMEOUT_MS, 120_000);
  assert.equal(rl.DEFAULT_MAX_CHAIN_STEPS, 8);
  assert.equal(rl.DEFAULT_MAX_BUFFER_BYTES, 32 * 1024 * 1024);
  assert.equal(rl.DEFAULT_OUTPUT_MAX_BYTES, 204_800);
  const limits = rl.parse_runtime_limits({});
  assert.equal(limits.context_max_chars, 64 * 1024);
  assert.equal(limits.stdin_timeout_ms, 30_000);
  assert.equal(limits.stdin_max_bytes, 1_048_576);
  assert.equal(limits.exec_timeout_ms, 120_000);
  assert.equal(limits.max_chain_steps, 8);
  assert.equal(limits.max_buffer_bytes, 32 * 1024 * 1024);
  assert.equal(limits.output_max_bytes, 204_800);
});

// --- precedence flag > env > project > user > default ---
check('precedence flag wins over env/tellrc/default', () => {
  const limits = rl.parse_runtime_limits({
    flags: { max_chain_steps: '3' },
    env: { TELL_MAX_CHAIN_STEPS: '5' },
    project: { source: 'proj', limits: { max_chain_steps: 6 } },
    user: { source: 'user', limits: { max_chain_steps: 7 } },
  });
  assert.equal(limits.max_chain_steps, 3);
});

check('precedence env wins over tellrc', () => {
  const limits = rl.parse_runtime_limits({
    env: { TELL_CONTEXT_MAX_CHARS: '8192' },
    project: { source: 'proj', limits: { context_chars: 16384 } },
    user: { source: 'user', limits: { context_chars: 32768 } },
  });
  assert.equal(limits.context_max_chars, 8192);
});

check('precedence project wins over user', () => {
  const limits = rl.parse_runtime_limits({
    project: { source: 'proj', limits: { context_chars: 16384 } },
    user: { source: 'user', limits: { context_chars: 32768 } },
  });
  assert.equal(limits.context_max_chars, 16384);
});

check('precedence user used when higher layers absent', () => {
  const limits = rl.parse_runtime_limits({ user: { source: 'user', limits: { context_chars: 32768 } } });
  assert.equal(limits.context_max_chars, 32768);
});

// --- zero timeout disables the deadline ---
check('--no-stdin-timeout resolves to zero', () => {
  const limits = rl.parse_runtime_limits({ flags: { no_stdin_timeout: true } });
  assert.equal(limits.stdin_timeout_ms, 0);
});

check('stdin timeout zero via env disables deadline', () => {
  const limits = rl.parse_runtime_limits({ env: { TELL_STDIN_TIMEOUT_MS: '0' } });
  assert.equal(limits.stdin_timeout_ms, 0);
});

// --- invalid flag/env/tellrc fail with exit 2 (never silent default) ---
check('max-chain range is 1..128', () => {
  assert.equal(rl.MAX_CHAIN_STEPS, 128);
  assert.equal(rl.parse_runtime_limits({ flags: { max_chain_steps: '1' } }).max_chain_steps, 1);
  assert.equal(rl.parse_runtime_limits({ flags: { max_chain_steps: '99' } }).max_chain_steps, 99);
  assert.equal(rl.parse_runtime_limits({ flags: { max_chain_steps: '128' } }).max_chain_steps, 128);
  assert.equal(rl.parse_runtime_limits({ env: { TELL_MAX_CHAIN_STEPS: '20' } }).max_chain_steps, 20);
});

check('invalid flag fails with exit 2', () => {
  assert.throws(() => rl.parse_runtime_limits({ flags: { max_chain_steps: '129' } }), (err) => {
    assert.equal(err.exit_code, 2);
    assert.equal(err.limit, 'max_chain_steps');
    assert.ok(String(err.message).includes('1..128'));
    return true;
  });
  assert.throws(() => rl.parse_runtime_limits({ flags: { max_chain_steps: '0' } }), (err) => {
    assert.equal(err.exit_code, 2);
    return true;
  });
});

check('non-numeric flag fails with exit 2', () => {
  assert.throws(() => rl.parse_runtime_limits({ flags: { exec_timeout_ms: 'fast' } }), (err) => {
    assert.equal(err.exit_code, rl.EXIT_CONFIG_ERROR);
    return true;
  });
});

check('invalid env fails with exit 2', () => {
  assert.throws(() => rl.parse_runtime_limits({ env: { TELL_EXEC_TIMEOUT_MS: '1' } }), (err) => {
    assert.equal(err.exit_code, 2);
    return true;
  });
});

check('invalid project tellrc is diagnosable with source', () => {
  assert.throws(
    () => rl.parse_runtime_limits({ project: { source: '/w/.tellrc', limits: { max_chain_steps: 129 } } }),
    (err) => {
      assert.equal(err.exit_code, 2);
      assert.ok(String(err.message).includes('/w/.tellrc'));
      return true;
    },
  );
});

check('invalid user tellrc fails with exit 2', () => {
  assert.throws(() => rl.parse_runtime_limits({ user: { source: '~/.tellrc', limits: { context_chars: 10 } } }), (err) => {
    assert.equal(err.exit_code, 2);
    return true;
  });
});

// --- StdinLimitError carries stable 124/125 ---
check('stdin errors map to 124/125', () => {
  const timeout = new rl.StdinLimitError('timeout', 'timed out');
  const overflow = new rl.StdinLimitError('overflow', 'too big');
  assert.equal(timeout.exit_code, 124);
  assert.equal(timeout.exit_code, rl.EXIT_TIMEOUT);
  assert.equal(overflow.exit_code, 125);
  assert.equal(overflow.exit_code, rl.EXIT_LIMIT);
});

// --- truncate_context: whole turns, marker, tag balance ---
check('short text passes through untouched', () => {
  assert.equal(rl.truncate_context('User:\nhi', 65536), 'User:\nhi');
});

check('drops oldest whole turns with marker', () => {
  const text = 'User:\nfirst\nAssistant:\nsecond\nUser:\nthird';
  // The marker is part of the budget: 27 + the newest turn (10) fits in 40.
  const out = rl.truncate_context(text, 40);
  assert.ok(out.startsWith('[older context truncated]'));
  assert.ok(out.includes('third'));
  assert.ok(!out.includes('first'));
  assert.ok(out.length <= 40);
});

check('never splits a <RUN> block across the cut', () => {
  const run = '<RUN>\necho hello world\n</RUN>';
  const text = `User:\nold question\n${run}\nAssistant:\n${run}\nUser:\nnew question here`;
  const out = rl.truncate_context(text, 120);
  assert.ok(!/<$/.test(out));
  assert.ok(!/<\/?R?$/.test(out));
  assert.equal(rl.has_balanced_tags(out), true);
});

check('never splits a <DELEGATE> block across the cut', () => {
  const block = '<DELEGATE>\nlist the txt files\n</DELEGATE>';
  const text = `User:\nold question\n${block}\nAssistant:\n${block}\nUser:\nnew question here`;
  const out = rl.truncate_context(text, 120);
  assert.ok(!/<$/.test(out));
  assert.equal(rl.has_balanced_tags(out), true);
});

check('unclosed <SUBTASK> opener is closed, not leaked raw', () => {
  // Single-turn path (budget < 1024): the tail retains the opener, so the
  // balancer must close it — same contract as an unclosed <RUN>.
  const big = `User:\n${'x'.repeat(2000)}\n<SUBTASK>\nshort`;
  const out = rl.truncate_context(big, 512);
  assert.ok(out.includes('<SUBTASK>'), 'opener survives the cut');
  assert.ok(out.includes('</SUBTASK>'), 'balancer closes the opener');
  assert.equal(rl.has_balanced_tags(out), true);
});

check('orphan delegation closers are dropped from a cut tail', () => {
  // Head-cut tail keeps only `</DELEGATE>`: no opener, so it must go.
  assert.equal(rl.has_balanced_tags('tail text\n</DELEGATE>'), false);
  const big = `${'z'.repeat(3000)}\n</DELEGATE>\nUser:\nfinal question here?`;
  const out = rl.truncate_context(big, 512);
  assert.equal(rl.has_balanced_tags(out), true);
  assert.ok(out.includes('final question here?'));
});

check('never splits a <think> block', () => {
  const text = `User:\nq1\nAssistant:\n<think>reasoning one two three</think>\nanswer one\nUser:\nq2 new`;
  const out = rl.truncate_context(text, 60);
  assert.equal(rl.has_balanced_tags(out), true);
  assert.ok(!out.includes('<thi') || out.includes('</think>') || !out.includes('<think>'));
});

check('single oversized message is tail-cut safely', () => {
  const big = `User:\n${'x'.repeat(5000)}<RUN>\n${'y'.repeat(5000)}\n</RUN>`;
  const out = rl.truncate_context(big, 2048);
  assert.ok(out.startsWith('[older context truncated]'));
  assert.ok(out.length <= 2048 + '[older context truncated]\n'.length + 20);
  assert.equal(rl.has_balanced_tags(out), true);
});

check('unbalanced turn is dropped, not emitted half-tagged', () => {
  const text = `User:\nfirst\nAssistant:\n<think>unclosed reasoning\nUser:\nsecond fresh`;
  // Budget below the text length forces truncation; the remainder must stay balanced.
  const out = rl.truncate_context(text, 60);
  assert.ok(!out.includes('unclosed') || rl.has_balanced_tags(out));
  // A text that fits the budget passes through untouched (no rewriting of history).
  assert.equal(rl.truncate_context(text, 1024), text);
});

check('unicode survives truncation', () => {
  const text = `User:\n${'héllo wörld 🌱 '.repeat(200)}\nAssistant:\n${'réponse ✓ '.repeat(200)}\nUser:\nfinal?`;
  const out = rl.truncate_context(text, 2048);
  assert.ok(out.includes('final?'));
});

// --- truncate_output: exact/exceeded, marker, no raw leakage beyond cap ---
check('output under cap passes through', () => {
  assert.equal(rl.truncate_output('hello', 204800), 'hello');
});

check('output at exact cap passes through', () => {
  const exact = 'a'.repeat(2048);
  assert.equal(rl.truncate_output(exact, 2048), exact);
});

check('output over cap is cut with marker inside budget', () => {
  const out = rl.truncate_output('a'.repeat(3000), 2048);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 2048);
  assert.ok(out.includes('[output truncated at 2048 bytes]'));
});

check('multibyte output never splits a character', () => {
  const out = rl.truncate_output('🌱'.repeat(2000), 2048);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 2048);
  assert.ok(out.includes('[output truncated at 2048 bytes]'));
  assert.ok(!out.includes('�'));
});

// --- build_execution_options maps limits to core injection ---
check('execution options map to core ports', () => {
  const limits = rl.parse_runtime_limits({});
  const exec = rl.build_execution_options(limits);
  assert.equal(exec.timeout_ms, 120_000);
  assert.equal(exec.max_output_bytes, 204_800);
  assert.equal(exec.max_buffer_bytes, 32 * 1024 * 1024);
  assert.equal(exec.max_rounds, 8);
});

// --- CLI wiring: Tell.ts consumes the contract (no second constant/state machine) ---
check('Tell.ts reuses runtime-limits and has no blind slice', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'Tell.ts'), 'utf8');
  assert.ok(src.includes("from '@tell-ai/core'"), 'Tell.js reads the limit contract from the owner');
  assert.ok(!src.includes("from './runtime-limits'"), 'no CLI facade module remains');
  assert.ok(src.includes('truncate_context'));
  assert.ok(src.includes('truncate_output'));
  assert.ok(src.includes('parse_runtime_limits'));
  assert.ok(src.includes('--stdin-max-bytes'));
  assert.ok(src.includes('--output-max-bytes'));
  assert.ok(src.includes('--no-stdin-timeout'));
  assert.ok(!src.includes('text.slice(-MAX_CONTEXT_CHARS)'));
  assert.ok(!src.includes('process.stdout.write ='));
  assert.ok(!src.includes('suppressStdout'));
});

check('Tell.ts stdin propagates 124/125 instead of empty prompt', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'Tell.ts'), 'utf8');
  assert.ok(src.includes('StdinLimitError'));
  assert.ok(src.includes('EXIT_TIMEOUT'));
  assert.ok(src.includes('EXIT_LIMIT'));
  assert.ok(!src.includes("read_stdin().catch(() => '')"));
});

check('Tell.ts forwards limits to executor and loop', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'Tell.ts'), 'utf8');
  assert.ok(src.includes('create_cli_executor({'));
  assert.ok(src.includes('max_chain_steps'));
  assert.ok(src.includes('resolve_cli_core_config({'));
  assert.ok(src.includes('exec_timeout_ms'));
});

check('Tell.ts consumes build_execution_options (contract is live)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'Tell.ts'), 'utf8');
  assert.ok(src.includes('build_execution_options(state.limits)'));
  assert.ok(src.includes('exec_options.max_rounds') || src.includes('chain_budget'));
  assert.ok(!src.includes('function create_runtime(max_rounds'));
});

check('Tell.ts has no second limit constant (single owner)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'Tell.ts'), 'utf8');
  assert.ok(!src.includes('1_048_576'), 'stdin byte cap must come from DEFAULT_STDIN_MAX_BYTES');
  assert.ok(src.includes('?? DEFAULT_STDIN_MAX_BYTES'));
  for (const name of [
    'DEFAULT_CONTEXT_MAX_CHARS',
    'DEFAULT_STDIN_TIMEOUT_MS',
    'DEFAULT_STDIN_MAX_BYTES',
    'DEFAULT_EXEC_TIMEOUT_MS',
    'DEFAULT_MAX_CHAIN_STEPS',
    'DEFAULT_MAX_BUFFER_BYTES',
    'DEFAULT_OUTPUT_MAX_BYTES',
  ]) {
    assert.ok(src.includes(`\${${name}}`), `help text must derive from ${name}`);
  }
  assert.ok(src.includes('${MAX_CHAIN_STEPS}'), 'chain range must derive from MAX_CHAIN_STEPS');
});

check('Tell.ts exit status uses the single owner (no literal 1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'Tell.ts'), 'utf8');
  assert.ok(!src.includes('process.exitCode = 1;'), 'use EXIT_MODEL_ERROR instead of literal 1');
  assert.ok(src.includes('EXIT_MODEL_ERROR'));
});

check('Tell.ts forwards CLI limit flags to tell-web (no silent drop)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'Tell.ts'), 'utf8');
  assert.ok(src.includes('opts.maxChain !== undefined'));
  assert.ok(src.includes('opts.execTimeout !== undefined'));
  assert.ok(src.includes('opts.contextMaxChars !== undefined'));
  assert.ok(src.includes("child_args.push('--exec-timeout'"));
});

check('CLI harnesses read the owner directly (no local module to mock)', () => {
  for (const file of ['test-tell-security.js', 'test-tell-context.js', 'test-tell-stream.js', 'test-tell-mentions.js']) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(!src.includes('./runtime-limits'), `${file} must not mock a local module`);
    assert.ok(src.includes("'@tell-ai/core'"), `${file} must read the core owner`);
  }
});

// No CLI module remains: the whole contract (defaults, ranges, parse,
// truncate, stdin failures, exit statuses, env reading) is owned by
// `@tell-ai/core`, so the CLI must not restate a value and its tellrc keys
// must be the ones the core publishes.
check('no CLI runtime-limits module remains (core owns the contract)', () => {
  assert.ok(
    !fs.existsSync(path.join(__dirname, '..', 'packages', 'cli', 'src', 'runtime-limits.ts')),
    'the CLI module must be gone',
  );
  const owner = fs.readFileSync(path.join(__dirname, '..', 'packages', 'core', 'src', 'runtime-limits.ts'), 'utf8');
  assert.ok(owner.includes('StdinLimitError'), 'stdin failures are owned by the core');
  assert.ok(owner.includes('runtime_env_from_process'), 'env reading is owned by the core');
  assert.ok(!/process\.env|process\.cwd|process\.argv/.test(owner), 'the owner never binds process itself');
});

// Host-env hermeticity: the CLI suites copy `process.env` into a fake process,
// so a leaked `TELL_*` from the caller's shell used to change chain caps and
// timeouts under test. Every sandbox must purge the limit keys.
check('CLI sandboxes purge host TELL_* limit vars (hermetic suite)', () => {
  const harnesses = ['test-tell-security.js', 'test-tell-context.js', 'test-tell-stream.js', 'test-tell-mentions.js'];
  for (const file of harnesses) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(src.includes('sanitizedFakeEnv'), `${file} must sanitize the fake env`);
    assert.ok(!/\.\.\.process\.env, HOME: home/.test(src), `${file} must not copy the raw host env`);
    assert.ok(src.includes('TELL_LIMIT_ENV_KEYS'), `${file} must read the key list from the core`);
  }
});

check('owner limits and tellrc keys match the loaded contract', () => {
  const core = require('@tell-ai/core');
  assert.deepEqual(core.TELLRC_LIMIT_KEYS.slice().sort(), rl.TELLRC_LIMIT_KEYS.slice().sort());
  assert.equal(rl.parse_runtime_limits({}).context_max_chars, core.DEFAULT_CONTEXT_MAX_CHARS);
  assert.equal(rl.MAX_CHAIN_STEPS, core.MAX_CHAIN_STEPS);
  assert.deepEqual(rl.runtime_env_from_process({ TELL_MAX_CHAIN_STEPS: '4' }), { TELL_MAX_CHAIN_STEPS: '4' });
});

check('runtime_env_from_process reads TELL_* without secrets', () => {
  const env = rl.runtime_env_from_process({
    TELL_CONTEXT_MAX_CHARS: '8192',
    TELL_STDIN_TIMEOUT_MS: '5000',
    OPENAI_API_KEY: 'secret',
  });
  assert.equal(env.TELL_CONTEXT_MAX_CHARS, '8192');
  assert.equal(env.TELL_STDIN_TIMEOUT_MS, '5000');
  assert.equal(env.OPENAI_API_KEY, undefined);
});

console.log(`\ntest-tell-runtime-limits: ${passed} checks passed`);
