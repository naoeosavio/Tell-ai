// Live Web validation for task_039 (Playwright + Chromium, real OpenRouter models).
// Per model: boots the real server, drives the chat in a headless browser,
// approves one RUN command through the confirm card, and asserts the marker
// output plus the "Executed command" feedback card render.
// Usage: node test/test-web-live-task039.js
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..');
const DIST_SERVER = path.join(REPO, 'packages', 'web', 'dist', 'server.js');

const MODELS = [
  { name: 'dots', spec: 'openrouter:dots-studio/dots-3-note-preview:free', port: 3991 },
  { name: 'ling', spec: 'openrouter:inclusionai/ling-3.1-flash', port: 3992 },
  { name: 'apodex', spec: 'openrouter:apodex/apodex-1.1-mini:free', port: 3993 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot_server(model, port) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `web-live-${model.name}-`));
  const proc = spawn(process.execPath, [DIST_SERVER, '--cwd', cwd, '--port', String(port), '-m', model.spec], {
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += String(d); });
  proc.stderr.on('data', (d) => { out += String(d); });
  const deadline = Date.now() + 30000;
  for (;;) {
    if (out.includes(`running at http://`)) break;
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`server did not boot for ${model.name}: ${out.slice(-1000)}`);
    }
    await sleep(250);
  }
  // Readiness probe.
  const probe_deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (res.ok) break;
    } catch { /* still booting */ }
    if (Date.now() > probe_deadline) {
      proc.kill('SIGKILL');
      throw new Error(`config probe failed for ${model.name}`);
    }
    await sleep(250);
  }
  return { proc, cwd, base: `http://127.0.0.1:${port}` };
}

async function validate_model(model) {
  console.log(`\n=== live: ${model.name} (${model.spec}) ===`);
  const { proc, cwd, base } = await boot_server(model, model.port);
  const marker = `WEB_MARKER_${model.name.toUpperCase()}`;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.log(`[${model.name}] pageerror: ${error.message}`));
    // Force the offline fallback loop: the server-side chain is unreachable,
    // so the App runs the local loop (RUN → /api/execute → feedback card).
    // This is the exact Fase-2 browser path under test.
    await page.route('**/api/chain*', (route) => route.abort());
    await page.goto(base, { waitUntil: 'networkidle' });
    const input = page.locator('textarea[placeholder*="Ask the agent"]');
    await input.waitFor({ timeout: 30000 });

    // The boot model must be selected and its vendor keyed.
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.strictEqual(config.defaultModel, model.spec, 'boot model must be the default');
    const models = await (await fetch(`${base}/api/models`)).json();
    assert.strictEqual(models.keysStatus.openrouter, true, 'openrouter key must be keyed');
    console.log(`[${model.name}] config ok (defaultModel + openrouter keyed)`);

    // Local fallback loop (no --chain on the server): the Chain Loop toggle
    // must be on so the executed output feeds back to the model.
    const chain_toggle = page.locator('label:has-text("Chain Loop") input[type="checkbox"]');
    if (!(await chain_toggle.isChecked())) {
      await chain_toggle.click();
    }
    assert.ok(await chain_toggle.isChecked(), 'Chain Loop toggle must be on');

    await input.fill(`Reply with ONLY a RUN block containing exactly this command and no other text: echo ${marker}`);
    await page.locator('button[type="submit"]').click();

    // The local loop pauses on the manual confirm card.
    const card = page.locator('text=Permission Requested: Shell Execution');
    await card.waitFor({ timeout: 240000 });
    const card_text = await page.locator('pre').filter({ hasText: 'echo' }).first().innerText().catch(() => '');
    assert.ok(card_text.includes(`echo ${marker}`), `confirm card must show the marker command, got: ${card_text.slice(0, 200)}`);
    console.log(`[${model.name}] confirm card shows the command`);

    await page.locator('button:has-text("Authorize & Execute")').click();

    // The executed output feeds back through the local loop into the chat.
    await page.locator(`text=${marker}`).first().waitFor({ timeout: 240000 });
    console.log(`[${model.name}] marker output rendered in chat`);

    // The feedback card (core wording parsed by the delegated parser) renders
    // with the EXECUTED COMMAND header; expanding it shows command + output.
    const header = page.locator('button:has-text("EXECUTED COMMAND")').first();
    await header.waitFor({ timeout: 60000 });
    await header.click();
    const card_body = page.locator('pre', { hasText: `echo ${marker}` }).first();
    await card_body.waitFor({ timeout: 30000 });
    console.log(`[${model.name}] feedback card parsed and expanded (command + output)`);

    await page.screenshot({ path: path.join('/tmp', `web-live-${model.name}.png`) });

    // The request really went to the boot model, and the session persisted
    // through the migrated canonical_* paths.
    const session_file = path.join(cwd, '.tell', 'session.json');
    assert.ok(fs.existsSync(session_file), '.tell/session.json must exist after the run');
    const session = JSON.parse(fs.readFileSync(session_file, 'utf8'));
    assert.strictEqual(session.model, model.spec, 'chat must have run on the boot model');
    console.log(`[${model.name}] session persisted on the boot model`);

    console.log(`=== live: ${model.name} PASSED ===`);
  } finally {
    await browser.close();
    proc.kill('SIGKILL');
  }
}

(async () => {
  assert.ok(fs.existsSync(DIST_SERVER), 'web bundle missing (run the web build first)');
  const only = (process.env['LIVE_MODEL'] || '').trim().toLowerCase();
  const targets = only ? MODELS.filter((m) => m.name === only) : MODELS;
  assert.ok(targets.length > 0, `unknown LIVE_MODEL=${only}`);
  for (const model of targets) {
    await validate_model(model);
  }
  console.log('\nAll live Web validations passed.');
})().catch((error) => {
  console.error(`LIVE VALIDATION FAILED: ${error.message}`);
  process.exitCode = 1;
});
