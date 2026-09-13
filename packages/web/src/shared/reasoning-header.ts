// Pure label helpers for the collapsible reasoning header in the chat.
// Kept free of React/DOM so the singular/plural and rounding rules are
// pinned by tests.

/** Live counter while the model is still thinking: "3s", "0s". */
export function format_reasoning_elapsed(elapsedMs: number): string {
  return `${Math.max(0, Math.floor(elapsedMs / 1000))}s`;
}

/** Frozen label once reasoning ends: "Thought for 4 seconds", "Thought for 1 second". */
export function format_reasoning_duration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  return `Thought for ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/** Header open state: an explicit per-message override wins over the saved default. */
export function resolve_reasoning_open(override: boolean | undefined, defaultOpen: boolean): boolean {
  return override ?? defaultOpen;
}
