# Changelog

## v0.6.0 — 2026-10-01

### Breaking changes
- `--ctx` re-grammar: the **first word** of the value is the ref, and only `@N` (recency) / `%id` (use-or-create) open one. The old bare-name form is gone — `--ctx myproj "prompt"` now fails with `Invalid context reference "myproj" — naming a context requires %: use --ctx %<id>`; write `--ctx %myproj "prompt"`. The `#hash` prefix is gone too (`%<hex>` resumes a hash-named context, e.g. `%a1b2c3`). `-n` requires `%id` (`--ctx %id -n`).
- A lone bare `--ctx` token (`--ctx ola`) is now **prompt text for the default context**, not a context name; it is only rejected when a positional prompt is also present. This retires the old "a lone single token is a NAME, never a prompt" rule — one-word prompts no longer need `-c` or a multi-word value.

### Features
- `--ctx @N <words>` / `--ctx %id <words>`: text after the ref is the prompt for the addressed context. Refs are consumed before `expand_mentions`, so `@N` no longer triggers a false `mention "@0" not found` warning while real `@path` mentions in the remaining text still expand. The `--ctx` prompt text is prepended for `existing`/`create` plans too (not only `default`); `plan_prompt_from_ref` centralizes the extraction.
- `%id` is use-or-create over the single id namespace (= context file names): an exact id or a unique hex prefix resumes, no match creates `<id>.txt`. Only `@<digits>` opens a ref, so a leading `@file` in `--ctx` stays prompt text (`--ctx "@a.ts explain"` expands the mention as usual).
- `-l` is now `--history` (replacing `-l/--list`, which listed contexts only): one lister for contexts **and** conversations. Bare `tell -l` prints two tables — `Contexts:` (`@N | id | age | preview`) and `Conversations:` (`#N | date | model | preview`, parsed from `~/.ai/tell_history/conversation_*.txt`, newest first). `tell --history @N` reprints a context in full (the same file `--ctx @N` addresses); `--history #N` reprints a conversation log; any other value searches both stores case-insensitively, printing `@N`/`#N` rows with the matched line (highlighted on TTY) that can be reopened by the same ref. `#N` inside `--history` is always a conversation; `#hash`-prefix refs stay exclusive to `--ctx`. The flag needs no prompt, no API key and no network; search failures/misses map to exit codes (empty term → hint + exit 0, no match → exit 1, invalid `@N`/`#N` → error naming the namespace total). New read-only module `packages/cli/src/history.ts` (`list_sessions`, `search_contexts`, `search_sessions`, `print_history_list`, `print_search_results`, `show_entry`); `Tell.ts` injects the existing `ContextEntry[]` so context indexing stays single-sourced. Context previews now show the actual first prompt text (previous `context_preview` read the bare `User:` marker line and printed an empty preview).
- Conversation refs in `--history` use `%N` instead of `#N`: `#` starts a shell comment, so the old form required quotes (`-l %5` works unquoted in bash/zsh). `@N` stays for contexts; `#hash`-prefix refs remain exclusive to `--ctx`.
- `tell --history` hardening (audit round): entry echo (cat, listing, search) strips ANSI/control characters — conversation logs replay raw command stdout/stderr, so a poisoned log could otherwise spoof the terminal or write to the clipboard via OSC 52; the 8-bit C1 range (`U+0080`–`U+009F`) is stripped too, since some terminals read `U+009B`/`U+009D` as CSI/OSC; files that vanish between `readdir` and `stat` (dangling symlinks, concurrent removal) are skipped instead of crashing with ENOENT (both `--history` stores and `list_context_entries`); listing order is stable on equal mtimes (name tie-break, keeping the `--history @N` == `--ctx @N` invariant); `~/.ai/tell_history`/`~/.ai/tell_context` dirs are `0700` and files `0600` (they contain command output and prompts), repaired on every write so legacy world-readable stores are tightened too; non-ISO session filenames fall back to `(unknown date)`.
- Outside-cwd command gate: with `-y`, any command referencing a path that resolves outside the working directory now requires confirmation — reads included, mirroring the `@path` mention gate. Path tokens (absolute, `~/`, `$HOME`, `../`, `./`, bare `..`/`~`, after `=`, quoted) resolve through `is_outside_cwd` from `mentions.ts` (lexical + symlink/realpath); when cwd IS `$HOME`, `~/x` stays allowed. Non-TTY rejects (fail-closed). New label: `Command touches paths outside the working directory`.
- New `--require-approval` flag: makes the Require Approval posture explicit in the CLI, mirroring the Tell Web toggle. Combined with `-y` the behavior is unchanged (safe commands auto-run, high-risk still asks); alone every command asks, same as the default. The flag never weakens the high-risk gate and is forwarded by `-w`/`--web` to `tell-web` (seed for the sandbox toggle).
- New `--stream` flag: print the answer token by token as the model generates it, using `AskInstance.ask_stream` from `@tell-ai/sdk`. The full response is still accumulated for `<RUN>` extraction, logging and context — streaming only changes *when* the text appears. Each `--chain` round streams too.
- New `--think` flag: show the model reasoning dimmed on stderr. Works with `--stream` (reasoning prints live as it is generated) and without it (printed once the response arrives). Reasoning never reaches stdout and never enters the saved context.
- Without `--think`, a live `Thinking...` indicator is shown until the first answer token (streaming) or the response arrives (non-streaming).
- Both flags pass through `-w`/`--web` to `tell-web` (`--stream`/`--think`).
- New `@path` file mentions: any `@file`/`@dir` token in the prompt is expanded by `expand_mentions` (`src/mentions.ts`) before the model call — files inline as `File:` blocks (64 KB cap with `[truncated]`), directories as 3-level trees (skipping `node_modules`, `.git`, `dist`, `.env`, `.tell`). Applies to positional text, `-i` stdin, and multi-word `--ctx` alike; the expanded text is what reaches the log and the saved context. Missing/binary/unreadable targets warn on stderr and pass through intact (`\@` is literal). Targets outside the cwd need interactive confirmation even with `-y` (denied without a TTY). No conflict with `--ctx @N`: context refs are flag values, never prompt tokens.
- `MODELS` targets the current catalog: GPT-6.1 Sol/Sol Pro, GPT-6 Astra/Astra Pro, Claude Sonnet/Opus/Fable/Haiku, Gemini 3.1 Pro and Qwen3.8 27B/Flash. Total: 142 aliases.
- Direct Meta and Xiaomi vendors are available through `META_API_KEY`/`MIMO_API_KEY` with their base URL overrides and vendor-specific auth.

### Security
- Context labels are echoed through `sanitize_label` (from `history.ts`): `Using context:` / `Created context:` and the ambiguous-`%<hex>` id list strip ANSI/OSC/C1 controls and newlines. A context file name planted in `~/.ai/tell_context/` (any local process can write there) can no longer spoof the terminal or forge extra stderr lines — the same hardening `--history` already applied to stored text. Pinned by `test_ctx_echo_strips_control_chars_from_file_names`.
- Model-generated commands receive a scrubbed environment without provider keys, `TELL_TOKEN`, package tokens, credential/loader variables, `SSH_AUTH_SOCK`, or `NODE_OPTIONS`-style injection. The CLI also removes matching credentials from its own `process.env` after constructing the provider, before the first model call.
- High-risk detection now covers absolute executable paths (`/usr/bin/curl`, `/bin/bash -c`), every `/proc` reference (including `p=/proc; …`), network clients, `printenv`, uppercase `rm -R` flags, and long `git clean --force` options.
- The outside-cwd confirmation gate expands `${PWD}`/`$PWD`, rejects shell parameter-default forms such as `${PWD:-/etc}` in auto mode, and resolves simple file-command arguments through `realpath`, so a workspace symlink such as `cat outside-link` can no longer bypass confirmation with `-y`.
- Provider reasoning is neutralized before it can forge `<think>`/`<RUN>` delimiters, in both streaming and non-streaming responses.

### Fixes
- A model response can now yield at most one executable `<RUN>` block; previously multiple blocks in one answer were all run.

### Refactors
- `ConversationState` now carries a single `execMode: 'no-exec' | 'confirm-all' | 'auto-risk'` (resolved once in `run_tell`) instead of the scattered `execEnabled`/`yes` pair; `confirm_command`, `run_script` and `run_scripts` take the mode.

### Tests
- `test/test-tell-context.js` (42 tests total): bare-name cases migrated to `%name` plus new grammar-table coverage — `@N`/`%id` + prompt text addresses and writes that context (never the default hash file), `@0 fix the bug` emits no mention warning, `%<hex>` unique-prefix resume and no-match create, lone bare token as default-context prompt (`--ctx ola`, `--ctx ola --stream`), bare token + positional → error, `%id` + positional valid, `--ctx ola -n` → error, and context label/id echo strips ANSI/OSC/C1/newline (`test_ctx_echo_strips_control_chars_from_file_names`). The suite mock now also provides `ask_stream` so `--stream` flags are exercised there.
- The same suite covers `--history`: combined listing shows the `Contexts:` section plus a `Conversations:` section (`%N | date | model | preview`); `--history @N` / `--history %N` reprint a context/conversation in full; a term search returns `@N context` + `%N conversation` rows whose refs reopen the entry; invalid `@N`/`%N` error with the namespace total (exit 1); empty term exits 0, no-match exits 1. Hardening cases: dangling symlink in a store is skipped without crashing; echoed entries/search snippets strip ANSI/control bytes (OSC/CSI/DEL poison probe); C1 controls (`U+0080`–`U+009F`) are stripped from cat and search output; equal-mtime order is stable across calls; fresh stores are private (0700 dirs, 0600 files); a pre-existing `0755`/`0644` store is tightened on the next write; malformed session names fall back to `(unknown date)`; standalone unit check of `print_search_results` on empty/basic input. The existing listing test asserts the `Contexts:` section survives the merge. All four CLI harnesses (`security`/`context`/`stream`/`mentions`) compile `./history` into the vm sandbox alongside `./mentions`.
- Security regressions capture the child-process environment and assert credential/loader variables are absent while ordinary values remain; cover absolute network/shell forms, `/proc` aliasing, `rm -R`, `git clean --force`, `${PWD}` traversal/default expansion, symlink file arguments, reasoning-forged `<RUN>` tags, and the one-block limit. Streaming gains a split-delta reasoning injection regression.
- Extend `test/test-tell-security.js`: outside-cwd gate — `-y` + `cat ~/.ssh/id_rsa`, `rm ../outside-file`, `cat /etc/os-release`, `grep /var/log/…`, `$HOME` paths, `--output=/tmp/…`, `cd ..`, `-C /` are all skipped without a TTY; inside-cwd paths (`ls -la`, `cat ./local.txt`, `./a/../local.txt`, quoted redirects, `cd .`) still execute. `--require-approval` without `-y` skips even safe commands in non-TTY (fail-closed); `-y --require-approval` executes safe commands and still skips high-risk ones; `--no-exec` beats both; `-w` forwards `--require-approval` to the child and omits it when not requested. New high-risk cases: non-recursive `chmod`/`chown` on privileged paths.
- Add `test/test-tell-stream.js` (wired as `test:stream`, part of `npm test`): a sandboxed CLI harness with a mocked SDK `ask_stream` covering progressive stdout writes (single trailing newline, no duplicate final print), `--think` stderr reasoning visibility, byte-identical log/context contents vs the non-stream path, `RUN` command detection + `-y` execution, and per-round streaming in `--chain`.
- Add `test/test-tell-mentions.js` (wired as `test:mentions`, part of `npm test`): 22 tests over `src/mentions.ts` — unit layer (file/dir/missing/binary/truncation/escape/trailing-punctuation/email/tree depth + skip-list, `is_outside_cwd` lexical + symlink-outside cases, FIFO refusal) and `vm`-sandbox integration (expanded prompt reaches model/log/saved context, outside-cwd denied under `--yes`, poisoned `<RUN>` file content never executes, stdin + `--ctx` combined). Existing `test-tell-security/context/stream.js` harnesses compile `./mentions` into the sandbox so it binds to the faked process per test.

### Documentation
- `docs/cli/context.md` rewritten for the new grammar (break note, `ContextPlan`, ref/prompt rules, `%<hash>` addressing the default file); `docs/cli/cli-reference.md`, `docs/usage.md`, `docs/cli/input-logging.md` and `docs/cli/history.md` updated; test counts refreshed in `docs/cli/development.md`/`docs/cli/security.md`; root `AGENTS.md` `--ctx` convention updated.
- `docs/cli/env-config.md` gains the `meta`/`xiaomi` key + token rows and their base-URL entries, including the note that Xiaomi authenticates with an `api-key` header (not a bearer) and that Meta calls the Responses API. `docs/usage.md`'s alias table is regenerated from `tell -m --help` (142 aliases) instead of drifting from `MODELS`.
- New `docs/cli/history.md` reference (`-l/--history` grammar, `@N`/`%N` invariant, exit codes); `docs/cli/cli-reference.md`, `docs/cli/context.md`, `docs/cli/overview.md`, `docs/cli/input-logging.md` and `docs/cli/README.md` updated to drop `-l, --list` and point at the history page; `docs/cli/development.md`/`docs/cli/security.md` test counts refreshed.
- New `docs/cli/mentions.md` reference (rules, outside-cwd gate, ordering, constants) indexed in `docs/cli/README.md`; `@path` covered in `docs/cli/cli-reference.md`, `docs/usage.md`, `packages/cli/README.md`, and the read-gate in `docs/cli/security.md`.

### Chores
- Remove the Fireworks AI integration and update the default SDK vendor base URLs.

---

## v0.5.2 — 2026-09-08

### Features

- Add Alibaba API key support to environment configuration loading
- Add `-w`/`--web` mode to launch the interactive Tell Web sandbox (`tell-web`): spawns the server with the selected model (`-m`), `--cwd` working directory (created with a warning when missing), `--prompt` pre-seed and `--no-exec`/`--chain`/`-y` passthrough; propagates the sandbox exit code and explains how to install `@tell-ai/web` when the binary is missing
### Fixes

- Tighten shell risk detection and expand coverage for remote execution vectors and piped downloads
- Reduce accumulated context threshold to optimize LLM window limits
- Defer model label resolution for graceful configuration error reporting
- Catch top-level errors to ensure formatted error messages and non-zero exit codes

---

## v0.5.1 — 2026-08-15

### Features
- Add Z.ai model provider and GLM-5.3 support with OpenAI-compatible adapter
- Introduce browser-safe bundles and MIT license support in SDK
- Add custom base URLs and `tell` function for one-shot assistant calls
- Add addressable, named, and use-or-create context options in CLI
- Initialize core tell-ai terminal assistant CLI package and persistence

### Refactors
- Streamline context flags, addressing syntax, and unify `--ctx` usage
- Extract system prompt generation logic into SDK and dedicated modules
- Improve model spec detection and context argument handling in CLI
- Migrate CLI package to ESM modules and update workspace metadata

### Documentation
- Structure project README and add dedicated package readmes

### Chores
- Update project license, changelogs, and SDK versions across the monorepo

---

## v0.5.0 — 2026-08-05

### Features
- Split the codebase into a bun workspaces monorepo; `tell-ai` is now the CLI package (0.5.0), with model resolution, tag handling and summarization moved into the new `@tell-ai/sdk` library.
- Environment resolution (env vars + `~/.config/<vendor>.token` fallback) now lives exclusively in the CLI (`packages/cli/src/env.ts`), which assembles the `SDKConfig` for `create_ask_ai(spec, config)`.

### Refactors
- `tell_silently` now delegates to the SDK `tell()` (with `ask` + `raw`), making `tell()` the single implementation of "call the model with the tell system prompt" shared by CLI and web.
- `packages/cli/src/systemPrompt.ts` is now a thin wrapper around the SDK prompt, passing `process.cwd()` and platform info; CLI behavior unchanged.
- CLI package builds to a minified CJS bundle (`dist/Tell.js`, `#!/usr/bin/env node`) with `commander`; the SDK builds to ESM + CJS + declarations via tsup.
- Extracted the strict TypeScript configuration into `tsconfig.base.json`, extended by both packages.
- Root package is now a private workspace that orchestrates everything with `bun run --filter`.
- Removed `gpt-tokenizer` usage and the stale root `src/` layout (`src/ai`, `src/config`, `src/summarize.ts`, `src/Tell.ts`).

### Tests
- Security test suite now transpiles `packages/cli/src/Tell.ts` and mocks `@tell-ai/sdk` from the real built SDK (tag functions are exercised for real), depending on the SDK build step.

### Documentation
- Updated `AGENTS.md` to describe the monorepo architecture, package boundaries, and injected-config design.

---

## v0.4.2 — 2026-07-25

### Features
- Include reasoning text in AI responses, wrapping reasoning steps in ` thinking` tags when present.
- Expand context buffer capacity to 256 MiB and filter internal reasoning blocks (` thinking` tags) from conversation history.
- Implement incremental context saving to persist state during long-running conversation loops, with periodic file writes.
- Replace naive context truncation with AI-driven summarization when conversation history exceeds token limits, preserving critical information with fallback to truncation.

### Fixes
- Allow flexible model identifier resolution for custom thinking budgets and unknown vendors, falling back to single-part resolution when vendor is unrecognized.

### Refactors
- Update Claude Opus model identifiers to version 5 across all reasoning tiers.
- Update system prompt and execution loop behavior: refine prompt-injection policies, add `stripRunTags` helper, update `runResponseLoop`, and remove global AI SDK warnings configuration.
- Update model mappings: upgrade flash-lite to 3.5, flash to 3.6, adjust DeepSeek reasoning and flash tiers, add MoonshotAI Kimi K3 low and max variants, remove unnecessary type casting.
- Change feedback generation in response loop to use `conversationText` instead of `resultText` for full conversation context.

### Documentation
- Document flag interactions, including behavior between persistent context and multi-step chaining flags, with a flag interaction matrix added to README and usage guide.

---

## v0.4.1 — 2026-07-16

### Features

- Integrated MoonshotAI provider with reasoning effort configuration and new environment variable support for API key.
- Added model aliases for Gemini 3.1 Flash Lite, Fireworks GLM-5p2, and Moonshot Kimi models; refined Deepseek model shortcut mappings.
- Renamed Luna reasoning effort aliases from `m-*` to `c-*` and upgraded the default Gemini Flash model from 3.1-preview to 3.5.
- Bumped Claude Sonnet to v5 and Grok to 4.5 across all applicable reasoning effort levels.
- Migrated GPT-5.5 aliases to GPT-5.6 Sol series; introduced Terra and Luna model families with full reasoning effort range; replaced the `xhigh` effort level with `max`.
- Enhanced the command execution flow in the tell subsystem to capture and report exit codes, enabling failure‑aware AI decision‑making and automatic recovery.

---

## v0.4.0 — 2026-07-08

### Features

- Added command confirmation timeout: prompts auto-reject after a configurable period (`EXEC_TIMEOUT`), preventing indefinite hangs.
- Ensured the assistant's visible response is always printed when the chain limit is reached or auto-continue is disabled.
- Model responses now strip ` thinking` blocks before command extraction and output, preventing commands inside think tags from being executed.
- Improved model selection for Vast and Local providers by consistently using `provider.chat(model)`; added response filtering for run command extraction.

### Fixes

- Separated error handling for AI interactions and context file writes to avoid unhandled exceptions; context write failures now log and set a non-zero exit code.
- Fixed an issue where the assistant's visible response was not printed when the conversation chain limit was reached or auto-continue was disabled.

### Refactors

- Dropped the unused `messages` array and `ChatMessage` type from conversation state; narrowed the error handling scope in `runTell` to only cover the AI creation call.
- Removed the `suppressStdout` function and simplified `tellSilently`; suppressed Vercel AI SDK warnings via a global flag.
- Centralized API key and base URL configuration into a new `env` config module with typed keys, default URLs, and simplified provider key lookup.

### Performance

- Cached directory creation tracking to avoid redundant `mkdirSync` calls during conversations.
- Used the model label instead of the raw model string for context file hashing, ensuring stable filenames across runs.

### Documentation

- Added comprehensive git suite examples and integration reference covering git hooks, CI/CD, editors, bots, and self-hosted servers.
- Added a usage guide detailing model selection, command execution, piped input, chain mode, persistent context, and logging.
- Updated README with environment variable API key configuration for all providers (including Deepseek, Cerebras, OpenRouter) and self-hosted endpoint setup.

### Tests

- Added tests for command extraction with visible surrounding text and multi-command chaining.
- Removed outdated vendor-stdout-injection security test.

### Chores

- Relicensed from MIT to GPL-3.0; added LICENSE file and updated package.json license field, repository, bugs, and homepage URLs.

---

## v0.3.2 — 2026-07-08

### Features
- Introduced `tell` CLI for querying AI models and executing approved bash commands with safety checks. Supports multiple AI providers, persistent context per directory/model, chain-mode multi-step reasoning, piped stdin, and command execution toggle. Logs full conversations and includes heuristic detection for high-risk scripts.

### Documentation
- Added comprehensive README covering installation, usage, configuration, and security considerations.

### Tests
- Added security test suite covering prompt injection, risky command handling, exec controls, chain limits, and context hygiene.

### Chores
- Initialized project configuration with `.gitignore`, `package.json`, and `tsconfig.json`.
