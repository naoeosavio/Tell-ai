// Library runtime on Bun — offline, no provider calls.
// Run with: bun examples/core/core-bun.ts
import { createTellRuntime, MemoryStorageAdapter } from '../../packages/core/src/runtime-api.ts';

const MODEL_ANSWER = 'Bun answer with a command.\n<RUN>\necho hello-bun\n</RUN>';

// Mocked ModelPort: answers without touching any provider or network.
const model = {
  async ask(_message: string, _options: { system: string; stream: false }): Promise<string> {
    return MODEL_ANSWER;
  },
};

// Environment allowlist: only these keys reach the executor, everything else
// (API keys, tokens, loader-injection variables) is dropped by the host.
const ALLOWLIST = new Set(['PATH', 'HOME', 'TMPDIR']);

function filter_env(env: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (ALLOWLIST.has(key)) {
      kept[key] = value;
    } else {
      // Dropped — never forwarded to the child.
    }
  }
  return kept;
}

// Bun/Node-comparable executor stand-in: no Bun global is required and
// nothing is spawned (offline). A real adapter would use Bun.spawn here with
// the filtered env above plus timeout and output caps.
async function bun_executor(options: {
  script: string;
  env?: Record<string, string>;
}): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  const safe_env = filter_env(options.env ?? {});
  void safe_env;
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
  executor: bun_executor,
  approval: async () => 'approved',
  env: { PATH: '/usr/bin', HOME: '/home/user', SECRET_API_KEY: 'must-not-forward' },
  callbacks: {
    onText: (text) => console.log(`[text] ${text}`),
    onCommandOutput: (event) => console.log(`[output] ${event.output.trim()}`),
  },
});

const result = await runtime.run('Say hello via a shell command.');
console.log(JSON.stringify(result, null, 2));
