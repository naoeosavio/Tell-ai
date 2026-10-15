// Library runtime behind a backend — offline, no provider calls.
// Run with: bun examples/core/core-express.ts
// The boundary supports backends without turning the SDK into Node: the app
// imports the public `@tell-ai/core` entrypoint and injects Node-only
// ports (executor, storage) from the host side. No framework dependency here —
// the handler below has the exact shape an Express route would call.
import { createTellRuntime, MemoryStorageAdapter } from '../../packages/core/src/runtime-api.ts';

const MODEL_ANSWER = 'Backend answer.\n<RUN>\necho hello-backend\n</RUN>';

// Mocked ModelPort: answers without touching any provider or network.
const model = {
  async ask(_message: string, _options: { system: string; stream: false }): Promise<string> {
    return MODEL_ANSWER;
  },
};

// Host-side executor stand-in (offline). Production wires child_process here
// with an environment allowlist, timeout and output caps.
async function host_executor(options: { script: string }): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  const script = options.script.trim();
  if (script.startsWith('echo ')) {
    return { stdout: `${script.slice('echo '.length).trim()}\n`, stderr: '', exit_code: 0 };
  } else {
    return { stdout: '', stderr: `refused: ${script}`, exit_code: 1 };
  }
}

const runtime = createTellRuntime({
  model,
  exec: true,
  storage: new MemoryStorageAdapter(),
  executor: host_executor,
  approval: async () => 'approved',
});

// Same shape as `app.post('/api/ask', handler)`: receives a prompt, returns
// the TellResult payload the frontend renders.
async function handle_ask(prompt: string): Promise<unknown> {
  return runtime.run(prompt);
}

const result = await handle_ask('Say hello via a shell command.');
console.log(JSON.stringify(result, null, 2));
