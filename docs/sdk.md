# SDK (Programmatic Usage)

`tell-ai` can be imported as a library — no CLI, no child processes, no terminal. You control every side effect through callbacks.

```bash
npm install tell-ai
```

```ts
import { tell } from 'tell-ai';
// or
const { tell } = require('tell-ai');
```

---

## Why use `tell-ai` as a library?

| Scenario | With the CLI | With the SDK |
|---|---|---|
| Shell automation / scripts | `tell "create a docker-compose.yml"` | — |
| Web backend (Express, Next.js, NestJS) | Spawn a child process, capture stdout, strip ANSI | `const { text } = await tell(...)` |
| Frontend / PWA | Impossible — browser has no shell | `import { tell }` works anywhere JS runs |
| Electron / desktop app | Manage subprocess lifecycle | In-process, no shell overhead |
| Chatbot (Telegram, Discord, Slack) | Polling shell script with `timeout` | Async function, pipeline to messages |
| Custom sandbox / restricted env | Trust the model not to escape the shell | Replace `executeCommand` with your own sandbox |
| Streaming UI (websockets, SSE) | Parse stdout lines | Use `onText`, `onThinking`, `onCommandOutput` callbacks |
| Database-backed context | File-based `~/.ai/tell_context/` | Inject `getContext` / `setContext` pointing at your DB |
| Multi-tenant SaaS | One machine, one user | Per-user model/context isolation with custom storage |

**TL;DR:** The SDK decouples the AI loop from the operating system. You bring the environment, we bring the model.

---

## API reference

### `tell(prompt, options)` / `tell(model, prompt, options)`

```ts
async function tell(prompt: string, opts?: TellOptions): Promise<TellResult>;
async function tell(model: string, prompt: string, opts?: TellOptions): Promise<TellResult>;
```

| Parameter | Type | Description |
|---|---|---|
| `model` | `string` | Model alias (e.g. `'g'`, `'d'`) or full spec (`'openai:gpt-5.5:medium'`). Defaults to `TELL_MODEL` env or `'g'`. |
| `prompt` | `string` | The message sent to the AI. |
| `opts` | `TellOptions` | Behavioral flags and callback overrides (see below). |

Returns `TellResult`:

```ts
interface TellResult {
  text: string;       // Final visible response from the assistant
  timeline: string[]; // Full conversation log for this invocation
}
```

### `TellOptions`

All properties are optional. When a callback is omitted, the SDK uses Node.js default implementations (filesystem, `child_process`, `readline`).

```ts
interface TellOptions {
  // ── Behavioral flags (same as CLI) ──────────────────────────────────
  model?: string;     // Override model alias
  context?: boolean;  // Enable persistent context (default: false)
  yes?: boolean;      // Auto-execute commands (high-risk still needs confirmation)
  chain?: boolean;    // Multi-step mode — model can run sequential commands
  exec?: boolean;     // Enable command execution (default: true, set false to disable)
  silent?: boolean;   // Suppress all stderr/stdout output
  cwd?: string;       // Working directory for commands (default: process.cwd())

  // ── Execution ───────────────────────────────────────────────────────
  executeCommand?: (script: string) => Promise<string> | string;
  confirmCommand?: (script: string, isHighRisk: boolean) => Promise<boolean> | boolean;

  // ── Output / streaming ──────────────────────────────────────────────
  onThinking?: (isThinking: boolean) => void;
  onText?: (text: string) => void;
  onCommandRequest?: (script: string) => void;
  onCommandOutput?: (script: string, output: string) => void;
  onCommandSkip?: (script: string, reason: 'disabled' | 'skipped') => void;

  // ── Context persistence ─────────────────────────────────────────────
  getContext?: (model: string) => Promise<string> | string;
  setContext?: (model: string, contextText: string) => Promise<void> | void;
  clearContext?: (model: string) => Promise<void> | void;

  // ── Logging ─────────────────────────────────────────────────────────
  appendLog?: (text: string) => Promise<void> | void;
}
```

#### Callback reference

| Callback | When called | Use for |
|---|---|---|
| `executeCommand` | Model requests `<RUN>` and user confirmed | Sandboxing, Docker exec, SSH, or mocking |
| `confirmCommand` | Before executing any command | Custom authorization UI, rate-limiting, audit |
| `onThinking` | AI starts/stops generating | Show/hide typing indicator in UI |
| `onText` | Final visible response ready | Stream to WebSocket, append to chat |
| `onCommandRequest` | Model emits a `<RUN>` tag | Log for audit, show in terminal |
| `onCommandOutput` | Command finishes executing | Show output in UI, stream to client |
| `onCommandSkip` | Command blocked or skipped | Notify user, log rejection |
| `getContext` | Loading persistent context | Read from database, localStorage, redis |
| `setContext` | Saving context after conversation | Write to database, localStorage, redis |
| `clearContext` | Clearing context (non-`-c` invocations) | Delete session from store |
| `appendLog` | Every assistant message and command result | Ship logs to external service, write to file |

---

## Examples

### 1. Express backend

```ts
import express from 'express';
import { tell } from 'tell-ai';

const app = express();
app.use(express.json());

app.post('/api/ask', async (req, res) => {
  const { prompt, model = 'g', context = false } = req.body;

  try {
    const result = await tell(model, prompt, {
      context,
      silent: true,
      exec: false,            // never execute commands from web requests
      onThinking: (thinking) => {
        // push to websocket or SSE
        console.log(thinking ? 'AI is thinking...' : 'AI responding...');
      },
    });

    res.json({ reply: result.text, timeline: result.timeline });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.listen(3000);
```

### 2. Next.js API route (App Router)

```ts
// app/api/tell/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { tell } from 'tell-ai';

export async function POST(req: NextRequest) {
  const { prompt, model, history } = await req.json();

  const result = await tell(model || 'd', prompt, {
    exec: false,
    silent: true,
    context: true,
    getContext: () => history || '',
    setContext: async (_, text) => {
      // Save to your database
      await db.sessions.update({ where: { id: sessionId }, data: { context: text } });
    },
  });

  return NextResponse.json({ reply: result.text });
}
```

### 3. WebSocket streaming

```ts
import { WebSocketServer } from 'ws';
import { tell } from 'tell-ai';

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    const { prompt, model } = JSON.parse(data.toString());

    await tell(model || 'g', prompt, {
      silent: true,
      onThinking: (thinking) => ws.send(JSON.stringify({ type: 'thinking', thinking })),
      onText: (text) => ws.send(JSON.stringify({ type: 'text', text })),
      onCommandRequest: (script) => ws.send(JSON.stringify({ type: 'command', script })),
      onCommandOutput: (script, output) =>
        ws.send(JSON.stringify({ type: 'output', script, output })),
    });
  });
});
```

### 4. Frontend (browser) — read-only assistant

No Node.js APIs needed. Useful for helpdesk, documentation bots, or in-app copilots.

```ts
import { tell } from 'tell-ai';

async function askAssistant(userMessage: string) {
  const result = await tell('g', userMessage, {
    silent: true,
    exec: false,
    onThinking: (thinking) => {
      document.getElementById('spinner')!.style.display = thinking ? 'block' : 'none';
    },
    onCommandRequest: (script) => {
      console.warn('Model requested command (blocked in browser):', script);
    },
  });

  return result.text;
}

// Usage in a React component:
// const [reply, setReply] = useState('');
// const handleAsk = async () => {
//   setReply(await askAssistant('explain how Promises work'));
// };
```

**Caveats for browser usage:**
- Set `exec: false` — the browser has no shell.
- API keys must be exposed client-side (use a proxy backend for production).
- Use a bundler (Vite, webpack, esbuild) that resolves Node built-ins to polyfills/no-ops.

### 5. Frontend + proxy backend (production-safe)

Browser talks to your backend, which calls `tell` server-side. API keys never reach the client.

```ts
// backend: POST /api/tell
app.post('/api/tell', async (req, res) => {
  const result = await tell(req.body.model, req.body.prompt, {
    exec: false,
    silent: true,
    onText: (chunk) => {
      // Could also stream via SSE here
    },
  });
  res.json({ reply: result.text });
});

// frontend
const reply = await fetch('/api/tell', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'd', prompt: 'explain REST' }),
}).then((r) => r.json());
```

### 6. Sandboxed command execution

Run model-requested commands inside a Docker container, VM, or isolated directory.

```ts
import { tell } from 'tell-ai';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const result = await tell('d', 'create a file called test.txt with "hello" inside', {
  cwd: '/tmp/sandbox',
  yes: true, // auto-execute inside the sandbox
  executeCommand: async (script) => {
    // Run inside a Docker container instead of the host
    const { stdout, stderr } = await execAsync(
      `docker run --rm -v /tmp/sandbox:/work alpine sh -c ${JSON.stringify(script)}`,
    );
    return stdout + stderr;
  },
  confirmCommand: async (script, isHighRisk) => {
    // Block any network access from the sandbox
    if (script.includes('curl') || script.includes('wget')) return false;
    return !isHighRisk;
  },
});
```

### 7. Database-backed context (multi-tenant)

```ts
import { tell } from 'tell-ai';
import { db } from './db';

async function askForUser(userId: string, prompt: string) {
  return tell('g', prompt, {
    context: true,
    silent: true,
    getContext: async (model) => {
      const row = await db.sessions.findFirst({
        where: { userId, model },
        orderBy: { updatedAt: 'desc' },
      });
      return row?.context || '';
    },
    setContext: async (model, text) => {
      await db.sessions.upsert({
        where: { userId_model: { userId, model } },
        update: { context: text, updatedAt: new Date() },
        create: { userId, model, context: text },
      });
    },
    clearContext: async (model) => {
      await db.sessions.deleteMany({ where: { userId, model } });
    },
  });
}
```

### 8. Telegram bot (JS version)

Replaces the shell-based bot from `integrations.md` with 40 lines of JS.

```ts
import { tell } from 'tell-ai';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const API = `https://api.telegram.org/bot${TOKEN}`;
let offset = 0;

async function sendMessage(chatId: number, text: string) {
  await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

async function poll() {
  const res = await fetch(`${API}/getUpdates?offset=${offset}&timeout=10`);
  const { result } = await res.json();

  for (const update of result || []) {
    offset = update.update_id + 1;
    const chatId = update.message?.chat?.id;
    const text = update.message?.text;
    if (!chatId || !text) continue;

    const reply = await tell('d', text, {
      exec: false,
      silent: true,
      onThinking: () => fetch(`${API}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
      }),
    });

    await sendMessage(chatId, reply.text);
  }
}

setInterval(poll, 2000);
```

### 9. Electron / desktop app

```ts
import { tell } from 'tell-ai';

// In main process (has Node.js access):
ipcMain.handle('tell-ask', async (_, model: string, prompt: string, opts: any) => {
  const result = await tell(model, prompt, {
    ...opts,
    executeCommand: async (script) => {
      // Execute in a real terminal subprocess
      const { exec } = require('node:child_process');
      const { promisify } = require('node:util');
      const { stdout, stderr } = await promisify(exec)(script);
      return stdout + stderr;
    },
    onThinking: (thinking) => {
      mainWindow.webContents.send('tell-thinking', thinking);
    },
    onText: (text) => {
      mainWindow.webContents.send('tell-text', text);
    },
  });
  return result;
});

// In renderer (browser context):
const reply = await ipcRenderer.invoke('tell-ask', 'g', 'create a React component', {
  cwd: projectPath,
  yes: true,
});
```

### 10. Chain mode with progress tracking

```ts
import { tell } from 'tell-ai';

const steps: string[] = [];

const result = await tell('d', 'find out why the build is failing and fix it', {
  chain: true,
  silent: true,
  onCommandRequest: (script) => {
    steps.push(`Running: ${script}`);
    console.log(`[step ${steps.length}] ${script}`);
  },
  onCommandOutput: (script, output) => {
    console.log(`[output] ${output.slice(0, 200)}...`);
  },
  onText: (text) => {
    console.log(`[final] ${text}`);
  },
});

console.log(`Done in ${steps.length} steps.`);
```

---

## Exported utilities

```ts
import {
  tell,              // Main function
  TellOptions,       // Options type
  TellResult,        // Result type
  isHighRiskScript,  // Check if a script matches dangerous patterns
  MODELS,            // Record of all model aliases
  resolveModelSpec,  // Parse alias/full-spec into { vendor, model, thinking, fast }
  createAskAI,       // Low-level: create AskInstance from model spec
} from 'tell-ai';
```

---

## Model aliases

Same shortcodes as the CLI. See [usage.md](usage.md#model-aliases) for the full table.

```ts
// Short alias
await tell('d', 'your prompt');          // DeepSeek V4 Pro (medium thinking)

// Full spec
await tell('openai:gpt-5.5:high', '...');
await tell('anthropic:claude-sonnet-4-6:medium', '...');

// Fast mode (no reasoning tokens)
await tell('.g', 'quick answer');        // GPT-5.5 with reasoning disabled
await tell('openai:gpt-5.5:none', '...');
```

---

## Security

- **`exec: false`** disables all command execution. Always set this for public-facing endpoints.
- **`confirmCommand`** lets you implement custom authorization (RBAC, rate limits, audit log).
- **`isHighRiskScript`** is exported so you can pre-screen scripts before even calling `tell`.
- **API keys** are resolved from environment variables or `~/.config/<vendor>.token`. Never expose them to the frontend — use a proxy backend.
- **`cwd`** restricts filesystem access when using `executeCommand`.

```ts
// Pre-screen a script from untrusted sources
import { isHighRiskScript } from 'tell-ai';

if (isHighRiskScript(userProvidedScript)) {
  throw new Error('Blocked: high-risk pattern detected');
}
```
