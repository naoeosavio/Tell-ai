# Overview

`tell-ai` (`packages/cli/`) is a one-shot terminal assistant. Each invocation sends one prompt to an LLM and exits. Optional behaviors — command execution, multi-step chaining, persistent context — are opt-in per invocation.

## What it owns vs the SDK

| Layer | Package | Responsibilities |
|-------|---------|------------------|
| LIB | `@tell-ai/sdk` (`packages/sdk/`) | Model resolution (`MODELS`, `resolve_model_spec`), vendor dispatch (`create_ask_ai`), `tell()`, `get_system_prompt()`, `<RUN>`/`<think>` helpers, `summarize_context`. Browser-safe: no `node:*`, no `process.env`. |
| CLI | `tell-ai` (`packages/cli/`) | `process.env` + `~/.config/<vendor>.token` resolution (`src/env.ts`), commander parsing, stdin, `@path` mention expansion (`src/mentions.ts`), `/bin/bash` execution, confirmation + high-risk guard, `~/.ai/tell_context` + `~/.ai/tell_history`, chain loop (`src/Tell.ts`). |

The CLI depends on the SDK (`packages/cli/package.json:52-55`): `@tell-ai/sdk` + `commander@15`. It never reimplements model dispatch — `run_tell` calls `load_sdk_config()` then `create_ask_ai(model, config)` (`Tell.ts:871-873`), and `tell_silently` delegates to SDK `tell()` with `ask` + `raw: true` (`Tell.ts:477-495`).

## Invocation lifecycle

```
main (Tell.ts:886)
 ├─ wants_model_help? → print_model_help, return
 ├─ build_program (commander) → opts
 ├─ --history? → run_history_dispatch (list/cat/search), return
 ├─ reject --ctx + -c combination
 ├─ parse_args (positional model detect) → { model, parts }
 ├─ read_stdin (if piped) → format_prompt → prompt
 ├─ run_tell (Tell.ts:820)
 │   ├─ model_label + build_context_plan → ContextPlan
 │   ├─ raw_prompt (ctx text + user prompt) → expand_mentions → full_prompt
 │   ├─ load previous context / delete default on 'none'
 │   ├─ load_sdk_config → create_ask_ai
 │   └─ run_response_loop
 │       ├─ tell_silently(firstPrompt)
 │       ├─ remember_assistant + save_incremental_context
 │       ├─ extract_runs → scripts + visible
 │       ├─ should_finish? → finish_round / handle_final_answer
 │       └─ run_scripts → remember_command_result → [chain?] build_feedback → next round
 └─ maybe_summarize_context (if saved context grew past MAX_CONTEXT_CHARS)
```

Key detail: without any context flag the plan is `'none'`, and `run_tell` deletes the default per-directory+model file (`Tell.ts:865`). One-shot is the default; persistence requires `-c` / `--ctx`. See [context.md](context.md). `@path` mentions expand before anything else in `run_tell`, so the model, the log, and the saved context all see the expanded text. See [mentions.md](mentions.md).

## Key constants (`Tell.ts:23-31`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `DEFAULT_MODEL` | `process.env.TELL_MODEL \|\| 'g'` | Default alias when no model given |
| `MAX_BUFFER` | `32 * 1024 * 1024` | Max stdout+stderr per command |
| `MAX_CHAIN_STEPS` | `8` | Max command rounds in `--chain` |
| `EXEC_TIMEOUT` | `120_000` ms | Per-command timeout + confirm prompt auto-reject |
| `STDIN_TIMEOUT` | `30_000` ms | Piped stdin read timeout |
| `MAX_CONTEXT_CHARS` | `64 * 1024` | Saved-context budget before AI summarization |

Execution uses `/bin/bash` with `cwd: process.cwd()` (`Tell.ts:116-143`). Non-zero exit is reported back to the model as `Command failed (exit code N)` (`Tell.ts:449-451`), enabling failure-aware retries in chain mode.

## Core types (`Tell.ts:34-77`)

* `CliOptions`: parsed commander flags (`model`, `context`, `ctx`, `name`, `history`, `yes`, `chain`, `exec`, `input`).
* `ParsedInput`: `{ model, parts, readStdin }` from `parse_args`.
* `ContextEntry`: `{ file, id, mtimeMs }` — one saved context file.
* `ContextPlan`: `'none' | 'default' | 'existing' | 'create'` — how this invocation reads/writes context. See [context.md](context.md).
* `ConversationState`: in-memory timeline, `commandRounds`, `chainLimitReached`, `autoContinue`, `execEnabled`, `yes`, `saveContext`.

## Entry points and outputs

* Binary: `tell` → `dist/Tell.mjs` (`package.json:6-8`). Built as minified ESM with `#!/usr/bin/env node` banner (`tsup.config.ts`).
* stdout: the assistant's visible answer only (RUN/think tags stripped). Command output goes to stderr (dimmed on TTY) and into the model feedback, not stdout — except via chain final answer. See [execution.md](execution.md) and [chain-mode.md](chain-mode.md).
* stderr: `Thinking...` spinner, `Using context:` / `Created context:` notices, command echoes, warnings, errors (red).
* Files: `~/.ai/tell_history/conversation_<timestamp>.txt` (always), `~/.ai/tell_context/*.txt` (only with context flags). See [input-logging.md](input-logging.md).

Sources: `Tell.ts:1-31`, `Tell.ts:820-884`, `src/mentions.ts`, `src/env.ts`, `src/systemPrompt.ts`, `package.json`, `tsup.config.ts`.
