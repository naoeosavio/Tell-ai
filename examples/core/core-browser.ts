// Library runtime in the browser — offline, no provider calls.
// Run with: bun examples/core/core-browser.ts
// This file is browser-safe by construction: no Node builtin imports, no
// environment reads, no ambient storage and no ambient network. Storage and
// network are injected fakes through the structural contracts.
import { createTellRuntime } from '../../packages/core/src/runtime-api.ts';
import { createLocalStorageAdapter } from '../../packages/core/src/browser-runtime.ts';

const MODEL_ANSWER = '<think>checking the question</think>\nAnswer from the mocked model.';

// Injected StorageLike fake (an in-memory Map behind the structural
// contract). Pass a real DOM-storage-shaped object here in production.
function fake_storage_like(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

// Injected FetchLike fake with package-owned request/response shapes.
function fake_fetch(): (request: { url: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }> {
  return async (request: { url: string }) => ({
    ok: true,
    status: 200,
    url: request.url,
    json: async () => ({}),
    text: async () => '',
  });
}

// Mocked ModelPort: answers without touching any provider or network.
const model = {
  async ask(_message: string, _options: { system: string; stream: false }): Promise<string> {
    return MODEL_ANSWER;
  },
};

// No executor: browser turns report commands and never execute them.
const runtime = createTellRuntime({
  model,
  storage: createLocalStorageAdapter(fake_storage_like()),
  fetch: fake_fetch(),
  callbacks: {
    onThinking: (content) => console.log(`[thinking] ${content}`),
    onText: (text) => console.log(`[text] ${text}`),
  },
});

const result = await runtime.run('What is the answer?');
console.log(JSON.stringify(result, null, 2));
