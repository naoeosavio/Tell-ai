// Fase 1 gate for `tasks/task_035_core.md` — legal signoff, runtime and
// library-api contract. Fail-closed: exits non-zero with a specific message
// while signoff, contract or Node 22 are missing. The `packages/core`
// scaffold is allowed only after the GPL→MIT signoff exists, and the core
// must still not anticipate `TELL_KEY`/`TELL_BASE_URL` before the tellkey
// handoff. No network, no provider calls.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE_DIR = path.join(ROOT, 'packages', 'core');
const CORE_SRC = path.join(CORE_DIR, 'src');
const PROVENANCE = path.join(ROOT, 'docs', 'core-provenance.md');
const SDK_MANIFEST = path.join(ROOT, 'packages', 'sdk', 'package.json');
const INSTALLED_AI_MANIFEST = path.join(ROOT, 'node_modules', 'ai', 'package.json');
const BUN_LOCK = path.join(ROOT, 'bun.lock');

// Minimum Node major required by `ai@7` (see `packages/web/package.json`).
const MIN_NODE_MAJOR = 22;
// Expected AI SDK line pinned by `packages/sdk/package.json`.
const EXPECTED_AI_VERSION = '7.0.99';

// Collected gate failures; empty means the gate passes.
function check_node_version(failures) {
  const parts = process.versions.node.split('.');
  const major = Number(parts[0]);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    failures.push(`BLOCKED: node >= ${MIN_NODE_MAJOR} required (got ${process.versions.node})`);
  }
}

// Human GPL→MIT signoff must exist before any `packages/core` scaffold.
function check_legal_signoff(failures) {
  let text = '';
  try {
    text = fs.readFileSync(PROVENANCE, 'utf8');
  } catch {
    failures.push('BLOCKED: missing human GPL→MIT signoff in docs/core-provenance.md');
    return;
  }
  const lowered = text.toLowerCase();
  const has_approval = lowered.includes('approv') || lowered.includes('autoriz') || lowered.includes('signoff');
  const has_licenses = lowered.includes('gpl') && lowered.includes('mit');
  if (!has_approval || !has_licenses) {
    failures.push('BLOCKED: docs/core-provenance.md exists but lacks GPL→MIT human approval');
  }
}

// The runtime contract (`createTellRuntime`/ports, owned by the core since
// the move from `@tell-ai/sdk`) must exist; the loop never defines a second
// contract next to it.
function check_library_contract(failures) {
  const candidates = [
    path.join(ROOT, 'packages', 'core', 'src', 'runtime-api.ts'),
    path.join(ROOT, 'packages', 'core', 'src', 'browser-runtime.ts'),
  ];
  const has_contract_file = candidates.every((file) => fs.existsSync(file));
  let has_factory = false;
  try {
    const core = require('@tell-ai/core');
    has_factory = typeof core.createTellRuntime === 'function';
  } catch {
    has_factory = false;
  }
  if (!has_contract_file || !has_factory) {
    failures.push('BLOCKED: core runtime contract missing (createTellRuntime/ports per task_035_core.md)');
  }
}

// `ai@7.0.99` must agree across manifest, installed package and lockfile.
function check_ai_pin(failures) {
  let declared = '';
  try {
    const manifest = JSON.parse(fs.readFileSync(SDK_MANIFEST, 'utf8'));
    declared = manifest.dependencies.ai || '';
  } catch {
    declared = '';
  }
  let installed = '';
  try {
    const manifest = JSON.parse(fs.readFileSync(INSTALLED_AI_MANIFEST, 'utf8'));
    installed = manifest.version || '';
  } catch {
    installed = '';
  }
  let lock_text = '';
  try {
    lock_text = fs.readFileSync(BUN_LOCK, 'utf8');
  } catch {
    lock_text = '';
  }
  const declares_pin = declared.includes(EXPECTED_AI_VERSION);
  const installs_pin = installed === EXPECTED_AI_VERSION;
  const locks_pin = lock_text.includes(`ai@${EXPECTED_AI_VERSION}`);
  if (!declares_pin || !installs_pin || !locks_pin) {
    failures.push(
      `BLOCKED: ai@${EXPECTED_AI_VERSION} mismatch (manifest:${declared || '?'} installed:${installed || '?'} lock:${locks_pin ? 'ok' : 'miss'})`,
    );
  }
}

// The `packages/core` scaffold is allowed only after the GPL→MIT signoff;
// before it, any scaffold fails. After it, only an early `TELL_KEY`/
// `TELL_BASE_URL` in `src/config.ts` fails (tellkey handoff owns those keys).
function check_scaffold_timing(failures, has_signoff) {
  const scaffold_exists = fs.existsSync(CORE_DIR);
  if (!has_signoff && scaffold_exists) {
    failures.push('BLOCKED: packages/core exists before the GPL→MIT gate — remove scaffold until signoff');
    return;
  } else if (!has_signoff) {
    return;
  } else {
    const config = path.join(CORE_SRC, 'config.ts');
    let text = '';
    try {
      text = fs.readFileSync(config, 'utf8');
    } catch {
      return;
    }
    const without_comments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    if (without_comments.includes('TELL_KEY') || without_comments.includes('TELL_BASE_URL')) {
      failures.push('BLOCKED: packages/core/src/config.ts anticipates TELL_KEY/TELL_BASE_URL before the tellkey handoff');
    } else {
      // Scaffold after signoff without early keys — allowed.
    }
  }
}

(async () => {
  const src_existed_before = fs.existsSync(CORE_SRC);
  const failures = [];
  check_node_version(failures);
  const signoff_failures = [];
  check_legal_signoff(signoff_failures);
  failures.push(...signoff_failures);
  check_library_contract(failures);
  check_ai_pin(failures);
  check_scaffold_timing(failures, signoff_failures.length === 0);

  // The gate is a pure reader: it must never scaffold code as a side effect.
  assert.strictEqual(fs.existsSync(CORE_SRC), src_existed_before, 'gate must not change packages/core/src');

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    console.error(`core package gate BLOCKED (${failures.length} reason(s))`);
    process.exitCode = 1;
    return;
  }

  console.log('core package gate passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
