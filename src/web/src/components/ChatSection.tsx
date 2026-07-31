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
  { label: '🔍 Structure', prompt: 'explain this directory and list the contents' },
  { label: '💾 Write Script', prompt: 'save a demo file called hello.ts with a console log and show it' },
  { label: '🧪 Lint Workspace', prompt: 'run the workspace linter command and report if there are any issues' },
  { label: '🛠️ Sys Information', prompt: 'create a script to print system info and run it' },
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

  return (
    <div className="flex flex-col h-full bg-[#0A0A0A]">
      {/* Top Navbar */}
      <div className="flex flex-wrap items-center justify-between p-4 border-b border-white/10 bg-[#0A0A0A] text-[#F5F5F5] gap-3 shrink-0 select-none">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-rose-600 animate-pulse" />
          <span className="font-display font-black text-xs tracking-[0.2em] uppercase text-[#F5F5F5]">
            Console Interface
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs">
          {/* Model Selector */}
          <div className="flex items-center gap-2">
            <span className="text-white/40 uppercase tracking-widest text-[9px] font-bold">Model:</span>
            <select
              value={modelAlias}
              onChange={(e) => onModelAliasChange(e.target.value)}
              className="bg-[#121212] border border-white/20 rounded-none px-2.5 py-1 text-[#F5F5F5] font-mono text-[10px] focus:outline-none focus:border-white transition-colors cursor-pointer uppercase"
            >
              {models.map((m) => (
                <option key={m.alias} value={m.alias} className="bg-[#0A0A0A]">
                  {m.alias} : {m.vendor.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          {/* Chain Mode Toggle */}
          <label className="flex items-center gap-2 cursor-pointer text-white/50 hover:text-white transition-colors">
            <input
              type="checkbox"
              checked={chainMode}
              onChange={(e) => onChainModeChange(e.target.checked)}
              className="accent-rose-600 rounded-none bg-[#121212] border-white/20 focus:ring-0 cursor-pointer w-3.5 h-3.5"
            />
            <span className="font-bold tracking-wider text-[9px] uppercase">Chain Loop</span>
          </label>

          {/* Yes Auto Execute Toggle */}
          <label className="flex items-center gap-2 cursor-pointer text-white/50 hover:text-white transition-colors">
            <input
              type="checkbox"
              checked={autoExecute}
              onChange={(e) => onAutoExecuteChange(e.target.checked)}
              className="accent-rose-600 rounded-none bg-[#121212] border-white/20 focus:ring-0 cursor-pointer w-3.5 h-3.5"
            />
            <span className="font-bold tracking-wider text-[9px] uppercase">Auto-Run (-y)</span>
          </label>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar select-text bg-[#0A0A0A] relative">
        {/* Subtle grid line backdrop for premium brutalist look */}
        <div className="absolute inset-0 opacity-[0.03] pointer-events-none grid grid-cols-6 h-full w-full">
          <div className="border-r border-white h-full"></div>
          <div className="border-r border-white h-full"></div>
          <div className="border-r border-white h-full"></div>
          <div className="border-r border-white h-full"></div>
          <div className="border-r border-white h-full"></div>
        </div>

        {messages.length === 0 ? (
          <div className="h-full flex flex-col justify-center max-w-xl mx-auto space-y-8 pt-8 relative z-10">
            {/* Elegant Top Annotation */}
            <div className="text-[10px] font-bold tracking-[0.5em] text-white/40 uppercase">
              [ Sandbox Assistant v1.2 ]
            </div>

            {/* Massive Displays Slogan from Design HTML */}
            <div className="space-y-2 select-none">
              <h1 className="text-7xl sm:text-8xl font-black leading-[0.85] uppercase tracking-tighter -ml-1 text-white">
                Speak<br/>Deeply.
              </h1>
              <div className="mt-4 flex gap-4 items-center">
                <div className="h-[1px] w-12 bg-white/20"></div>
                <p className="text-sm font-light leading-relaxed tracking-tight text-white/70 italic">
                  Tell your story. The engine is mapping your terminal directives to a synthetic reality in real-time.
                </p>
              </div>
            </div>

            {/* Quick Actions / Sample Accelerator styled exactly like the synthesis badges in the design */}
            <div className="space-y-2">
              <div className="text-[9px] uppercase font-bold tracking-[0.2em] text-white/30">
                Synthesis Anchors
              </div>
              <div className="grid grid-cols-2 gap-3 pt-1 select-none">
                {SAMPLE_PROMPTS.map((sample, idx) => (
                  <button
                    key={idx}
                    onClick={() => onSelectSample(sample.prompt)}
                    className="px-4 py-2.5 border border-white/10 text-left text-[10px] font-bold uppercase tracking-widest text-[#F5F5F5] hover:bg-white hover:text-black hover:border-white transition-all duration-150 cursor-pointer rounded-none font-display"
                  >
                    {sample.label}
                  </button>
                ))}
              </div>
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
                className={`flex gap-3 max-w-3xl mx-auto relative z-10 ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                {/* Assistant Avatar */}
                {!isUser && (
                  <div className="w-8 h-8 bg-white/5 border border-white/15 text-white rounded-none flex items-center justify-center shrink-0 select-none">
                    <BrainCircuit className="w-4 h-4 text-rose-500" />
                  </div>
                )}

                {/* Message Bubble */}
                <div className="space-y-2 max-w-[85%]">
                  {/* Thought/Reasoning Panel */}
                  {m.thought && (
                    <div className="bg-[#121212] border-l-2 border-rose-600 p-3.5 text-[11px] text-white/60 font-mono space-y-1">
                      <div className="flex items-center gap-1.5 text-[9px] text-white/40 font-bold uppercase tracking-widest select-none">
                        <BrainCircuit className="w-3.5 h-3.5 text-rose-600" />
                        <span>Cognitive Sequence</span>
                      </div>
                      <div className="leading-relaxed pl-1 whitespace-pre-wrap">{m.thought}</div>
                    </div>
                  )}

                  {cleanContent && (
                    <div
                      className={`p-4 rounded-none text-xs leading-relaxed ${
                        isUser
                          ? 'bg-white/5 text-white border border-white/25 selection:bg-rose-900/50'
                          : 'bg-[#121212] text-white/90 border border-white/10 selection:bg-rose-900/50'
                      }`}
                    >
                      <div className="whitespace-pre-wrap leading-relaxed select-text font-sans">
                        {cleanContent}
                      </div>

                      {/* Run tag notification inside chat bubble */}
                      {containsRuns && (
                        <div className="mt-3 flex items-center gap-2 text-[10px] bg-rose-600/10 text-rose-400 border border-rose-600/25 px-2.5 py-1.5 rounded-none font-mono tracking-wide select-none">
                          <Terminal className="w-3.5 h-3.5 shrink-0" />
                          <span className="uppercase font-bold">SCRIPT GENERATED IN TERMINAL PIPELINE</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* User Avatar */}
                {isUser && (
                  <div className="w-8 h-8 bg-white text-black rounded-none flex items-center justify-center shrink-0 select-none font-mono font-bold text-xs border border-white">
                    U
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
        className="p-4 border-t border-white/10 bg-[#0A0A0A] select-none shrink-0"
      >
        <div className="flex items-center gap-3 max-w-3xl mx-auto bg-[#121212] border border-white/15 px-3 py-1">
          <input
            type="text"
            value={inputPrompt}
            onChange={(e) => onInputChange(e.target.value)}
            disabled={loading}
            placeholder={loading ? "PROCESSOR EXECUTING LOOP..." : "PROMPT CONSOLE FOR DIRECTIVES..."}
            className="flex-1 bg-transparent border-none py-2 text-xs text-[#F5F5F5] placeholder-white/35 focus:outline-none leading-relaxed font-sans select-text uppercase tracking-wide"
          />
          <button
            type="submit"
            disabled={loading || !inputPrompt.trim()}
            className="p-2 bg-white text-black hover:bg-rose-600 hover:text-white disabled:bg-white/10 disabled:text-white/20 transition-all duration-150 rounded-none shrink-0 cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </form>
    </div>
  );
}
