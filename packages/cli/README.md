# tell-ai

One-shot terminal assistant.

This is the CLI package of the tell-ai monorepo. It depends on [`@tell-ai/sdk`](../sdk/README.md) for model resolution, vendors, and prompt handling; it owns environment/API-key resolution and command execution.

What It Includes
----------------

- `tell` — terminal CLI for one prompt at a time

Usage
-----

```bash
npm install -g tell-ai
```

Run a prompt:

```bash
tell "explain this directory"
tell d "run ls -la"
tell -m d "run ls -la"
tell -m --help
```

Mention files or directories with `@` — content is injected into the prompt, no pasting:

```bash
tell "ache o memory leak em @server.ts"
tell "liste @src e sugira onde por testes"
```

Files inline as `File:` blocks (64 KB cap, binaries skipped with a warning); directories inject a tree listing. Missing targets warn and pass through intact; `\@` is literal. Anything outside the working directory asks for confirmation first, even with `-y`. Full rules: `docs/cli/mentions.md`.

Command execution is interactive by default:

```bash
tell d "run ls -la"       # asks before executing
tell -y d "run ls -la"    # executes without confirmation
tell --no-exec d "run ls" # never executes requested commands
```

`-y`/`--yes` is intended for disposable or sandboxed environments. The CLI blocks known high-risk command patterns, but this is a heuristic guard, not a security boundary. Do not use automatic execution in production, critical hosts, or trusted workstations unless it is contained by a real sandbox such as a container or VM.

High-risk commands always ask, even with `-y`, and so does any command touching a
path outside the working directory (reads included). `--require-approval` makes
that posture explicit: with `-y` safe commands run directly and high-risk ones
still ask; without `-y` every command asks, same as the default.

```bash
tell --require-approval "fix the failing test"   # ask for everything
tell -y --require-approval "fix the failing test"  # auto-run safe, ask risky
```

Persistent context across sessions:

```bash
tell -c "remember that this project uses PostgreSQL"
tell -c "now add a users table migration"   # remembers the previous message
```

Context is stored per working directory and model under `~/.ai/tell_context`.
Without `-c`, each invocation starts fresh.

Name a context with `--ctx` instead of the per-directory default. The first word
of the value is the ref (`@N` by recency, `%id` by name) and the rest is the
prompt for that context:

```bash
tell --ctx %myproj "remember the deploy steps"    # use-or-create the named context
tell --ctx %myproj "now write the migration"      # same context, keeps the thread
tell --ctx @0 "and what about staging?"           # the most recent context
tell --ctx %myproj -n "start over"                # -n resets it, even if it exists
```

A bare `--ctx` with no ref is prompt text for the default context (same as `-c`),
so `tell --ctx "just this"` needs no extra flag. Full grammar: `docs/cli/context.md`.

Browse saved contexts and past conversations without a model call, an API key or
network access:

```bash
tell -l                     # list contexts (@N) and conversations (%N)
tell -l @0                  # reprint one context
tell -l %3                  # reprint one conversation
tell -l postgres            # search both stores
```

Multi-step chain mode — the assistant can run a command, see its output, and continue with follow-up commands until it reaches a final answer:

```bash
tell --chain "find out why the build is failing and fix it"
```

With `--task`/`-t` (task mode) the model can also delegate: `<DELEGATE>` (read-only research, never writes) and `<SUBTASK>` (build with normal approval). One tag per answer at most; the parent only receives the `Research result (STATUS):` / `Task result (STATUS):` record (repost target 2 KiB via `--delegation-repost`, summary wins only when shorter), never raw child output. Fixed budget of 2 per run (`--max-delegations 0..2`, `0` disables; chain `< 2` always 0). Without `-t` the chain keeps the baseline prompt (no tag, no child). Details: `docs/cli/chain-mode.md`, `docs/cli/execution.md`.

Stream the answer as it is generated (each chain round also streams):

```bash
tell --stream "explain this directory"
tell --stream --think "why does this race condition happen?"  # reasoning on stderr
```

`--think` also works without `--stream`: the reasoning is printed dimmed on
stderr once the response arrives. Streaming never changes what is logged or
saved to the context.

Include piped input with a prompt:

```bash
npm run build 2>&1 | tell --chain -i "what should I fix first?"
git diff --staged | tell --input "review this change"
```

Tell logs conversations under `~/.ai/tell_history`.

Launch the browser sandbox instead of the one-shot prompt — it opens a terminal,
file explorer and chat anchored to a directory:

```bash
tell -w                              # sandbox in the current directory
tell -w --cwd ~/project -m s --stream
```

`--stream`, `--think`, `--chain`, `-y`, `--no-exec` and `--require-approval` are
forwarded to it. See [`@tell-ai/web`](../web/README.md).

### `.tellrc` — profiles, aliases, temperature and limits

The only persisted config file is INI (there is deliberately no
`tell.config.json`; JSON appears only as `--json` data output, a different
contract). Two sources merge: `~/.tellrc` (user) and `<cwd>/.tellrc`
(project). Scalar precedence is
`flag > env > project .tellrc > user ~/.tellrc > default`; deny entries are
union-only — the most restrictive set always wins and no flag or lower layer
can remove an entry.

```ini
model = s
temperature = 0.7
profile = node

[aliases]
work = openai:gpt-6.1-sol:high

[profiles.node]
prompt = Prefer bun and TypeScript.

[policy]
denyCommands = rm -rf /, mkfs

[limits]
max_chain_steps = 4
```

Custom aliases resolve per invocation without mutating the built-in table
(`-m`, `--model` and a valid positional model all accept them; dot-prefix
fast and full `vendor:model:thinking` specs keep working). `system` /
`system-file` compose as custom instructions *before* the safety prompt —
config can never replace `<RUN>`, approval, injection or deny rules.
`system-file` is capped at 64 KB, must be a regular file, and a project file
may not escape the cwd via symlink. Profiles `node`, `security` and `devops`
carry prompt/style/model/temperature/deny/limits data, and any
`[profiles.<name>]` is a valid custom profile (own `system`/`system-file`,
own aliases via `[profiles.<name>.aliases]`, fill-if-empty semantics —
explicit layers always win, file aliases beat profile aliases); enforcement
stays in
the policy sandbox. `[limits]` accepts all seven runtime keys
(`context_chars`, `stdin_timeout_ms`, `stdin_max_bytes`, `exec_timeout_ms`,
`max_chain_steps`, `max_buffer_bytes`, `output_max_bytes`); the parser imports
the ranges from `runtime-limits` instead of keeping its own table, so a bad
value warns and is dropped without ever failing the run. `tell --web` forwards
only non-secret fields (model via `-m`, profile, system via `--system-file`,
temperature via `--temperature`, numeric limits); keys, URLs and secrets never
enter args, files or `/api/config`. Env layer: `TELL_MODEL`,
`TELL_SYSTEM`, `TELL_SYSTEM_FILE`, `TELL_TEMPERATURE`, `TELL_PROFILE`.
New flags: `--profile`, `--system`, `--system-file`, `--temperature` (0..2).

### Runtime limits

Operational caps live in `@tell-ai/core` (`src/runtime-limits.ts` — single owner of `parse_runtime_limits`, `truncate_context`, `RuntimeLimits`, `ExecutionOptions`); the CLI only adds `StdinLimitError` and the process exit-status family: context 64 Ki (`--context-max-chars` / `TELL_CONTEXT_MAX_CHARS`), stdin 30 s (`--stdin-timeout` / `--no-stdin-timeout` / `TELL_STDIN_TIMEOUT_MS`) and 1 MiB (`--stdin-max-bytes` / `TELL_STDIN_MAX_BYTES`), exec 120 s (`--exec-timeout` / `TELL_EXEC_TIMEOUT_MS`), 8 chain rounds by default (`--max-chain` / `TELL_MAX_CHAIN_STEPS`, range `1..128`), 32 Mi buffer (`--max-buffer` / `TELL_MAX_BUFFER_BYTES`), 200 Ki delivered output (`--output-max-bytes` / `TELL_OUTPUT_MAX_BYTES`), delegation budget 2 (`--max-delegations` / `TELL_MAX_DELEGATIONS`, `0..2`) and repost target 2 Ki (`--delegation-repost` / `TELL_DELEGATION_REPOST_CHARS`, `512..8192`). Precedence `flag > env > project .tellrc > user ~/.tellrc > default`; bad flag/env fails with exit `2` before any model call, stdin timeout is `124`, overflow is `125`. Context is cut by whole turns with balanced `<think>`/`<RUN>` blocks — no tokenizer, no stdout monkey-patch. Covered by `bun run test:runtime`.

### Flag interactions

| Flags | Reads context? | Deletes? | Writes? | Loop? |
|-------|--------|---------|--------|------|
| *(none)* | no | yes | no | no |
| `-c` / bare `--ctx` | yes (default file) | no | yes | no |
| `--ctx @N` / `--ctx %id` | yes (that file) | no | yes | no |
| `--chain` | no | yes | no | yes (8 rounds) |
| `-c --chain` | yes | no | yes (incremental) | yes (8 rounds) |
| `-l` / `--history` | no | no | no | no |
| `-y` / `--require-approval` / `--no-exec` | no | no | no | no |

`--ctx` cannot be combined with `-c`. `--stream` and `--think` only change what
is printed: the log, the saved context and `<RUN>` extraction stay identical.

### Building from source

```bash
bun install
npm run build          # builds the SDK then the CLI
npm run lint && npm run check
```

API Keys
--------

Set environment variables (preferred) or use `~/.config/<vendor>.token` files as fallback.

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_API_KEY="..."        # or GEMINI_API_KEY
export XAI_API_KEY="..."
export DEEPSEEK_API_KEY="..."
export CEREBRAS_API_KEY="..."
export MOONSHOTAI_API_KEY="..."
export OPENROUTER_API_KEY="..."
export ALIBABA_API_KEY="..."       # Qwen
export ZHIPU_API_KEY="..."         # Z.ai GLM
export META_API_KEY="..."          # Meta Llama API
export MIMO_API_KEY="..."          # Xiaomi MiMo
```

Token files (fallback):

```bash
~/.config/openai.token
~/.config/anthropic.token
~/.config/google.token
~/.config/xai.token
~/.config/deepseek.token
~/.config/cerebras.token
~/.config/moonshotai.token
~/.config/openrouter.token
~/.config/alibaba.token
~/.config/zhipu.token
~/.config/meta.token
~/.config/mimo.token
```

Self-hosted endpoints (optional):

```bash
export VAST_BASE_URL="http://..."
export LOCAL_OPENAI_BASE_URL="http://localhost:8080/v1"
```

Security Tests
--------------

Run the prompt-injection and command-execution safety checks with:

```bash
npm run test:security
npm run test:mentions   # @path expansion + outside-cwd read gate
npm run test:context    # --ctx grammar + --history
npm run test:stream     # --stream / --think
npm run test:tellrc     # .tellrc parser, precedence, profiles, aliases, temperature, limits (28 tests; part of the aggregate)
```

License
-------

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

This package is licensed under the **GNU General Public License v3.0** — see the [LICENSE](../../LICENSE) file for more details.