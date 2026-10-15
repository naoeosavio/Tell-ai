// Library runtime on Node — offline, no provider calls.
// Run with: bun examples/core/core-node.ts
import { createTellRuntime, MemoryStorageAdapter } from '../../packages/core/src/runtime-api.ts';

const MODEL_ANSWER = 'Hello from the mocked model.\n<RUN>\necho hello-runtime\n</RUN>';

// Mocked ModelPort: answers without touching any provider or network.
const model = {
  async ask(_message: string, _options: { system: string; stream: false }): Promise<string> {
    return MODEL_ANSWER;
  },
};

// Node-shaped executor stand-in: simulates a child_process result for `echo`
// without spawning anything (offline). A real adapter would call execFile
// here with an environment allowlist and output caps.
async function node_executor(options: { script: string }): Promise<{ stdout: string; stderr: string; exit_code: number }> {
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
  executor: node_executor,
  approval: async () => 'approved',
  cwd: process.cwd(),
  platform: process.platform,
  callbacks: {
    onThinking: (content) => console.log(`[thinking] ${content}`),
    onText: (text) => console.log(`[text] ${text}`),
    onCommandStart: (event) => console.log(`[run] ${event.script}`),
  },
});

const result = await runtime.run('Say hello via a shell command.');
console.log(JSON.stringify(result, null, 2));
