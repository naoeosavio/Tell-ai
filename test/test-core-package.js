// Fase 1 gate for `tasks/task_035_core.md` — legal signoff, runtime and
// library-api contract. Fail-closed: exits non-zero with a specific message
// while signoff, contract or Node 22 are missing. The `packages/core`
// scaffold is allowed only after the GPL→MIT signoff exists, and the core
// must still not anticipate `TELL_KEY`/`TELL_BASE_URL` before the tellkey
// handoff. No network, no provider calls.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const CORE_DIR = path.join(ROOT, 'packages', 'core');
const CORE_SRC = path.join(CORE_DIR, 'src');
const CORE_MANIFEST = path.join(CORE_DIR, 'package.json');
const BROWSER_JS = path.join(CORE_DIR, 'dist', 'browser.js');
const BROWSER_SRC = path.join(CORE_SRC, 'browser.ts');
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

// Builtins that must never appear as specifiers in the browser entry or its
// bundle (bare or `node:`/`bun:`-prefixed) — Vite externalizes them as
// `__vite-browser-external` stubs that export nothing, breaking the build.
const BROWSER_FORBIDDEN_BUILTINS = [
  'fs',
  'path',
  'os',
  'crypto',
  'child_process',
  'readline',
  'http',
  'url',
  'util',
  'stream',
  'fs/promises',
];

function builtin_specifier_pattern(name) {
  const escaped = name.replace('/', '\\/');
  return new RegExp(`(?:from\\s*|require\\s*\\(|import\\s*\\()(['"])(?:node:|bun:)?${escaped}\\1`);
}

// The `browser` condition of the main entry must exist, come first (so Vite
// clients resolve it while Node skips the inactive condition), and point at
// built files.
function check_browser_export(failures) {
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(CORE_MANIFEST, 'utf8'));
  } catch {
    failures.push('BLOCKED: cannot read packages/core/package.json');
    return;
  }
  const main_export = manifest.exports?.['.'];
  if (!main_export || typeof main_export !== 'object') {
    failures.push('BLOCKED: packages/core exports["."] missing');
    return;
  }
  const keys = Object.keys(main_export);
  if (keys[0] !== 'browser') {
    failures.push(`BLOCKED: exports["."].browser must be the first condition (got [${keys.join(', ')}])`);
  }
  const browser = main_export.browser;
  const candidates = [
    browser?.import?.default,
    browser?.import?.types,
    browser?.require?.default,
    browser?.require?.types,
    browser?.default,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !fs.existsSync(path.join(CORE_DIR, candidate))) {
      failures.push(`BLOCKED: exports["."].browser points at missing file: ${candidate}`);
    }
  }
}

// `src/browser.ts` and its bundle must reference no Node/Bun builtin.
function check_browser_no_builtins(failures) {
  for (const file of [BROWSER_SRC, BROWSER_JS]) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      failures.push(`BLOCKED: cannot read ${path.relative(ROOT, file)} (build the core first)`);
      continue;
    }
    for (const name of BROWSER_FORBIDDEN_BUILTINS) {
      if (builtin_specifier_pattern(name).test(text)) {
        failures.push(`BLOCKED: ${path.relative(ROOT, file)} references builtin "${name}"`);
      }
    }
  }
}

// The browser bundle must stay self-contained: zero bare imports. A package
// specifier would drag that package's graph into the browser build — the
// shape that broke the Vite client once (`import '@tell-ai/sdk'` survived
// in the minified ESM bundle while the CJS one looked clean).
function check_browser_no_bare_imports(failures) {
  let text = '';
  try {
    text = fs.readFileSync(BROWSER_JS, 'utf8');
  } catch {
    failures.push('BLOCKED: cannot read packages/core/dist/browser.js (build the core first)');
    return;
  }
  // Import statements only (statement boundary + the `import` keyword), so a
  // string that merely contains the word "from" is not a false positive.
  const statement = /(?:^|[;})\n])\s*import\s*(?:[^"';]*?\s*from\s*)?["']([^"']+)["']/g;
  const specifiers = new Set();
  for (const match of text.matchAll(statement)) {
    const spec = match[1];
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      specifiers.add(spec);
    }
  }
  for (const spec of [...specifiers].sort()) {
    failures.push(`BLOCKED: dist/browser.js has a bare import "${spec}" (the browser bundle must be self-contained)`);
  }
}

// The browser bundle must import cleanly and expose the pure surface only:
// wording helpers work, Node-only factories are absent.
async function check_browser_functional(failures) {
  let mod = null;
  try {
    mod = await import(pathToFileURL(BROWSER_JS).href);
  } catch (error) {
    failures.push(`BLOCKED: dist/browser.js not importable: ${error.message}`);
    return;
  }
  for (const name of [
    'format_executed_command',
    'parse_command_feedback',
    'assess_base_risk',
    'validate_chain_decision_payload',
    'truncate_context',
    'resolve_core_config',
    'createLocalStorageAdapter',
    'run_primitive_loop',
    'create_core_runtime',
    'createTellRuntime',
    'create_cancellation_token',
    'format_command_feedback',
  ]) {
    if (typeof mod[name] !== 'function') {
      failures.push(`BLOCKED: dist/browser.js missing export "${name}"`);
    }
  }
  for (const name of ['create_node_executor', 'canonical_path', 'build_project_context', 'build_sdk_config_from_env']) {
    if (name in mod) {
      failures.push(`BLOCKED: dist/browser.js leaks Node-only export "${name}"`);
    }
  }
  try {
    const record = mod.format_executed_command('echo hi', 'hi');
    assert.ok(record.includes('Executed command:'), 'wording mismatch');
    const parsed = mod.parse_command_feedback(record);
    assert.strictEqual(parsed?.kind, 'executed', 'round-trip mismatch');
    assert.strictEqual(mod.assess_base_risk('sudo ls', 'strict').risky, true, 'risk mismatch');
  } catch (error) {
    failures.push(`BLOCKED: dist/browser.js pure helpers misbehave: ${error.message}`);
  }
}

// The removed `./loop-feedback` subpath must stay gone: nothing may
// reintroduce it (wording travels via the main entry + `browser` condition),
// and its build artifacts must not linger in dist.
function check_no_loop_feedback_subpath(failures) {
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(CORE_MANIFEST, 'utf8'));
  } catch {
    failures.push('BLOCKED: cannot read packages/core/package.json');
    return;
  }
  if (manifest.exports?.['./loop-feedback'] !== undefined) {
    failures.push('BLOCKED: packages/core exports["./loop-feedback"] resurrected (use the browser condition)');
  }
  for (const file of ['loop-feedback.js', 'loop-feedback.cjs', 'loop-feedback.d.ts', 'loop-feedback.d.cts']) {
    if (fs.existsSync(path.join(CORE_DIR, 'dist', file))) {
      failures.push(`BLOCKED: stale artifact packages/core/dist/${file} (drop the loop-feedback build entry)`);
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
  check_browser_export(failures);
  check_browser_no_builtins(failures);
  check_browser_no_bare_imports(failures);
  await check_browser_functional(failures);
  check_no_loop_feedback_subpath(failures);

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
