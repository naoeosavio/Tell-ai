import React, { useState } from 'react';
import { Key, Settings, Info, CheckCircle, AlertCircle, HelpCircle, FileText, ChevronDown, ChevronUp } from 'lucide-react';

interface SettingsPanelProps {
  keysStatus: {
    google: boolean;
    openai: boolean;
    anthropic: boolean;
    xai: boolean;
    deepseek: boolean;
    fireworks: boolean;
    openrouter: boolean;
  };
  models: Array<{
    alias: string;
    spec: string;
    vendor: string;
    model: string;
    thinking: string;
    fast: boolean;
  }>;
  systemPrompt: string;
  onSystemPromptChange: (newPrompt: string) => void;
  onResetSystemPrompt: () => void;
}

export default function SettingsPanel({
  keysStatus,
  models,
  systemPrompt,
  onSystemPromptChange,
  onResetSystemPrompt,
}: SettingsPanelProps) {
  const [showPromptEditor, setShowPromptEditor] = useState(false);
  const [showModelsList, setShowModelsList] = useState(false);

  return (
    <div className="flex flex-col h-full bg-slate-900 overflow-y-auto custom-scrollbar p-4 space-y-4 text-slate-300">
      {/* Title */}
      <div className="flex items-center gap-2 pb-2 border-b border-slate-800">
        <Settings className="w-4 h-4 text-sky-400" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Settings & Context</h2>
      </div>

      {/* Model Keys Status */}
      <div className="bg-slate-950 p-3 rounded-md border border-slate-800 space-y-2.5">
        <div className="flex items-center gap-1.5 font-semibold text-xs text-slate-300">
          <Key className="w-3.5 h-3.5 text-sky-400" />
          <span>Vendor Credentials Status</span>
        </div>

        <p className="text-[10px] text-slate-500 leading-normal font-sans">
          To activate additional models, provide keys in the Secrets panel inside the AI Studio UI.
        </p>

        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <div className="flex items-center justify-between p-1.5 rounded bg-slate-900 border border-slate-850">
            <span className="font-medium">Google/Gemini</span>
            {keysStatus.google ? (
              <span className="flex items-center gap-1 text-emerald-400 font-semibold text-[9px]">
                <CheckCircle className="w-3 h-3 fill-emerald-500/10" /> Active
              </span>
            ) : (
              <span className="flex items-center gap-1 text-slate-500 text-[9px]">
                <AlertCircle className="w-3 h-3" /> Missing
              </span>
            )}
          </div>

          <div className="flex items-center justify-between p-1.5 rounded bg-slate-900 border border-slate-850">
            <span className="font-medium">OpenAI</span>
            {keysStatus.openai ? (
              <span className="flex items-center gap-1 text-emerald-400 font-semibold text-[9px]">
                <CheckCircle className="w-3 h-3 fill-emerald-500/10" /> Active
              </span>
            ) : (
              <span className="flex items-center gap-1 text-slate-500 text-[9px]">
                <AlertCircle className="w-3 h-3" /> Missing
              </span>
            )}
          </div>

          <div className="flex items-center justify-between p-1.5 rounded bg-slate-900 border border-slate-850">
            <span className="font-medium">Anthropic</span>
            {keysStatus.anthropic ? (
              <span className="flex items-center gap-1 text-emerald-400 font-semibold text-[9px]">
                <CheckCircle className="w-3 h-3 fill-emerald-500/10" /> Active
              </span>
            ) : (
              <span className="flex items-center gap-1 text-slate-500 text-[9px]">
                <AlertCircle className="w-3 h-3" /> Missing
              </span>
            )}
          </div>

          <div className="flex items-center justify-between p-1.5 rounded bg-slate-900 border border-slate-850">
            <span className="font-medium">DeepSeek</span>
            {keysStatus.deepseek ? (
              <span className="flex items-center gap-1 text-emerald-400 font-semibold text-[9px]">
                <CheckCircle className="w-3 h-3 fill-emerald-500/10" /> Active
              </span>
            ) : (
              <span className="flex items-center gap-1 text-slate-500 text-[9px]">
                <AlertCircle className="w-3 h-3" /> Missing
              </span>
            )}
          </div>

          <div className="flex items-center justify-between p-1.5 rounded bg-slate-900 border border-slate-850 col-span-2">
            <span className="font-medium">xAI, Fireworks, OpenRouter</span>
            <div className="flex gap-2">
              <span className={keysStatus.xai ? "text-emerald-400 font-semibold" : "text-slate-500"}>
                xAI: {keysStatus.xai ? "●" : "○"}
              </span>
              <span className={keysStatus.fireworks ? "text-emerald-400 font-semibold" : "text-slate-500"}>
                FW: {keysStatus.fireworks ? "●" : "○"}
              </span>
              <span className={keysStatus.openrouter ? "text-emerald-400 font-semibold" : "text-slate-500"}>
                OR: {keysStatus.openrouter ? "●" : "○"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* System Prompt Customizer */}
      <div className="bg-slate-950 rounded-md border border-slate-800 overflow-hidden">
        <button
          onClick={() => setShowPromptEditor(!showPromptEditor)}
          className="w-full flex items-center justify-between p-3 text-left font-semibold text-xs text-slate-300 hover:bg-slate-900/50 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-sky-400" />
            <span>Agent System Guidelines</span>
          </div>
          {showPromptEditor ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </button>

        {showPromptEditor && (
          <div className="p-3 border-t border-slate-900 space-y-2">
            <p className="text-[10px] text-slate-500 leading-normal font-sans">
              Modify the core system prompt that commands Tell AI how to format run actions, keep answers direct, and execute scripts safely.
            </p>
            <textarea
              value={systemPrompt}
              onChange={(e) => onSystemPromptChange(e.target.value)}
              className="w-full h-48 p-2 bg-slate-900 text-slate-300 font-mono text-[10px] rounded focus:outline-none focus:ring-1 focus:ring-sky-500 resize-y leading-relaxed select-text"
            />
            <div className="flex justify-end pt-1">
              <button
                onClick={onResetSystemPrompt}
                className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded text-[10px] cursor-pointer font-semibold transition-colors"
              >
                Reset to Default
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Alias Legend / Support List */}
      <div className="bg-slate-950 rounded-md border border-slate-800 overflow-hidden">
        <button
          onClick={() => setShowModelsList(!showModelsList)}
          className="w-full flex items-center justify-between p-3 text-left font-semibold text-xs text-slate-300 hover:bg-slate-900/50 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5 text-sky-400" />
            <span>Model Alias Shortcodes ({models.length})</span>
          </div>
          {showModelsList ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </button>

        {showModelsList && (
          <div className="p-2 border-t border-slate-900 overflow-y-auto max-h-60 custom-scrollbar">
            <table className="w-full text-left text-[9px] text-slate-400">
              <thead>
                <tr className="border-b border-slate-800 text-slate-500 uppercase text-[8px] font-sans">
                  <th className="py-1 px-1.5">Alias</th>
                  <th className="py-1 px-1.5">Provider</th>
                  <th className="py-1 px-1.5">Target Model</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-900">
                {models.map((m) => (
                  <tr key={m.alias} className="hover:bg-slate-900/50">
                    <td className="py-1 px-1.5 font-mono font-bold text-sky-400">{m.alias}</td>
                    <td className="py-1 px-1.5 font-sans capitalize">{m.vendor}</td>
                    <td className="py-1 px-1.5 font-mono truncate max-w-[120px]" title={m.model}>
                      {m.model}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Quick Guide */}
      <div className="p-3.5 bg-slate-950 border border-slate-850 rounded-md space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
          <HelpCircle className="w-4 h-4 text-indigo-400" />
          <span>How to use Tell AI</span>
        </div>
        <div className="text-[10px] space-y-1.5 text-slate-400 font-sans leading-normal">
          <p>
            1. **Select a Model**: Choose from Google's Gemini, OpenAI's GPT, Anthropic's Claude, or DeepSeek from the top dropdown.
          </p>
          <p>
            2. **Type your request**: Prompt the agent to "write a greeting module", "list files", "refactor test files", or "explain what index.html is".
          </p>
          <p>
            3. **Confirm & Execute**: When Tell AI suggests running bash scripts, authorize the command, inspect/edit it, or skip it step-by-step.
          </p>
        </div>
      </div>

      {/* Footer credits */}
      <div className="pt-2 text-center text-[9px] text-slate-600 font-sans">
        <p>Tell-ai GPL-3.0 License</p>
        <p>Author: it is not savio</p>
      </div>
    </div>
  );
}
