// Custom endpoints: point any vendor at your own OpenAI-compatible URL.
//
// Run offline (localhost mock, no keys needed):
//   bun examples/sdk/custom-endpoint.ts
// Run against Ollama (optional, needs `ollama serve` + a pulled model):
//   OLLAMA_MODEL=qwen3 bun examples/sdk/custom-endpoint.ts
// Same idea via CLI:
//   LOCAL_OPENAI_BASE_URL=http://localhost:11434/v1 tell -m q "explain this"
//   LOCAL_OPENAI_BASE_URL=http://127.0.0.1:11434/v1 tell -m local:qwen3:high "explain this"
import http from 'node:http';
import { create_ask_ai } from '../../packages/sdk/src/index.ts';

const MOCK_TEXT = 'custom endpoint answer';

function start_mock(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let streamed = false;
      try {
        streamed = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean }).stream === true;
      } catch {
        // Non-JSON body — answer with a plain completion below.
      }
      if (streamed) {
        // Minimal OpenAI-compatible SSE stream: one delta, then DONE.
        const delta = `data: ${JSON.stringify({
          id: 'mock',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'mock',
          choices: [{ index: 0, delta: { content: MOCK_TEXT }, finish_reason: null }],
        })}\n\ndata: [DONE]\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(delta);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          created: 0,
          model: 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: MOCK_TEXT }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  });
}

async function scenario_mock(mock_url: string) {
  console.log('=== Scenario 1 — custom URL via SDKConfig (runs offline) ===\n');
  // Any `urls.<vendor>` slot accepts a custom baseURL — here `local`, which
  // needs no key. Keys stay optional for proxies that inject them server-side.
  const ai = await create_ask_ai('local:mock-model:high', { keys: {}, urls: { local: mock_url } });
  const answer = await ai.ask('Reply with exactly: ok', { system: 'test', stream: false });
  console.log(`  ask() -> ${answer}`);

  const seen: string[] = [];
  for await (const event of ai.ask_stream('Reply with exactly: ok', { system: 'test' })) {
    seen.push(event.type);
  }
  console.log(`  ask_stream() event types: ${seen.join(', ')}\n`);
}

async function scenario_ollama() {
  console.log('=== Scenario 2 — Ollama (optional, needs `ollama serve`) ===\n');
  const model = Bun.env['OLLAMA_MODEL'];
  if (!model) {
    console.log('  skipped: set OLLAMA_MODEL=<pulled-model> to try, e.g. OLLAMA_MODEL=qwen3\n');
    return;
  }
  const ai = await create_ask_ai(`local:${model}:high`, { keys: {}, urls: { local: 'http://localhost:11434/v1' } });
  try {
    const answer = await ai.ask('Answer in one sentence: what is the capital of Brazil?', {
      system: 'be concise',
      stream: false,
    });
    console.log(`  answer: ${answer}\n`);
  } catch (error) {
    console.log(`  failed: ${error instanceof Error ? error.message : error}`);
    console.log('  is `ollama serve` running and the model pulled (`ollama pull <model>`)?\n');
  }
}

function scenario_new_vendor() {
  console.log('=== Scenario 3 — brand-new vendor (no handler needed) ===\n');
  console.log('  Vendors without a dedicated handler fall back to the generic');
  console.log('  OpenAI-compatible provider, so adding one is two lines:');
  console.log('    1. add the name to SUPPORTED_VENDORS (packages/sdk/src/models.ts)');
  console.log('    2. point config.urls.<name> (or a default in COMPAT_DEFAULT_URLS)');
  console.log('  at the endpoint. No handler, no new dependency.\n');
}

const mock = await start_mock();
try {
  await scenario_mock(mock.url);
} finally {
  mock.close();
}
await scenario_ollama();
scenario_new_vendor();

console.log('=== Summary ===');
console.log('1. Any urls.<vendor> overrides the built-in default (proxy, mock, self-hosted).');
console.log('2. `local`/`v` need no key — ideal for Ollama and other local servers.');
console.log('3. CLI equivalent: LOCAL_OPENAI_BASE_URL=<url> tell -m q "..."');
