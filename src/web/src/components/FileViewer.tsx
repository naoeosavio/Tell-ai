import React, { useState, useEffect } from 'react';
import { Save, AlertCircle, CheckCircle, Edit3, X, Loader2 } from 'lucide-react';

interface FileViewerProps {
  filePath: string | null;
  onSaveCompleted: () => void;
  onCloseFile?: () => void;
}

export default function FileViewer({ filePath, onSaveCompleted, onCloseFile }: FileViewerProps) {
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    if (!filePath) {
      setContent('');
      setIsEditing(false);
      setMessage(null);
      return;
    }

    const fetchFile = async () => {
      setLoading(true);
      setMessage(null);
      try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        if (data.content !== undefined) {
          setContent(data.content);
          setOriginalContent(data.content);
        } else {
          setMessage({ text: data.error || 'Failed to read file', type: 'error' });
        }
      } catch (error: any) {
        setMessage({ text: error.message || 'Error fetching file', type: 'error' });
      } finally {
        setLoading(false);
      }
    };

    fetchFile();
    setIsEditing(false);
  }, [filePath]);

  const handleSave = async () => {
    if (!filePath) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/save-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content }),
      });
      const data = await res.json();
      if (data.success) {
        setOriginalContent(content);
        setIsEditing(false);
        setMessage({ text: 'File saved successfully!', type: 'success' });
        onSaveCompleted();
        setTimeout(() => setMessage(null), 3000);
      } else {
        setMessage({ text: data.error || 'Failed to save file', type: 'error' });
      }
    } catch (error: any) {
      setMessage({ text: error.message || 'Error saving file', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setContent(originalContent);
    setIsEditing(false);
    setMessage(null);
  };

  if (!filePath) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-[#0A0A0A] text-white/30 border-l border-white/10 select-none">
        <Edit3 className="w-8 h-8 opacity-20 mb-3 text-rose-600" />
        <p className="text-[10px] font-display font-bold tracking-[0.2em] uppercase text-center max-w-xs">
          Select a node from explorer to modify workspace stream
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0A0A0A] border-l border-white/10 overflow-hidden">
      {/* File Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-[#0A0A0A] border-b border-white/10 shrink-0 select-none">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono font-bold text-white/80 truncate max-w-xs md:max-w-md uppercase tracking-wider">
            {filePath}
          </span>
          {isEditing && (
            <span className="text-[9px] bg-rose-600 text-white px-2 py-0.5 font-bold uppercase tracking-widest">
              Live Write
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <button
                onClick={handleCancel}
                disabled={saving}
                className="flex items-center gap-1 px-3 py-1 border border-white/10 text-white/60 hover:text-white hover:bg-white/5 rounded-none text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer font-display"
              >
                <X className="w-3.5 h-3.5" />
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-1 bg-white hover:bg-rose-600 text-black hover:text-white rounded-none text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer font-display"
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                Commit
              </button>
            </>
          ) : (
            <button
              onClick={() => setIsEditing(true)}
              disabled={loading}
              className="flex items-center gap-1 px-4 py-1.5 bg-white text-black hover:bg-rose-600 hover:text-white rounded-none text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer font-display"
            >
              <Edit3 className="w-3.5 h-3.5" />
              Edit Stream
            </button>
          )}

          {onCloseFile && (
            <button
              onClick={onCloseFile}
              className="flex items-center gap-1 px-3 py-1.5 border border-white/10 hover:border-rose-600/60 hover:bg-rose-950/20 text-white/50 hover:text-rose-400 text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer font-display"
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
              ? 'bg-emerald-600/10 text-emerald-400 border-emerald-600/20'
              : 'bg-rose-600/10 text-rose-400 border-rose-600/20'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle className="w-4 h-4 shrink-0 mt-0.5 text-emerald-500" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-500" />
          )}
          <span className="flex-1 font-bold">{message.text}</span>
        </div>
      )}

      {/* Code Area */}
      <div className="flex-1 overflow-auto relative">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0A0A0A]/80 z-10">
            <Loader2 className="w-6 h-6 animate-spin text-rose-600" />
          </div>
        ) : null}

        {isEditing ? (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full h-full p-4 bg-[#0A0A0A] text-[#F5F5F5] font-mono text-xs focus:outline-none resize-none select-text border-0 leading-relaxed overflow-y-auto custom-scrollbar"
            style={{ tabSize: 2, MozTabSize: 2 }}
          />
        ) : (
          <pre className="w-full h-full p-4 text-white/80 font-mono text-xs overflow-auto select-text leading-relaxed bg-[#0A0A0A] whitespace-pre-wrap custom-scrollbar">
            {content || <span className="text-white/35 italic uppercase tracking-wider">[ Workspace File is Empty ]</span>}
          </pre>
        )}
      </div>
    </div>
  );
}
