import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get_system_prompt } from '@tell-ai/sdk';
import { resolveWithin } from './paths';

const MAX_DEPTH = 4;
const MAX_FILE_CHARS = 6 * 1024;
const MAX_DOC_BYTES = 64 * 1024;
const MAX_TREE_FILES = 2000;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.env',
  '.tell',
  '.cache',
  'coverage',
  '.next',
  '.turbo',
  '.storybook',
  'temp_tell_ai',
  '.DS_Store',
]);

const DOC_FILES = ['README.md', 'readme.md', 'README', 'AGENTS.md', 'agents.md', 'agent.md', 'CLAUDE.md'];

interface TreeNode {
  name: string;
  isDirectory: boolean;
  children?: TreeNode[];
}

interface ScanState {
  visited: Set<string>;
  fileCount: number;
}

function scanTree(dir: string, depth: number, state: ScanState): TreeNode[] {
  if (depth > MAX_DEPTH) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  let real: string | null = null;
  try {
    real = fs.realpathSync(dir);
    if (state.visited.has(real)) return []; // symlink loop guard
    state.visited.add(real);
  } catch {
    return [];
  }
  const nodes: TreeNode[] = [];
  for (const name of entries.sort()) {
    if (SKIP_DIRS.has(name)) continue;
    if (state.fileCount >= MAX_TREE_FILES) {
      nodes.push({ name: '[truncated-tree]', isDirectory: false });
      break;
    }
    const full = path.join(dir, name);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue; // skip symlinks (dirs and files)
    if (stat.isDirectory()) {
      state.fileCount += 1;
      nodes.push({ name, isDirectory: true, children: scanTree(full, depth + 1, state) });
    } else if (stat.isFile()) {
      state.fileCount += 1;
      nodes.push({ name, isDirectory: false });
    }
  }
  if (real) state.visited.delete(real);
  return nodes;
}

function renderTree(nodes: TreeNode[], prefix = ''): string {
  const out: string[] = [];
  nodes.forEach((node, i) => {
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '└─ ' : '├─ ';
    out.push(`${prefix}${connector}${node.name}${node.isDirectory ? '/' : ''}`);
    if (node.isDirectory && node.children?.length) {
      out.push(renderTree(node.children, prefix + (isLast ? '   ' : '│  ')));
    }
  });
  return out.join('\n');
}

function findDoc(cwd: string, name: string): fs.Stats | null {
  try {
    const full = resolveWithin(cwd, name);
    if (!full) return null;
    const stat = fs.lstatSync(full);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function readDoc(cwd: string, name: string): string | null {
  if (!findDoc(cwd, name)) return null;
  const full = resolveWithin(cwd, name);
  if (!full) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    let text: string;
    if (stat.size > MAX_DOC_BYTES) {
      const buf = Buffer.alloc(MAX_DOC_BYTES);
      const bytes = fs.readSync(fd, buf, 0, MAX_DOC_BYTES, 0);
      text = buf.toString('utf8', 0, bytes);
    } else {
      text = fs.readFileSync(fd, 'utf8');
    }
    if (!text.trim()) return null;
    if (stat.size > MAX_DOC_BYTES) return `${text}\n\n[truncated ${stat.size} bytes total]`;
    return text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n\n[truncated]` : text;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export interface ProjectContext {
  cwd: string;
  platform: string;
  date: string;
  tree: string;
  readme: string | null;
  agents: string | null;
}

export function buildProjectContext(cwd: string): ProjectContext {
  const tree = renderTree(scanTree(cwd, 0, { visited: new Set(), fileCount: 0 })) || '(empty project)';
  const isDoc = (f: string) => findDoc(cwd, f) !== null;
  const readme = DOC_FILES.find(isDoc);
  const agents = DOC_FILES.find((f) => /^(agent|claude)/i.test(f) && isDoc(f));
  return {
    cwd,
    platform: `${os.platform()} ${os.arch()}`,
    date: new Date().toISOString(),
    tree,
    readme: readme ? readDoc(cwd, readme) : null,
    agents: agents ? readDoc(cwd, agents) : null,
  };
}

export function buildSystemPrompt(cwd: string): string {
  const ctx = buildProjectContext(cwd);
  const sections: string[] = [];

  sections.push(`# Tell Web Sandbox — System Context

Project: ${path.basename(cwd) || cwd}
Working directory: ${ctx.cwd}
Platform: ${ctx.platform}
Generated: ${ctx.date}`);

  sections.push(`## Project structure (${MAX_DEPTH} levels)
${ctx.tree}`);

  if (ctx.readme) {
    sections.push(`## README
${ctx.readme}`);
  }

  if (ctx.agents) {
    sections.push(`## Project conventions (AGENTS)
${ctx.agents}`);
  }

  // Execution protocol is owned by @tell-ai/sdk (single source of truth,
  // shared with the CLI): chain mode, <RUN> tags, injection policy.
  sections.push(get_system_prompt({ chain: true, cwd: ctx.cwd, platform: ctx.platform }));

  return sections.join('\n\n').trim();
}
