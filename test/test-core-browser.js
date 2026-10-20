// test-core-browser.js
//
// Functional gate for the `@tell-ai/core` browser entry: the built
// `dist/browser.cjs` must evaluate and run with zero Node globals.
//
// The static gate in `test-core-package.js` rejects builtin imports; this
// suite proves behavior — every pure surface works with no `process`,
// `Buffer`, `require`, `module` or `__dirname` in scope (a `vm` context with
// only standard JS + Web natives: `TextEncoder`/`TextDecoder`).
//
// Run with: node test/test-core-browser.js (after building @tell-ai/core).

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const BROWSER_CJS = path.join(ROOT, 'packages', 'core', 'dist', 'browser.cjs');
const NODE_CJS = path.join(ROOT, 'packages', 'core', 'dist', 'index.cjs');

// The stub single turn: round one asks for a command, round two answers.
// It mimics the SDK timeline shape (every round opens with its `User:` line,
// which the loop drops from the second round on) and is a pure function of
// the message, so the browser bundle and the Node build must produce
// byte-identical transcripts from it.
function stub_single_turn(seen) {
  let calls = 0;
  return {
    run: async (message) => {
      seen.push(message);
      calls += 1;
      if (calls === 1) {
        return {
          status: 'completed',
          text: '',
          timeline: ['User:\nhi'],
          commands: [{ script: 'echo hi', output: 'hi\n', exit_code: 0, status: 'executed' }],
        };
      } else {
        return {
          status: 'completed',
          text: 'done',
          timeline: [`User:\n${message}`, 'Assistant:\ndone'],
          commands: [],
        };
      }
    },
  };
}

// Cross-realm safe structural comparison: the vm sandbox has its own
// Object.prototype, so `deepStrictEqual` would trip on the prototype alone.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((error) => {
      failures.push(name);
      console.error(`FAIL - ${name}: ${error.message}`);
    });
}

async function main() {
  const src = fs.readFileSync(BROWSER_CJS, 'utf8');

  // Browser-like sandbox: no process, Buffer, require, module, __dirname.
  const fakeStore = (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => void m.set(k, String(v)),
      removeItem: (k) => void m.delete(k),
    };
  })();
  const sandbox = { exports: {}, TextEncoder, TextDecoder, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'browser.cjs' });
  const ns = sandbox.exports;
  assert.ok(ns && typeof ns.assess_base_risk === 'function', 'browser entry must export assess_base_risk');

  await check('no process/Buffer/require in scope', () => {
    for (const name of ['process', 'Buffer', 'require', 'module', '__dirname']) {
      assert.strictEqual(vm.runInContext(`typeof ${name}`, sandbox), 'undefined', `${name} leaked`);
    }
  });

  await check('risk: strict flags eval, ignores bare word', () => {
    assert.strictEqual(ns.assess_base_risk('php -r "x"', 'strict').risky, true);
    assert.strictEqual(ns.assess_base_risk('echo ssh', 'strict').risky, false);
  });

  await check('truncate_output respects byte budget (UTF-8)', () => {
    const out = ns.truncate_output('é'.repeat(100), 10);
    assert.ok(Buffer.byteLength(out, 'utf8') <= 10, `over budget: ${out.length}`);
  });

  await check('truncate_context respects char budget', () => {
    const ctx = ns.truncate_context('x'.repeat(5000), 1024);
    assert.ok(ctx.length <= 1024, `over budget: ${ctx.length}`);
  });

  await check('load_env_layer() with no process returns {} (no throw)', () => {
    assert.strictEqual(JSON.stringify(ns.load_env_layer()), '{}');
  });

  await check('load_env_layer picks TELL_MODEL from explicit env', () => {
    assert.strictEqual(JSON.stringify(ns.load_env_layer({ TELL_MODEL: 'g' })), '{"model":"g"}');
  });

  await check('runtime_env_from_process reads explicit record', () => {
    assert.strictEqual(
      JSON.stringify(ns.runtime_env_from_process({ TELL_MAX_BUFFER_BYTES: '123' })),
      '{"TELL_MAX_BUFFER_BYTES":"123"}',
    );
  });

  await check('resolve_core_config resolves host default', () => {
    const cfg = ns.resolve_core_config({ host: 'web', layers: [{}] });
    assert.strictEqual(cfg.model, ns.HOST_DEFAULT_MODEL.web);
  });

  await check('chain-decision accepts good payload, rejects script field', () => {
    const good = ns.validate_chain_decision_payload({ decisionId: 'd1', expectedVersion: 0, decision: 'approve' });
    assert.strictEqual(good.ok, true, JSON.stringify(good));
    const bad = ns.validate_chain_decision_payload({ script: 'rm -rf /' });
    assert.strictEqual(bad.ok, false, 'bad payload accepted');
  });

  await check('loop-feedback formats and parses back', () => {
    const parsed = ns.parse_command_feedback(ns.format_executed_command('echo hi', 'hi\n', 0));
    assert.strictEqual(parsed.kind, 'executed');
    assert.strictEqual(parsed.script, 'echo hi');
  });

  await check('compose_custom_system composes', () => {
    assert.ok(ns.compose_custom_system('hello').includes('hello'));
  });

  await check('storage adapter works on injected store', async () => {
    const port = ns.createLocalStorageAdapter(fakeStore);
    await port.save('k', 'v');
    assert.strictEqual(await port.load('k'), 'v');
  });

  await check('parse_runtime_limits works without env', () => {
    assert.ok(ns.parse_runtime_limits({ flags: {}, env: {}, tellrcLayers: [] }));
  });

  await check('loop runs stub rounds with the same transcript shape', async () => {
    const seen = [];
    const stub = stub_single_turn(seen);
    const result = await ns.run_primitive_loop('hi', { runtime_options: {}, single_turn: stub, max_rounds: 8 });
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.commands.length, 1);
    assert.strictEqual(result.commands[0].script, 'echo hi');
    assert.strictEqual(seen.length, 2, 'two rounds ran');
    assert.ok(seen[1].includes('Executed command:'), 'round 2 carries the feedback wording');
    assert.ok(result.text.includes('done'), 'final text');
    assert.deepStrictEqual(plain(result.timeline), ['User:\nhi', 'Assistant:\ndone']);
  });

  await check('browser loop transcript is identical to the Node loop', async () => {
    const node_core = require(NODE_CJS);
    const browser_seen = [];
    const node_seen = [];
    const browser_result = await ns.run_primitive_loop('hi', {
      runtime_options: {},
      single_turn: stub_single_turn(browser_seen),
      max_rounds: 8,
    });
    const node_result = await node_core.run_primitive_loop('hi', {
      runtime_options: {},
      single_turn: stub_single_turn(node_seen),
      max_rounds: 8,
    });
    assert.deepStrictEqual(plain(browser_result), plain(node_result), 'result drift between builds');
    assert.deepStrictEqual(browser_seen, node_seen, 'round feedback drift between builds');
  });

  await check('browser loop keeps the Node cancellation contract', async () => {
    // A token that is live at the round boundary but fires mid-round: the
    // loop must forward it to the injected runner (that is what aborts the
    // turn before the command runs).
    let live = false;
    const token = {
      get cancelled() {
        return live;
      },
      on_cancel: () => () => {},
    };
    const seen = [];
    const stub = {
      run: async (message, override) => {
        seen.push(message);
        assert.strictEqual(override?.cancellation, token, 'the loop forwards the cancellation token');
        live = true;
        return { status: 'cancelled', text: '', timeline: ['User:\nhi'], commands: [] };
      },
    };
    const mid = await ns.run_primitive_loop('hi', {
      runtime_options: { cancellation: token },
      single_turn: stub,
      max_rounds: 8,
    });
    assert.strictEqual(mid.status, 'cancelled');
    assert.strictEqual(mid.commands.length, 0);
    assert.strictEqual(seen.length, 1, 'the round ran and was cancelled inside the turn');

    // A token that is already cancelled stops the loop before the first
    // round: nothing runs, nothing is reported.
    const before = await ns.run_primitive_loop('hi', {
      runtime_options: { cancellation: { cancelled: true, on_cancel: () => () => {} } },
      single_turn: stub,
      max_rounds: 8,
    });
    assert.strictEqual(before.status, 'cancelled');
    assert.strictEqual(before.commands.length, 0);
    assert.strictEqual(seen.length, 1, 'a pre-cancelled token stops before the first round');
  });

  await check('browser entry exposes the loop and hides the Node factory', () => {
    assert.strictEqual(typeof ns.run_primitive_loop, 'function');
    assert.strictEqual(typeof ns.LOOP_MAX_ROUNDS, 'number');
    assert.strictEqual(typeof ns.chain_limit_notice, 'function');
    assert.ok(!('create_node_executor' in ns), 'the Node executor stays out');
  });

  await check('create_core_runtime runs in the browser (commands reported, never executed)', async () => {
    // The full Node path, browser edition: the core wires the single turn
    // itself, so the host only injects the model and the storage.
    let asked = 0;
    const model = {
      async ask() {
        asked += 1;
        return asked === 1 ? 'run it\n<RUN>\necho hi\n</RUN>' : 'all done.';
      },
    };
    const runtime = ns.create_core_runtime({
      config: ns.resolve_core_config({ host: 'web', layers: [{}] }),
      model,
      storage: ns.createLocalStorageAdapter(fakeStore),
    });
    const result = await runtime.run('hi');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.text, 'run it');
    assert.strictEqual(result.commands.length, 1);
    // No executor in the browser: the command is reported, never run.
    assert.strictEqual(result.commands[0].script, 'echo hi');
    assert.notStrictEqual(result.commands[0].status, 'executed');
    assert.ok(
      ['denied', 'skipped', 'awaiting_approval', 'requested'].includes(result.commands[0].status),
      `unexpected command status: ${result.commands[0].status}`,
    );
    // A command that was not executed stops the loop (fail-closed): one round.
    assert.strictEqual(asked, 1, 'the loop stopped after the non-executed command');
  });

  await check('the browser runtime never touches the filesystem or the environment', async () => {
    // A fresh runtime with no executor must still answer from the model alone
    // (no env read, no fs, no process) — the browser has none of those.
    const model = { async ask() { return 'plain answer'; } };
    const runtime = ns.create_core_runtime({
      config: ns.resolve_core_config({ host: 'web', layers: [{}] }),
      model,
    });
    const result = await runtime.run('hi');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.text, 'plain answer');
    assert.strictEqual(result.commands.length, 0);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} core browser check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\ncore browser gate passed (no process, no builtins)');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
