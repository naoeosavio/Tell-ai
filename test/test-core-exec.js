// Core executor tests — offline, no provider, no network.
// Proves the Node executor (`create_node_executor`) runs through the
// explicit shell with real cwd, timeout, output cap, process-group kill,
// structural cancellation and a scrubbed environment; and that the single
// redaction boundary still masks stdout/stderr before callbacks, logs,
// context, TellResult or JSON. A denied approval never reaches the host.
// Run with: node --test test/test-core-exec.js (after the core build).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const core = require('../packages/core/dist/index.cjs');

function script_model(answers) {
  let calls = 0;
  return {
    async ask() {
      calls += 1;
      return answers[Math.min(calls - 1, answers.length - 1)];
    },
  };
}

describe('sanitize_exec_env', () => {
  it('drops provider keys, tokens, preload and loader variables', () => {
    const sanitized = core.sanitize_exec_env({
      PATH: '/usr/bin',
      HOME: '/home/user',
      TELL_KEY: 'sk-secret',
      TELL_TOKEN: 'tok-secret',
      OPENAI_API_KEY: 'sk-openai',
      ANTHROPIC_API_KEY: 'sk-antho',
      CUSTOM_API_KEY: 'sk-custom',
      NPM_TOKEN: 'npm-secret',
      NODE_OPTIONS: '--require evil',
      BASH_ENV: '/tmp/evil',
      ENV: '/tmp/evil',
      LD_PRELOAD: '/tmp/evil.so',
      LD_LIBRARY_PATH: '/tmp/evil',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      PYTHONPATH: '/tmp/evil',
      KEEP_ME: 'yes',
    });
    assert.strictEqual(sanitized.PATH, '/usr/bin');
    assert.strictEqual(sanitized.HOME, '/home/user');
    assert.strictEqual(sanitized.KEEP_ME, 'yes');
    for (const name of Object.keys(sanitized)) {
      assert.ok(!core.SENSITIVE_ENV_NAMES.has(name), `leaked ${name}`);
      assert.ok(!core.SENSITIVE_ENV_SUFFIX.test(name), `leaked ${name}`);
    }
    assert.ok(!('TELL_KEY' in sanitized));
    assert.ok(!('TELL_TOKEN' in sanitized));
    assert.ok(!('NODE_OPTIONS' in sanitized));
    assert.ok(!('LD_PRELOAD' in sanitized));
  });

  it('collects secret values for the redaction boundary', () => {
    const secrets = core.collect_exec_secrets({ TELL_KEY: 'sk-abc', PATH: '/usr/bin', EMPTY: '' });
    assert.ok(secrets.includes('sk-abc'));
    assert.ok(!secrets.includes('/usr/bin'));
    const redact = core.create_secret_redactor(secrets);
    assert.strictEqual(redact('leaked sk-abc here'), 'leaked [redacted] here');
    assert.strictEqual(redact('nothing secret'), 'nothing secret');
  });
});

describe('create_node_executor basics', () => {
  it('uses the explicit shell and runs a benign command', async () => {
    assert.strictEqual(core.EXEC_SHELL, '/bin/bash');
    const executor = core.create_node_executor();
    const result = await executor({ script: 'echo hello' });
    assert.strictEqual(result.exit_code, 0);
    assert.match(result.stdout, /hello/);
  });

  it('resolves a real cwd and fails closed on a missing base', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'core-exec-cwd-'));
    const executor = core.create_node_executor();
    const result = await executor({ script: 'pwd', cwd: work });
    assert.strictEqual(result.exit_code, 0);
    assert.match(result.stdout.trim(), /core-exec-cwd-/);
    await assert.rejects(executor({ script: 'echo hi', cwd: path.join(work, 'no-such-dir') }), /unusable/);
  });

  it('scrubs secrets from the child environment', async () => {
    const executor = core.create_node_executor();
    const result = await executor({
      script: 'printenv TELL_KEY; printenv OPENAI_API_KEY; echo visible',
      env: { TELL_KEY: 'sk-should-not-leak', OPENAI_API_KEY: 'sk-nope' },
    });
    assert.ok(!result.stdout.includes('sk-should-not-leak'));
    assert.ok(!result.stdout.includes('sk-nope'));
    assert.match(result.stdout, /visible/);
  });
});

describe('create_node_executor limits', () => {
  it('times out a hanging command with exit 124', async () => {
    const executor = core.create_node_executor();
    const started = Date.now();
    const result = await executor({ script: 'sleep 5', timeout_ms: 300 });
    const elapsed = Date.now() - started;
    assert.strictEqual(result.exit_code, core.EXEC_TIMEOUT_EXIT_CODE);
    assert.match(result.stderr, /timed out/);
    assert.ok(elapsed < 4000, `took ${elapsed}ms`);
  });

  it('carries the script in the timeout message, through the owner formatter', async () => {
    const executor = core.create_node_executor();
    const result = await executor({ script: 'sleep 5', timeout_ms: 300 });
    assert.strictEqual(result.stderr, core.format_timeout_message('sleep 5', 300));
    assert.strictEqual(core.format_timeout_message('sleep 5', 1000), 'Command timed out after 1s:\nsleep 5');
  });

  it('kills the whole process group on timeout, leaving no orphans', async () => {
    const executor = core.create_node_executor();
    const marker = `core-orphan-${process.pid}-${Date.now()}`;
    // Background child shares the detached group; without `kill(-pid)` it
    // would survive the timeout and keep the marker file fresh. The script
    // reports the background pid so the check can look at THAT process
    // instead of scanning the whole process table.
    const script = `rm -f /tmp/${marker}; sleep 30 & echo bg=$!; sleep 30`;
    const result = await executor({ script, timeout_ms: 800 });
    assert.strictEqual(result.exit_code, core.EXEC_TIMEOUT_EXIT_CODE);
    const pid = Number(/bg=(\d+)/.exec(result.stdout)?.[1]);
    assert.ok(Number.isInteger(pid) && pid > 0, `the script must report the background pid (stdout: ${JSON.stringify(result.stdout)})`);
    // The background sleeper is the orphan candidate: it must be gone once
    // the group is killed. Poll instead of a fixed sleep — the kill is
    // immediate, but the kernel reaps asynchronously and a loaded machine
    // can take longer. The intent is "no orphan survived", so wait for it.
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && alive()) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(!alive(), `the timed-out background sleeper (pid ${pid}) must be gone`);
  });

  it('cancels mid-run through the structural token', async () => {
    const token = core.create_cancellation_token();
    const executor = core.create_node_executor();
    const pending = executor({ script: 'sleep 5', timeout_ms: 10_000, cancellation: token });
    setTimeout(() => token.cancel(), 200);
    await assert.rejects(pending, /cancelled/);
  });

  it('rejects immediately on a pre-cancelled token without spawning', async () => {
    const executor = core.create_node_executor();
    await assert.rejects(
      executor({ script: 'echo never', cancellation: core.cancelled_token() }),
      /cancelled/,
    );
  });

  it('caps combined output at max_output_bytes', async () => {
    const executor = core.create_node_executor();
    const result = await executor({
      script: 'for i in $(seq 1 50); do echo "line-$i-payload-padding"; done',
      max_output_bytes: 64,
    });
    assert.strictEqual(result.exit_code, 1);
    assert.match(result.stderr, /exceeded 64 bytes/);
    assert.ok(result.stdout.length <= 64);
  });
});

describe('redaction boundary and denied approvals', () => {
  it('redacts immediately after stdout/stderr, before callbacks and TellResult', async () => {
    const seen = [];
    const runtime = core.createTellRuntime({
      model: script_model(['go\n<RUN>\necho hi\n</RUN>']),
      exec: true,
      executor: async () => ({ stdout: 'out SECRET end', stderr: 'err SECRET here', exit_code: 0 }),
      approval: async () => 'approved',
      redact: (value) => value.replaceAll('SECRET', '[redacted]'),
      callbacks: {
        onCommandOutput: (event) => seen.push(event),
      },
    });
    const result = await runtime.run('hi');
    assert.strictEqual(result.commands[0].output, 'out [redacted] end\nerr [redacted] here');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    assert.ok(!result.timeline.join('\n').includes('SECRET'));
    assert.deepStrictEqual(
      seen.map((event) => event.output),
      ['out [redacted] end\nerr [redacted] here'],
    );
  });

  it('never executes on the host when the approval denies (outside path included)', async () => {
    let executor_calls = 0;
    const runtime = core.create_core_runtime({
      config: core.resolve_core_config({ host: 'cli' }),
      model: script_model(['read it\n<RUN>\ncat /etc/passwd\n</RUN>']),
      executor: async () => {
        executor_calls += 1;
        return { stdout: 'root:x', stderr: '', exit_code: 0 };
      },
      approval: async () => 'denied',
    });
    const result = await runtime.run('hi');
    assert.strictEqual(executor_calls, 0);
    assert.strictEqual(result.commands[0].status, 'denied');
  });

  it('represents no-exec as denied/disabled without touching the host', async () => {
    let executor_calls = 0;
    const runtime = core.create_core_runtime({
      config: core.resolve_core_config({ host: 'cli', flag: { exec_enabled: false } }),
      model: script_model(['read it\n<RUN>\ncat /etc/passwd\n</RUN>']),
      executor: async () => {
        executor_calls += 1;
        return { stdout: 'x', stderr: '', exit_code: 0 };
      },
      approval: async () => 'approved',
    });
    const result = await runtime.run('hi');
    assert.strictEqual(executor_calls, 0);
    assert.strictEqual(result.commands[0].status, 'denied');
    assert.strictEqual(result.commands[0].reason, 'disabled');
    assert.strictEqual(result.commands[0].source, '--no-exec');
  });
});

describe('collect_sensitive_file_secrets (workspace redaction sources)', () => {
  it('collects .env values and key-file lines, skips .env.example and symlinks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-secret-scan-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-secret-out-'));
    try {
      fs.mkdirSync(path.join(dir, 'nested'));
      fs.writeFileSync(path.join(dir, '.env'), 'CANARY=super-secret-55\nSHORT=1\n# comment\n', 'utf8');
      fs.writeFileSync(path.join(dir, '.env.example'), 'ALLOWED=1\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'secret.key'), 'key-canary-55\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'nested', 'private.pem'), 'nested-secret-55\n', 'utf8');
      fs.writeFileSync(path.join(outside, 'outside.key'), 'outside-canary-55\n', 'utf8');
      fs.symlinkSync(path.join(outside, 'outside.key'), path.join(dir, 'link.key'));

      const values = core.collect_sensitive_file_secrets(dir);
      assert.ok(values.includes('super-secret-55'), JSON.stringify(values));
      assert.ok(values.includes('key-canary-55'), JSON.stringify(values));
      assert.ok(values.includes('nested-secret-55'), JSON.stringify(values));
      assert.ok(!values.includes('ALLOWED'), JSON.stringify(values));
      assert.ok(!values.includes('1'), JSON.stringify(values));
      assert.ok(!values.includes('outside-canary-55'), JSON.stringify(values));

      const redact = core.create_secret_redactor(values);
      const masked = redact('CANARY=super-secret-55\nkey=false\nnested-secret-55');
      assert.strictEqual(redact('1'), '1');
      assert.ok(!masked.includes('super-secret-55'), masked);
      assert.ok(!masked.includes('nested-secret-55'), masked);
      assert.ok(masked.includes(core.EXEC_REDACTED_MARKER), masked);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
