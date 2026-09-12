import {
  ArrowDown,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  GitFork,
  Minimize2,
  Pencil,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultFeedbackOpen,
  displaySideFor,
  FEEDBACK_PREFIX_RE,
  findLinkedFeedbackIndex,
  parseFeedback,
} from '../shared/chain-feedback.ts';
import { useTheme } from '../theme.tsx';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thought?: string | null;
}

export interface ModelInfo {
  alias: string;
  spec: string;
  vendor: string;
  model: string;
  thinking: string;
  fast: boolean;
}

interface ChatSectionProps {
  messages: ChatMessage[];
  inputPrompt: string;
  onInputChange: (val: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
  loading: boolean;
  modelAlias: string;
  onModelAliasChange: (alias: string) => void;
  models: ModelInfo[];
  keysStatus: Record<string, boolean>;
  chainMode: boolean;
  onChainModeChange: (val: boolean) => void;
  autoExecute: boolean;
  onAutoExecuteChange: (val: boolean) => void;
  requireApproval: boolean;
  onRequireApprovalChange: (val: boolean) => void;
  noExec: boolean;
  onNoExecChange: (val: boolean) => void;
  onSelectSample: (prompt: string) => void;
  onMinimize?: () => void;
  cwd?: string;
  onClearChat?: () => void;
  onEditMessage?: (id: string, content: string) => void;
  onRetryMessage?: (id: string) => void;
  onForkFromMessage?: (id: string) => void;
}

const SAMPLE_PROMPTS = [
  { label: '🔍 Structure', prompt: 'explain this directory and list the contents' },
  { label: '💾 Write Script', prompt: 'save a demo file called hello.ts with a console log and show it' },
  { label: '🧪 Lint Workspace', prompt: 'run the workspace linter command and report if there are any issues' },
  { label: '🛠️ Sys Information', prompt: 'create a script to print system info and run it' },
];

// Project name shown in the empty state (last path segment of cwd)
export function projectBasename(cwd: string): string {
  if (!cwd) return 'workspace';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'workspace';
}

// Vendors that require an API key (vast/local are keyless endpoints)
const KEYED_VENDORS = new Set([
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'openrouter',
  'moonshotai',
  'cerebras',
]);
const VENDOR_KEY_ALIASES: Record<string, string> = { google: 'google' };

// Autoscroll only sticks when the user is already this close to the bottom
const NEAR_BOTTOM_PX = 80;
// Hard cap for the prompt textarea
const MAX_INPUT_CHARS = 8000;
// Input grows line by line up to this many visual lines, then scrolls
const MAX_INPUT_LINES = 9;

export default function ChatSection({
  messages,
  inputPrompt,
  onInputChange,
  onSubmit,
  onStop,
  loading,
  modelAlias,
  onModelAliasChange,
  models,
  keysStatus,
  chainMode,
  onChainModeChange,
  autoExecute,
  onAutoExecuteChange,
  requireApproval,
  onRequireApprovalChange,
  noExec,
  onNoExecChange,
  onSelectSample,
  onMinimize,
  cwd,
  onClearChat,
  onEditMessage,
  onRetryMessage,
  onForkFromMessage,
}: ChatSectionProps) {
  const { config } = useTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nearBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [expandedScriptId, setExpandedScriptId] = useState<string | null>(null);
  // Explicit per-card open overrides; default follows content length (long starts collapsed).
  const [feedbackOpen, setFeedbackOpen] = useState<Record<string, boolean>>({});
  const isFeedbackOpen = (m: { id: string; content: string }) => feedbackOpen[m.id] ?? defaultFeedbackOpen(m.content);

  // Chat width: custom layout reads customChatWrap (default 80ch, 'max' = free space)
  const chatWrap = config.layout === 'custom' ? config.customChatWrap : 80;
  const isMaxWrap = chatWrap === 'max';
  const wrapStyle: React.CSSProperties = isMaxWrap
    ? { maxWidth: 'none', width: '100%' }
    : { maxWidth: `${chatWrap}ch`, width: '100%' };

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = distance < NEAR_BOTTOM_PX;
    if (nearBottomRef.current) setShowJump(false);
  }, []);

  // Stick to bottom only when already near it; otherwise offer a jump button
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (nearBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, []);

  // Auto-resize the prompt input: grows up to MAX_INPUT_LINES visual lines,
  // then scrolls inside the box (overflowY toggles at the cap).
  // Runs on every render (refs only) so it re-fits after submit/clear too.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 19.5;
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const maxHeight = lineHeight * MAX_INPUT_LINES + padY;
    el.style.maxHeight = `${maxHeight}px`;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden';
  });

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const handleSaveEdit = (id: string) => {
    const next = editingValue.trim();
    if (!next || loading) return;
    onEditMessage?.(id, next);
    setEditingId(null);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingValue('');
  };

  // Helper to strip <RUN> tags (case-insensitive) from text response so they don't pollute the visual bubble
  const cleanResponseContent = (text: string) => {
    return text.replace(/<run>[\s\S]*?<\/run>/gi, '').trim();
  };

  const hasRunsInMessage = (text: string) => {
    return /<run>[\s\S]*?<\/run>/i.test(text);
  };

  const extractRunScripts = (text: string): string[] => {
    return [...text.matchAll(/<run>([\s\S]*?)<\/run>/gi)].map((m) => (m[1] ?? '').trim()).filter(Boolean);
  };

  const selectedModel = models.find((m) => m.alias === modelAlias);
  const hasKey = (vendor: string) => !KEYED_VENDORS.has(vendor) || !!keysStatus[VENDOR_KEY_ALIASES[vendor] || vendor];

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!loading && inputPrompt.trim()) formRef.current?.requestSubmit();
    }
  };

  return (
    <div className="relative flex flex-col h-full bg-(--color-bg-primary)">
      {/* Top Navbar */}
      <div className="flex flex-wrap items-center justify-between p-4 border-b border-(--color-border-subtle) bg-(--color-bg-primary) text-(--color-text-primary) gap-3 shrink-0 select-none">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-(--color-accent) animate-pulse" />
          <span className="font-display font-black text-xs tracking-[0.2em] uppercase text-(--color-text-primary)">
            Chat Interface
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs">
          {/* Model Selector */}
          <div className="flex items-center gap-2">
            <span className="text-(--color-text-muted) uppercase tracking-widest text-[10px] font-bold">Model:</span>
            <select
              value={modelAlias}
              onChange={(e) => onModelAliasChange(e.target.value)}
              title={selectedModel && !hasKey(selectedModel.vendor) ? 'no key' : undefined}
              className="bg-(--color-bg-secondary) border border-(--color-border-medium) rounded-none px-2.5 py-1 text-(--color-text-primary) font-mono text-[10px] focus:outline-none focus:border-(--color-text-primary) transition-colors cursor-pointer"
            >
              {models.map((m) => (
                <option key={m.alias} value={m.alias} disabled={!hasKey(m.vendor)} className="bg-(--color-bg-primary)">
                  {m.alias} : {m.model}
                  {!hasKey(m.vendor)
                    ? ' (no key)'
                    : m.fast
                      ? ' · fast'
                      : m.thinking && m.thinking !== 'none'
                        ? ` · ${m.thinking}`
                        : ' · none'}
                </option>
              ))}
            </select>
            {selectedModel && (
              <span className="flex items-center gap-1">
                {selectedModel.fast ? (
                  <span className="text-[8px] font-black uppercase tracking-wider px-1 py-0.2 border border-(--color-accent)/40 bg-(--color-accent-subtle) text-(--color-accent-text)">
                    ⚡ Fast
                  </span>
                ) : (
                  selectedModel.thinking &&
                  selectedModel.thinking !== 'none' && (
                    <span className="text-[8px] font-black uppercase tracking-wider px-1 py-0.2 border border-(--color-border-medium) bg-white/5 text-(--color-text-secondary)">
                      🧠 {selectedModel.thinking}
                    </span>
                  )
                )}
              </span>
            )}
          </div>

          {/* Chain Mode Toggle */}
          <label className="flex items-center gap-2 cursor-pointer text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors">
            <input
              type="checkbox"
              checked={chainMode}
              onChange={(e) => onChainModeChange(e.target.checked)}
              className="accent-(--color-accent) rounded-none bg-(--color-bg-secondary) border-(--color-border-medium) focus:ring-0 cursor-pointer w-3.5 h-3.5"
            />
            <span className="font-bold tracking-wider text-[10px] uppercase">Chain Loop</span>
          </label>

          {/* Yes Auto Execute Toggle */}
          <label
            className={`flex items-center gap-2 transition-colors ${noExec ? 'cursor-not-allowed text-(--color-text-muted) opacity-50' : 'cursor-pointer text-(--color-text-secondary) hover:text-(--color-text-primary)'}`}
            title={
              noExec
                ? 'Disabled while No-Exec is on'
                : requireApproval
                  ? 'Auto-Run with Require Approval: safe commands run directly, risky need approval'
                  : undefined
            }
          >
            <input
              type="checkbox"
              checked={autoExecute}
              disabled={noExec}
              onChange={(e) => onAutoExecuteChange(e.target.checked)}
              className="accent-(--color-accent) rounded-none bg-(--color-bg-secondary) border-(--color-border-medium) focus:ring-0 cursor-pointer w-3.5 h-3.5 disabled:cursor-not-allowed"
            />
            <span className="font-bold tracking-wider text-[10px] uppercase">Auto-Run (-y)</span>
          </label>

          {/* Require Approval Toggle — risky commands need manual confirmation */}
          <label
            className={`flex items-center gap-2 transition-colors ${noExec ? 'cursor-not-allowed text-(--color-text-muted) opacity-50' : 'cursor-pointer text-(--color-text-secondary) hover:text-(--color-text-primary)'}`}
            title={
              noExec
                ? 'Disabled while No-Exec is on (nothing runs)'
                : 'Risky commands need manual approval; safe ones follow Auto-Run'
            }
          >
            <input
              type="checkbox"
              checked={requireApproval}
              disabled={noExec}
              onChange={(e) => onRequireApprovalChange(e.target.checked)}
              className="accent-(--color-accent) rounded-none bg-(--color-bg-secondary) border-(--color-border-medium) focus:ring-0 cursor-pointer w-3.5 h-3.5 disabled:cursor-not-allowed"
            />
            <span className="font-bold tracking-wider text-[10px] uppercase">Require Approval</span>
          </label>

          {/* No-Exec Toggle — never run, only show what would run */}
          <label
            className="flex items-center gap-2 cursor-pointer text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors"
            title="Never execute commands — show what would run (--no-exec)"
          >
            <input
              type="checkbox"
              checked={noExec}
              onChange={(e) => onNoExecChange(e.target.checked)}
              className="accent-(--color-accent) rounded-none bg-(--color-bg-secondary) border-(--color-border-medium) focus:ring-0 cursor-pointer w-3.5 h-3.5"
            />
            <span className="font-bold tracking-wider text-[10px] uppercase">No-Exec</span>
          </label>

          {onClearChat && messages.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Clear the whole chat? This cannot be undone.')) onClearChat();
              }}
              title="Clear chat — deletes all messages"
              className="p-1.5 border border-(--color-border-subtle) hover:bg-white/10 text-(--color-text-secondary) hover:text-(--color-error) transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          {onMinimize && (
            <button
              type="button"
              onClick={onMinimize}
              title="Minimize chat — show terminal"
              className="p-1.5 border border-(--color-border-subtle) hover:bg-white/10 text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors cursor-pointer"
            >
              <Minimize2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar select-text bg-(--color-bg-primary) relative"
      >
        {/* Subtle grid line backdrop for premium brutalist look */}
        <div className="absolute inset-0 opacity-[0.03] pointer-events-none grid grid-cols-6 h-full w-full">
          <div className="border-r border-(--color-text-primary) h-full"></div>
          <div className="border-r border-(--color-text-primary) h-full"></div>
          <div className="border-r border-(--color-text-primary) h-full"></div>
          <div className="border-r border-(--color-text-primary) h-full"></div>
          <div className="border-r border-(--color-text-primary) h-full"></div>
        </div>

        {messages.length === 0 ? (
          <div className="h-full flex flex-col justify-center max-w-xl mx-auto space-y-6 pt-6 relative z-10">
            {/* Project annotation — real workspace name */}
            <div
              className="text-[10px] font-bold tracking-[0.3em] text-(--color-text-muted) uppercase truncate"
              title={cwd}
            >
              [ Tell Web — {projectBasename(cwd || '')} ]
            </div>

            {/* Compact hero — stays above the fold on mobile */}
            <div className="space-y-2 select-none">
              <h1 className="text-5xl sm:text-7xl font-black leading-[0.85] uppercase tracking-tighter -ml-1 text-(--color-text-primary)">
                Tell
                <br />
                Web.
              </h1>
              <div className="mt-3 flex gap-4 items-center">
                <div className="h-[1px] w-12 bg-(--color-border-medium) shrink-0"></div>
                <p className="text-sm font-light leading-relaxed tracking-tight text-(--color-text-secondary)">
                  Ask the agent to run commands, edit files and inspect this workspace. Scripts require your
                  confirmation before executing.
                </p>
              </div>
            </div>

            {/* Suggested tasks */}
            <div className="space-y-2">
              <div className="text-[10px] uppercase font-bold tracking-[0.2em] text-(--color-text-muted)">
                Suggested tasks
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 select-none">
                {SAMPLE_PROMPTS.map((sample, idx) => (
                  <button
                    type="button"
                    key={idx}
                    onClick={() => onSelectSample(sample.prompt)}
                    className="px-4 py-2.5 border border-(--color-border-subtle) text-left text-[10px] font-bold uppercase tracking-widest text-(--color-text-primary) hover:bg-(--color-text-primary) hover:text-(--color-bg-primary) hover:border-(--color-text-primary) transition-all duration-150 cursor-pointer rounded-none font-display"
                  >
                    {sample.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          messages.map((m, msgIdx) => {
            const isUser = m.role === 'user';
            const isFeedback = isUser && FEEDBACK_PREFIX_RE.test(m.content);
            // Chain-loop feedback (Executed/Skipped) renders on the LLM side;
            // the stored role stays 'user' so the LLM context is unchanged.
            const displayIsUser = displaySideFor(m) === 'user';
            const cleanContent = displayIsUser ? m.content : cleanResponseContent(m.content);
            const containsRuns = !displayIsUser && hasRunsInMessage(m.content);
            const runScripts = !displayIsUser && containsRuns ? extractRunScripts(m.content) : [];
            const scriptExpanded = expandedScriptId === m.id;
            const linkedFeedbackIdx = !displayIsUser && containsRuns ? findLinkedFeedbackIndex(messages, msgIdx) : -1;
            const linkedFeedback =
              linkedFeedbackIdx >= 0 ? parseFeedback(messages[linkedFeedbackIdx]?.content ?? '') : null;

            // Skip rendering if content is empty (e.g. intermediate thought only messages or silent system runs)
            if (!cleanContent && !m.thought) return null;

            // Feedback pipeline card (left/LLM side, never a user bubble)
            if (isFeedback) {
              const parsed = parseFeedback(m.content);
              const header = parsed?.kind === 'skipped' ? 'SKIPPED BY USER' : 'EXECUTED COMMAND';
              const open = isFeedbackOpen(m);
              return (
                <div key={m.id} style={wrapStyle} className="group/msg flex gap-3 mx-auto relative z-10 justify-start">
                  <div className="w-8 h-8 bg-white/5 border border-(--color-border-medium) text-(--color-text-primary) rounded-none flex items-center justify-center shrink-0 select-none">
                    <Terminal className="w-4 h-4 text-(--color-accent)" />
                  </div>
                  <div className={`space-y-2 min-w-0 ${isMaxWrap ? 'max-w-full' : 'max-w-[85%]'}`}>
                    <div className="rounded-none text-xs leading-relaxed bg-(--color-bg-secondary) text-(--color-text-primary) border border-(--color-border-subtle) selection:bg-(--color-accent-subtle) overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setFeedbackOpen((prev) => ({ ...prev, [m.id]: !open }))}
                        aria-expanded={open}
                        title={open ? 'Hide result' : 'Expand result'}
                        className="w-full flex items-center gap-1.5 p-4 text-[10px] font-bold uppercase tracking-wider text-(--color-accent-text) cursor-pointer hover:bg-white/5 transition-colors select-none"
                      >
                        <Terminal className="w-3.5 h-3.5 shrink-0" />
                        <span className="flex-1 text-left">{header}</span>
                        {open ? (
                          <ChevronUp className="w-3.5 h-3.5 shrink-0" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                        )}
                      </button>
                      {open && (
                        <div className="px-4 pb-4 space-y-2">
                          {parsed?.command && (
                            <pre className="mt-2 p-2 bg-(--color-bg-primary) border border-(--color-border-subtle) text-[10px] font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto custom-scrollbar select-text">
                              {parsed.command}
                            </pre>
                          )}
                          {parsed?.kind === 'executed' ? (
                            parsed.output ? (
                              <pre className="mt-2 p-2 bg-(--color-bg-primary) border border-(--color-border-subtle) text-[10px] font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto custom-scrollbar select-text text-(--color-text-secondary)">
                                {parsed.output}
                              </pre>
                            ) : (
                              <p className="mt-2 text-[10px] text-(--color-text-muted) font-sans">(no output)</p>
                            )
                          ) : (
                            <p className="mt-2 text-[10px] text-(--color-text-muted) font-sans">
                              Command skipped by user.
                            </p>
                          )}
                          <div className="mt-2 flex justify-end gap-1.5 select-none">
                            {parsed?.command && (
                              <button
                                type="button"
                                onClick={() => handleCopy(`${m.id}-cmd`, parsed.command)}
                                title="Copy command"
                                className="flex items-center gap-1 px-2 py-1 border border-(--color-border-medium) text-[9px] font-bold uppercase tracking-wider text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-white/10 transition-colors cursor-pointer"
                              >
                                {copiedId === `${m.id}-cmd` ? (
                                  <Check className="w-3 h-3 text-(--color-success)" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                                {copiedId === `${m.id}-cmd` ? 'Copied' : 'Cmd'}
                              </button>
                            )}
                            {parsed?.kind === 'executed' && parsed.output && (
                              <button
                                type="button"
                                onClick={() => handleCopy(`${m.id}-out`, parsed.output)}
                                title="Copy result"
                                className="flex items-center gap-1 px-2 py-1 border border-(--color-border-medium) text-[9px] font-bold uppercase tracking-wider text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-white/10 transition-colors cursor-pointer"
                              >
                                {copiedId === `${m.id}-out` ? (
                                  <Check className="w-3 h-3 text-(--color-success)" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                                {copiedId === `${m.id}-out` ? 'Copied' : 'Output'}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={m.id}
                style={wrapStyle}
                className={`group/msg flex gap-3 mx-auto relative z-10 ${displayIsUser ? 'justify-end' : 'justify-start'}`}
              >
                {/* Assistant Avatar */}
                {!displayIsUser && (
                  <div className="w-8 h-8 bg-white/5 border border-(--color-border-medium) text-(--color-text-primary) rounded-none flex items-center justify-center shrink-0 select-none">
                    <BrainCircuit className="w-4 h-4 text-(--color-accent)" />
                  </div>
                )}

                {/* Message Bubble */}
                <div className={`space-y-2 min-w-0 ${isMaxWrap ? 'max-w-full' : 'max-w-[85%]'}`}>
                  {/* Thought/Reasoning Panel */}
                  {m.thought && (
                    <div className="bg-(--color-bg-secondary) border-l-2 border-(--color-accent) p-3.5 text-[11px] text-(--color-text-secondary) font-mono space-y-1">
                      <div className="flex items-center gap-1.5 text-[9px] text-(--color-text-muted) font-bold uppercase tracking-widest select-none">
                        <BrainCircuit className="w-3.5 h-3.5 text-(--color-accent)" />
                        <span>Cognitive Sequence</span>
                      </div>
                      <div className="leading-relaxed pl-1 whitespace-pre-wrap">
                        {typeof m.thought === 'string'
                          ? m.thought
                          : typeof m.thought === 'object' && m.thought !== null
                            ? (m.thought as any).text || JSON.stringify(m.thought, null, 2)
                            : String(m.thought)}
                      </div>
                    </div>
                  )}

                  {/* Edit mode (user messages, ChatGPT-style) */}
                  {isUser && editingId === m.id ? (
                    <div className="bg-white/5 border border-(--color-accent)/60 p-3 space-y-2">
                      <textarea
                        value={editingValue}
                        onChange={(e) => setEditingValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            handleCancelEdit();
                          }
                        }}
                        rows={Math.min(12, Math.max(2, editingValue.split('\n').length + 1))}
                        className="w-full bg-transparent border-none text-xs text-(--color-text-primary) focus:outline-none leading-relaxed font-sans select-text resize-y custom-scrollbar"
                      />
                      <div className="flex items-center justify-end gap-2 select-none">
                        <button
                          type="button"
                          onClick={handleCancelEdit}
                          className="px-3 py-1 border border-(--color-border-medium) text-[10px] font-bold uppercase tracking-wider text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-white/10 transition-colors cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveEdit(m.id)}
                          disabled={!editingValue.trim() || loading}
                          className="flex items-center gap-1.5 px-3 py-1 bg-(--color-text-primary) hover:bg-(--color-accent) text-(--color-bg-primary) hover:text-white disabled:opacity-40 disabled:cursor-not-allowed text-[10px] font-black uppercase tracking-wider transition-colors cursor-pointer"
                        >
                          <Send className="w-3 h-3" />
                          Save & Resend
                        </button>
                      </div>
                    </div>
                  ) : (
                    cleanContent && (
                      <div
                        className={`p-4 rounded-none text-xs leading-relaxed group ${
                          displayIsUser
                            ? 'bg-white/5 text-(--color-text-primary) border border-(--color-border-medium) selection:bg-(--color-accent-subtle)'
                            : 'bg-(--color-bg-secondary) text-(--color-text-primary) border border-(--color-border-subtle) selection:bg-(--color-accent-subtle)'
                        }`}
                      >
                        <div
                          className="whitespace-pre-wrap leading-relaxed select-text font-sans"
                          style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
                        >
                          {cleanContent}
                        </div>

                        {/* Run tag notification inside chat bubble — click to expand/collapse script */}
                        {containsRuns && (
                          <div className="mt-3 border border-(--color-accent)/25 bg-(--color-accent-subtle) rounded-none overflow-hidden">
                            <button
                              type="button"
                              onClick={() => setExpandedScriptId(scriptExpanded ? null : m.id)}
                              aria-expanded={scriptExpanded}
                              title={scriptExpanded ? 'Minimize script' : 'Expand to view the script and result'}
                              className="w-full flex items-center gap-2 text-[10px] text-(--color-accent-text) px-2.5 py-1.5 font-mono tracking-wide cursor-pointer hover:bg-white/5 transition-colors"
                            >
                              <Terminal className="w-3.5 h-3.5 shrink-0" />
                              <span className="uppercase font-bold flex-1 text-left">
                                SCRIPT GENERATED IN TERMINAL PIPELINE
                              </span>
                              {scriptExpanded ? (
                                <ChevronUp className="w-3.5 h-3.5 shrink-0" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                              )}
                            </button>
                            {scriptExpanded && runScripts.length > 0 && (
                              <div className="border-t border-(--color-accent)/25 p-2 space-y-2">
                                {runScripts.map((script, idx) => (
                                  <div key={idx} className="space-y-1.5">
                                    {runScripts.length > 1 && (
                                      <div className="text-[9px] font-bold uppercase tracking-wider text-(--color-text-muted)">
                                        Script {idx + 1}/{runScripts.length}
                                      </div>
                                    )}
                                    <pre className="p-2 bg-(--color-bg-primary) border border-(--color-border-subtle) text-[10px] font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto custom-scrollbar select-text text-(--color-text-primary)">
                                      {script}
                                    </pre>
                                    <div className="flex justify-end">
                                      <button
                                        type="button"
                                        onClick={() => handleCopy(`${m.id}-script-${idx}`, script)}
                                        title="Copy script"
                                        className="flex items-center gap-1 px-2 py-1 border border-(--color-border-medium) text-[9px] font-bold uppercase tracking-wider text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-white/10 transition-colors cursor-pointer"
                                      >
                                        {copiedId === `${m.id}-script-${idx}` ? (
                                          <Check className="w-3 h-3 text-(--color-success)" />
                                        ) : (
                                          <Copy className="w-3 h-3" />
                                        )}
                                        {copiedId === `${m.id}-script-${idx}` ? 'Copied' : 'Copy'}
                                      </button>
                                    </div>
                                  </div>
                                ))}
                                <div className="space-y-1.5 border-t border-(--color-accent)/25 pt-2">
                                  <div className="text-[9px] font-bold uppercase tracking-wider text-(--color-text-muted)">
                                    Command result
                                  </div>
                                  {linkedFeedback?.kind === 'executed' ? (
                                    linkedFeedback.output ? (
                                      <>
                                        <pre className="p-2 bg-(--color-bg-primary) border border-(--color-border-subtle) text-[10px] font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto custom-scrollbar select-text text-(--color-text-secondary)">
                                          {linkedFeedback.output}
                                        </pre>
                                        <div className="flex justify-end">
                                          <button
                                            type="button"
                                            onClick={() => handleCopy(`${m.id}-output`, linkedFeedback.output)}
                                            title="Copy result"
                                            className="flex items-center gap-1 px-2 py-1 border border-(--color-border-medium) text-[9px] font-bold uppercase tracking-wider text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-white/10 transition-colors cursor-pointer"
                                          >
                                            {copiedId === `${m.id}-output` ? (
                                              <Check className="w-3 h-3 text-(--color-success)" />
                                            ) : (
                                              <Copy className="w-3 h-3" />
                                            )}
                                            {copiedId === `${m.id}-output` ? 'Copied' : 'Copy result'}
                                          </button>
                                        </div>
                                      </>
                                    ) : (
                                      <p className="text-[10px] text-(--color-text-muted) font-sans">(no output)</p>
                                    )
                                  ) : linkedFeedback?.kind === 'skipped' ? (
                                    <p className="text-[10px] text-(--color-text-muted) font-sans">
                                      Command skipped by user.
                                    </p>
                                  ) : (
                                    <p className="text-[10px] text-(--color-text-muted) font-sans">
                                      Waiting for execution — output will appear here after you authorize and run the
                                      command.
                                    </p>
                                  )}
                                </div>{' '}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  )}

                  {/* Assistant message actions (copy / retry / fork) — always visible on touch */}
                  {!displayIsUser && editingId !== m.id && (
                    <div className="flex justify-start gap-1 opacity-100 md:opacity-0 md:group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity select-none">
                      <button
                        type="button"
                        onClick={() => handleCopy(m.id, cleanContent)}
                        title="Copy response"
                        className="p-1.5 text-(--color-text-muted) hover:text-(--color-text-primary) hover:bg-white/10 transition-colors cursor-pointer"
                      >
                        {copiedId === m.id ? (
                          <Check className="w-3 h-3 text-(--color-success)" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                      {onRetryMessage && (
                        <button
                          type="button"
                          onClick={() => onRetryMessage(m.id)}
                          disabled={loading}
                          title="Retry — regenerate from this response"
                          className="p-1.5 text-(--color-text-muted) hover:text-(--color-text-primary) hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                        >
                          <RotateCcw className="w-3 h-3" />
                        </button>
                      )}
                      {onForkFromMessage && (
                        <button
                          type="button"
                          onClick={() => onForkFromMessage(m.id)}
                          title="Fork from this message"
                          className="p-1.5 text-(--color-text-muted) hover:text-(--color-text-primary) hover:bg-white/10 transition-colors cursor-pointer"
                        >
                          <GitFork className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  )}

                  {/* User message actions (copy / edit, ChatGPT-style hover row) */}
                  {isUser && !isFeedback && onEditMessage && editingId !== m.id && (
                    <div className="flex justify-end gap-1 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity select-none">
                      <button
                        type="button"
                        onClick={() => handleCopy(m.id, m.content)}
                        title="Copy message"
                        className="p-1.5 text-(--color-text-muted) hover:text-(--color-text-primary) hover:bg-white/10 transition-colors cursor-pointer"
                      >
                        {copiedId === m.id ? (
                          <Check className="w-3 h-3 text-(--color-success)" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(m.id);
                          setEditingValue(m.content);
                        }}
                        disabled={loading}
                        title="Edit message — resends the conversation from this point"
                        className="p-1.5 text-(--color-text-muted) hover:text-(--color-text-primary) hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>

                {/* User Avatar */}
                {isUser && (
                  <div className="w-8 h-8 bg-(--color-text-primary) text-(--color-bg-primary) rounded-none flex items-center justify-center shrink-0 select-none font-mono font-bold text-xs border border-(--color-border-medium)">
                    U
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Jump-to-new-message button */}
      {showJump && (
        <button
          type="button"
          onClick={() => {
            nearBottomRef.current = true;
            setShowJump(false);
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
          }}
          className="absolute bottom-28 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 bg-(--color-accent) text-white text-[9px] font-black uppercase tracking-widest shadow-lg cursor-pointer hover:bg-(--color-accent-hover) transition-colors"
        >
          <ArrowDown className="w-3 h-3" />
          new
        </button>
      )}

      {/* Message Input Bar */}
      <form
        ref={formRef}
        onSubmit={onSubmit}
        className="p-4 border-t border-(--color-border-subtle) bg-(--color-bg-primary) select-none shrink-0"
      >
        <div style={wrapStyle} className="flex items-end gap-2 mx-auto">
          {/* Char counter: outside the box (left), fixed size, aligned with the last text line */}
          {inputPrompt.length > 0 && (
            <span className="text-[8px] font-mono text-(--color-text-muted) pb-3 shrink-0 select-none">
              {inputPrompt.length}/{MAX_INPUT_CHARS}
            </span>
          )}
          {/* Growing box: textarea only — counter and action button live outside so they never expand */}
          <div className="flex-1 min-w-0 flex items-end bg-(--color-bg-secondary) border border-(--color-border-medium) px-3 py-1">
            <textarea
              ref={inputRef}
              value={inputPrompt}
              onChange={(e) => onInputChange(e.target.value.slice(0, MAX_INPUT_CHARS))}
              onKeyDown={handleKeyDown}
              disabled={loading}
              rows={1}
              maxLength={MAX_INPUT_CHARS}
              placeholder={
                loading ? 'Executing… (Stop button cancels the chain)' : 'Ask the agent… (Shift+Enter = newline)'
              }
              className="flex-1 min-w-0 bg-transparent border-none py-2 text-xs text-(--color-text-primary) placeholder-(--color-text-secondary) focus:outline-none leading-relaxed font-sans select-text resize-none overflow-hidden custom-scrollbar"
            />
          </div>
          {loading ? (
            <button
              type="button"
              onClick={onStop}
              title="Stop generation / chain"
              className="p-2 bg-(--color-error) text-white hover:opacity-80 transition-all duration-150 rounded-none shrink-0 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!inputPrompt.trim()}
              className="p-2 bg-(--color-text-primary) text-(--color-bg-primary) hover:bg-(--color-accent) hover:text-white disabled:bg-white/10 disabled:text-(--color-text-muted) transition-all duration-150 rounded-none shrink-0 cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
