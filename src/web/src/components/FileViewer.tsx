import React, { useState, useEffect } from 'react';
import { Save, AlertCircle, CheckCircle, Edit3, X, Loader2 } from 'lucide-react';

interface FileViewerProps {
  filePath: string | null;
  onSaveCompleted: () => void;
}

export default function FileViewer({ filePath, onSaveCompleted }: FileViewerProps) {
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
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-950 text-slate-500 border-l border-slate-900">
        <Edit3 className="w-8 h-8 opacity-30 mb-2" />
        <p className="text-xs">Select a file from the workspace explorer to view or edit</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 border-l border-slate-900 overflow-hidden">
      {/* File Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono font-semibold text-slate-300 truncate max-w-xs md:max-w-md">
            {filePath}
          </span>
          {isEditing && (
            <span className="text-[10px] bg-amber-500/10 text-amber-500 border border-amber-500/20 px-1.5 py-0.5 rounded">
              Editing
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {isEditing ? (
            <>
              <button
                onClick={handleCancel}
                disabled={saving}
                className="flex items-center gap-1 px-2.5 py-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded text-xs transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-sky-500 hover:bg-sky-600 disabled:bg-sky-500/50 text-white rounded text-xs font-medium transition-colors cursor-pointer"
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                Save
              </button>
            </>
          ) : (
            <button
              onClick={() => setIsEditing(true)}
              disabled={loading}
              className="flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded text-xs transition-colors cursor-pointer"
            >
              <Edit3 className="w-3.5 h-3.5" />
              Edit File
            </button>
          )}
        </div>
      </div>

      {/* Message Notifications */}
      {message && (
        <div
          className={`flex items-start gap-2 px-4 py-2.5 text-xs border-b ${
            message.type === 'success'
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          )}
          <span className="flex-1 font-sans">{message.text}</span>
        </div>
      )}

      {/* Code Area */}
      <div className="flex-1 overflow-auto relative">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/75 z-10">
            <Loader2 className="w-6 h-6 animate-spin text-sky-500" />
          </div>
        ) : null}

        {isEditing ? (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full h-full p-4 bg-slate-950 text-slate-300 font-mono text-xs focus:outline-none resize-none select-text border-0 leading-relaxed overflow-y-auto"
            style={{ tabSize: 2, MozTabSize: 2 }}
          />
        ) : (
          <pre className="w-full h-full p-4 text-slate-300 font-mono text-xs overflow-auto select-text leading-relaxed bg-slate-950 whitespace-pre-wrap">
            {content || <span className="text-slate-600 italic">This file is empty</span>}
          </pre>
        )}
      </div>
    </div>
  );
}
