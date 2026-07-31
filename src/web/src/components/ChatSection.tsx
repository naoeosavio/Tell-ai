import React, { useRef, useEffect } from 'react';
import { Send, Sparkles, BrainCircuit, User, Terminal, Check, Copy } from 'lucide-react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thought?: string | null;
}

interface ChatSectionProps {
  messages: ChatMessage[];
  inputPrompt: string;
  onInputChange: (val: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  loading: boolean;
  modelAlias: string;
  onModelAliasChange: (alias: string) => void;
  models: Array<{ alias: string; spec: string; vendor: string; model: string }>;
  chainMode: boolean;
  onChainModeChange: (val: boolean) => void;
  autoExecute: boolean;
  onAutoExecuteChange: (val: boolean) => void;
  onSelectSample: (prompt: string) => void;
}

const SAMPLE_PROMPTS = [
  { label: '🔍 Explain Directory', prompt: 'explain this directory and list the contents' },
  { label: '💾 Save Demo File', prompt: 'save a demo file called hello.ts with a console log and show it' },
  { label: '🧪 Run Linter Check', prompt: 'run the workspace linter command and report if there are any issues' },
  { label: '🛠️ Create Temp Script', prompt: 'create a script to print system info and run it' },
];

export default function ChatSection({
  messages,
  inputPrompt,
  onInputChange,
  onSubmit,
  loading,
  modelAlias,
  onModelAliasChange,
  models,
  chainMode,
  onChainModeChange,
  autoExecute,
  onAutoExecuteChange,
  onSelectSample,
}: ChatSectionProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Helper to strip <RUN> tags from text response so they don't pollute the visual bubble
  const cleanResponseContent = (text: string) => {
    return text.replace(/<RUN>[\s\S]*?<\/RUN>/g, '').trim();
  };

  const hasRunsInMessage = (text: string) => {
    return /<RUN>([\s\S]*?)<\/RUN>/.test(text);
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
  };

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* Top Navbar */}
      <div className="flex flex-wrap items-center justify-between p-3 border-b border-slate-900 bg-slate-900 text-slate-300 gap-2 shrink-0 select-none">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sky-400 animate-pulse" />
          <span className="font-sans font-bold text-xs tracking-wider uppercase text-slate-200">Tell AI Console</span>
        </div>

        <div className="flex items-center gap-3 text-xs">
          {/* Model Selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500 font-medium">Model:</span>
            <select
              value={modelAlias}
              onChange={(e) => onModelAliasChange(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-300 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-sky-500 cursor-pointer"
            >
              {models.map((m) => (
                <option key={m.alias} value={m.alias}>
                  {m.alias} ({m.vendor}: {m.model.slice(0, 15)}...)
                </option>
              ))}
            </select>
          </div>

          {/* Chain Mode Toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer hover:text-white transition-colors">
            <input
              type="checkbox"
              checked={chainMode}
              onChange={(e) => onChainModeChange(e.target.checked)}
              className="rounded bg-slate-950 border-slate-800 text-sky-500 focus:ring-0 focus:ring-offset-0 cursor-pointer w-3.5 h-3.5"
            />
            <span className="text-slate-400 font-medium text-[11px]">Chain Mode (--chain)</span>
          </label>

          {/* Yes Auto Execute Toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer hover:text-white transition-colors">
            <input
              type="checkbox"
              checked={autoExecute}
              onChange={(e) => onAutoExecuteChange(e.target.checked)}
              className="rounded bg-slate-950 border-slate-800 text-sky-500 focus:ring-0 focus:ring-offset-0 cursor-pointer w-3.5 h-3.5"
            />
            <span className="text-slate-400 font-medium text-[11px]">Auto-Run (-y)</span>
          </label>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar select-text bg-[#030712]">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col justify-center items-center max-w-lg mx-auto text-center space-y-4 pt-12">
            <div className="bg-sky-500/10 p-3.5 rounded-full border border-sky-500/20 shadow-lg shadow-sky-500/5">
              <Sparkles className="w-8 h-8 text-sky-400" />
            </div>
            <div className="space-y-1.5 select-none">
              <h1 className="text-sm font-semibold text-slate-200">Welcome to the Tell AI Interactive Playground</h1>
              <p className="text-xs text-slate-400 font-sans max-w-sm mx-auto leading-relaxed">
                Provide natural language commands and witness your terminal assistant run tasks, draft source code, and refactor code inside this sandbox.
              </p>
            </div>

            {/* Quick Actions / Sample Accelerator */}
            <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-2 pt-4 select-none">
              {SAMPLE_PROMPTS.map((sample, idx) => (
                <button
                  key={idx}
                  onClick={() => onSelectSample(sample.prompt)}
                  className="p-2.5 bg-slate-900/50 hover:bg-slate-900 hover:border-slate-850 border border-slate-900 rounded-md text-left text-xs text-slate-400 hover:text-slate-200 cursor-pointer transition-all duration-150"
                >
                  {sample.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => {
            const isUser = m.role === 'user';
            const cleanContent = isUser ? m.content : cleanResponseContent(m.content);
            const containsRuns = !isUser && hasRunsInMessage(m.content);

            // Skip rendering if content is empty (e.g. intermediate thought only messages or silent system runs)
            if (!cleanContent && !m.thought) return null;

            return (
              <div
                key={m.id}
                className={`flex gap-3 max-w-3xl mx-auto ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                {/* Assistant Avatar */}
                {!isUser && (
                  <div className="w-7 h-7 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-full flex items-center justify-center shrink-0 select-none">
                    <BrainCircuit className="w-4 h-4" />
                  </div>
                )}

                {/* Message Bubble */}
                <div className="space-y-2 max-w-[85%]">
                  {/* Thought/Reasoning Panel */}
                  {m.thought && (
                    <div className="bg-slate-950 border-l-2 border-slate-700 p-2.5 rounded text-[11px] text-slate-400 font-mono space-y-1">
                      <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-semibold select-none">
                        <BrainCircuit className="w-3.5 h-3.5" />
                        <span>Thinking Process</span>
                      </div>
                      <div className="leading-relaxed pl-1">{m.thought}</div>
                    </div>
                  )}

                  {cleanContent && (
                    <div
                      className={`p-3 rounded-lg text-xs leading-relaxed font-sans ${
                        isUser
                          ? 'bg-sky-500/10 text-sky-200 border border-sky-500/20 selection:bg-sky-950'
                          : 'bg-slate-900 text-slate-200 border border-slate-850 selection:bg-indigo-950'
                      }`}
                    >
                      <div className="whitespace-pre-wrap leading-relaxed select-text font-sans">
                        {cleanContent}
                      </div>

                      {/* Run tag notification inside chat bubble */}
                      {containsRuns && (
                        <div className="mt-2.5 flex items-center gap-1.5 text-[10px] bg-amber-500/10 text-amber-500 border border-amber-500/20 px-2 py-1 rounded select-none">
                          <Terminal className="w-3.5 h-3.5 shrink-0" />
                          <span>Generated command actions inside terminal below.</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* User Avatar */}
                {isUser && (
                  <div className="w-7 h-7 bg-sky-500/10 border border-sky-500/20 text-sky-400 rounded-full flex items-center justify-center shrink-0 select-none">
                    <User className="w-4 h-4" />
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={scrollRef} />
      </div>

      {/* Message Input Bar */}
      <form
        onSubmit={onSubmit}
        className="p-3 border-t border-slate-900 bg-slate-900 select-none shrink-0"
      >
        <div className="flex items-center gap-2 max-w-3xl mx-auto">
          <input
            type="text"
            value={inputPrompt}
            onChange={(e) => onInputChange(e.target.value)}
            disabled={loading}
            placeholder={loading ? "Agent is processing in chain loop..." : "Ask Tell AI to perform a workspace task..."}
            className="flex-1 bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-sky-500 leading-relaxed font-sans select-text"
          />
          <button
            type="submit"
            disabled={loading || !inputPrompt.trim()}
            className="p-2 bg-sky-500 hover:bg-sky-600 disabled:bg-sky-500/30 disabled:text-slate-500 text-white rounded-md transition-colors cursor-pointer shrink-0 shadow-lg shadow-sky-500/10"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </form>
    </div>
  );
}
