import React, { useState, useEffect, useRef } from 'react';
import { Terminal as TerminalIcon, Play, AlertCircle, Trash2, ShieldCheck } from 'lucide-react';

export interface TerminalLine {
  type: 'input' | 'output' | 'error' | 'system' | 'request';
  text: string;
  commandId?: string; // identifier if it's an action prompt
}

interface TerminalProps {
  lines: TerminalLine[];
  onExecuteCommand: (command: string) => Promise<string>;
  onClear: () => void;
  pendingCommand: string | null;
  onConfirmPending: (editedCommand: string) => void;
  onSkipPending: () => void;
}

export default function Terminal({
  lines,
  onExecuteCommand,
  onClear,
  pendingCommand,
  onConfirmPending,
  onSkipPending,
}: TerminalProps) {
  const [customCommand, setCustomCommand] = useState<string>('');
  const [executing, setExecuting] = useState<boolean>(false);
  const [editedPending, setEditedPending] = useState<string>('');
  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pendingCommand) {
      setEditedPending(pendingCommand);
    } else {
      setEditedPending('');
    }
  }, [pendingCommand]);

  useEffect(() => {
    // Scroll terminal to bottom on new lines or pending command
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, pendingCommand, executing]);

  const handleRunCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customCommand.trim() || executing) return;

    const cmd = customCommand.trim();
    setCustomCommand('');
    setExecuting(true);

    try {
      await onExecuteCommand(cmd);
    } catch (err) {
      console.error(err);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-black border-t border-slate-800 text-emerald-400 font-mono text-[11px] leading-relaxed select-text">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-950 border-b border-slate-900 text-slate-400 shrink-0 select-none">
        <div className="flex items-center gap-1.5 font-sans font-semibold text-[10px] tracking-wider uppercase text-slate-500">
          <TerminalIcon className="w-3.5 h-3.5 text-emerald-500" />
          <span>Interactive Shell Console</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-[9px] bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 px-1.5 py-0.5 rounded">
            <ShieldCheck className="w-3 h-3" /> Secure Sandbox (Linux)
          </span>
          <button
            onClick={onClear}
            className="p-1 rounded hover:bg-slate-900 hover:text-white transition-colors cursor-pointer"
            title="Clear Terminal logs"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Terminal Content Area */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar select-text bg-[#030712]">
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all selection:bg-emerald-950">
            {line.type === 'input' && (
              <div className="text-slate-300">
                <span className="text-emerald-500 font-bold">$ </span>
                {line.text}
              </div>
            )}
            {line.type === 'output' && <div className="text-slate-300">{line.text}</div>}
            {line.type === 'error' && <div className="text-rose-400 font-medium">{line.text}</div>}
            {line.type === 'system' && <div className="text-sky-400 italic text-[10px]">{line.text}</div>}
            {line.type === 'request' && (
              <div className="text-amber-400 border border-amber-500/20 bg-amber-500/5 p-2 rounded my-1.5">
                {line.text}
              </div>
            )}
          </div>
        ))}

        {/* Pending Command Authorization Prompt */}
        {pendingCommand && (
          <div className="border-2 border-amber-500/30 bg-amber-950/20 p-3 rounded-md my-2 space-y-2 text-slate-200">
            <div className="flex items-center gap-2 text-amber-400 font-bold text-[12px] select-none">
              <AlertCircle className="w-4 h-4 animate-bounce text-amber-500 shrink-0" />
              <span>Permission Requested: Shell Command Execution</span>
            </div>
            
            <p className="text-[10px] text-slate-400 font-sans select-none">
              The agent wants to execute this script in the workspace. You can edit the command below before authorizing:
            </p>

            <textarea
              value={editedPending}
              onChange={(e) => setEditedPending(e.target.value)}
              className="w-full p-2.5 bg-black border border-amber-500/30 text-amber-300 font-mono text-[11px] rounded focus:outline-none focus:border-amber-500/60 leading-relaxed resize-y h-24 select-text"
            />

            <div className="flex items-center justify-end gap-2 pt-1 select-none">
              <button
                onClick={onSkipPending}
                className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded font-sans text-xs font-semibold cursor-pointer transition-colors"
              >
                Skip Command
              </button>
              <button
                onClick={() => onConfirmPending(editedPending)}
                className="flex items-center gap-1 px-4 py-1.5 bg-amber-500 hover:bg-amber-600 text-black rounded font-sans text-xs font-bold cursor-pointer transition-colors shadow-md shadow-amber-500/10"
              >
                <Play className="w-3 h-3 fill-black" />
                Authorize & Execute
              </button>
            </div>
          </div>
        )}

        {executing && (
          <div className="flex items-center gap-1.5 text-slate-400 select-none">
            <span className="w-1.5 h-3 bg-emerald-500 animate-pulse inline-block" />
            <span>Executing command...</span>
          </div>
        )}

        <div ref={terminalEndRef} />
      </div>

      {/* Manual Input Line */}
      {!pendingCommand && (
        <form
          onSubmit={handleRunCustom}
          className="flex items-center gap-2 border-t border-slate-900 bg-slate-950 p-2 shrink-0 select-none"
        >
          <span className="text-emerald-500 font-bold pl-1 select-none">$</span>
          <input
            type="text"
            value={customCommand}
            onChange={(e) => setCustomCommand(e.target.value)}
            disabled={executing}
            placeholder={executing ? "Please wait..." : "Type custom shell command and press Enter (e.g. ls -la)..."}
            className="flex-1 bg-transparent text-slate-300 placeholder-slate-600 focus:outline-none text-[11px] font-mono select-text"
          />
        </form>
      )}
    </div>
  );
}
