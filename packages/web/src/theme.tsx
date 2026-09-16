import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { clampSettingsHeightPx } from './shared/sidebar-layout.ts';
import { clampTerminalWidthCh } from './shared/terminal-layout.ts';

export type ThemeMode = 'dark' | 'light';
export type AccentPalette = 'rose' | 'blue' | 'emerald' | 'amber' | 'violet' | 'cyan';
export type FontChoice = 'Inter' | 'Space Grotesk' | 'JetBrains Mono' | 'Custom';
export type ScaleLevel = 0.85 | 0.92 | 1.0 | 1.08 | 1.15;
export type LayoutMode = 'default' | 'focused' | 'custom';
export type SidebarSide = 'left' | 'right';
export type TerminalPlacement = 'left' | 'right' | 'top' | 'bottom' | 'hidden';
export type AgentFeedPlacement = 'top' | 'bottom' | 'left' | 'right';
export type ChatThreadsSide = 'left' | 'right' | 'top' | 'bottom';
export type ChatWrap = number | 'max';

export interface CustomFonts {
  sans: string;
  display: string;
  mono: string;
}

export interface ThemeConfig {
  mode: ThemeMode;
  accent: AccentPalette;
  fontSans: FontChoice;
  fontDisplay: FontChoice;
  fontMono: FontChoice;
  scale: ScaleLevel;
  layout: LayoutMode;
  settingsHeight: number;
  terminalHeight: number;
  terminalWidth: number;
  terminalWidthCh: number;
  sidebarCollapsed: boolean;
  threadsCollapsed: boolean;
  /** File explorer pane collapsed to its title bar (independent of `sidebarCollapsed`). */
  explorerCollapsed: boolean;
  /** Settings pane collapsed to its title bar (independent of `sidebarCollapsed`). */
  settingsCollapsed: boolean;
  customSidebarSide: SidebarSide;
  customTerminal: TerminalPlacement;
  customAgentFeed: AgentFeedPlacement;
  customChatThreadsSide: ChatThreadsSide;
  customChatWrap: ChatWrap;
  customFonts: CustomFonts;
}

const STORAGE_KEY = 'theme-config-v3';

const DEFAULT_CUSTOM_FONTS: CustomFonts = {
  sans: 'Inter',
  display: 'Space Grotesk',
  mono: 'JetBrains Mono',
};

const DEFAULT_THEME: ThemeConfig = {
  mode: 'dark',
  accent: 'rose',
  fontSans: 'Inter',
  fontDisplay: 'Space Grotesk',
  fontMono: 'JetBrains Mono',
  scale: 1.0,
  layout: 'default',
  settingsHeight: 320,
  terminalHeight: 280,
  terminalWidth: 420,
  terminalWidthCh: 80,
  sidebarCollapsed: false,
  threadsCollapsed: false,
  explorerCollapsed: false,
  settingsCollapsed: false,
  customSidebarSide: 'right',
  customTerminal: 'bottom',
  customAgentFeed: 'bottom',
  customChatThreadsSide: 'left',
  customChatWrap: 80,
  customFonts: DEFAULT_CUSTOM_FONTS,
};

// Single source of truth for accent tokens (per mode). applyConfigToRoot writes
// these to inline root vars, which override the :root fallbacks in index.css.
const ACCENT_COLORS: Record<
  AccentPalette,
  { primary: string; hover: string; subtle: Record<ThemeMode, string>; text: Record<ThemeMode, string> }
> = {
  rose: {
    primary: '#E11D48',
    hover: '#F43F5E',
    subtle: { dark: '#4C0519', light: '#FDE7EC' },
    text: { dark: '#FB7185', light: '#BE123C' },
  },
  blue: {
    primary: '#2563EB',
    hover: '#3B82F6',
    subtle: { dark: '#1E3A5F', light: '#DBEAFE' },
    text: { dark: '#60A5FA', light: '#1D4ED8' },
  },
  emerald: {
    primary: '#059669',
    hover: '#10B981',
    subtle: { dark: '#064E3B', light: '#D1FAE5' },
    text: { dark: '#34D399', light: '#047857' },
  },
  amber: {
    primary: '#D97706',
    hover: '#F59E0B',
    subtle: { dark: '#78350F', light: '#FEF3C7' },
    text: { dark: '#FBBF24', light: '#B45309' },
  },
  violet: {
    primary: '#7C3AED',
    hover: '#8B5CF6',
    subtle: { dark: '#4C1D95', light: '#EDE9FE' },
    text: { dark: '#A78BFA', light: '#6D28D9' },
  },
  cyan: {
    primary: '#0891B2',
    hover: '#06B6D4',
    subtle: { dark: '#164E63', light: '#CFFAFE' },
    text: { dark: '#22D3EE', light: '#0E7490' },
  },
};

const DARK_VARS: Record<string, string> = {
  '--color-bg-primary': '#0A0A0A',
  '--color-bg-secondary': '#121212',
  '--color-bg-tertiary': '#080808',
  '--color-bg-elevated': '#141414',
  '--color-bg-input': '#0D0D0D',
  '--color-text-primary': '#F5F5F5',
  '--color-text-secondary': 'rgba(255,255,255,0.6)',
  '--color-text-muted': 'rgba(255,255,255,0.35)',
  '--color-border-subtle': 'rgba(255,255,255,0.08)',
  '--color-border-medium': 'rgba(255,255,255,0.15)',
  '--color-border-strong': 'rgba(255,255,255,0.25)',
  '--color-success': '#10B981',
  '--color-error': '#EF4444',
  '--color-scrollbar-track': 'rgba(255,255,255,0.03)',
  '--color-scrollbar-thumb': 'rgba(255,255,255,0.15)',
};

const LIGHT_VARS: Record<string, string> = {
  '--color-bg-primary': '#FFFFFF',
  '--color-bg-secondary': '#F5F5F5',
  '--color-bg-tertiary': '#E5E5E5',
  '--color-bg-elevated': '#FAFAFA',
  '--color-bg-input': '#F0F0F0',
  '--color-text-primary': '#0A0A0A',
  '--color-text-secondary': 'rgba(0,0,0,0.6)',
  '--color-text-muted': 'rgba(0,0,0,0.35)',
  '--color-border-subtle': 'rgba(0,0,0,0.08)',
  '--color-border-medium': 'rgba(0,0,0,0.15)',
  '--color-border-strong': 'rgba(0,0,0,0.25)',
  '--color-success': '#059669',
  '--color-error': '#DC2626',
  '--color-scrollbar-track': 'rgba(0,0,0,0.03)',
  '--color-scrollbar-thumb': 'rgba(0,0,0,0.15)',
};

const FONT_CHOICES: FontChoice[] = ['Inter', 'Space Grotesk', 'JetBrains Mono', 'Custom'];

export function getFontFamily(name: FontChoice, custom?: string): string {
  if (name === 'Custom') {
    return custom?.trim() ? `"${sanitizeFontFamily(custom)}", system-ui, sans-serif` : '"Inter", system-ui, sans-serif';
  }
  switch (name) {
    case 'Inter':
      return '"Inter", system-ui, sans-serif';
    case 'Space Grotesk':
      return '"Space Grotesk", system-ui, sans-serif';
    case 'JetBrains Mono':
      return '"JetBrains Mono", monospace';
  }
}

function sanitizeFontFamily(raw: string): string {
  return raw
    .replace(/["'\\`{};<>]/g, '')
    .trim()
    .slice(0, 120);
}

function sanitizeCustomFontValue(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const v = sanitizeFontFamily(raw);
  return v || fallback;
}

interface ThemeContextValue {
  config: ThemeConfig;
  setMode: (m: ThemeMode) => void;
  setAccent: (a: AccentPalette) => void;
  setFontSans: (f: FontChoice) => void;
  setFontDisplay: (f: FontChoice) => void;
  setFontMono: (f: FontChoice) => void;
  setScale: (s: ScaleLevel) => void;
  setLayout: (l: LayoutMode) => void;
  setSettingsHeight: (h: number) => void;
  setTerminalHeight: (h: number) => void;
  setTerminalWidth: (w: number) => void;
  setTerminalWidthCh: (w: number) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setThreadsCollapsed: (v: boolean) => void;
  setExplorerCollapsed: (v: boolean) => void;
  setSettingsCollapsed: (v: boolean) => void;
  setCustomSidebarSide: (v: SidebarSide) => void;
  setCustomTerminal: (v: TerminalPlacement) => void;
  setCustomAgentFeed: (v: AgentFeedPlacement) => void;
  setCustomChatThreadsSide: (v: ChatThreadsSide) => void;
  setCustomChatWrap: (v: ChatWrap) => void;
  setCustomFont: (slot: keyof CustomFonts, value: string) => void;
  resetTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  config: DEFAULT_THEME,
  setMode: () => {},
  setAccent: () => {},
  setFontSans: () => {},
  setFontDisplay: () => {},
  setFontMono: () => {},
  setScale: () => {},
  setLayout: () => {},
  setSettingsHeight: () => {},
  setTerminalHeight: () => {},
  setTerminalWidth: () => {},
  setTerminalWidthCh: () => {},
  setSidebarCollapsed: () => {},
  setThreadsCollapsed: () => {},
  setExplorerCollapsed: () => {},
  setSettingsCollapsed: () => {},
  setCustomSidebarSide: () => {},
  setCustomTerminal: () => {},
  setCustomAgentFeed: () => {},
  setCustomChatThreadsSide: () => {},
  setCustomChatWrap: () => {},
  setCustomFont: () => {},
  resetTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function xtermThemeFromConfig(config: ThemeConfig) {
  const accent = ACCENT_COLORS[config.accent] || ACCENT_COLORS.rose;
  if (config.mode === 'light') {
    return {
      background: '#F5F5F5',
      foreground: '#1A1A1A',
      cursor: accent.primary,
      cursorAccent: '#FFFFFF',
      selectionBackground: accent.subtle.light,
      black: '#000000',
      red: accent.primary,
      green: '#059669',
      yellow: '#D97706',
      blue: '#2563EB',
      magenta: '#7C3AED',
      cyan: '#0891B2',
      white: '#1A1A1A',
    };
  }
  return {
    background: '#080808',
    foreground: '#e5e5e5',
    cursor: accent.primary,
    cursorAccent: '#000000',
    selectionBackground: accent.subtle.dark,
    black: '#000000',
    red: accent.primary,
    green: '#10B981',
    yellow: '#FBBF24',
    blue: '#3B82F6',
    magenta: '#D946EF',
    cyan: '#22D3EE',
    white: '#e5e5e5',
  };
}

function normalizeConfig(raw: any): ThemeConfig {
  const c: ThemeConfig = { ...DEFAULT_THEME, customFonts: { ...DEFAULT_CUSTOM_FONTS } };
  if (raw && typeof raw === 'object') {
    if (raw.mode === 'dark' || raw.mode === 'light') c.mode = raw.mode;
    if (ACCENT_COLORS[raw.accent as AccentPalette]) c.accent = raw.accent as AccentPalette;
    if (FONT_CHOICES.includes(raw.fontSans)) c.fontSans = raw.fontSans;
    if (FONT_CHOICES.includes(raw.fontDisplay)) c.fontDisplay = raw.fontDisplay;
    if (FONT_CHOICES.includes(raw.fontMono)) c.fontMono = raw.fontMono;
    if ([0.85, 0.92, 1.0, 1.08, 1.15].includes(raw.scale)) c.scale = raw.scale;
    if (['default', 'focused', 'custom'].includes(raw.layout)) c.layout = raw.layout;
    if (typeof raw.settingsHeight === 'number' && !Number.isNaN(raw.settingsHeight)) {
      c.settingsHeight = clampSettingsHeightPx(raw.settingsHeight);
    }
    if (typeof raw.terminalHeight === 'number' && !Number.isNaN(raw.terminalHeight)) {
      c.terminalHeight = Math.min(Math.max(raw.terminalHeight, 120), 1200);
    }
    if (typeof raw.terminalWidth === 'number' && !Number.isNaN(raw.terminalWidth)) {
      c.terminalWidth = Math.min(Math.max(raw.terminalWidth, 240), 1200);
    }
    if (typeof raw.terminalWidthCh === 'number' && !Number.isNaN(raw.terminalWidthCh)) {
      c.terminalWidthCh = clampTerminalWidthCh(raw.terminalWidthCh);
    } else if (
      typeof raw.terminalWidth === 'number' &&
      !Number.isNaN(raw.terminalWidth) &&
      raw.terminalWidthCh === undefined
    ) {
      // Migrate legacy px width to char width (JetBrains Mono ~7px per char at 12px)
      c.terminalWidthCh = clampTerminalWidthCh(raw.terminalWidth / 7);
    }
    if (typeof raw.sidebarCollapsed === 'boolean') c.sidebarCollapsed = raw.sidebarCollapsed;
    if (typeof raw.threadsCollapsed === 'boolean') c.threadsCollapsed = raw.threadsCollapsed;
    if (typeof raw.explorerCollapsed === 'boolean') c.explorerCollapsed = raw.explorerCollapsed;
    if (typeof raw.settingsCollapsed === 'boolean') c.settingsCollapsed = raw.settingsCollapsed;
    if (raw.customSidebarSide === 'left' || raw.customSidebarSide === 'right')
      c.customSidebarSide = raw.customSidebarSide;
    if (['top', 'bottom', 'left', 'right', 'hidden'].includes(raw.customTerminal))
      c.customTerminal = raw.customTerminal;
    if (['top', 'bottom', 'left', 'right'].includes(raw.customAgentFeed)) c.customAgentFeed = raw.customAgentFeed;
    if (['top', 'bottom', 'left', 'right'].includes(raw.customChatThreadsSide))
      c.customChatThreadsSide = raw.customChatThreadsSide;
    if (raw.customChatWrap === 'max') {
      c.customChatWrap = 'max';
    } else if (typeof raw.customChatWrap === 'number' && !Number.isNaN(raw.customChatWrap)) {
      c.customChatWrap = Math.min(Math.max(Math.round(raw.customChatWrap), 60), 200);
    }
    if (raw.customFonts && typeof raw.customFonts === 'object') {
      c.customFonts.sans = sanitizeCustomFontValue(raw.customFonts.sans, DEFAULT_CUSTOM_FONTS.sans);
      c.customFonts.display = sanitizeCustomFontValue(raw.customFonts.display, DEFAULT_CUSTOM_FONTS.display);
      c.customFonts.mono = sanitizeCustomFontValue(raw.customFonts.mono, DEFAULT_CUSTOM_FONTS.mono);
    }
  }
  return c;
}

function loadConfig(): ThemeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return normalizeConfig(parsed);
    }
  } catch {}
  return DEFAULT_THEME;
}

function saveConfig(config: ThemeConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {}
}

function applyConfigToRoot(config: ThemeConfig) {
  try {
    const root = document.documentElement;
    const modeVars = (config.mode === 'light' ? LIGHT_VARS : DARK_VARS) || DARK_VARS;
    const accent = ACCENT_COLORS[config.accent] || ACCENT_COLORS.rose;

    for (const [key, value] of Object.entries(modeVars)) {
      root.style.setProperty(key, value);
    }

    root.style.setProperty('--color-accent', accent.primary);
    root.style.setProperty('--color-accent-hover', accent.hover);
    root.style.setProperty('--color-accent-subtle', accent.subtle[config.mode]);
    root.style.setProperty('--color-accent-text', accent.text[config.mode]);

    root.style.setProperty('--font-sans', getFontFamily(config.fontSans, config.customFonts.sans));
    root.style.setProperty('--font-display', getFontFamily(config.fontDisplay, config.customFonts.display));
    root.style.setProperty('--font-mono', getFontFamily(config.fontMono, config.customFonts.mono));

    root.style.setProperty('--ui-scale', String(config.scale));

    root.setAttribute('data-theme', config.mode);
    root.style.colorScheme = config.mode;
  } catch (err) {
    console.error('[theme] failed to apply theme to root:', err);
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<ThemeConfig>(loadConfig);

  useEffect(() => {
    applyConfigToRoot(config);
    saveConfig(config);
  }, [config]);

  const update = useCallback((partial: Partial<ThemeConfig>) => {
    setConfig((prev) => ({ ...prev, ...partial }));
  }, []);

  const ctx: ThemeContextValue = React.useMemo(
    () => ({
      config,
      setMode: (mode) => update({ mode }),
      setAccent: (accent) => update({ accent }),
      setFontSans: (fontSans) => update({ fontSans }),
      setFontDisplay: (fontDisplay) => update({ fontDisplay }),
      setFontMono: (fontMono) => update({ fontMono }),
      setScale: (scale) => update({ scale }),
      setLayout: (layout) => update({ layout }),
      setSettingsHeight: (settingsHeight) => update({ settingsHeight }),
      setTerminalHeight: (terminalHeight) => update({ terminalHeight }),
      setTerminalWidth: (terminalWidth) => update({ terminalWidth }),
      setTerminalWidthCh: (terminalWidthCh) => update({ terminalWidthCh: clampTerminalWidthCh(terminalWidthCh) }),
      setSidebarCollapsed: (sidebarCollapsed) => update({ sidebarCollapsed }),
      setThreadsCollapsed: (threadsCollapsed) => update({ threadsCollapsed }),
      setExplorerCollapsed: (explorerCollapsed) => update({ explorerCollapsed }),
      setSettingsCollapsed: (settingsCollapsed) => update({ settingsCollapsed }),
      setCustomSidebarSide: (customSidebarSide) => update({ customSidebarSide }),
      setCustomTerminal: (customTerminal) => update({ customTerminal }),
      setCustomAgentFeed: (customAgentFeed) => update({ customAgentFeed }),
      setCustomChatThreadsSide: (customChatThreadsSide) => update({ customChatThreadsSide }),
      setCustomChatWrap: (customChatWrap) => update({ customChatWrap }),
      setCustomFont: (slot, value) =>
        setConfig((prev) => ({ ...prev, customFonts: { ...prev.customFonts, [slot]: sanitizeFontFamily(value) } })),
      resetTheme: () => setConfig({ ...DEFAULT_THEME, customFonts: { ...DEFAULT_CUSTOM_FONTS } }),
    }),
    [config, update],
  );

  return <ThemeContext.Provider value={ctx}>{children}</ThemeContext.Provider>;
}
