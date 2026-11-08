// Core escalation tests — offline, no network, no provider.
// Proves Phase 6: a denied high command can request one approval with a
// justification; a forbidden command cannot. One decision event per command
// lands in the timeline. Reuses the permission table, the tag scanner and
// the command-status wording (no new parser, no new gate).
// Run with: node --test test/test-core-escalation.js (after the core build).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const ts = require('typescript');

const core = require('../packages/core/dist/index.cjs');

function compile_cli_source(relative) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'src', relative), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}

const mentions_module = { exports: {} };
new Function('require', 'module', 'exports', compile_cli_source('mentions.ts'))(
  require,
  mentions_module,
  mentions_module.exports,
);

function test_require(name) {
  if (name === './mentions') {
    return mentions_module.exports;
  } else {
    return require(name);
  }
}

const adapters_module = { exports: {} };
new Function('require', 'module', 'exports', compile_cli_source('core-adapters.ts'))(
  test_require,
  adapters_module,
  adapters_module.exports,
);
const adapters = adapters_module.exports;

// Web gate loader (same shape as test-web-chain-runtime.js, core from source).
const WEB_SRC = path.join(__dirname, '..', 'packages', 'web');
const CORE_SRC = path.join(__dirname, '..', 'packages', 'core', 'src');
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-escalation-gate-'));
try {
  fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(CACHE_DIR, 'node_modules'), 'dir');
} catch {
  /* already linked */
}
const compiledModules = new Map();
function transpile(js_source) {
  return ts.transpileModule(js_source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}
function compileSourceModule(absPath) {
  const key = `src:${absPath}`;
  if (compiledModules.has(key)) return compiledModules.get(key);
  const source = fs.readFileSync(absPath, 'utf8');
  let js = transpile(source);
  js = js.replace(/require\(["'](\.[^"']*)["']\)/g, (_m, rel) => {
    let resolved = path.normalize(path.join(path.dirname(absPath), rel));
    if (!/\.[a-z]+$/i.test(resolved)) resolved += '.ts';
    return `require(${JSON.stringify(compileSourceModule(resolved))})`;
  });
  const file = path.join(CACHE_DIR, `core_${path.basename(absPath).replace(/\.ts$/, '.cjs')}`);
  fs.writeFileSync(file, js);
  compiledModules.set(key, file);
  return file;
}
const BARE_SOURCES = { '@tell-ai/core': compileSourceModule(path.join(CORE_SRC, 'index.ts')) };
function compileModule(name) {
  if (compiledModules.has(name)) return compiledModules.get(name);
  const source = fs.readFileSync(path.join(WEB_SRC, name), 'utf8');
  let js = transpile(source);
  js = js.replace(/require\(["'](\.[^"']*)["']\)/g, (_m, rel) => {
    let resolved = path.normalize(path.join(path.dirname(name), rel));
    if (!/\.[a-z]+$/i.test(resolved)) resolved += '.ts';
    return `require(${JSON.stringify(compileModule(resolved))}`;
  });
  js = js.replace(/require\((["'])(@tell-ai\/[^"']+)\1\)/g, (m, _q, spec) => {
    const mapped = BARE_SOURCES[spec];
    return mapped === undefined ? m : `require(${JSON.stringify(mapped)})`;
  });
  const file = path.join(CACHE_DIR, name.replace(/\//g, '_').replace(/\.ts$/, '.cjs'));
  fs.writeFileSync(file, js);
  compiledModules.set(name, file);
  return file;
}
function loadWeb(name) {
  const loaded = { exports: {} };
  const factory = new Function('require', 'module', 'exports', fs.readFileSync(compileModule(name), 'utf8'));
  const localRequire = (spec) => {
    if (spec.startsWith('.')) return loadWeb(path.normalize(path.join(path.dirname(name), spec)));
    if (BARE_SOURCES[spec] !== undefined) return require(BARE_SOURCES[spec]);
    return require(spec);
  };
  factory(localRequire, { exports: loaded.exports }, loaded.exports);
  return loaded.exports;
}
const chain = loadWeb('src/server/chain-runtime.ts');

const HIGH = 'git push --force origin main';
const FORBIDDEN = 'cat .env';

describe('escalation tag protocol (reuse, no new parser)', () => {
  it('extracts the first non-empty justification, tolerant and case-insensitive', () => {
    assert.strictEqual(core.extract_escalation_justification('fix prod <ESCALATE>hotfix window</ESCALATE>'), 'hotfix window');
    assert.strictEqual(core.extract_escalation_justification('fix < ESCALATE > spaced </ ESCALATE >'), 'spaced');
    assert.strictEqual(core.extract_escalation_justification('fix <escalate>lower</escalate>'), 'lower');
    assert.strictEqual(core.extract_escalation_justification('no tag'), null);
    assert.strictEqual(core.extract_escalation_justification('<ESCALATE>   </ESCALATE>'), null);
    assert.strictEqual(core.extract_escalation_justification('<ESCALATE>unterminated'), null);
  });

  it('ignores fenced blocks like <RUN> does', () => {
    assert.strictEqual(core.extract_escalation_justification('```\n<ESCALATE>fenced</ESCALATE>\n```'), null);
  });

  it('strips the tag from the visible text', () => {
    assert.strictEqual(core.strip_escalation_tags('a <ESCALATE>why</ESCALATE> b'), 'a  b');
    assert.strictEqual(core.strip_escalation_tags('no tag'), 'no tag');
  });
});

describe('escalatable class (high only)', () => {
  it('allows high and denies every other class', () => {
    assert.strictEqual(core.is_escalatable_class('high'), true);
    assert.strictEqual(core.is_escalatable_class('forbidden'), false);
    assert.strictEqual(core.is_escalatable_class('medium'), false);
    assert.strictEqual(core.is_escalatable_class('low'), false);
  });

  it('classifies through the one table (scope aware with cwd)', () => {
    assert.strictEqual(core.is_escalatable_script(HIGH), true);
    assert.strictEqual(core.is_escalatable_script(FORBIDDEN), false);
    assert.strictEqual(core.is_escalatable_script('echo hi'), false);
    assert.strictEqual(core.is_escalatable_script('touch a'), false);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-escalation-scope-'));
    try {
      assert.strictEqual(core.is_escalatable_script('touch /outside/f', { cwd }), true);
      assert.strictEqual(core.is_escalatable_script('cat /outside/f', { cwd }), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('denial hint and decision event (one owner)', () => {
  it('appends the hint only when escalatable', () => {
    const plain = core.format_denied_feedback(HIGH, 'high-destructive');
    assert.ok(!plain.includes('<ESCALATE>'), 'base denial carries no hint');
    const escalatable = core.format_denied_feedback(HIGH, 'high-destructive', true);
    assert.ok(escalatable.includes('<ESCALATE>justification</ESCALATE>'), 'high denial invites one request');
    const forbidden = core.format_denied_feedback(FORBIDDEN, 'forbidden-credential', false);
    assert.ok(!forbidden.includes('<ESCALATE>'), 'forbidden never invites');
  });

  it('records one decision event per escalated command', () => {
    const record = core.format_escalation_request(HIGH, 'hotfix window');
    assert.strictEqual(record, `${core.ESCALATION_HEADER}\n${HIGH}\nJustification:\nhotfix window`);
  });
});

describe('CLI port escalation (one shot, high only)', () => {
  function throwing_confirm() {
    return async () => {
      throw new Error('must not prompt');
    };
  }

  it('prompts once for high with justification, then denies the repeat', async () => {
    let prompts = 0;
    const approval = adapters.create_cli_approval({ enabled: true, auto: true }, async () => {
      prompts += 1;
      return true;
    }, undefined, true);
    assert.strictEqual(await approval({ script: HIGH, escalation: 'hotfix window' }), 'approved');
    assert.strictEqual(prompts, 1);
    assert.strictEqual(await approval({ script: HIGH, escalation: 'hotfix window' }), 'denied');
    assert.strictEqual(prompts, 1, 'second request denies without a prompt');
  });

  it('denies forbidden even with a justification and without a prompt', async () => {
    const approval = adapters.create_cli_approval(
      { enabled: true, auto: true, approve_high: true },
      throwing_confirm(),
      undefined,
      true,
    );
    assert.strictEqual(await approval({ script: FORBIDDEN, escalation: 'please' }), 'denied');
  });

  it('denies without a justification and without a prompt', async () => {
    const approval = adapters.create_cli_approval({ enabled: true, auto: true }, throwing_confirm(), undefined, true);
    assert.strictEqual(await approval({ script: HIGH, escalation: '   ' }), 'denied');
    assert.strictEqual(await approval({ script: HIGH }), 'denied');
  });

  it('denies block (--no-exec) even with a justification', async () => {
    const approval = adapters.create_cli_approval({ enabled: false }, throwing_confirm(), undefined, true);
    assert.strictEqual(await approval({ script: HIGH, escalation: 'hotfix' }), 'denied');
  });

  it('fails closed without a TTY (no channel, no grant)', async () => {
    const approval = adapters.create_cli_approval({ enabled: true, auto: true }, throwing_confirm(), undefined, false);
    assert.strictEqual(await approval({ script: HIGH, escalation: 'hotfix' }), 'denied');
  });

  it('maps a declined escalation to skipped', async () => {
    const approval = adapters.create_cli_approval({ enabled: true, auto: true }, async () => false, undefined, true);
    assert.strictEqual(await approval({ script: HIGH, escalation: 'hotfix' }), 'skipped');
  });

  it('treats always as once on escalation (stores nothing)', async () => {
    const stored = [];
    const approval = adapters.create_cli_approval(
      { enabled: true, auto: true },
      async () => 'always',
      undefined,
      true,
      (p) => stored.push(p),
    );
    assert.strictEqual(await approval({ script: HIGH, escalation: 'hotfix' }), 'approved');
    assert.deepStrictEqual(stored, [], 'escalation never stores a prefix');
  });
});

describe('Web gate escalation (park once, never forbidden)', () => {
  it('parks high with justification instead of denying', () => {
    assert.deepStrictEqual(
      chain.decide_chain_gate({ no_exec: false, require_approval: false, auto_execute: true, permission_class: 'high' }),
      { action: 'deny', reason: 'high-risk' },
    );
    assert.deepStrictEqual(
      chain.decide_chain_gate({
        no_exec: false,
        require_approval: false,
        auto_execute: true,
        permission_class: 'high',
        escalation: 'hotfix window',
      }),
      { action: 'park' },
    );
  });

  it('denies forbidden even with a justification', () => {
    for (const escalation of [undefined, '', '   ', 'please']) {
      assert.deepStrictEqual(
        chain.decide_chain_gate({
          no_exec: false,
          require_approval: true,
          auto_execute: true,
          permission_class: 'forbidden',
          ...(escalation === undefined ? {} : { escalation }),
        }),
        { action: 'deny', reason: 'high-risk' },
        `forbidden ${String(escalation)}`,
      );
    }
  });

  it('denies block (--no-exec) even with a justification', () => {
    assert.deepStrictEqual(
      chain.decide_chain_gate({
        no_exec: true,
        require_approval: true,
        auto_execute: true,
        permission_class: 'high',
        escalation: 'hotfix',
      }),
      { action: 'deny', reason: 'no-exec' },
    );
  });

  it('ignores a blank justification', () => {
    assert.deepStrictEqual(
      chain.decide_chain_gate({
        no_exec: false,
        require_approval: false,
        auto_execute: true,
        permission_class: 'high',
        escalation: '   ',
      }),
      { action: 'deny', reason: 'high-risk' },
    );
  });
});

describe('runtime single-turn escalation (timeline audit pair)', () => {
  it('records the request and runs after approval (high)', async () => {
    const seen = [];
    const runtime = core.createTellRuntime({
      model: { ask: async () => `<RUN>\n${HIGH}\n</RUN>\n<ESCALATE>hotfix window</ESCALATE>` },
      exec: true,
      executor: async () => ({ stdout: 'ok', stderr: '', exit_code: 0 }),
      approval: async (request) => {
        seen.push(request);
        return 'approved';
      },
    });
    const result = await runtime.run('hi');
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].escalation, 'hotfix window');
    assert.ok(result.timeline.some((line) => line.includes(core.ESCALATION_HEADER)), 'request event in timeline');
    assert.ok(result.timeline.some((line) => line.includes('Executed command:')), 'decision event in timeline');
    assert.strictEqual(result.commands[0].status, 'executed');
    assert.ok(!result.text.includes('<ESCALATE>'), 'tag never reaches the visible text');
  });

  it('records the request and still denies forbidden', async () => {
    let prompts = 0;
    const runtime = core.createTellRuntime({
      model: { ask: async () => `<RUN>\n${FORBIDDEN}\n</RUN>\n<ESCALATE>please</ESCALATE>` },
      exec: true,
      executor: async () => {
        prompts += 1;
        return { stdout: 'ok', stderr: '', exit_code: 0 };
      },
      approval: async () => 'denied',
    });
    const result = await runtime.run('hi');
    assert.strictEqual(prompts, 0, 'forbidden never executes');
    assert.ok(result.timeline.some((line) => line.includes(core.ESCALATION_HEADER)), 'request still audited');
    assert.strictEqual(result.commands[0].status, 'denied');
  });
});

describe('primitive loop escalation (one continuation, then stop)', () => {
  function script_model(answers) {
    let calls = 0;
    return {
      calls: () => calls,
      async ask() {
        calls += 1;
        return answers[Math.min(calls - 1, answers.length - 1)];
      },
    };
  }

  it('continues once after a high denial with the hint, then runs the escalation', async () => {
    const prompts = [];
    let calls = 0;
    const model = {
      calls: () => calls,
      async ask(message) {
        calls += 1;
        prompts.push(message);
        const answers = [
          `<RUN>\n${HIGH}\n</RUN>`,
          `<RUN>\n${HIGH}\n</RUN>\n<ESCALATE>hotfix window</ESCALATE>`,
          'done.',
        ];
        return answers[Math.min(calls - 1, answers.length - 1)];
      },
    };
    const approvals = [];
    const runtime = core.create_core_runtime({
      config: core.resolve_core_config({ host: 'cli' }),
      model,
      executor: async () => ({ stdout: 'ok', stderr: '', exit_code: 0 }),
      approval: async (request) => {
        if (request.escalation !== undefined && request.escalation !== '') {
          approvals.push(request.escalation);
          return 'approved';
        } else {
          return 'denied';
        }
      },
      risk: core.create_base_risk_port('permissive'),
      max_rounds: 5,
    });
    const result = await runtime.run('hi');
    assert.strictEqual(model.calls(), 3, 'denial + escalation + final answer');
    assert.deepStrictEqual(approvals, ['hotfix window']);
    assert.ok(prompts[1].includes('<ESCALATE>'), 'hint fed to the model as the next message');
    assert.ok(result.timeline.some((line) => line.includes(core.ESCALATION_HEADER)), 'request audited');
    assert.ok(result.commands.some((command) => command.status === 'denied'), 'first denial kept');
    assert.ok(result.commands.some((command) => command.status === 'executed'), 'escalation ran');
  });

  it('ends the attempt on the second denial (no second escalation)', async () => {
    const model = script_model([
      `<RUN>\n${HIGH}\n</RUN>`,
      `<RUN>\n${HIGH}\n</RUN>\n<ESCALATE>first</ESCALATE>`,
      `<RUN>\n${HIGH}\n</RUN>\n<ESCALATE>second</ESCALATE>`,
    ]);
    const runtime = core.create_core_runtime({
      config: core.resolve_core_config({ host: 'cli' }),
      model,
      executor: async () => ({ stdout: 'ok', stderr: '', exit_code: 0 }),
      approval: async () => 'denied',
      risk: core.create_base_risk_port('permissive'),
      max_rounds: 5,
    });
    const result = await runtime.run('hi');
    assert.strictEqual(model.calls(), 2, 'one continuation only');
    assert.strictEqual(result.commands.filter((command) => command.status === 'denied').length, 2);
  });

  it('never continues after a forbidden denial', async () => {
    const model = script_model([`<RUN>\n${FORBIDDEN}\n</RUN>`, `<RUN>\n${FORBIDDEN}\n</RUN>\n<ESCALATE>please</ESCALATE>`]);
    const runtime = core.create_core_runtime({
      config: core.resolve_core_config({ host: 'cli' }),
      model,
      executor: async () => ({ stdout: 'ok', stderr: '', exit_code: 0 }),
      approval: async () => 'denied',
      risk: core.create_base_risk_port('permissive'),
      max_rounds: 5,
    });
    const result = await runtime.run('hi');
    assert.strictEqual(model.calls(), 1, 'forbidden ends at once');
    assert.ok(!result.timeline.some((line) => line.includes('<ESCALATE>justification')), 'no hint fed');
  });
});

describe('child never escalates (headless, no prompt)', () => {
  it('denies install even with a justification', async () => {
    const approval = core.create_child_approval('build', async () => 'approved', '/tmp/work');
    assert.strictEqual(await approval({ script: 'npm install evil', escalation: 'please' }), 'denied');
  });
});
