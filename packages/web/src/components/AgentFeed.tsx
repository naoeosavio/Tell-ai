import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react';
import { useState } from 'react';
import type { TerminalLine } from './Terminal.tsx';

interface AgentFeedProps {
  lines: TerminalLine[];
  open: boolean;
  onToggle: (open: boolean) => void;
  onClear?: () => void;
  className?: string;
}

function SparkleIcon() {
  return <span className="text-(--color-accent)">✦</span>;
}

export default function AgentFeed({ lines, open, onToggle, onClear, className }: AgentFeedProps) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const handleCopy = async (idx: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (lines.length === 0) return null;

  return (
    <div className={`shrink-0 border-b border-(--color-accent)/20 bg-(--color-bg-primary) ${className ?? ''}`}>
      <div className="flex items-center justify-between px-3 py-1 select-none">
        <button
          type="button"
          onClick={() => onToggle(!open)}
          aria-expanded={open}
          title={open ? 'Minimize Agent Feed' : 'Expand Agent Feed'}
          className="flex items-center gap-1.5 text-[9px] font-display font-black uppercase tracking-widest text-(--color-accent) cursor-pointer"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
          <SparkleIcon />
          <span>Agent Feed ({lines.length})</span>
        </button>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="text-(--color-text-muted) hover:text-(--color-accent-text) text-[9px] uppercase tracking-widest cursor-pointer"
          >
            Clear
          </button>
        )}
      </div>
      {open && (
        <div className="px-3 pb-2 space-y-1 max-h-40 overflow-y-auto custom-scrollbar">
          {lines.map((line, i) => {
            const expanded = expandedIdx === i;
            const isLong = line.text.length > 300;
            const shown = expanded || !isLong ? line.text : `${line.text.slice(0, 300)}…`;
            return (
              <div key={i} className="whitespace-pre-wrap break-all text-[9.5px] group/feed flex items-start gap-1.5">
                <div className="flex-1 min-w-0">
                  {line.type === 'input' && (
                    <div className="text-(--color-text-primary) font-semibold">
                      <span className="text-(--color-accent) font-black">$ </span>
                      {shown}
                    </div>
                  )}
                  {line.type === 'output' && <div className="text-(--color-text-secondary)">{shown}</div>}
                  {line.type === 'error' && (
                    <div className="text-(--color-error) font-bold uppercase tracking-wide">{shown}</div>
                  )}
                  {line.type === 'system' && (
                    <div className="text-(--color-text-muted) italic font-sans">[ {shown} ]</div>
                  )}
                  {line.type === 'request' && (
                    <div className="text-(--color-accent-text) border border-(--color-accent)/20 bg-(--color-accent-subtle) p-1 font-sans text-[9.5px]">
                      {shown}
                    </div>
                  )}
                  {isLong && (
                    <button
                      type="button"
                      onClick={() => setExpandedIdx(expanded ? null : i)}
                      className="mt-0.5 text-[9px] uppercase tracking-wider text-(--color-accent-text) hover:text-(--color-accent) cursor-pointer"
                    >
                      {expanded ? 'collapse' : 'expand'}
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy(i, line.text)}
                  title="Copy feed line"
                  className="shrink-0 p-1 text-(--color-text-muted) hover:text-(--color-text-primary) opacity-0 group-hover/feed:opacity-100 focus:opacity-100 transition-opacity cursor-pointer"
                >
                  {copiedIdx === i ? (
                    <Check className="w-3 h-3 text-(--color-success)" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
