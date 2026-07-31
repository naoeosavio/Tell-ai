import React, { useState, useEffect } from 'react';
import { Folder, File, ChevronRight, ChevronDown, RefreshCw, Eye, Save } from 'lucide-react';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

interface FileExplorerProps {
  onFileSelect: (path: string) => void;
  selectedFilePath: string | null;
  refreshTrigger: number;
}

export default function FileExplorer({ onFileSelect, selectedFilePath, refreshTrigger }: FileExplorerProps) {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);

  const fetchFiles = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (data.files) {
        setFiles(data.files);
      }
    } catch (error) {
      console.error('Error fetching file structure:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles();
  }, [refreshTrigger]);

  const toggleExpand = (dirPath: string) => {
    setExpandedDirs((prev) => ({
      ...prev,
      [dirPath]: !prev[dirPath],
    }));
  };

  // Pre-expand top-level folders by default if they are empty
  useEffect(() => {
    if (files.length > 0) {
      const initialExpand: Record<string, boolean> = {};
      files.forEach((file) => {
        if (file.isDirectory && file.name === 'src') {
          initialExpand[file.path] = true;
        }
      });
      setExpandedDirs((prev) => ({ ...initialExpand, ...prev }));
    }
  }, [files]);

  const renderNode = (node: FileNode, depth = 0) => {
    const isExpanded = expandedDirs[node.path];
    const isSelected = selectedFilePath === node.path;

    if (node.isDirectory) {
      return (
        <div key={node.path} className="flex flex-col">
          <button
            onClick={() => toggleExpand(node.path)}
            className="flex items-center gap-1.5 py-1 px-2 rounded-sm hover:bg-slate-800 text-left text-xs font-medium text-slate-300 transition-colors w-full cursor-pointer"
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            )}
            <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0 fill-amber-400/20" />
            <span className="truncate">{node.name}</span>
          </button>
          {isExpanded && node.children && (
            <div className="flex flex-col">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    } else {
      return (
        <button
          key={node.path}
          onClick={() => onFileSelect(node.path)}
          className={`flex items-center gap-1.5 py-1 px-2 rounded-sm text-left text-xs transition-colors w-full cursor-pointer ${
            isSelected
              ? 'bg-sky-500/20 text-sky-400 font-medium border-l-2 border-sky-400'
              : 'hover:bg-slate-800 text-slate-400'
          }`}
          style={{ paddingLeft: `${depth * 12 + 18}px` }}
        >
          <File className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-sky-400' : 'text-slate-500'}`} />
          <span className="truncate">{node.name}</span>
        </button>
      );
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-900 border-r border-slate-800">
      <div className="flex items-center justify-between p-3 border-b border-slate-800 bg-slate-950">
        <div className="flex items-center gap-2">
          <Folder className="w-4 h-4 text-sky-400" />
          <span className="text-xs font-semibold tracking-wider uppercase text-slate-400">Workspace Files</span>
        </div>
        <button
          onClick={fetchFiles}
          disabled={loading}
          className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer"
          title="Refresh workspace files"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-0.5 custom-scrollbar">
        {files.length === 0 ? (
          <div className="p-4 text-center text-slate-500 text-xs">No files found</div>
        ) : (
          files.map((file) => renderNode(file))
        )}
      </div>
    </div>
  );
}
