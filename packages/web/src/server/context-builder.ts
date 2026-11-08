import path from 'path';
import {
  build_project_context,
  delegation_prompt_section,
  type DelegationPromptMode,
  PROJECT_TREE_MAX_DEPTH,
} from '@tell-ai/core';
import { get_system_prompt } from '@tell-ai/sdk';

// The scan (depth, caps, skip dirs, README/AGENTS lookup) is owned by
// `@tell-ai/core`; this module only composes the host system prompt on top
// of the shared context.

/**
 * Builds the host system prompt for a working directory.
 *
 * Reads the bounded context via `build_project_context` in `@tell-ai/core`
 * and wraps it with the Web sandbox headers plus the shared SDK protocol.
 *
 * @param cwd - Project root to describe.
 * @param delegation - Delegation sections to describe; omit to teach none.
 * @returns The full system prompt text.
 */
export function buildSystemPrompt(cwd: string, delegation?: DelegationPromptMode): string {
  const ctx = build_project_context(cwd);
  const sections: string[] = [];

  sections.push(`# Tell Web Sandbox — System Context

Project: ${path.basename(cwd) || cwd}
Working directory: ${ctx.cwd}
Platform: ${ctx.platform}
Generated: ${ctx.date}`);

  sections.push(`## Project structure (${PROJECT_TREE_MAX_DEPTH} levels)
${ctx.tree}`);

  if (ctx.readme) {
    sections.push(`## README
${ctx.readme}`);
  }

  if (ctx.agents) {
    sections.push(`## Project conventions (AGENTS)
${ctx.agents}`);
  }

  // Execution protocol is owned by @tell-ai/sdk (single source of truth,
  // shared with the CLI): chain mode, <RUN> tags, injection policy. The
  // delegation section is core-owned and appended after it, only when the
  // host can approve it: research is always read-only; build only where the
  // approval is automatic (server `-y`). Without task mode the tags are
  // never taught, so the run keeps the baseline prompt.
  sections.push(
    `${get_system_prompt({ chain: true, cwd: ctx.cwd, platform: ctx.platform })}${
      delegation === undefined ? '' : delegation_prompt_section(delegation)
    }`,
  );

  return sections.join('\n\n').trim();
}
