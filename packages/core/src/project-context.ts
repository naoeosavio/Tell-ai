import fs from 'fs';
import os from 'os';
import path from 'path';
import { canonical_path } from './paths';

/** Max project-tree depth (the working directory itself is depth 0). */
export const PROJECT_TREE_MAX_DEPTH = 4;
/** Max characters kept per doc before a `[truncated]` marker. */
export const PROJECT_DOC_MAX_CHARS = 6 * 1024;
/** Max bytes read per doc before a `[truncated N bytes total]` marker. */
export const PROJECT_DOC_MAX_BYTES = 64 * 1024;
/** Max tree entries before a `[truncated-tree]` marker. */
export const PROJECT_TREE_MAX_FILES = 2000;

/** Directories never descended into when scanning the project tree. */
export const PROJECT_SKIP_DIRS: ReadonlySet<string> = new Set([
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

/** Doc files searched at the project root, in priority order. */
export const PROJECT_DOC_FILES = [
  'README.md',
  'readme.md',
  'README',
  'AGENTS.md',
  'agents.md',
  'agent.md',
  'CLAUDE.md',
];

/** One project-tree node (ported from the Web context builder). */
export type ProjectTreeNode = {
  name: string;
  is_directory: boolean;
  children?: ProjectTreeNode[];
};

/** Bounded server-side project context (tree plus root docs, no system prompt). */
export type ProjectContext = {
  cwd: string;
  platform: string;
  date: string;
  tree: string;
  readme: string | null;
  agents: string | null;
};

/** Mutable scan state: visited real paths (symlink-loop guard) and entry budget. */
type ScanState = {
  visited: Set<string>;
  file_count: number;
};

/**
 * Recursively scans a directory into tree nodes, bounded by depth, skip
 * dirs, symlink guards and the file budget. Symlinks are never followed.
 *
 * @param dir - Absolute directory to scan.
 * @param depth - Current depth (the working directory is 0).
 * @param state - Shared visited-set and file budget.
 * @returns The child nodes of `dir`.
 */
function scan_tree(dir: string, depth: number, state: ScanState): ProjectTreeNode[] {
  if (depth > PROJECT_TREE_MAX_DEPTH) {
    return [];
  } else {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }
    let real: string | null = null;
    try {
      real = fs.realpathSync(dir);
      if (state.visited.has(real)) {
        return [];
      } else {
        state.visited.add(real);
      }
    } catch {
      return [];
    }
    const nodes: ProjectTreeNode[] = [];
    for (const name of entries.sort()) {
      if (PROJECT_SKIP_DIRS.has(name)) {
      } else if (state.file_count >= PROJECT_TREE_MAX_FILES) {
        nodes.push({ name: '[truncated-tree]', is_directory: false });
        break;
      } else {
        const full = path.join(dir, name);
        let stat: fs.Stats | undefined;
        try {
          stat = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) {
        } else if (stat.isDirectory()) {
          state.file_count += 1;
          nodes.push({ name, is_directory: true, children: scan_tree(full, depth + 1, state) });
        } else if (stat.isFile()) {
          state.file_count += 1;
          nodes.push({ name, is_directory: false });
        } else {
        }
      }
    }
    if (real !== null) {
      state.visited.delete(real);
    } else {
      // Unreachable: `real` is set whenever entries were listed.
    }
    return nodes;
  }
}

/**
 * Renders tree nodes as an indented ASCII tree.
 *
 * @param nodes - Nodes to render.
 * @param prefix - Line prefix for the current level.
 * @returns The rendered tree text.
 */
function render_tree(nodes: ProjectTreeNode[], prefix = ''): string {
  const out: string[] = [];
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    const connector = last ? '└─ ' : '├─ ';
    out.push(`${prefix}${connector}${node.name}${node.is_directory ? '/' : ''}`);
    if (node.is_directory && node.children !== undefined && node.children.length > 0) {
      out.push(render_tree(node.children, prefix + (last ? '   ' : '│  ')));
    } else {
      // Leaf node — nothing to recurse into.
    }
  });
  return out.join('\n');
}

/**
 * Stats a root doc through the fail-closed canonical path, or null.
 *
 * @param cwd - Project root the doc must stay inside.
 * @param name - Doc file name.
 * @returns The file stats, or null when missing, outside, or not a file.
 */
function find_doc(cwd: string, name: string): fs.Stats | null {
  try {
    const full = canonical_path(cwd, name);
    if (full === null) {
      return null;
    } else {
      const stat = fs.lstatSync(full);
      if (stat.isFile()) {
        return stat;
      } else {
        return null;
      }
    }
  } catch {
    return null;
  }
}

/**
 * Reads a bounded root doc (`O_NOFOLLOW`, byte cap, char cap).
 *
 * @param cwd - Project root the doc must stay inside.
 * @param name - Doc file name.
 * @returns The doc text with truncation markers, or null when unreadable/empty.
 */
function read_doc(cwd: string, name: string): string | null {
  if (find_doc(cwd, name) === null) {
    return null;
  } else {
    const full = canonical_path(cwd, name);
    if (full === null) {
      return null;
    } else {
      let fd: number | null = null;
      try {
        fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        let text: string;
        if (stat.size > PROJECT_DOC_MAX_BYTES) {
          const buffer = Buffer.alloc(PROJECT_DOC_MAX_BYTES);
          const bytes = fs.readSync(fd, buffer, 0, PROJECT_DOC_MAX_BYTES, 0);
          text = buffer.toString('utf8', 0, bytes);
        } else {
          text = fs.readFileSync(fd, 'utf8');
        }
        if (text.trim() === '') {
          return null;
        } else if (stat.size > PROJECT_DOC_MAX_BYTES) {
          return `${text}\n\n[truncated ${stat.size} bytes total]`;
        } else if (text.length > PROJECT_DOC_MAX_CHARS) {
          return `${text.slice(0, PROJECT_DOC_MAX_CHARS)}\n\n[truncated]`;
        } else {
          return text;
        }
      } catch {
        return null;
      } finally {
        if (fd !== null) {
          fs.closeSync(fd);
        } else {
          // Open failed — nothing to close.
        }
      }
    }
  }
}

/**
 * Builds the bounded server-side project context for a working directory.
 *
 * Depth, caps, skip dirs and README/AGENTS lookup match the Web builder;
 * the system prompt is not included (the core never persists it).
 *
 * @param cwd - Project root to describe.
 * @returns The tree plus the selected root docs.
 */
export function build_project_context(cwd: string): ProjectContext {
  const tree = render_tree(scan_tree(cwd, 0, { visited: new Set(), file_count: 0 })) || '(empty project)';
  const is_doc = (name: string): boolean => find_doc(cwd, name) !== null;
  const readme = PROJECT_DOC_FILES.find(is_doc);
  const agents = PROJECT_DOC_FILES.find((name) => /^(agent|claude)/i.test(name) && is_doc(name));
  return {
    cwd,
    platform: `${os.platform()} ${os.arch()}`,
    date: new Date().toISOString(),
    tree,
    readme: readme === undefined ? null : read_doc(cwd, readme),
    agents: agents === undefined ? null : read_doc(cwd, agents),
  };
}
