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
    <div className="flex flex-col h-full bg-[#0A0A0A] border-t border-white/10 text-white/90 font-mono text-[11px] leading-relaxed select-text">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#0A0A0A] border-b border-white/10 text-white/50 shrink-0 select-none">
        <div className="flex items-center gap-2 font-display font-black text-[10px] tracking-widest uppercase text-white/40">
          <TerminalIcon className="w-3.5 h-3.5 text-rose-600 animate-pulse" />
          <span>Interactive Core Shell</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-[9px] bg-white/5 text-white/80 border border-white/15 px-2 py-0.5 rounded-none uppercase font-bold tracking-wider">
            <ShieldCheck className="w-3 h-3 text-rose-600" /> Secure Sandbox (Linux)
          </span>
          <button
            onClick={onClear}
            className="p-1 rounded-none hover:bg-white/5 text-white/40 hover:text-white transition-colors cursor-pointer"
            title="Wipe output pipeline"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Content Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar select-text bg-[#0A0A0A]">
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all selection:bg-rose-950">
            {line.type === 'input' && (
              <div className="text-white font-semibold">
                <span className="text-rose-600 font-black">$ </span>
                {line.text}
              </div>
            )}
            {line.type === 'output' && <div className="text-white/70">{line.text}</div>}
            {line.type === 'error' && <div className="text-rose-500 font-bold uppercase tracking-wide">{line.text}</div>}
            {line.type === 'system' && <div className="text-white/40 italic text-[10px] font-sans">[ {line.text} ]</div>}
            {line.type === 'request' && (
              <div className="text-rose-400 border border-rose-600/20 bg-rose-600/5 p-3 rounded-none my-2 font-sans text-xs">
                {line.text}
              </div>
            )}
          </div>
        ))}

        {/* Pending Command Authorization Prompt */}
        {pendingCommand && (
          <div className="border border-rose-600/30 bg-rose-950/10 p-4 rounded-none my-3 space-y-3 text-white">
            <div className="flex items-center gap-2 text-rose-500 font-black text-xs uppercase tracking-wider select-none font-display">
              <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
              <span>Permission Requested: Shell Command Execution</span>
            </div>
            
            <p className="text-[10px] text-white/55 font-sans select-none">
              The agent wants to execute this script in the workspace. You can edit the command below before authorizing:
            </p>

            <textarea
              value={editedPending}
              onChange={(e) => setEditedPending(e.target.value)}
              className="w-full p-3 bg-[#121212] border border-white/10 text-white font-mono text-[11px] rounded-none focus:outline-none focus:border-white leading-relaxed resize-y h-24 select-text"
            />

            <div className="flex items-center justify-end gap-3 pt-1 select-none">
              <button
                onClick={onSkipPending}
                className="px-4 py-1.5 border border-white/15 hover:bg-white/5 text-white/75 rounded-none font-sans text-xs font-bold uppercase tracking-widest cursor-pointer transition-colors"
              >
                Skip Command
              </button>
              <button
                onClick={() => onConfirmPending(editedPending)}
                className="flex items-center gap-1.5 px-5 py-2 bg-white hover:bg-rose-600 text-black hover:text-white rounded-none font-sans text-xs font-black uppercase tracking-widest cursor-pointer transition-colors"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                Authorize & Execute
              </button>
            </div>
          </div>
        )}

        {executing && (
          <div className="flex items-center gap-2 text-white/40 select-none">
            <span className="w-2 h-2 bg-rose-600 animate-ping inline-block rounded-full" />
            <span className="font-mono text-[10px] uppercase tracking-widest">Executing instructions...</span>
          </div>
        )}

        <div ref={terminalEndRef} />
      </div>

      {/* Manual Input Line */}
      {!pendingCommand && (
        <form
          onSubmit={handleRunCustom}
          className="flex items-center gap-2 border-t border-white/10 bg-[#0A0A0A] p-3 shrink-0 select-none"
        >
          <span className="text-rose-600 font-bold pl-1 select-none">$</span>
          <input
            type="text"
            value={customCommand}
            onChange={(e) => setCustomCommand(e.target.value)}
            disabled={executing}
            placeholder={executing ? "Please wait..." : "Type custom shell command and press Enter (e.g. ls -la)..."}
            className="flex-1 bg-transparent text-white placeholder-white/20 focus:outline-none text-[11px] font-mono select-text"
          />
        </form>
      )}
    </div>
  );
}
