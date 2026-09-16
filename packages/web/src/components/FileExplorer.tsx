import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../api.ts';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[] | undefined;
}

interface FileExplorerProps {
  onFileSelect: (path: string) => void;
  selectedFilePath: string | null;
  refreshTrigger: number;
  /** Pane folded to its title bar (persisted in theme-config-v3). */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

// Extension → icon mapping (fallback: File)
function iconForFile(name: string) {
  const ext = name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'sh', 'bash', 'rs', 'go', 'c', 'cpp', 'h'].includes(ext))
    return FileCode;
  if (['json', 'jsonc', 'yaml', 'yml', 'toml'].includes(ext)) return FileJson;
  if (['md', 'txt', 'log'].includes(ext)) return FileText;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) return FileImage;
  if (['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z'].includes(ext)) return FileArchive;
  return File;
}

/** Keep nodes whose own name or any descendant matches the query (case-insensitive). */
function filterTree(nodes: FileNode[], query: string): FileNode[] {
  if (!query) return nodes;
  const q = query.toLowerCase();
  const walk = (list: FileNode[]): FileNode[] =>
    list.reduce<FileNode[]>((acc, node) => {
      if (node.isDirectory) {
        const children = node.children ? walk(node.children) : [];
        if (children.length > 0 || node.name.toLowerCase().includes(q)) {
          acc.push({ ...node, children: children.length > 0 ? children : node.children });
        }
      } else if (node.name.toLowerCase().includes(q)) {
        acc.push(node);
      }
      return acc;
    }, []);
  return walk(nodes);
}

export default function FileExplorer({
  onFileSelect,
  selectedFilePath,
  refreshTrigger,
  collapsed,
  onToggleCollapsed,
}: FileExplorerProps) {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const firstLoadRef = useRef(true);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/status');
      const data = await res.json();
      if (data.files) {
        setFiles(data.files);
        setLoaded(true);
      } else {
        setError(data.error || 'Failed to load directory');
      }
    } catch (error: any) {
      setError(error.message || 'Error fetching file structure');
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-fetch when the parent bumps refreshTrigger (e.g. after a file save).
  useEffect(() => {
    void refreshTrigger;
    fetchFiles();
  }, [fetchFiles, refreshTrigger]);

  const toggleExpand = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => ({
      ...prev,
      [dirPath]: !prev[dirPath],
    }));
  }, []);

  // Pre-expand top-level `src` folders — only on the first successful load
  useEffect(() => {
    if (!firstLoadRef.current || files.length === 0) return;
    firstLoadRef.current = false;
    const initialExpand: Record<string, boolean> = {};
    files.forEach((file) => {
      if (file.isDirectory && file.name === 'src') {
        initialExpand[file.path] = true;
      }
    });
    setExpandedDirs((prev) => ({ ...prev, ...initialExpand }));
  }, [files]);

  const filteredTree = useMemo(() => filterTree(files, query.trim()), [files, query]);

  const renderNode = useCallback(
    (node: FileNode, depth = 0): React.ReactNode => {
      const isExpanded = query.trim() ? true : expandedDirs[node.path];
      const isSelected = selectedFilePath === node.path;

      if (node.isDirectory) {
        return (
          <div key={node.path} className="flex flex-col">
            <button
              type="button"
              onClick={() => toggleExpand(node.path)}
              className="flex items-center gap-2 py-1.5 px-2.5 hover:bg-white/5 text-left text-xs font-bold text-(--color-text-secondary) transition-colors w-full cursor-pointer rounded-none uppercase tracking-wide font-display"
              style={{ paddingLeft: `${depth * 12 + 10}px` }}
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-(--color-text-muted) shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-(--color-text-muted) shrink-0" />
              )}
              {isExpanded ? (
                <FolderOpen className="w-3.5 h-3.5 text-(--color-accent) shrink-0 fill-(--color-accent)/10" />
              ) : (
                <Folder className="w-3.5 h-3.5 text-(--color-accent) shrink-0 fill-(--color-accent)/10" />
              )}
              <span className="truncate">{node.name}</span>
            </button>
            {isExpanded && node.children && (
              <div className="flex flex-col border-l border-(--color-border-subtle) ml-3.5">
                {node.children.map((child) => renderNode(child, depth + 1))}
              </div>
            )}
          </div>
        );
      } else {
        const Icon = iconForFile(node.name);
        return (
          <button
            type="button"
            key={node.path}
            onClick={() => onFileSelect(node.path)}
            className={`flex items-center gap-2 py-1.5 px-2.5 text-left text-xs transition-all duration-150 w-full cursor-pointer rounded-none font-mono ${
              isSelected
                ? 'bg-white/5 text-(--color-text-primary) font-bold border-l-2 border-(--color-accent)'
                : 'hover:bg-white/5 text-(--color-text-secondary)'
            }`}
            style={{ paddingLeft: `${depth * 12 + 15}px` }}
          >
            <Icon
              className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-(--color-accent)' : 'text-(--color-text-muted)'}`}
            />
            <span className="truncate">{node.name}</span>
          </button>
        );
      }
    },
    [expandedDirs, onFileSelect, query, selectedFilePath, toggleExpand],
  );

  const rows = useMemo(() => filteredTree.map((node) => renderNode(node)), [filteredTree, renderNode]);

  // Collapsed: keep only the title bar so the settings pane below can take the
  // freed height (reopen by clicking the chevron).
  if (collapsed) {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-(--color-border-subtle) bg-(--color-bg-primary)">
        <div className="flex items-center gap-2">
          <Folder className="w-4 h-4 text-(--color-accent)" />
          <span className="text-[10px] font-display font-black tracking-[0.25em] uppercase text-(--color-text-secondary)">
            Files
          </span>
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="p-1 rounded-none text-(--color-text-muted) hover:text-(--color-text-primary) hover:bg-white/5 transition-colors cursor-pointer"
          title="Expand files"
          aria-label="Expand files"
          aria-expanded={false}
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-(--color-bg-primary) border-r border-(--color-border-subtle)">
      <div className="flex items-center justify-between p-4 pb-2 border-b border-(--color-border-subtle) bg-(--color-bg-primary)">
        <div className="flex items-center gap-2">
          <Folder className="w-4 h-4 text-(--color-accent)" />
          <span className="text-[10px] font-display font-black tracking-[0.25em] uppercase text-(--color-text-secondary)">
            Files
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={fetchFiles}
            disabled={loading}
            className="p-1 rounded-none text-(--color-text-muted) hover:text-(--color-text-primary) hover:bg-white/5 disabled:opacity-50 transition-colors cursor-pointer"
            title="Sync files"
          >
            {loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-(--color-accent)" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="p-1 rounded-none text-(--color-text-muted) hover:text-(--color-text-primary) hover:bg-white/5 transition-colors cursor-pointer"
            title="Collapse files"
            aria-label="Collapse files"
            aria-expanded={true}
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Search filter */}
      <div className="px-2.5 py-2 border-b border-(--color-border-subtle)">
        <div className="flex items-center gap-1.5 bg-(--color-bg-secondary) border border-(--color-border-subtle) px-2 py-1">
          <Search className="w-3 h-3 text-(--color-text-muted) shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter files..."
            className="w-full bg-transparent border-none py-0.5 text-[10px] text-(--color-text-primary) placeholder-white/30 focus:outline-none font-mono"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="text-(--color-text-muted) hover:text-(--color-text-primary) text-[10px] cursor-pointer shrink-0"
              title="Clear filter"
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 space-y-0.5 custom-scrollbar bg-(--color-bg-primary)">
        {error ? (
          <div className="p-4 flex flex-col items-center gap-2 text-center">
            <AlertTriangle className="w-5 h-5 text-(--color-error)" />
            <p className="text-[10px] font-mono uppercase tracking-wider text-(--color-error)">{error}</p>
            <button
              type="button"
              onClick={fetchFiles}
              className="px-3 py-1 border border-(--color-border-medium) text-[9px] font-bold uppercase tracking-wider text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-white/5 cursor-pointer"
            >
              Retry
            </button>
          </div>
        ) : loading && !loaded ? (
          <div className="p-4 flex flex-col items-center gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-(--color-accent)" />
            <p className="text-[10px] font-mono uppercase tracking-wider text-(--color-text-muted)">Loading tree...</p>
          </div>
        ) : files.length === 0 ? (
          <div className="p-4 text-center text-(--color-text-muted) text-xs font-mono uppercase tracking-wider">
            Empty Directory
          </div>
        ) : filteredTree.length === 0 ? (
          <div className="p-4 text-center text-(--color-text-muted) text-xs font-mono uppercase tracking-wider">
            No matches
          </div>
        ) : (
          rows
        )}
      </div>
    </div>
  );
}
