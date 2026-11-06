// test-web-chain-runtime.js
//
// Unit pins for `packages/web/src/server/chain-runtime.ts` (pure chain
// helpers): every wording/budget mapping is asserted 1:1 against the real
// `@tell-ai/core` owners, so the server chain and the core primitive loop
// cannot drift. Follows the `test-web-backend.js` loader (transpile web
// sources, compile core straight from source, `@tell-ai/sdk` from dist).
//
// Run with: bun run --filter @tell-ai/sdk build && bun run --filter @tell-ai/core build && node test/test-web-chain-runtime.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const WEB_SRC = path.join(__dirname, '..', 'packages', 'web');
const CORE_SRC = path.join(__dirname, '..', 'packages', 'core', 'src');
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-web-chain-runtime-'));
try {
  fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(CACHE_DIR, 'node_modules'), 'dir');
} catch {
  /* already linked */
}

const compiledModules = new Map();

function transpile(js_source) {
  return ts.transpileModule(js_source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

function compileSourceModule(absPath) {
  const key = `src:${absPath}`;
  if (compiledModules.has(key)) return compiledModules.get(key);
  const source = fs.readFileSync(absPath, 'utf8');
  let js = transpile(source);
  js = js.replace(/require\(["'](\.[^"']*)["']\)/g, (_match, relativePath) => {
    let resolved = path.normalize(path.join(path.dirname(absPath), relativePath));
    if (!/\.[a-z]+$/i.test(resolved)) resolved += '.ts';
    return `require(${JSON.stringify(compileSourceModule(resolved))})`;
  });
  const file = path.join(CACHE_DIR, `core_${path.basename(absPath).replace(/\.ts$/, '.cjs')}`);
  fs.writeFileSync(file, js);
  compiledModules.set(key, file);
  return file;
}

const BARE_SOURCES = {
  '@tell-ai/core': compileSourceModule(path.join(CORE_SRC, 'index.ts')),
};

function compileModule(name) {
  if (compiledModules.has(name)) return compiledModules.get(name);
  const source = fs.readFileSync(path.join(WEB_SRC, name), 'utf8');
  let js = transpile(source);
  js = js.replace(/require\(["'](\.[^"']*)["']\)/g, (_match, relativePath) => {
    let resolved = path.normalize(path.join(path.dirname(name), relativePath));
    if (!/\.[a-z]+$/i.test(resolved)) resolved += '.ts';
    return `require(${JSON.stringify(compileModule(resolved))}`;
  });
  js = js.replace(/require\((["'])(@tell-ai\/[^"']+)\1\)/g, (match, _quote, specifier) => {
    const mapped = BARE_SOURCES[specifier];
    return mapped === undefined ? match : `require(${JSON.stringify(mapped)})`;
  });
  const file = path.join(CACHE_DIR, name.replace(/\//g, '_').replace(/\.ts$/, '.cjs'));
  fs.writeFileSync(file, js);
  compiledModules.set(name, file);
  return file;
}

function loadWeb(name) {
  const loaded = { exports: {} };
  const factory = new Function('require', 'module', 'exports', fs.readFileSync(compileModule(name), 'utf8'));
  const localRequire = (specifier) => {
    if (specifier.startsWith('.')) return loadWeb(path.normalize(path.join(path.dirname(name), specifier)));
    if (BARE_SOURCES[specifier] !== undefined) return require(BARE_SOURCES[specifier]);
    return require(specifier);
  };
  factory(localRequire, { exports: loaded.exports }, loaded.exports);
  return loaded.exports;
}

const chain = loadWeb('src/server/chain-runtime.ts');
const core = require(BARE_SOURCES['@tell-ai/core']);

const failures = [];
function check(name, fn) {
  try {
    const result = fn();
    if (result !== undefined && typeof result.then === 'function') {
      return result.then(
        () => console.log(`ok - ${name}`),
        (error) => {
          failures.push(name);
          console.error(`FAIL - ${name}: ${error.message}`);
        },
      );
    }
    console.log(`ok - ${name}`);
    return Promise.resolve();
  } catch (error) {
    failures.push(name);
    console.error(`FAIL - ${name}: ${error.message}`);
    return Promise.resolve();
  }
}

async function main() {
  await check('extract_run_scripts lists every script trimmed', () => {
    assert.deepStrictEqual(chain.extract_run_scripts('a<RUN>\nls\n</RUN>b<RUN>\necho hi\n</RUN>'), ['ls', 'echo hi']);
    assert.deepStrictEqual(chain.extract_run_scripts('no tags'), []);
    assert.deepStrictEqual(chain.extract_run_scripts('<RUN>   \n  </RUN>'), []);
  });

  await check('tail_chain_output keeps short text and marks long tails', () => {
    assert.strictEqual(chain.tail_chain_output('short', 1024), 'short');
    assert.strictEqual(chain.tail_chain_output('x'.repeat(5000), 1024), `…[truncated]\n${'x'.repeat(1024)}`);
  });

  await check('record uses executed wording on exit 0', () => {
    const record = chain.build_chain_command_record({
      script: 'echo hi',
      stdout: 'hi\n',
      stderr: '',
      exit_code: 0,
      max_bytes: 1024,
      max_tail_chars: 1024,
      redact: (value) => value,
    });
    assert.strictEqual(record.failed, false);
    assert.strictEqual(record.message, core.format_executed_command('echo hi', 'hi'));
    assert.strictEqual(record.output, 'hi');
  });

  await check('record uses failed wording on non-zero exit', () => {
    const record = chain.build_chain_command_record({
      script: 'exit 3',
      stdout: '',
      stderr: 'boom',
      exit_code: 3,
      max_bytes: 1024,
      max_tail_chars: 1024,
      redact: (value) => value,
    });
    assert.strictEqual(record.failed, true);
    assert.strictEqual(record.message, core.format_failed_command('exit 3', 'boom', 3));
    assert.ok(record.message.includes('Command failed (exit code 3):'));
  });

  await check('record drops the parenthetical without a status', () => {
    const record = chain.build_chain_command_record({
      script: 'ls',
      stdout: 'executor exploded',
      stderr: '',
      exit_code: null,
      max_bytes: 1024,
      max_tail_chars: 1024,
      redact: (value) => value,
    });
    assert.strictEqual(record.failed, true);
    assert.strictEqual(record.message, core.format_failed_command('ls', 'executor exploded', null));
  });

  await check('record joins stdout/stderr like the core owner', () => {
    const record = chain.build_chain_command_record({
      script: 'both',
      stdout: 'out',
      stderr: 'err',
      exit_code: 0,
      max_bytes: 1024,
      max_tail_chars: 1024,
      redact: (value) => value,
    });
    assert.strictEqual(record.output, core.combine_output('out', 'err'));
    assert.strictEqual(record.output, 'out\nerr');
  });

  await check('record redacts before the tail and tails only the message', () => {
    const record = chain.build_chain_command_record({
      script: 'leak',
      stdout: `sk-live-secret ${'x'.repeat(5000)}`,
      stderr: '',
      exit_code: 0,
      max_bytes: 64 * 1024,
      max_tail_chars: 64,
      redact: (value) => value.replace('sk-live-secret', '[redacted]'),
    });
    assert.ok(!record.output.includes('sk-live-secret'));
    assert.ok(!record.message.includes('sk-live-secret'));
    assert.ok(record.message.includes('…[truncated]'));
    assert.ok(!record.output.includes('…[truncated]'), 'stored output keeps the full capped text');
  });

  await check('record matches the core single-turn timeline byte for byte', async () => {
    for (const [stdout, stderr, exit_code] of [
      ['hi\n', '', 0],
      ['', 'boom', 1],
    ]) {
      const runtime = core.createTellRuntime({
        model: { ask: async () => `<RUN>\necho hi\n</RUN>` },
        exec: true,
        executor: async () => ({ stdout, stderr, exit_code }),
        approval: async () => 'approved',
      });
      const result = await runtime.run('hi');
      const record = chain.build_chain_command_record({
        script: 'echo hi',
        stdout,
        stderr,
        exit_code,
        max_bytes: 32 * 1024,
        max_tail_chars: 4096,
        redact: (value) => value,
      });
      const line = result.timeline.find(
        (entry) => entry.includes('Executed command:') || entry.includes('Command failed'),
      );
      assert.strictEqual(record.message, line);
    }
  });

  await check('gate denies no-exec and forbidden first', () => {
    assert.deepStrictEqual(
      chain.decide_chain_gate({
        no_exec: true,
        require_approval: true,
        auto_execute: true,
        permission_class: 'low',
      }),
      { action: 'deny', reason: 'no-exec' },
    );
    for (const permission_class of ['low', 'medium', 'high', 'forbidden']) {
      assert.deepStrictEqual(
        chain.decide_chain_gate({
          no_exec: false,
          require_approval: false,
          auto_execute: true,
          permission_class,
        }),
        permission_class === 'forbidden' || permission_class === 'high'
          ? { action: 'deny', reason: 'high-risk' }
          : permission_class === 'medium'
            ? { action: 'park' }
            : { action: 'execute' },
        permission_class,
      );
    }
  });

  await check('gate follows the web flag table per class', () => {
    const cells = [
      // [flags, low, medium, high, forbidden]
      [{ auto_execute: false, require_approval: false }, 'park', 'park', 'deny', 'deny'],
      [{ auto_execute: true, require_approval: false }, 'execute', 'park', 'deny', 'deny'],
      [{ auto_execute: true, require_approval: true }, 'execute', 'execute', 'park', 'deny'],
      [{ auto_execute: false, require_approval: true }, 'park', 'park', 'park', 'deny'],
    ];
    for (const [flags, low, medium, high, forbidden] of cells) {
      const expected = { low, medium, high, forbidden };
      for (const permission_class of ['low', 'medium', 'high', 'forbidden']) {
        const decision = chain.decide_chain_gate({ no_exec: false, ...flags, permission_class });
        const want = expected[permission_class];
        if (want === 'deny') {
          assert.deepStrictEqual(decision, { action: 'deny', reason: 'high-risk' }, `${permission_class} ${JSON.stringify(flags)}`);
        } else {
          assert.deepStrictEqual(decision, { action: want }, `${permission_class} ${JSON.stringify(flags)}`);
        }
      }
    }
  });

  await check('gate classifies web scripts strict with the host cwd', () => {
    assert.strictEqual(chain.classify_web_script('echo hi', '/work'), 'low');
    assert.strictEqual(chain.classify_web_script('touch /outside/f', '/work'), 'high');
    assert.strictEqual(chain.classify_web_script('cat /etc/hosts', '/work'), 'forbidden');
  });

  await check('concurrency guard starts one more only under the cap', () => {
    assert.strictEqual(chain.can_start_chain_execution(0, 2), true);
    assert.strictEqual(chain.can_start_chain_execution(1, 2), true);
    assert.strictEqual(chain.can_start_chain_execution(2, 2), false);
    assert.strictEqual(chain.can_start_chain_execution(3, 2), false);
  });

  await check('extra tag instruction asks for the final answer once', () => {
    const text = chain.format_extras_instruction(['cat a.txt', 'cat b.txt']);
    assert.ok(text.includes('Only the first <RUN> block ran.'), text);
    assert.ok(text.includes('Do not repeat them.'), text);
    assert.ok(text.includes('answer now in plain text'), text);
    assert.ok(text.includes('- cat a.txt') && text.includes('- cat b.txt'), text);
    assert.ok(!text.includes('Skipped by user:'), text);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} chain-runtime check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nchain-runtime gate passed');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
