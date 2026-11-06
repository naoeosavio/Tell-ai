// Core permission tests — offline, no network, no provider.
// Proves the live-risk fix: named destroy commands are risky,
// the denial text stops the model, and a denied child stops.
// Run with: node --test test/test-core-permission.js (after the core build).
const assert = require('node:assert');
const { describe, it } = require('node:test');

const core = require('../packages/core/dist/index.cjs');

function base(script, profile) {
  return core.assess_base_risk(script, profile);
}

describe('Named destroy commands are risky', () => {
  it('flags force push, reset hard and docker destroy in both profiles', () => {
    const vectors = [
      ['git push --force origin main', 'git-force-push'],
      ['git push -f origin main', 'git-force-push'],
      ['git reset --hard HEAD~5', 'git-reset-hard'],
      ['docker run --privileged -v /:/host x', 'destructive-docker'],
      ['docker system prune -af', 'destructive-docker'],
      ['kubectl delete ns prod', 'destructive-kubectl-delete'],
      ['aws s3 rm s3://b --recursive', 'destructive-aws-s3-rm'],
      ['truncate -s 0 data.db', 'destructive-truncate'],
      ['export LD_PRELOAD=./x.so', 'environment-ld-preload'],
      ['systemctl enable x', 'persistence-scheduler'],
      ['pip install evil', 'install-pip'],
    ];
    for (const [script, rule] of vectors) {
      for (const profile of ['permissive', 'strict']) {
        const assessment = base(script, profile);
        assert.strictEqual(assessment.risky, true, `${profile}: ${script}`);
        assert.ok(assessment.rules.includes(rule), `${profile}: ${script} names ${rule}`);
        assert.strictEqual(assessment.severity, 'high', `${profile}: ${script}`);
      }
    }
  });

  it('keeps the safe counterparts allowed', () => {
    const safe = [
      'git push origin main',
      'git reset HEAD~5',
      'docker ps',
      'kubectl get pods',
      'aws s3 ls s3://b',
      'pip list',
      'echo hi',
    ];
    for (const script of safe) {
      assert.strictEqual(base(script, 'permissive').risky, false, script);
    }
  });
});

describe('Denial text stops the model', () => {
  it('says stop and report, never request a different command', () => {
    assert.match(core.COMMAND_DENIED_PREAMBLE, /Do not retry it/);
    assert.match(core.COMMAND_DENIED_PREAMBLE, /Do not work around it/);
    assert.match(core.COMMAND_DENIED_INSTRUCTION, /Stop and report/);
    assert.ok(!core.COMMAND_DENIED_PREAMBLE.includes('Request a different command'));
    assert.ok(!core.COMMAND_DENIED_INSTRUCTION.includes('simple command'));
  });

  it('names the rule in the feedback', () => {
    const text = core.format_denied_feedback('git push --force origin main', 'git-force-push');
    assert.ok(text.includes('Reason: git-force-push'));
    assert.ok(text.includes('Do not retry it'));
    assert.ok(text.includes('Stop and report it'));
  });

  it('child prompt stops on denial', () => {
    const prompt = core.child_system_prompt('research');
    assert.ok(prompt.includes('If a command is denied, stop and report it. Do not retry it.'));
    assert.ok(!prompt.includes('request a simpler one'));
  });
});

describe('Denied child stops', () => {
  it('stops on a denied command and reports BLOCKED', async () => {
    let calls = 0;
    const runner = core.create_delegation_runner({
      model: {
        ask: async () => {
          calls += 1;
          return '<RUN>\ncd /tmp && cat AGENTS.md\n</RUN>';
        },
      },
      executor: async () => ({ stdout: 'ok\n', stderr: '', exit_code: 0 }),
      cwd: '/tmp/work',
      exec_enabled: true,
    });
    const result = await runner({ kind: 'research', objective: 'read the repo' });
    assert.ok('outcome' in result);
    assert.strictEqual(calls, 1);
    assert.strictEqual(result.outcome.facts.commands_run, 0);
    assert.strictEqual(result.outcome.facts.denied, 1);
    assert.strictEqual(result.outcome.status, 'BLOCKED');
  });

  it('stops on a skipped approval and reports BLOCKED', async () => {
    let calls = 0;
    const runner = core.create_delegation_runner({
      model: {
        ask: async () => {
          calls += 1;
          return '<RUN>\ncat f\n</RUN>';
        },
      },
      executor: async () => ({ stdout: 'ok\n', stderr: '', exit_code: 0 }),
      approval: async () => 'skipped',
      exec_enabled: true,
    });
    const result = await runner({ kind: 'build', objective: 'read the file' });
    assert.ok('outcome' in result);
    assert.strictEqual(calls, 1);
    assert.strictEqual(result.outcome.status, 'BLOCKED');
  });
});
