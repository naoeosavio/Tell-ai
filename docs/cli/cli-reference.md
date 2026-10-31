# CLI reference

Commander program definition: `build_program` (`Tell.ts:525-540`). Name `tell`, description `One-shot terminal assistant`, one variadic positional `[input...]`.

## Synopsis

```bash
tell [model] [prompt...] [options]
tell -m <model> [prompt...] [options]
tell -m --help
tell --models
```

Model resolution order (`parse_args`, `Tell.ts:484-498`):

1. `-m/--model <model>` if given.
2. Else first positional arg if `is_model_spec()` matches (known alias in `MODELS`, or `vendor:model[:thinking]` parseable by `resolve_model_spec`, with optional `.` fast prefix).
3. Else `DEFAULT_MODEL` (`$TELL_MODEL` or `'g'`).

```bash
tell d "run ls -la"                    # positional alias
tell -m d "run ls -la"                 # explicit flag
tell -m deepseek:deepseek-v4-pro:medium "run ls -la"  # full spec
tell .g "fast, no reasoning tokens"    # dot-prefix fast mode
```

Full spec format: `vendor:model[:thinking]` with thinking in `none|low|medium|high|xhigh|max|auto`, optional `:fast` suffix. Unknown vendors throw `Unsupported vendor`. Source: `packages/sdk/src/models.ts:329-362`.

`tell -m --help` is handled before commander parsing (`wants_model_help`, `Tell.ts:521-523`) and prints the live alias table via `print_model_help` (`Tell.ts:99-107`). That output is authoritative; the snapshot in `../usage.md` may lag.

## Flags

| Flag | Type | Meaning |
|------|------|---------|
| `-m, --model <model>` | string | Model alias or full spec. `-m --help` lists aliases. |
| `-c, --context` | boolean | Use default per-directory+model context. |
| `--ctx [ref]` | optional string | Context ref + prompt: `@N` recency, `%id` use-or-create; text after the ref is the prompt. No ref = prompt text for the default context. A single bare token with a positional prompt is an error (naming requires `%`). Cannot combine with `-c`. |
| `-n, --name` | boolean | Reset modifier: `--ctx %id -n` (or `--task %id -n`) always starts empty. Requires `%id`. |
| `-t, --task [ref]` | optional string | Task mode: `%id` resumes or creates `task-NNN-name`; without a ref the prompt creates `task-NNN-<hash8>`. Forces `--chain --stream --require-approval` (add `-y` to auto-run safe commands; without it every command asks) and uses `~/.ai/tell_context/task-NNN-name/main.txt`. A new task needs a prompt; a resume can continue without one. Cannot combine with `--ctx`, `-c` or `--no-exec`. See Task mode below. |
| `-l, --history [ref]` | optional string | List contexts + conversations; `@N`/`%N` reprints an entry; any other value searches both. No model call. See [history.md](history.md). |
| `-y, --yes` | boolean | Auto-approve commands. High-risk **and** any reference to paths outside the working directory still require confirmation. No-op without TTY for those (auto-reject). |
| `--require-approval` | boolean | Explicit Require Approval mode: with `-y`, safe commands run directly and high-risk ones still ask; without `-y`, every command asks (same as default). Never weakens the high-risk gate. Forwarded by `-w`/`--web` to seed the web sandbox toggle. |
| `--chain` | boolean | Loop up to 8 command rounds, feeding output back to the model. |
| `--tags` | boolean | Show `<RUN>`/`<DELEGATE>`/`<SUBTASK>` tag blocks on stdout. Hidden by default (the live stream is filtered; the saved text is always tag-free). |
| `--output` | boolean | Show the output of executed commands (parent and delegation child); hidden by default. Approval prompts still show the script. |
| `--delegation` | boolean | Show the child acting live (commands, outputs, text) until it returns the `Research/Task result` record. Hidden by default: only a compact `Delegando pesquisa… (research: <20>)` / `Delegando sub-tarefa… (build: <20>)` indicator remains (like `Thinking...`). |
| `-i, --input` | boolean | Force stdin capture and wrap as `User request:` + `Input:` sections. |
| `--no-exec` | boolean | Never execute; report `Command execution disabled` per script. Overrides `-y`. |
| `--models` | boolean | List the models the `custom` endpoint exposes (`GET {CUSTOM_BASE_URL}/models`), grouped by the wire each would use, with a copy-pasteable `custom:<model>` spec. No model call, no prompt needed. Requires `CUSTOM_BASE_URL` + `CUSTOM_API_KEY`. |
| `--context-max-chars <n>` | string | Max saved-context chars (default `65536`). See Runtime limits. |
| `--stdin-timeout <ms>` | string | Stdin read deadline in ms (default `30000`). `0` disables the deadline. |
| `--no-stdin-timeout` | boolean | Disable the stdin deadline (byte cap stays active). Equivalent to `--stdin-timeout 0`. |
| `--stdin-max-bytes <n>` | string | Max stdin bytes (default `1048576`). Overflow exits `125`. |
| `--exec-timeout <ms>` | string | Per-command timeout in ms (default `120000`, max `600000`). |
| `--max-chain <n>` | string | Max chain rounds, `1..128` (default `8`; the core loop enforces no upper clamp). Parent delegation budget is fixed at 2 whenever the chain has `>= 2` rounds, else 0 (`1` → 0, the tag stays inert). |
| `--max-buffer <n>` | string | Internal exec buffer bytes (default `33554432`). |
| `--output-max-bytes <n>` | string | Delivered output cap bytes (default `204800`); cut output carries a `[output truncated at N bytes]` marker. |
| `--max-delegations <n>` | string | Max delegations per run, `0..2` (default `2`; `0` disables). Chain gate is structural: fewer than 2 chain rounds always give 0. |
| `--delegation-repost <n>` | string | Delegation repost target chars, `512..8192` (default `2048`). The summary wins only when shorter than the target; otherwise the redacted original climbs. |

`exec` in `CliOptions` is `false` only with `--no-exec` (commander negated boolean); `run_tell` resolves the flags once into `execMode: 'no-exec' | 'confirm-all' | 'auto-risk'` — `--no-exec` wins over everything, `-y` (with or without `--require-approval`) selects `auto-risk`, anything else confirms every command.

## Task mode (`-t`, `--task`)

Task mode is sugar over chain mode. It opens a saved task, forces `--chain --stream --require-approval`, and refuses `--no-exec` (exit `2`). `-y` is opt-in: without it every command asks (non-TTY denies); with it safe commands auto-run and high-risk/outside-cwd commands still ask.

- Id: `task-NNN-name`. `--task %name` resumes the saved task or creates it with the next free number. `--task "objective"` creates `task-NNN-<hash8>` from `sha256(cwd + prompt)`. Numbers never reset, repeat or renumber; a resume never allocates one. Repeating the exact objective reuses the same hash id (resume) — pass a distinct `%ref` to force a second task. When several saved tasks share the normalized name, the most recently used one wins; pass the full id to pick another.
- The task line (`Created task:`/`Using task:`) is printed only after the run succeeds, so a model failure never reports a task that was never saved.
- Storage: `~/.ai/tell_context/task-NNN-name/main.txt` is the context file (it appears in `-l` as `@N`). Each delegation writes `delegate-NNN.txt` or `subtask-NNN.txt` beside it with `Objective:`, `Context-at-delegation:` (8 Ki cap), `Status:` (`DONE` / `IN PROGRESS` / `BLOCKED`) and `Result:` (the `Research result (STATUS):` / `Task result (STATUS):` record, repost target 2 Ki).
- Reset: `--task %id -n` full-wipes `main.txt` plus every `delegate-*.txt`/`subtask-*.txt`, keeps the directory (the NNN anchor) and writes an empty `main.txt` so the task stays visible in `-l`. History is kept. `-n` outside task mode is unchanged.
- A new task needs an objective. A resume without a prompt continues from the saved context.
- Only `%ref` guarantees a resume. The automatic name is `sha256(cwd + "\n" + prompt)`: a different case or internal spacing is a different task.
- Numbering is `max + 1` over the saved ids. Deleting the highest task frees its number (a shortcut: a task should be resumed, not deleted).
- Two runs on the same task at the same time keep the last writer's turns: each write is atomic, but there is no run lock.
- `tell --web --task …` forwards the same value. The CLI does not claim the task; the sandbox resolves and creates the same id, so `--cwd` never leaves a phantom task.
- Fixed budget of 2 delegations per invocation (`0` when the chain has fewer than 2 rounds). `--max-delegations 0..2` is the explicit exit (`0` disables); env `TELL_MAX_DELEGATIONS`, tellrc `max_delegations`, Web parity. Status never consumes budget; only a real child run does. The 3rd tag is inert with a deterministic warning (`Delegation budget exceeded (2); ignoring delegation tag.` on stderr + log).
- At most one delegation tag runs per answer; extra tags print a warning. A tag inside a literal `<think>` block is inert. The objective must be self-contained; the parent reads the record status (`DONE` uses it, `IN PROGRESS` may delegate again with a narrower objective while budget remains, `BLOCKED` stops and reports).

Delegation is task-only: `-t/--task` adds the core-owned sections (`<DELEGATE>` research read-only, `<SUBTASK>` build with normal approval; at most one tag per answer, delegation wins over `<RUN>` which is recorded skipped, never executed). Without `-t`, `--chain` keeps the baseline prompt of commit `09269bb`: no delegation section, no child, and an emitted tag is inert text. See [chain-mode.md](chain-mode.md) and [execution.md](execution.md).

## Flag interactions

| Flags | Reads? | Deletes default? | Writes? | Loop? |
|-------|--------|------------------|---------|-------|
| *(none)* | no | yes | no | no |
| `-c` / bare `--ctx` | yes (default file) | no | yes (final + incremental) | no |
| `--chain` | no | yes | no | yes, 8 rounds |
| `-c --chain` / `--ctx … --chain` | yes | no | yes (incremental each round) | yes, 8 rounds |
| `--ctx @N\|%id` | yes (that file) | no | yes | only with `--chain` |

Without flags the default context file for this cwd+model is removed (`Tell.ts:695`) — deliberate one-shot hygiene, covered by `test_no_flag_invocation_clears_default_context`.

`--ctx` + `-c` together is a hard error: `--ctx cannot be combined with -c`, exit 1, no model call (`Tell.ts:731-735`).

## Prompt assembly

`format_prompt(userText, stdinText, opts)` (`Tell.ts:500-508`):

* Without `-i/--input`: `[userText, stdinText].filter(Boolean).join('\n')`.
* With `-i/--input`: `User request:\n<user>\n\nInput:\n<stdin>` (either half may stand alone).

Missing prompt is exit 1 with commander help (`format_missing_prompt_error`). Exception: a `--ctx` value that carries prompt text counts — text after a ref, or a bare value with no positional prompt (`ctx_value_has_prompt`):

```bash
tell d --ctx %ola "say hello"    # context "ola" + prompt "say hello"
tell d --ctx %ola                # ref only, no prompt → error: missing prompt
tell d --ctx ola                 # "ola" is PROMPT text on the default context
tell d --ctx ola "say hello"     # one bare token + positional → error: naming requires %
tell d --ctx "say hello"         # multi-word → prompt on default context
tell d -c ola                    # one-word prompt on default context
```

## File mentions (`@path`)

Any `@path` token in the prompt is expanded before the model call (`expand_mentions`, `Tell.ts:842-845`): files inline as `File:` blocks, directories as trees. Applies to positional text, `-i` stdin, and multi-word `--ctx` alike. Missing/binary targets warn on stderr and pass through intact; `\@` is literal. Targets outside the cwd need interactive confirmation even with `-y`. Full rules: [mentions.md](mentions.md).

```bash
tell 'ache o bug em @server.ts'
tell 'liste @src e sugira testes'
tell --ctx "revise @a.ts com cuidado" "resuma em uma frase"
```

Prompt `@N` tokens do not conflict with `--ctx @N`: context refs are flag values, never prompt tokens (an unmatched `@0` in the prompt just warns and passes through).

## Runtime limits

Single owner: `packages/core/src/runtime-limits.ts` (`parse_runtime_limits`, `truncate_context`, `RuntimeLimits`, `ExecutionOptions`), owned entirely by the core now (the former CLI facade was removed; `StdinLimitError`, the `EXIT_*` statuses and the explicit-env reader live in the owner). Defaults preserve the historical CLI baseline: context 64 Ki, stdin 30 s / 1 MiB, exec 120 s, 8 chain rounds, 32 Mi internal buffer, 200 Ki delivered output, plus delegation knobs (budget 2, repost target 2 Ki). Precedence is `flag > env > tellrc do projeto > tellrc do usuário > default` (env: `TELL_CONTEXT_MAX_CHARS`, `TELL_STDIN_TIMEOUT_MS`, `TELL_STDIN_MAX_BYTES`, `TELL_EXEC_TIMEOUT_MS`, `TELL_MAX_CHAIN_STEPS`, `TELL_MAX_BUFFER_BYTES`, `TELL_OUTPUT_MAX_BYTES`, `TELL_MAX_DELEGATIONS`, `TELL_DELEGATION_REPOST_CHARS`; tellrc `[limits]`: all nine keys — `context_chars`, `stdin_timeout_ms` (`0` disables the deadline), `stdin_max_bytes`, `exec_timeout_ms`, `max_chain_steps` (up to 128), `max_buffer_bytes`, `output_max_bytes`, `max_delegations` (`0..2`), `delegation_repost_chars` (`512..8192`) — validated by the same owner via `validate_tellrc_limit_value`, never by a second table in `tellrc.ts`). `--max-chain` accepts `1..128` (the web sandbox keeps the clamp at 8). Invalid flag/env values fail before any model call or execution (exit `2`); invalid tellrc values fail diagnosably with their file source, never silently defaulting.

Full before/after guide with usage recipes: [runtime-limits.md](runtime-limits.md).

`read_stdin` counts bytes, enforces timeout + cap, cleans up timer/listeners on every path, and surfaces `StdinLimitError` (`timeout` → `124`, `overflow` → `125`) — the caller never converts it to an empty prompt. `truncate_context` keeps whole `User:`/`Assistant:`/result turns with balanced `<think>`/`<RUN>` blocks and an explicit `[older context truncated]` marker; a single oversized turn is tail-cut at a tag-safe boundary. No tokenizer dependency (`gpt-tokenizer` was evaluated out — bytes/chars only), no `process.stdout.write` monkey-patch. Suites: `test/test-tell-runtime-limits.js` (`bun run test:runtime`, wiring da CLI) e `test/test-core-limits.js` (contrato pela porta do core, em `test:core`), ambas em `test`/`ci`.

## Exit codes and streams

* `0`: answer printed to stdout (visible text only, tags stripped).
* `1`: usage error (`missing prompt`, bad `--ctx` ref, `-n` without name), model error (`Model error [(status)]: …` via `format_model_error`, `Tell.ts:473-482`), or context write/summarize failure path.
* `2`: invalid runtime limit from flag/env/tellrc (`RuntimeLimitError`, no model call, no execution).
* `124`: stdin read timeout or command execution timeout (child exit preserved otherwise).
* `125`: stdin byte-cap overflow.
* stdout: final visible answer. In non-chain mode with commands but no visible text, a follow-up model call produces the printed answer (`handle_final_answer`, `Tell.ts:576-587`).
* stderr: `Thinking...`, `Using context:` / `Created context:`, command output echo, `Command skipped by user.`, `Command execution disabled (--no-exec).`, `Chain limit reached (8)…`, warnings.

## Common examples

```bash
tell "explain this directory"
tell "ache o bug em @server.ts"  # file content injected, no pasting
tell "liste @src"                # directory tree injected
tell -y d "run ls -la"           # auto-approve safe commands
tell --no-exec d "run ls -la"    # show, don't run
tell --chain "find why the build fails and fix it"
npm run build 2>&1 | tell --chain -i "what should I fix first?"
git diff --staged | tell --input "review this change"
tell -c "remember this project uses PostgreSQL"
tell --ctx %myproj "continue the project"
tell --ctx %myproj -n "start over"
tell -l                          # combined contexts + conversations listing
tell --history @0                # cat the most recent context
tell -l %0                       # cat the most recent conversation
tell --history "kafka consumer"  # search both stores
tell --ctx @0 "resume the most recent"
tell --ctx %a1b2c3 "resume by hash prefix"

export CUSTOM_BASE_URL=https://gateway.internal/v1 CUSTOM_API_KEY=sk-...
tell --models                              # what the gateway serves, per wire
tell -m custom:kimi-k3 "explain this repo" # one-shot against that endpoint
CUSTOM_MODEL=kimi-k3 tell -m custom "hi"   # model id from the environment
```

Sources: `Tell.ts:83-107`, `Tell.ts:484-544`, `Tell.ts:655-752`.
