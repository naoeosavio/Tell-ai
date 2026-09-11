const PROXY = 'http://localhost:3000';

const MODEL = 'j';
const SPEC = 'gemini-3.5-flash-lite (google)';

async function raw_demo() {
  console.log('=== Scenario 1 — Raw HTTP via proxy (browser/curl without SDK) ===\n');
  const url = `${PROXY}/google/models`;

  console.log(`GET ${url}`);
  console.log(`  headers: { 'x-goog-api-key': 'proxy' }  <-- placeholder\n`);
  const r1 = await fetch(url, { headers: { 'x-goog-api-key': 'proxy' } });
  const body1 = (await r1.json()) as { models?: { name: string }[] };
  const names = body1.models?.slice(0, 3).map((m) => m.name) ?? [];
  console.log(`-> status ${r1.status} — the proxy swapped 'proxy' for the real server key`);
  console.log(`   models returned (first 3): ${names.join(', ')}\n`);

  const r2 = await fetch(url);
  const body2 = (await r2.json()) as { models?: unknown[] };
  console.log(`GET ${url} (no headers) → status ${r2.status} — ${body2.models?.length ?? 0} models`);
  console.log('   the proxy injected the server key by itself\n');
}

async function sdk_demo() {
  console.log(`=== Scenario 2 — SDK tell() via proxy (real browser usage) ===`);
  console.log(
    `\n  tell('...', {\n    model: '${MODEL}',   // ${SPEC}\n    keys: { google: 'proxy' },        // required placeholder (the SDK rejects empty)\n    urls: { google: '${PROXY}/google' }, // points to the proxy\n  })\n`,
  );

  const { tell } = await import('../../packages/sdk/src/index.ts');
  const t0 = performance.now();
  const answer = await tell('Answer in one sentence: what is the capital of Brazil?', {
    model: MODEL,
    keys: { google: 'proxy' },
    urls: { google: `${PROXY}/google` },
    platform: 'demo (proxy)',
  });
  const ms = Math.round(performance.now() - t0);
  console.log(`-> answer in ${ms}ms:\n`);
  console.log(`   ${answer}`);
}

await raw_demo();
await sdk_demo();

console.log('\n=== Summary ===');
console.log('1. Run the proxy with the keys:  GOOGLE_API_KEY=... bun examples/web/proxy.ts');
console.log(`2. The client uses urls.google = '${PROXY}/google' and keys.google = 'proxy' (any string).`);
console.log('3. The proxy replaces the placeholder with the server key — the real key never reaches the browser.');
