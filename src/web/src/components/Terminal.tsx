import React, { useState, useEffect, useRef } from 'react';
import {
  Terminal as TerminalIcon,
  Play,
  AlertCircle,
  Trash2,
  ShieldCheck,
  Columns,
  Rows,
  Plus,
  X,
  Maximize2,
  Minimize2,
  Sparkles,
  Code,
  FileText,
  RefreshCw,
  Square,
  Cpu,
  CornerDownLeft,
} from 'lucide-react';

export interface TerminalLine {
  type: 'input' | 'output' | 'error' | 'system' | 'request';
  text: string;
  commandId?: string;
}

export interface TerminalPane {
  id: string;
  title: string;
  lines: TerminalLine[];
  executing: boolean;
  customCommand: string;
  isTailing?: boolean;
  tailFile?: string;
}

export interface TerminalTab {
  id: string;
  name: string;
  panes: TerminalPane[];
  activePaneId: string;
}

interface TerminalProps {
  lines: TerminalLine[];
  onExecuteCommand: (command: string, skipGlobalAppend?: boolean) => Promise<string>;
  onClear: () => void;
  pendingCommand: string | null;
  onConfirmPending: (editedCommand: string) => void;
  onSkipPending: () => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

const INITIAL_PANE: TerminalPane = {
  id: 'pane-1',
  title: 'bash #1',
  lines: [
    { type: 'system', text: 'Interactive Core Shell initialized (tmux mode).' },
    { type: 'system', text: 'CLI AI engines available: tell-ai, codex, opencode.' },
  ],
  executing: false,
  customCommand: '',
};

const INITIAL_TAB: TerminalTab = {
  id: 'tab-1',
  name: '1: dev-shell',
  panes: [INITIAL_PANE],
  activePaneId: 'pane-1',
};

export default function Terminal({
  lines,
  onExecuteCommand,
  onClear,
  pendingCommand,
  onConfirmPending,
  onSkipPending,
  isExpanded = false,
  onToggleExpand,
}: TerminalProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([INITIAL_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>('tab-1');
  const [tailModalPaneId, setTailModalPaneId] = useState<string | null>(null);
  const [tailFilePath, setTailFilePath] = useState<string>('server.ts');
  const [tailLinesCount, setTailLinesCount] = useState<number>(30);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState<string>('');

  const previousLinesLengthRef = useRef<number>(lines.length);

  // Sync global lines from props (e.g. system messages from agent) into active pane
  useEffect(() => {
    if (lines.length > previousLinesLengthRef.current) {
      const newLines = lines.slice(previousLinesLengthRef.current);
      previousLinesLengthRef.current = lines.length;

      setTabs((prevTabs) =>
        prevTabs.map((tab) => {
          if (tab.id === activeTabId) {
            return {
              ...tab,
              panes: tab.panes.map((pane) => {
                if (pane.id === tab.activePaneId) {
                  return { ...pane, lines: [...pane.lines, ...newLines] };
                }
                return pane;
              }),
            };
          }
          return tab;
        })
      );
    }
  }, [lines, activeTabId]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  // Helper to update a pane inside active tab
  const updatePane = (paneId: string, updater: (pane: TerminalPane) => TerminalPane) => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id === activeTabId) {
          return {
            ...tab,
            panes: tab.panes.map((p) => (p.id === paneId ? updater(p) : p)),
          };
        }
        return tab;
      })
    );
  };

  // Add new tab (max 4 tabs)
  const handleAddTab = () => {
    if (tabs.length >= 4) return;
    const newTabNum = tabs.length + 1;
    const newPaneId = `pane-${Date.now()}`;
    const newTabId = `tab-${Date.now()}`;
    const newTab: TerminalTab = {
      id: newTabId,
      name: `${newTabNum}: session-${newTabNum}`,
      panes: [
        {
          id: newPaneId,
          title: `bash #${newTabNum}`,
          lines: [
            { type: 'system', text: `Session #${newTabNum} ready.` },
            { type: 'system', text: 'Max 4 parallel panes supported per tab.' },
          ],
          executing: false,
          customCommand: '',
        },
      ],
      activePaneId: newPaneId,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTabId);
  };

  // Close tab
  const handleCloseTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length <= 1) return;
    const filtered = tabs.filter((t) => t.id !== tabId);
    setTabs(filtered);
    if (activeTabId === tabId) {
      setActiveTabId(filtered[0].id);
    }
  };

  // Split Pane Vertically or Horizontally (max 4 panes)
  const handleSplitPane = (splitType: 'vertical' | 'horizontal') => {
    if (activeTab.panes.length >= 4) return;

    const newPaneId = `pane-${Date.now()}`;
    const paneCount = activeTab.panes.length + 1;
    const newPane: TerminalPane = {
      id: newPaneId,
      title: `bash #${paneCount}`,
      lines: [
        {
          type: 'system',
          text: `Split ${splitType} pane initialized. Ready for bash / CLI-AI commands.`,
        },
      ],
      executing: false,
      customCommand: '',
    };

    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id === activeTabId) {
          return {
            ...tab,
            panes: [...tab.panes, newPane],
            activePaneId: newPaneId,
          };
        }
        return tab;
      })
    );
  };

  // Close specific pane
  const handleClosePane = (paneId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (activeTab.panes.length <= 1) return; // Keep at least 1 pane

    const remainingPanes = activeTab.panes.filter((p) => p.id !== paneId);
    const newActivePaneId =
      activeTab.activePaneId === paneId ? remainingPanes[0].id : activeTab.activePaneId;

    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id === activeTabId) {
          return {
            ...tab,
            panes: remainingPanes,
            activePaneId: newActivePaneId,
          };
        }
        return tab;
      })
    );
  };

  // Set active pane inside active tab
  const handleSelectPane = (paneId: string) => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id === activeTabId) {
          return { ...tab, activePaneId: paneId };
        }
        return tab;
      })
    );
  };

  // Execute command in a specific pane
  const handleExecuteInPane = async (paneId: string, commandToRun?: string) => {
    const pane = activeTab.panes.find((p) => p.id === paneId);
    if (!pane) return;

    const cmd = (commandToRun ?? pane.customCommand).trim();
    if (!cmd || pane.executing) return;

    // Append input line
    updatePane(paneId, (p) => ({
      ...p,
      customCommand: '',
      executing: true,
      lines: [...p.lines, { type: 'input', text: cmd }],
    }));

    try {
      const output = await onExecuteCommand(cmd, true);
      updatePane(paneId, (p) => ({
        ...p,
        executing: false,
        lines: [...p.lines, { type: 'output', text: output }],
      }));
    } catch (err: any) {
      updatePane(paneId, (p) => ({
        ...p,
        executing: false,
        lines: [...p.lines, { type: 'error', text: err.message || 'Execution error' }],
      }));
    }
  };

  // Clear lines in active or specific pane
  const handleClearPane = (paneId: string) => {
    updatePane(paneId, (p) => ({
      ...p,
      lines: [{ type: 'system', text: 'Pane output cleared.' }],
    }));
    if (activeTab.panes.length === 1) {
      onClear();
    }
  };

  // Tail File Execution
  const handleExecuteTail = async (paneId: string) => {
    if (!tailFilePath.trim()) return;
    const cmd = `tail -n ${tailLinesCount} ${tailFilePath.trim()}`;
    setTailModalPaneId(null);
    await handleExecuteInPane(paneId, cmd);
  };

  // Continuous tail interval handling
  const toggleContinuousTail = (paneId: string) => {
    const pane = activeTab.panes.find((p) => p.id === paneId);
    if (!pane) return;

    if (pane.isTailing) {
      updatePane(paneId, (p) => ({ ...p, isTailing: false }));
    } else {
      updatePane(paneId, (p) => ({
        ...p,
        isTailing: true,
        lines: [
          ...p.lines,
          { type: 'system', text: `Live tail enabled for ${pane.tailFile || 'server.ts'} (polling every 3s)` },
        ],
      }));
    }
  };

  // Effect for active continuous tailing panes
  useEffect(() => {
    const activeTails = activeTab.panes.filter((p) => p.isTailing && p.tailFile);
    if (activeTails.length === 0) return;

    const interval = setInterval(() => {
      activeTails.forEach(async (pane) => {
        try {
          const output = await onExecuteCommand(`tail -n 20 ${pane.tailFile}`);
          updatePane(pane.id, (p) => {
            // keep max 200 lines to avoid memory leak
            const currentLines = p.lines;
            const updated: TerminalLine[] = [
              ...currentLines,
              { type: 'system', text: `--- tail update (${new Date().toLocaleTimeString()}) ---` },
              { type: 'output', text: output },
            ];
            return {
              ...p,
              lines: updated.slice(-200),
            };
          });
        } catch {
          // ignore tail errors in background
        }
      });
    }, 3000);

    return () => clearInterval(interval);
  }, [activeTab.panes, activeTabId]);

  // Tab Rename logic
  const handleStartRenameTab = (tab: TerminalTab, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingTabId(tab.id);
    setRenamingName(tab.name);
  };

  const handleSaveTabName = (tabId: string) => {
    if (renamingName.trim()) {
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, name: renamingName.trim() } : t))
      );
    }
    setRenamingTabId(null);
  };

  // Calculate grid CSS for panes count (1, 2, 3, 4)
  const getGridClasses = (count: number) => {
    switch (count) {
      case 1:
        return 'grid-cols-1 grid-rows-1';
      case 2:
        return 'grid-cols-1 md:grid-cols-2 grid-rows-1';
      case 3:
        return 'grid-cols-1 md:grid-cols-2 grid-rows-2';
      case 4:
      default:
        return 'grid-cols-2 grid-rows-2';
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0A0A0A] text-white/90 font-mono text-[11px] leading-relaxed select-text overflow-hidden relative">
      {/* Top Header & Tabs Bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#080808] border-b border-white/10 shrink-0 select-none">
        {/* Left: Shell Title + Tab list */}
        <div className="flex items-center gap-3 overflow-x-auto custom-scrollbar pr-2">
          <div className="flex items-center gap-1.5 font-display font-black text-[10px] tracking-widest uppercase text-white/50 shrink-0 pr-1 select-none">
            <TerminalIcon className="w-3.5 h-3.5 text-rose-600 animate-pulse" />
            <span className="inline font-bold text-white/80">Console Interface</span>
            {isExpanded && (
              <span className="text-white/60 bg-white/10 px-1.5 py-0.5 text-[9px] font-bold tracking-wider">
                Maximized
              </span>
            )}
            <span className="text-rose-500 font-mono text-[9px] bg-rose-950/60 border border-rose-600/30 px-1.5 py-0.5 ml-0.5 font-semibold">
              TMUX
            </span>
          </div>

          {/* Tab Buttons */}
          <div className="flex items-center gap-1">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const isRenaming = renamingTabId === tab.id;

              return (
                <div
                  key={tab.id}
                  onClick={() => setActiveTabId(tab.id)}
                  onDoubleClick={(e) => handleStartRenameTab(tab, e)}
                  className={`flex items-center gap-1.5 px-3 py-1 text-[10px] border font-mono transition-all cursor-pointer ${
                    isActive
                      ? 'bg-[#141414] border-rose-600/60 text-white font-bold shadow-sm'
                      : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80 hover:bg-white/10'
                  }`}
                >
                  <Square
                    className={`w-2.5 h-2.5 ${isActive ? 'fill-rose-600 text-rose-600' : 'text-white/30'}`}
                  />
                  {isRenaming ? (
                    <input
                      type="text"
                      value={renamingName}
                      onChange={(e) => setRenamingName(e.target.value)}
                      onBlur={() => handleSaveTabName(tab.id)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveTabName(tab.id)}
                      autoFocus
                      className="bg-black text-white px-1 py-0.5 border border-rose-500 text-[10px] w-20 focus:outline-none"
                    />
                  ) : (
                    <span className="truncate max-w-[100px]">{tab.name}</span>
                  )}

                  <span className="text-[9px] text-white/30 font-sans ml-0.5">
                    ({tab.panes.length}P)
                  </span>

                  {tabs.length > 1 && (
                    <button
                      onClick={(e) => handleCloseTab(tab.id, e)}
                      className="p-0.5 hover:bg-white/10 text-white/30 hover:text-rose-400 transition-colors ml-1"
                      title="Close Tab"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  )}
                </div>
              );
            })}

            {/* New Tab Button (Max 4) */}
            <button
              onClick={handleAddTab}
              disabled={tabs.length >= 4}
              className={`flex items-center gap-1 px-2.5 py-1 text-[10px] border font-mono transition-all ${
                tabs.length >= 4
                  ? 'border-white/5 text-white/20 cursor-not-allowed opacity-50'
                  : 'border-white/15 bg-white/5 text-white/60 hover:text-white hover:bg-white/10 hover:border-white/30 cursor-pointer'
              }`}
              title={tabs.length >= 4 ? 'Maximum 4 parallel tabs reached' : 'Add new parallel tab (Max 4)'}
            >
              <Plus className="w-3 h-3 text-rose-500" />
              <span className="hidden sm:inline">New Tab</span>
              <span className="text-[9px] text-white/30">({tabs.length}/4)</span>
            </button>
          </div>
        </div>

        {/* Right Header Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Split Pane Actions */}
          <div className="hidden sm:flex items-center gap-1 bg-white/5 border border-white/10 p-0.5">
            <button
              onClick={() => handleSplitPane('vertical')}
              disabled={activeTab.panes.length >= 4}
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] hover:bg-white/10 text-white/70 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              title="Split Pane Vertically (Side-by-side)"
            >
              <Columns className="w-3 h-3 text-rose-500" />
              <span>Split V</span>
            </button>

            <button
              onClick={() => handleSplitPane('horizontal')}
              disabled={activeTab.panes.length >= 4}
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] hover:bg-white/10 text-white/70 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              title="Split Pane Horizontally (Stacked)"
            >
              <Rows className="w-3 h-3 text-rose-500" />
              <span>Split H</span>
            </button>
          </div>

          <span className="hidden md:flex items-center gap-1.5 text-[9px] bg-white/5 text-white/80 border border-white/15 px-2 py-0.5 uppercase font-bold tracking-wider">
            <ShieldCheck className="w-3 h-3 text-rose-600" /> Sandbox
          </span>

          {onToggleExpand && (
            <button
              onClick={onToggleExpand}
              className="p-1 hover:bg-white/10 text-white/50 hover:text-white transition-colors cursor-pointer"
              title={isExpanded ? 'Restore Shell Height' : 'Maximize Shell Height'}
            >
              {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}

          <button
            onClick={() => handleClearPane(activeTab.activePaneId)}
            className="p-1 hover:bg-white/10 text-white/40 hover:text-rose-400 transition-colors cursor-pointer"
            title="Clear Active Pane Output"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Panes Grid Container */}
      <div className={`flex-1 grid gap-1.5 p-1.5 bg-[#050505] overflow-hidden ${getGridClasses(activeTab.panes.length)}`}>
        {activeTab.panes.map((pane, index) => {
          const isFocused = pane.id === activeTab.activePaneId;

          return (
            <div
              key={pane.id}
              onClick={() => handleSelectPane(pane.id)}
              className={`flex flex-col h-full min-h-0 border transition-all duration-200 ${
                isFocused
                  ? 'border-rose-600/80 bg-[#0C0C0C] shadow-lg shadow-rose-950/20'
                  : 'border-white/10 bg-[#080808] opacity-80 hover:opacity-100 hover:border-white/20'
              }`}
            >
              {/* Pane Bar */}
              <div className="flex items-center justify-between px-2.5 py-1 bg-[#101010] border-b border-white/10 shrink-0 select-none">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      pane.executing ? 'bg-amber-500 animate-ping' : isFocused ? 'bg-rose-600' : 'bg-white/30'
                    }`}
                  />
                  <span className="font-bold text-[10px] text-white/80 truncate">
                    {pane.title || `Pane #${index + 1}`}
                  </span>
                  {isFocused && (
                    <span className="text-[8px] bg-rose-600 text-white font-black px-1 py-0.2 tracking-wider uppercase">
                      ACTIVE
                    </span>
                  )}
                  {pane.isTailing && (
                    <span className="flex items-center gap-1 text-[8px] bg-emerald-950 text-emerald-400 border border-emerald-600/40 px-1 py-0.2 animate-pulse">
                      <RefreshCw className="w-2.5 h-2.5 animate-spin" /> TAILING
                    </span>
                  )}
                </div>

                {/* Pane Controls */}
                <div className="flex items-center gap-1">
                  {/* Tail Quick Modal Trigger */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setTailModalPaneId(pane.id);
                    }}
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] bg-white/5 hover:bg-white/15 text-white/60 hover:text-white border border-white/10 transition-colors cursor-pointer"
                    title="Tail Log or Code File"
                  >
                    <FileText className="w-2.5 h-2.5 text-amber-500" />
                    <span className="hidden sm:inline">Tail File</span>
                  </button>

                  {/* Toggle continuous tail */}
                  {pane.tailFile && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleContinuousTail(pane.id);
                      }}
                      className={`px-1.5 py-0.5 text-[9px] border transition-colors cursor-pointer ${
                        pane.isTailing
                          ? 'bg-emerald-600 text-white border-emerald-500'
                          : 'bg-white/5 text-white/60 border-white/10 hover:text-white'
                      }`}
                      title={pane.isTailing ? 'Pause Live Tail' : 'Start Live Tail'}
                    >
                      {pane.isTailing ? 'Pause' : 'Live'}
                    </button>
                  )}

                  {/* Close Pane Button */}
                  {activeTab.panes.length > 1 && (
                    <button
                      onClick={(e) => handleClosePane(pane.id, e)}
                      className="p-1 hover:bg-rose-950 hover:text-rose-400 text-white/30 transition-colors cursor-pointer ml-1"
                      title="Close Pane"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>

              {/* Pane Output Area */}
              <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5 custom-scrollbar bg-[#080808] selection:bg-rose-950 text-[10.5px]">
                {pane.lines.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">
                    {line.type === 'input' && (
                      <div className="text-white font-semibold">
                        <span className="text-rose-600 font-black">$ </span>
                        {line.text}
                      </div>
                    )}
                    {line.type === 'output' && <div className="text-white/70">{line.text}</div>}
                    {line.type === 'error' && (
                      <div className="text-rose-500 font-bold uppercase tracking-wide">{line.text}</div>
                    )}
                    {line.type === 'system' && (
                      <div className="text-white/40 italic text-[9.5px] font-sans">[ {line.text} ]</div>
                    )}
                    {line.type === 'request' && (
                      <div className="text-rose-400 border border-rose-600/20 bg-rose-600/5 p-2 rounded-none my-1 font-sans text-xs">
                        {line.text}
                      </div>
                    )}
                  </div>
                ))}

                {/* Pending Command Authorization Prompt inside Pane */}
                {pendingCommand && isFocused && (
                  <div className="border border-rose-600/40 bg-rose-950/20 p-3 rounded-none my-2 space-y-2 text-white">
                    <div className="flex items-center gap-1.5 text-rose-500 font-black text-xs uppercase tracking-wider select-none font-display">
                      <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                      <span>Permission Requested: Shell Execution</span>
                    </div>

                    <p className="text-[10px] text-white/60 font-sans select-none">
                      The AI requested to execute this script in workspace:
                    </p>

                    <pre className="p-2 bg-black border border-white/10 text-rose-300 font-mono text-[10px] overflow-x-auto whitespace-pre-wrap">
                      {pendingCommand}
                    </pre>

                    <div className="flex items-center justify-end gap-2 pt-1 select-none">
                      <button
                        onClick={onSkipPending}
                        className="px-3 py-1 border border-white/15 hover:bg-white/10 text-white/75 font-sans text-[10px] font-bold uppercase tracking-wider cursor-pointer"
                      >
                        Skip
                      </button>
                      <button
                        onClick={() => onConfirmPending(pendingCommand)}
                        className="flex items-center gap-1 px-4 py-1 bg-white hover:bg-rose-600 text-black hover:text-white font-sans text-[10px] font-black uppercase tracking-wider cursor-pointer transition-colors"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        Authorize & Execute
                      </button>
                    </div>
                  </div>
                )}

                {pane.executing && (
                  <div className="flex items-center gap-2 text-white/40 select-none py-1">
                    <span className="w-2 h-2 bg-rose-600 animate-ping inline-block rounded-full" />
                    <span className="font-mono text-[9px] uppercase tracking-widest">Executing bash process...</span>
                  </div>
                )}
              </div>

              {/* Pane Input Line */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleExecuteInPane(pane.id);
                }}
                className="flex items-center gap-2 border-t border-white/10 bg-[#080808] px-2.5 py-1.5 shrink-0 select-none"
              >
                <span className="text-rose-600 font-black text-xs select-none">$</span>
                <input
                  type="text"
                  value={pane.customCommand}
                  onChange={(e) =>
                    updatePane(pane.id, (p) => ({ ...p, customCommand: e.target.value }))
                  }
                  onFocus={() => handleSelectPane(pane.id)}
                  disabled={pane.executing}
                  placeholder={
                    pane.executing
                      ? 'Process running...'
                      : 'Type bash or CLI AI command (e.g. tell-ai, codex, tail -f log)...'
                  }
                  className="flex-1 bg-transparent text-white placeholder-white/25 focus:outline-none text-[11px] font-mono select-text"
                />
                <button
                  type="submit"
                  disabled={!pane.customCommand.trim() || pane.executing}
                  className="p-1 text-white/40 hover:text-rose-500 disabled:opacity-20 transition-colors cursor-pointer"
                  title="Execute Command"
                >
                  <CornerDownLeft className="w-3 h-3" />
                </button>
              </form>
            </div>
          );
        })}
      </div>

      {/* Tail File Config Modal */}
      {tailModalPaneId && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-[#121212] border border-rose-600/40 p-4 max-w-md w-full space-y-3 font-mono shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <div className="flex items-center gap-2 text-rose-500 font-bold uppercase tracking-wider text-xs">
                <FileText className="w-4 h-4 text-amber-500" />
                <span>Tail File Inspector</span>
              </div>
              <button
                onClick={() => setTailModalPaneId(null)}
                className="text-white/40 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-[10px] text-white/60 font-sans">
              Specify the path of the file you want to tail / view recent lines from in this pane:
            </p>

            <div className="space-y-2">
              <div>
                <label className="text-[9px] text-white/40 uppercase tracking-widest block mb-1">
                  File Path
                </label>
                <input
                  type="text"
                  value={tailFilePath}
                  onChange={(e) => setTailFilePath(e.target.value)}
                  placeholder="e.g. server.ts, package.json, src/App.tsx"
                  className="w-full bg-[#080808] border border-white/15 text-white p-2 text-xs font-mono focus:outline-none focus:border-rose-500"
                />
              </div>

              <div>
                <label className="text-[9px] text-white/40 uppercase tracking-widest block mb-1">
                  Number of Lines (-n)
                </label>
                <input
                  type="number"
                  value={tailLinesCount}
                  onChange={(e) => setTailLinesCount(Number(e.target.value))}
                  min={5}
                  max={500}
                  className="w-full bg-[#080808] border border-white/15 text-white p-2 text-xs font-mono focus:outline-none focus:border-rose-500"
                />
              </div>

              {/* Quick file chips */}
              <div className="flex items-center gap-1.5 pt-1">
                <span className="text-[9px] text-white/40">Presets:</span>
                {['server.ts', 'package.json', 'src/App.tsx', 'src/tell-ai/Tell.ts'].map((f) => (
                  <button
                    key={f}
                    onClick={() => setTailFilePath(f)}
                    className="px-1.5 py-0.5 text-[9px] bg-white/5 border border-white/10 hover:bg-white/15 text-white/70"
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
              <button
                onClick={() => setTailModalPaneId(null)}
                className="px-3 py-1.5 border border-white/15 text-white/60 hover:text-white text-xs font-sans"
              >
                Cancel
              </button>

              <button
                onClick={() => {
                  const pane = activeTab.panes.find((p) => p.id === tailModalPaneId);
                  if (pane) {
                    updatePane(pane.id, (p) => ({ ...p, tailFile: tailFilePath }));
                  }
                  handleExecuteTail(tailModalPaneId);
                }}
                className="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs uppercase tracking-wider transition-colors cursor-pointer"
              >
                Run Tail
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Classic TMUX Bottom Status Bar */}
      <div className="flex items-center justify-between px-3 py-1 bg-[#050505] border-t border-white/10 text-[9.5px] text-white/40 font-mono shrink-0 select-none">
        <div className="flex items-center gap-3">
          <span className="text-rose-500 font-bold uppercase tracking-wider">[tell-ai:tmux]</span>
          <div className="flex items-center gap-1.5 text-white/60">
            {tabs.map((tab, idx) => (
              <span
                key={tab.id}
                className={tab.id === activeTabId ? 'text-rose-400 font-bold underline' : 'text-white/30'}
              >
                {idx + 1}:{tab.name.split(':')[1] || tab.name}
                {tab.id === activeTabId ? '*' : ''}
              </span>
            ))}
          </div>
        </div>

        <div className="hidden md:flex items-center gap-3">
          <span>
            Tabs: <strong className="text-white/80">{tabs.length}/4</strong>
          </span>
          <span>
            Panes in Tab: <strong className="text-white/80">{activeTab.panes.length}/4</strong>
          </span>
          <span>CLI-AI Support: <strong className="text-rose-400">tell-ai, codex, opencode</strong></span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-white/30">CWD: /app</span>
          <span className="text-emerald-500 font-bold">• Online</span>
        </div>
      </div>
    </div>
  );
}
