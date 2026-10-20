# Fail-closed paths

`src/paths.ts` canonicalizes workspace paths through realpath and fails closed on symlinks, missing bases, sibling prefixes and external targets. Adapters adopt these helpers after they are tested here (`test/test-core-paths.js`); the CLI `mentions.ts` read gate is preserved UX, not a security proof — these helpers are the canonical check.

## `canonical_path(base_dir, candidate)`

Canonicalizes an **existing** path inside a base directory; returns the absolute realpath or `null`:

* The lexical path must stay inside `base_dir` (sibling-prefix tricks rejected).
* The base must exist and must not itself be a symlink.
* No path segment may be a symlink — a symlink inside the base pointing outside still counts as outside.
* The target must exist (missing → `null`).

Used for reads: Web file/context/session APIs, project doc lookup, exec-cwd style anchors.

## `canonical_write_path(base_dir, candidate, options?)`

Same rules, except the final segment may be missing (a new file): its parent chain must canonicalize inside the base. Missing intermediate directories still fail closed unless `create_parents: true` — past the first missing segment the walk accumulates without touching the filesystem (nothing deeper can exist), so the host can `mkdir -p` before writing. Symlinked segments are still rejected; escapes never are. A missing base or an empty final segment returns `null`.

## Lexical helpers (never authorize)

* `is_path_inside_base(base_dir, candidate)` — pure, I/O-free "is this path inside the base". Answers only to choose an error message; `true` never authorizes a read.
* `has_lexical_target(base_dir, candidate)` — "does something exist here" via `lstat`, so a host can tell an absent file (404) from an escaping symlink (403). Never authorizes a read either.

Containment is always decided by `canonical_path` (realpath); a `false` from a lexical helper must never be read as "outside", and a `true` never grants access.

Sources: `packages/core/src/paths.ts`, `test/test-core-paths.js`, `packages/web/src/server/server.ts` (file APIs), `packages/core/src/project-context.ts` (doc lookup), `packages/core/src/exec.ts` (`resolve_exec_cwd`).
