import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_CHARS = 6000;

const ALWAYS_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.cache',
  'coverage',
  '.nyc_output',
  '.turbo',
  '.vercel',
  '.vscode',
  '.idea',
  'target',
]);

interface TreeEntry {
  name: string;
  isDir: boolean;
  children?: TreeEntry[];
}

function readGitignore(root: string): string[] {
  try {
    const content = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

function matchGitignore(entryName: string, pattern: string, isDir: boolean): boolean {
  let p = pattern;
  let anchored = false;
  if (p.startsWith('/')) {
    anchored = true;
    p = p.slice(1);
  }
  if (p.endsWith('/')) {
    if (!isDir) return false;
    p = p.slice(0, -1);
  }

  if (!(p.includes('*') || p.includes('?') || p.includes('['))) {
    if (anchored) return entryName === p;
    return entryName === p || entryName.startsWith(`${p}/`);
  }

  const regexStr = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*')
    .replace(/\?/g, '[^/]');

  try {
    return new RegExp(`^${regexStr}${anchored ? '$' : '(?:/.*)?$'}`).test(entryName);
  } catch {
    return false;
  }
}

function isIgnored(entryName: string, isDir: boolean, ignorePatterns: string[]): boolean {
  if (ALWAYS_IGNORE.has(entryName)) return true;

  let ignored = false;
  for (const raw of ignorePatterns) {
    if (raw.startsWith('!')) {
      if (matchGitignore(entryName, raw.slice(1), isDir)) ignored = false;
    } else {
      if (matchGitignore(entryName, raw, isDir)) ignored = true;
    }
  }

  return ignored;
}

function walkDir(
  dir: string,
  depth: number,
  maxDepth: number,
  ignorePatterns: string[],
  counter: { value: number },
  maxEntries: number,
  isRoot: boolean,
): TreeEntry[] {
  if (depth > maxDepth || counter.value >= maxEntries) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const result: TreeEntry[] = [];
  for (const entry of entries) {
    if (counter.value >= maxEntries) break;
    if (ALWAYS_IGNORE.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    if (isRoot && isIgnored(entry.name, entry.isDirectory(), ignorePatterns)) continue;

    counter.value++;

    if (entry.isDirectory()) {
      const children = walkDir(
        path.join(dir, entry.name),
        depth + 1,
        maxDepth,
        ignorePatterns,
        counter,
        maxEntries,
        false,
      );
      result.push({ name: entry.name, isDir: true, children });
    } else {
      result.push({ name: entry.name, isDir: false });
    }
  }

  return result;
}

function formatTree(entries: TreeEntry[], prefix = ''): string[] {
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const nextPrefix = isLast ? '    ' : '│   ';

    if (entry.isDir) {
      lines.push(`${prefix}${connector}${entry.name}/`);
      if (entry.children && entry.children.length > 0) {
        lines.push(...formatTree(entry.children, prefix + nextPrefix));
      }
    } else {
      lines.push(`${prefix}${connector}${entry.name}`);
    }
  }
  return lines;
}

async function getGitContext(cwd: string): Promise<string | null> {
  try {
    const [branchResult, statusResult] = await Promise.all([
      execAsync('git branch --show-current', { cwd, timeout: 5000 }).catch(() => ({ stdout: '' })),
      execAsync('git status --short -- .', { cwd, timeout: 5000 }).catch(() => ({ stdout: '' })),
    ]);

    const branch = branchResult.stdout.trim();
    if (!branch) return null;

    const statusLines = statusResult.stdout.trim().split('\n').filter(Boolean);
    const parts: string[] = [`branch ${branch}`];

    if (statusLines.length > 0 && statusLines.length <= 8) {
      parts.push(statusLines.map((s) => s.trim()).join(', '));
    } else if (statusLines.length > 8) {
      parts.push(`${statusLines.length} changed files`);
    }

    return parts.join(' | ');
  } catch {
    return null;
  }
}

function getProjectMeta(cwd: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const name = pkg.name || path.basename(cwd);
    const depCount = Object.keys(pkg.dependencies || {}).length;
    const devCount = Object.keys(pkg.devDependencies || {}).length;
    const scripts = Object.keys(pkg.scripts || {})
      .slice(0, 5)
      .join(', ');
    const parts = [`${name} (Node.js)`];
    if (depCount + devCount > 0) parts.push(`${depCount + devCount} deps`);
    if (scripts) parts.push(`scripts: ${scripts}`);
    return parts.join(' — ');
  } catch {}

  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return 'Rust project';
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'Go project';
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'setup.py')))
    return 'Python project';

  return null;
}

export async function gatherProjectContext(rootDir: string): Promise<string | null> {
  const parts: string[] = [];

  const meta = getProjectMeta(rootDir);
  if (meta) parts.push(`Project: ${meta}`);

  const ignorePatterns = readGitignore(rootDir);
  const counter = { value: 0 };
  const tree = walkDir(rootDir, 0, DEFAULT_MAX_DEPTH, ignorePatterns, counter, DEFAULT_MAX_ENTRIES, true);

  if (tree.length > 0) {
    const treeLines = formatTree(tree);
    const isTruncated = counter.value >= DEFAULT_MAX_ENTRIES;
    const header = 'Project structure:';
    const suffix = isTruncated ? `\n  ... (${counter.value} entries, truncated at ${DEFAULT_MAX_ENTRIES})` : '';
    parts.push([header, ...treeLines.map((l) => `  ${l}`)].join('\n') + suffix);
  }

  const git = await getGitContext(rootDir);
  if (git) parts.push(`Git: ${git}`);

  const full = parts.join('\n\n');
  if (full.length > DEFAULT_MAX_CHARS) {
    return `${full.slice(0, DEFAULT_MAX_CHARS - 20)}\n... (truncated)`;
  }

  return full || null;
}
