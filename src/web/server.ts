import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { generateText } from 'ai';
import { getModel, MODELS, resolveModelSpec } from '../ai/models';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_MODEL = (process.env.TELL_MODEL || 'l').trim();

app.use(express.json());

// Helper: security check for high-risk scripts (copied from Tell-ai's engine)
function isHighRiskScript(script: string): boolean {
  const compact = script.replace(/\\\n/g, ' ').replace(/\s+/g, ' ').trim();
  const privilegedPath = [
    String.raw`(?:/(?:etc|boot|dev|proc|sys|usr|bin|sbin|lib|lib64)(?:\b|/)|`,
    String.raw`/(?:var/(?:spool/cron|cron)|etc/cron(?:\.(?:d|daily|hourly|monthly|weekly))?)(?:\b|/)|`,
    String.raw`(?:~|\$HOME)/(?:\.config/(?:autostart|systemd/user)|\.local/share/systemd/user)(?:\b|/))`,
  ].join('');
  return [
    /\b(?:sudo|doas|pkexec)\b/,
    /\brm\s+(-[^\s]*[rf][^\s]*|-[^\s]*[fr][^\s]*)\b/,
    /\b(git\s+clean\s+-[^\s]*[xfd]|mkfs|shutdown|reboot)\b/,
    /\bdd\b.*\bof=/,
    /\b(chmod|chown)\s+-R\b.*\s\/(?:\s|$)/,
    /(?:curl|wget)\b[^|;&]*\|\s*(?:ba)?sh\b/,
    /(?:^|[\s;&|])(?:crontab|systemctl\s+--user\s+enable)\b/,
    new RegExp(String.raw`(?:^|[\s;&|])(?:cp|mv|ln)\b[^;&|]*\s["']?${privilegedPath}`),
    new RegExp(String.raw`(?:^|[\s;&|])sed\b[^;&|]*\s-i[^\s;&|]*[^;&|]*\s["']?${privilegedPath}`),
    new RegExp(String.raw`(?:^|[\s;&|])tee\b[^;&|]*\s["']?${privilegedPath}`),
    new RegExp(String.raw`(?:^|[\s;&|])\d*(?:>>?|>\||&>)\s*["']?${privilegedPath}`),
  ].some((pattern) => pattern.test(compact));
}

// Recursively builds the file tree for the workspace status explorer
interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

function getFileTree(dir: string, baseDir = dir): FileNode[] {
  if (!fs.existsSync(dir)) return [];
  const items = fs.readdirSync(dir);
  const nodes: FileNode[] = [];

  for (const item of items) {
    if (
      item === 'node_modules' ||
      item === '.git' ||
      item === 'temp_tell_ai' ||
      item === 'dist' ||
      item === '.env' ||
      item === 'package-lock.json' ||
      item === '.DS_Store'
    ) {
      continue;
    }

    const fullPath = path.join(dir, item);
    const relPath = path.relative(baseDir, fullPath);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      nodes.push({
        name: item,
        path: relPath,
        isDirectory: true,
        children: getFileTree(fullPath, baseDir),
      });
    } else {
      nodes.push({
        name: item,
        path: relPath,
        isDirectory: false,
      });
    }
  }

  return nodes.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
}

// API: Get workspace file tree structure
app.get('/api/status', (req, res) => {
  try {
    const tree = getFileTree(process.cwd());
    res.json({ files: tree });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// API: Read file content
app.get('/api/file', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    return res.status(400).json({ error: 'File path is required' });
  }

  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!resolvedPath.startsWith(process.cwd())) {
    return res.status(403).json({ error: 'Access denied: Directory traversal blocked' });
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    const content = fs.readFileSync(resolvedPath, 'utf8');
    res.json({ content });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// API: Save file content
app.post('/api/save-file', (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'Path and content are required' });
  }

  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!resolvedPath.startsWith(process.cwd())) {
    return res.status(403).json({ error: 'Access denied: Directory traversal blocked' });
  }

  try {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, content, 'utf8');
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// API: Execute bash command safely
app.post('/api/execute', async (req, res) => {
  const { command } = req.body;
  if (!command) {
    return res.status(400).json({ error: 'Command is required' });
  }

  if (isHighRiskScript(command)) {
    return res.status(400).json({
      output: `Blocked Command: "${command}"\n\nSecurity Guard: This command contains high-risk patterns (e.g. root deletion, modification of system directories, curl pipe execution, or sudo privileges) and has been blocked for safety.`
    });
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      maxBuffer: 32 * 1024 * 1024,
      shell: '/bin/bash',
      timeout: 120_000,
    });
    res.json({ output: stdout + stderr });
  } catch (error: any) {
    res.json({
      output: [
        error.stdout || '',
        error.stderr || '',
        error.message || ''
      ].filter(Boolean).join('\n')
    });
  }
});

// API: List of supported models and aliases
app.get('/api/models', (req, res) => {
  const formattedModels = Object.entries(MODELS).map(([alias, spec]) => {
    try {
      const resolved = resolveModelSpec(spec);
      return {
        alias,
        spec,
        vendor: resolved.vendor,
        model: resolved.model,
        thinking: resolved.thinking,
        fast: resolved.fast,
      };
    } catch {
      return { alias, spec, vendor: 'unknown', model: spec, thinking: 'none', fast: false };
    }
  });

  // Check which API keys are active in the environment
  const keysStatus = {
    google: !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY),
    openai: !!process.env.OPENAI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    xai: !!process.env.XAI_API_KEY,
    deepseek: !!process.env.DEEPSEEK_API_KEY,
    fireworks: !!process.env.FIREWORKS_API_KEY,
    openrouter: !!process.env.OPENROUTER_API_KEY,
  };

  res.json({
    models: formattedModels,
    keysStatus,
  });
});

// Helper: safely convert reasoning tokens/objects to string
function sanitizeReasoning(val: any): string | null {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    if (typeof val.text === 'string') {
      return val.text;
    }
    if (Array.isArray(val)) {
      return val
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && typeof item.text === 'string') return item.text;
          return JSON.stringify(item);
        })
        .filter(Boolean)
        .join('\n');
    }
    return JSON.stringify(val);
  }
  return String(val);
}

// API: Server configuration (default model set via TELL_MODEL, e.g. `tell g web`)
app.get('/api/config', (req, res) => {
  res.json({ defaultModel: DEFAULT_MODEL });
});

// API: Model execution route (using Vercel AI SDK)
app.post('/api/tell', async (req, res) => {
  const { messages, modelAlias, systemPrompt } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const modelSpec = modelAlias || DEFAULT_MODEL;

  try {
    // Resolve model spec and get Vercel AI SDK model instance
    const handle = await getModel(modelSpec);
    const reasoning = handle.fast ? 'none' : handle.reasoning;

    // Convert messages to Vercel AI SDK format
    const formattedMessages = messages.map((m: any) => ({
      role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    }));

    // Call generateText
    const result = await generateText({
      model: handle.model,
      system: systemPrompt,
      instructions: systemPrompt, // safety fallback for older sdks
      messages: formattedMessages,
      reasoning: reasoning as any,
    });

    res.json({
      text: result.text,
      // Pass back other useful properties if available
      reasoning: sanitizeReasoning((result as any).reasoning),
    });
  } catch (error: any) {
    console.error('Error generating AI text:', error);
    res.status(500).json({
      error: error.message || 'An error occurred during AI text generation.',
    });
  }
});

// Setup Vite dev server middleware in development, and static file serving in production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = __dirname;
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Tell AI custom backend running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
