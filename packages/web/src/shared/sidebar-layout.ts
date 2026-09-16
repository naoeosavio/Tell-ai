// Pure sidebar layout helpers (no React): the sidebar stacks two panes (file
// explorer on top, settings below) and each one can collapse to its title bar.
// These helpers decide which pane absorbs the free space, whether the settings
// resize handle is usable, and at which fixed height the settings pane sits.
// Covered by tests so the "collapse one pane, the other takes the space" rule
// cannot regress silently.

/** Settings pane height bounds (px); shared by the persisted config and the layout. */
export const SETTINGS_HEIGHT_MIN_PX = 140;
export const SETTINGS_HEIGHT_MAX_PX = 900;
export const SETTINGS_HEIGHT_DEFAULT_PX = 320;

export interface SidebarPaneState {
  /** File explorer pane collapsed to its title bar. */
  isExplorerCollapsed: boolean;
  /** Settings pane collapsed to its title bar. */
  isSettingsCollapsed: boolean;
}

export interface SidebarPaneLayout {
  /** Explorer wrapper gets `flex-1` (absorbs the free sidebar height). */
  shouldGrowExplorer: boolean;
  /** Settings wrapper gets `flex-1` instead of a fixed height. */
  shouldGrowSettings: boolean;
  /** The draggable settings resizer is rendered. */
  shouldShowResizer: boolean;
  /** Fixed settings height, or null when the pane sizes itself. */
  settingsHeightPx: number | null;
}

/**
 * Clamps a persisted (or dragged) settings height into the supported range.
 *
 * @param value - Raw height, possibly missing or malformed.
 * @returns A rounded height within [140, 900]; the default when unusable.
 */
export function clampSettingsHeightPx(value: unknown): number {
  const n = typeof value === 'number' && !Number.isNaN(value) ? Math.round(value) : SETTINGS_HEIGHT_DEFAULT_PX;
  return Math.min(Math.max(n, SETTINGS_HEIGHT_MIN_PX), SETTINGS_HEIGHT_MAX_PX);
}

/**
 * Resolves the sidebar pane layout for the current collapse state.
 *
 * Invariant: the two panes never grow at the same time, and the resizer is
 * hidden exactly when the settings pane is collapsed (dragging a closed pane
 * would have no visible effect).
 *
 * @param state - Collapse state of both panes.
 * @param settingsHeightPx - Persisted settings height (used when the pane is open and not growing).
 * @returns Which pane grows, whether to render the resizer, and the fixed height.
 */
export function resolveSidebarPaneLayout(state: SidebarPaneState, settingsHeightPx: unknown): SidebarPaneLayout {
  const { isExplorerCollapsed, isSettingsCollapsed } = state;
  // Open settings + collapsed explorer is the only case where settings must
  // absorb the height the explorer gave up; otherwise it keeps its own height.
  const shouldGrowSettings = !isSettingsCollapsed && isExplorerCollapsed;
  const shouldGrowExplorer = !isExplorerCollapsed;
  const isFixedHeight = !isSettingsCollapsed && !shouldGrowSettings;
  return {
    shouldGrowExplorer,
    shouldGrowSettings,
    shouldShowResizer: !isSettingsCollapsed,
    settingsHeightPx: isFixedHeight ? clampSettingsHeightPx(settingsHeightPx) : null,
  };
}
