import { AlertCircle, CheckCircle, Download, Edit3, FileWarning, Loader2, RefreshCw, Save, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api.ts';
import { useToast } from './Toast.tsx';

interface FileViewerProps {
  filePath: string | null;
  onSaveCompleted: () => void;
  onCloseFile?: () => void;
}

// Files larger than this render a "download instead" notice instead of the content
const PREVIEW_CHAR_LIMIT = 500 * 1024;

export default function FileViewer({ filePath, onSaveCompleted, onCloseFile }: FileViewerProps) {
  const { toast } = useToast();
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [mtime, setMtime] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [isBinary, setIsBinary] = useState<boolean>(false);
  const [tooLarge, setTooLarge] = useState<boolean>(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [conflict, setConflict] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);

  const isDirty = content !== originalContent;

  const fetchFile = useCallback(async (path: string) => {
    // Abort the in-flight request of a previously selected file (race guard)
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setMessage(null);
    setConflict(false);
    setIsBinary(false);
    setTooLarge(false);
    try {
      const res = await apiFetch(`/api/file?path=${encodeURIComponent(path)}`);
      if (controller.signal.aborted) return;
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.content !== undefined) {
        const text: string = data.content;
        setContent(text);
        setOriginalContent(text);
        setMtime(typeof data.mtime === 'number' ? data.mtime : null);
        // Binary heuristic: NUL byte in the first chunk of the payload
        setIsBinary(text.slice(0, 8000).includes('\0'));
        setTooLarge(text.length > PREVIEW_CHAR_LIMIT);
      } else {
        setMessage({ text: data.error || 'Failed to read file', type: 'error' });
        setContent('');
        setOriginalContent('');
        setMtime(null);
      }
    } catch (error: any) {
      if (controller.signal.aborted || error.name === 'AbortError') return;
      setMessage({ text: error.message || 'Error fetching file', type: 'error' });
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!filePath) {
      abortRef.current?.abort();
      setContent('');
      setOriginalContent('');
      setMtime(null);
      setIsEditing(false);
      setMessage(null);
      setIsBinary(false);
      setTooLarge(false);
      return;
    }

    fetchFile(filePath);
    setIsEditing(false);
    return () => {
      abortRef.current?.abort();
    };
  }, [filePath, fetchFile]);

  const handleSave = async () => {
    if (!filePath) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/save-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content, expectedMtime: mtime ?? undefined }),
      });
      const data = await res.json();
      if (data.success) {
        setOriginalContent(content);
        if (typeof data.mtime === 'number') setMtime(data.mtime);
        setIsEditing(false);
        setConflict(false);
        setMessage({ text: 'File saved successfully!', type: 'success' });
        toast('success', `File saved: ${filePath}`);
        onSaveCompleted();
        setTimeout(() => setMessage(null), 3000);
      } else if (res.status === 409) {
        if (typeof data.mtime === 'number') setMtime(data.mtime);
        setConflict(true);
        setMessage({ text: data.error || 'File changed externally. Reload before saving.', type: 'error' });
        toast('error', data.error || 'File changed externally — reload before saving.');
      } else {
        setMessage({ text: data.error || 'Failed to save file', type: 'error' });
        toast('error', data.error || 'Failed to save file');
      }
    } catch (error: any) {
      setMessage({ text: error.message || 'Error saving file', type: 'error' });
      toast('error', error.message || 'Error saving file');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setContent(originalContent);
    setIsEditing(false);
    setMessage(null);
  };

  const handleReload = () => {
    if (filePath) fetchFile(filePath);
  };

  const handleDownload = async () => {
    if (!filePath) return;
    try {
      const res = await apiFetch(`/api/file/raw?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Download failed');
      }
      const objectUrl = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filePath.split('/').pop() || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (error: any) {
      toast('error', error.message || 'Download failed');
    }
  };

  if (!filePath) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-(--color-bg-primary) text-(--color-text-muted) border-l border-(--color-border-subtle) select-none">
        <Edit3 className="w-8 h-8 opacity-20 mb-3 text-(--color-accent)" />
        <p className="text-[10px] font-display font-bold tracking-[0.2em] uppercase text-center max-w-xs">
          Select a file to edit
        </p>
      </div>
    );
  }

  const blockedView = isBinary || tooLarge;

  return (
    <div className="flex-1 flex flex-col h-full bg-(--color-bg-primary) border-l border-(--color-border-subtle) overflow-hidden">
      {/* File Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-(--color-bg-primary) border-b border-(--color-border-subtle) shrink-0 select-none">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-mono font-bold text-(--color-text-secondary) truncate max-w-xs md:max-w-md uppercase tracking-wider">
            {filePath}
          </span>
          {isEditing && (
            <span className="text-[9px] bg-(--color-accent) text-white px-2 py-0.5 font-bold uppercase tracking-widest">
              Unsaved changes
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <button
                type="button"
                onClick={handleCancel}
                disabled={saving}
                className="flex items-center gap-1 px-3 py-1 border border-(--color-border-subtle) text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-white/5 rounded-none text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer font-display"
              >
                <X className="w-3.5 h-3.5" />
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !isDirty}
                title={isDirty ? 'Save changes' : 'No changes to save'}
                className="flex items-center gap-1.5 px-4 py-1 bg-(--color-text-primary) hover:bg-(--color-accent) text-(--color-bg-primary) hover:text-white disabled:opacity-40 disabled:cursor-not-allowed rounded-none text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer font-display"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              disabled={loading || blockedView}
              className="flex items-center gap-1 px-4 py-1.5 bg-(--color-text-primary) text-(--color-bg-primary) hover:bg-(--color-accent) hover:text-white disabled:opacity-40 disabled:cursor-not-allowed rounded-none text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer font-display"
            >
              <Edit3 className="w-3.5 h-3.5" />
              Edit
            </button>
          )}

          {blockedView && (
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1 px-3 py-1.5 border border-(--color-border-medium) text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-white/5 rounded-none text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer font-display"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </button>
          )}

          {onCloseFile && (
            <button
              type="button"
              onClick={onCloseFile}
              className="flex items-center gap-1 px-3 py-1.5 border border-(--color-border-subtle) hover:border-(--color-accent)/60 hover:bg-(--color-accent-subtle) text-(--color-text-secondary) hover:text-(--color-accent-text) text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer font-display"
              title="Close File Viewer"
            >
              <X className="w-3.5 h-3.5" />
              Close
            </button>
          )}
        </div>
      </div>

      {/* Message Notifications */}
      {message && (
        <div
          className={`flex items-start gap-2.5 px-4 py-3 text-[10px] font-mono border-b uppercase tracking-wide select-none ${
            message.type === 'success'
              ? 'bg-(--color-success)/10 text-(--color-success) border-(--color-success)/20'
              : 'bg-(--color-accent-subtle) text-(--color-accent-text) border-(--color-accent)/20'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle className="w-4 h-4 shrink-0 mt-0.5 text-(--color-success)" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-(--color-accent)" />
          )}
          <span className="flex-1 font-bold">{message.text}</span>
          {conflict && (
            <button
              type="button"
              onClick={handleReload}
              className="flex items-center gap-1 px-2 py-0.5 border border-(--color-border-medium) hover:bg-white/10 text-[9px] font-bold uppercase tracking-wider cursor-pointer shrink-0"
            >
              <RefreshCw className="w-3 h-3" />
              Reload
            </button>
          )}
        </div>
      )}

      {/* Code Area */}
      <div className="flex-1 overflow-auto relative">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-(--color-bg-primary)/80 z-10">
            <Loader2 className="w-6 h-6 animate-spin text-(--color-accent)" />
          </div>
        ) : null}

        {blockedView ? (
          <div className="h-full flex flex-col items-center justify-center p-8 text-(--color-text-muted) select-none gap-3">
            <FileWarning className="w-10 h-10 opacity-40 text-(--color-accent)" />
            <p className="text-[11px] font-display font-bold uppercase tracking-[0.2em] text-center">
              {isBinary ? 'Binary file — preview unavailable' : 'Large file (>500KB) — preview unavailable'}
            </p>
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-(--color-text-primary) text-(--color-bg-primary) hover:bg-(--color-accent) hover:text-white rounded-none text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Download file
            </button>
          </div>
        ) : isEditing ? (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full h-full p-4 bg-(--color-bg-primary) text-(--color-text-primary) font-mono text-xs focus:outline-none resize-none select-text border-0 leading-relaxed overflow-y-auto custom-scrollbar"
            style={{ tabSize: 2, MozTabSize: 2 }}
          />
        ) : (
          <pre className="w-full h-full p-4 text-(--color-text-secondary) font-mono text-xs overflow-auto select-text leading-relaxed bg-(--color-bg-primary) whitespace-pre-wrap custom-scrollbar">
            {content || (
              <span className="text-(--color-text-muted) italic uppercase tracking-wider">
                [ Workspace File is Empty ]
              </span>
            )}
          </pre>
        )}
      </div>
    </div>
  );
}
