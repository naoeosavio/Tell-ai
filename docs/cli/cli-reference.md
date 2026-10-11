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
| `-n, --name` | boolean | Reset modifier: `--ctx %id -n` always starts empty. Requires `%id`. |
| `-l, --history [ref]` | optional string | List contexts + conversations; `@N`/`%N` reprints an entry; any other value searches both. No model call. See [history.md](history.md). |
| `-y, --yes` | boolean | Auto-approve commands. High-risk **and** any reference to paths outside the working directory still require confirmation. No-op without TTY for those (auto-reject). |
| `--require-approval` | boolean | Explicit Require Approval mode: with `-y`, safe commands run directly and high-risk ones still ask; without `-y`, every command asks (same as default). Never weakens the high-risk gate. Forwarded by `-w`/`--web` to seed the web sandbox toggle. |
| `--chain` | boolean | Loop up to 8 command rounds, feeding output back to the model. |
| `-i, --input` | boolean | Force stdin capture and wrap as `User request:` + `Input:` sections. |
| `--no-exec` | boolean | Never execute; report `Command execution disabled` per script. Overrides `-y`. |
| `--models` | boolean | List the models the `custom` endpoint exposes (`GET {CUSTOM_BASE_URL}/models`), grouped by the wire each would use, with a copy-pasteable `custom:<model>` spec. No model call, no prompt needed. Requires `CUSTOM_BASE_URL` + `CUSTOM_API_KEY`. |
| `--context-max-chars <n>` | string | Max saved-context chars (default `65536`). See Runtime limits. |
| `--stdin-timeout <ms>` | string | Stdin read deadline in ms (default `30000`). `0` disables the deadline. |
| `--no-stdin-timeout` | boolean | Disable the stdin deadline (byte cap stays active). Equivalent to `--stdin-timeout 0`. |
| `--stdin-max-bytes <n>` | string | Max stdin bytes (default `1048576`). Overflow exits `125`. |
| `--exec-timeout <ms>` | string | Per-command timeout in ms (default `120000`, max `600000`). |
| `--max-chain <n>` | string | Max chain rounds, `1..128` (default `8`; the core loop enforces no upper clamp). |
| `--max-buffer <n>` | string | Internal exec buffer bytes (default `33554432`). |
| `--output-max-bytes <n>` | string | Delivered output cap bytes (default `204800`); cut output carries a `[output truncated at N bytes]` marker. |

`exec` in `CliOptions` is `false` only with `--no-exec` (commander negated boolean); `run_tell` resolves the flags once into `execMode: 'no-exec' | 'confirm-all' | 'auto-risk'` — `--no-exec` wins over everything, `-y` (with or without `--require-approval`) selects `auto-risk`, anything else confirms every command.

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

Single owner: `packages/cli/src/runtime-limits.ts` (`parse_runtime_limits`, `truncate_context`, `RuntimeLimits`, `ExecutionOptions`). Defaults preserve the historical CLI baseline: context 64 Ki, stdin 30 s / 1 MiB, exec 120 s, 8 chain rounds, 32 Mi internal buffer, 200 Ki delivered output. Precedence is `flag > env > tellrc do projeto > tellrc do usuário > default` (env: `TELL_CONTEXT_MAX_CHARS`, `TELL_STDIN_TIMEOUT_MS`, `TELL_STDIN_MAX_BYTES`, `TELL_EXEC_TIMEOUT_MS`, `TELL_MAX_CHAIN_STEPS`, `TELL_MAX_BUFFER_BYTES`, `TELL_OUTPUT_MAX_BYTES`; tellrc `[limits]`: all seven keys — `context_chars`, `stdin_timeout_ms` (`0` disables the deadline), `stdin_max_bytes`, `exec_timeout_ms`, `max_chain_steps` (up to 128), `max_buffer_bytes`, `output_max_bytes` — validated by the same owner via `validate_tellrc_limit_value`, never by a second table in `tellrc.ts`). `--max-chain` accepts `1..128` (the web sandbox keeps the clamp at 8). Invalid flag/env values fail before any model call or execution (exit `2`); invalid tellrc values fail diagnosably with their file source, never silently defaulting.

Full before/after guide with usage recipes: [runtime-limits.md](runtime-limits.md).

`read_stdin` counts bytes, enforces timeout + cap, cleans up timer/listeners on every path, and surfaces `StdinLimitError` (`timeout` → `124`, `overflow` → `125`) — the caller never converts it to an empty prompt. `truncate_context` keeps whole `User:`/`Assistant:`/result turns with balanced `<think>`/`<RUN>` blocks and an explicit `[older context truncated]` marker; a single oversized turn is tail-cut at a tag-safe boundary. No tokenizer dependency (`gpt-tokenizer` was evaluated out — bytes/chars only), no `process.stdout.write` monkey-patch. Suite: `test/test-tell-runtime-limits.js` (`bun run test:runtime`, in `test`/`ci`).

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
