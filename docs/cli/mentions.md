# File mentions (`@path`)

A `@path` token in the user prompt injects file content (or a directory tree) into the prompt automatically — no pasting. Implemented in `packages/cli/src/mentions.ts`, expanded once in `run_tell` (`Tell.ts:842-845`) before the prompt reaches the log, the timeline, and the saved context.

```bash
tell 'ache o memory leak em @server.ts'
tell 'liste o que ha aqui: @src'
tell --no-exec 'revise @packages/cli/src/mentions.ts'
```

## Expansion rules (`expand_mentions`, `mentions.ts:297-356`)

Tokens match `(?:^|\s)@([^\s`]+)` — the `@` must start the prompt or follow whitespace, so `user@host.com` never expands. Trailing sentence punctuation (``.,;:!?)]}``) is trimmed from the token and re-appended after the block. `\@` is a literal `@` (shielded before matching, restored after).

| Target | Injected block |
|--------|----------------|
| Regular file | `File: <token>\n```\n<content>\n``` ` |
| Directory | `Directory: <token>\n<ascii tree>` |
| Missing / unreadable / non-regular (FIFO, socket, device) | stderr warning, token passes through intact |
| Binary (NUL in the first 8 KB) | stderr warning, token passes through intact |
| Large file (> 64 KB) | first 64 KB + `[truncated]` marker |

Paths resolve against `process.cwd()`; absolute paths are accepted. Reads are bounded (fd-based, `limit + 1` bytes), so multi-GB files cost one small read. Nothing ever throws: every failure is a yellow `Warning: mention …` on stderr and the token stays in the prompt.

Directory trees go 3 levels deep (`TREE_MAX_DEPTH`), skip `node_modules`, `.git`, `dist`, `.env`, `.tell` (`SKIP_DIR_NAMES`), sort directories-first/alphabetical, cap at 200 entries per directory (`MAX_TREE_ENTRIES_PER_DIR`, overflow as `[N more entries]`), and guard symlink loops with a visited-realpath set.

## Outside-cwd gate (`is_outside_cwd`, `mentions.ts:39-58`)

A target outside the working directory needs interactive confirmation **even with `-y`** (`confirm_outside_read`, same readline/timeout pattern as `confirm_command`, 120s auto-reject). Without a TTY the read is denied (fail-closed). The check covers the lexical path and its `realpath` target, so a symlink inside the cwd pointing outside still prompts. This never conflicts with `--ctx @N`: context refs are flag values, never prompt tokens.

## Ordering

`run_tell` builds `raw_prompt` from the `--ctx` prompt text + the (already stdin-combined) user prompt, then `full_prompt = await expand_mentions(raw_prompt, process.cwd(), …)`. The expanded text is therefore what lands in `first_prompt`, `timeline[0]`, the history log, and the saved context file. Expansion applies to positional text, `-i` stdin, and multi-word `--ctx` alike. Injected file content is prompt data: only model-emitted `<RUN>` blocks are ever scanned, so a file containing `<RUN>echo PWN</RUN>` never auto-executes (test `test_cli_poisoned_file_content_does_not_execute`).

## Tests

`test/test-tell-mentions.js` (22 tests, `test:mentions`): unit layer (file/dir/missing/binary/truncation/escape/punctuation/email/tree depth + skip-list/`is_outside_cwd`/symlink-outside/FIFO) and integration layer through the `vm` sandbox (model/log/context receive the expansion, outside-cwd denied under `--yes`, poisoned content inert, stdin + `--ctx` combined, directory listing).

## Key constants (`mentions.ts:6-20`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `MAX_MENTION_BYTES` | `64 * 1024` | Injected bytes per file before `[truncated]` |
| `BINARY_PROBE_BYTES` | `8 * 1024` | Prefix scanned for NUL |
| `TREE_MAX_DEPTH` | `3` | Directory levels listed |
| `MAX_TREE_ENTRIES_PER_DIR` | `200` | Entries per dir before `[N more entries]` |
| `SKIP_DIR_NAMES` | `node_modules`, `.git`, `dist`, `.env`, `.tell` | Never descended into |
| `CONFIRM_TIMEOUT_MS` | `120_000` | Outside-cwd prompt auto-reject |

Sources: `packages/cli/src/mentions.ts`, `Tell.ts:21`, `Tell.ts:842-845`, `test/test-tell-mentions.js`.
