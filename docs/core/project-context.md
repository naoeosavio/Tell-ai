# Project context

`build_project_context(cwd)` (`src/project-context.ts`) builds the bounded server-side project context for a working directory: a directory tree plus the root README/AGENTS docs — no system prompt (the core never persists it). The Web `context-builder.ts` delegates its scan here and keeps only host-side composition; the scan caps and the `ProjectContext` shape are owned here.

```ts
import { build_project_context } from '@tell-ai/core';

const ctx = build_project_context(process.cwd());
// { cwd, platform, date, tree, readme, agents }
```

## Tree scan

* Depth: `PROJECT_TREE_MAX_DEPTH` (4; the working directory itself is 0).
* Budget: `PROJECT_TREE_MAX_FILES` (2000 entries, then a `[truncated-tree]` marker).
* Skipped: `PROJECT_SKIP_DIRS` (`node_modules`, `.git`, `dist`, `.env`, `.tell`, `.cache`, `coverage`, `.next`, `.turbo`, `.storybook`, `temp_tell_ai`, `.DS_Store`).
* Symlinks are never followed; a visited-realpath set guards against loops; unreadable directories contribute nothing. Empty projects render `(empty project)`.

## Root docs

Searched at the project root in priority order (`PROJECT_DOC_FILES`: `README.md`, `readme.md`, `README`, `AGENTS.md`, `agents.md`, `agent.md`, `CLAUDE.md`). Each doc resolves through the fail-closed `canonical_path` (symlink escapes rejected), opens with `O_NOFOLLOW`, and truncates: byte cap `PROJECT_DOC_MAX_BYTES` (64 Ki, with a `[truncated N bytes total]` marker) then char cap `PROJECT_DOC_MAX_CHARS` (6 Ki, with a `[truncated]` marker). Missing, empty or unreadable docs read as `null` — the first README-like hit fills `readme`, the first `agent*`/`claude*` hit fills `agents`.

`ProjectContext` (`{ cwd, platform, date, tree, readme, agents }`) is the shape the Web `/api/context` origin serves.

Sources: `packages/core/src/project-context.ts`, `packages/web/src/server/context-builder.ts`, `test/test-core-project-context.js`.
