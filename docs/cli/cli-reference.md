# CLI reference

Commander program definition: `build_program` (`Tell.ts:525-540`). Name `tell`, description `One-shot terminal assistant`, one variadic positional `[input...]`.

## Synopsis

```bash
tell [model] [prompt...] [options]
tell -m <model> [prompt...] [options]
tell -m --help
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
| `--ctx [ref]` | optional string | Use-or-create: bare = default; `@N` recency; `#hash` prefix; `name`; multi-word = prompt text for default. Cannot combine with `-c`. |
| `-n, --name` | boolean | Reset modifier: `--ctx <name> -n` always starts empty. Requires a valid name. |
| `-l, --history [ref]` | optional string | List contexts + conversations; `@N`/`%N` reprints an entry; any other value searches both. No model call. See [history.md](history.md). |
| `-y, --yes` | boolean | Auto-approve commands. High-risk **and** any reference to paths outside the working directory still require confirmation. No-op without TTY for those (auto-reject). |
| `--require-approval` | boolean | Explicit Require Approval mode: with `-y`, safe commands run directly and high-risk ones still ask; without `-y`, every command asks (same as default). Never weakens the high-risk gate. Forwarded by `-w`/`--web` to seed the web sandbox toggle. |
| `--chain` | boolean | Loop up to 8 command rounds, feeding output back to the model. |
| `-i, --input` | boolean | Force stdin capture and wrap as `User request:` + `Input:` sections. |
| `--no-exec` | boolean | Never execute; report `Command execution disabled` per script. Overrides `-y`. |

`exec` in `CliOptions` is `false` only with `--no-exec` (commander negated boolean); `run_tell` resolves the flags once into `execMode: 'no-exec' | 'confirm-all' | 'auto-risk'` — `--no-exec` wins over everything, `-y` (with or without `--require-approval`) selects `auto-risk`, anything else confirms every command.

## Flag interactions

| Flags | Reads? | Deletes default? | Writes? | Loop? |
|-------|--------|------------------|---------|-------|
| *(none)* | no | yes | no | no |
| `-c` / bare `--ctx` | yes (default file) | no | yes (final + incremental) | no |
| `--chain` | no | yes | no | yes, 8 rounds |
| `-c --chain` / `--ctx … --chain` | yes | no | yes (incremental each round) | yes, 8 rounds |
| `--ctx @N\|#hash\|name` | yes (that file) | no | yes | only with `--chain` |

Without flags the default context file for this cwd+model is removed (`Tell.ts:695`) — deliberate one-shot hygiene, covered by `test_no_flag_invocation_clears_default_context`.

`--ctx` + `-c` together is a hard error: `--ctx cannot be combined with -c`, exit 1, no model call (`Tell.ts:731-735`).

## Prompt assembly

`format_prompt(userText, stdinText, opts)` (`Tell.ts:500-508`):

* Without `-i/--input`: `[userText, stdinText].filter(Boolean).join('\n')`.
* With `-i/--input`: `User request:\n<user>\n\nInput:\n<stdin>` (either half may stand alone).

Missing prompt is exit 1 with commander help (`format_missing_prompt_error`, `Tell.ts:542-544`). Exception: a multi-word `--ctx` value counts as prompt text for the default context (`ctx_is_prompt`, `Tell.ts:740-744`):

```bash
tell d --ctx ola                 # "ola" is a NAME, no prompt → error: missing prompt
tell d --ctx ola "say hello"     # named context "ola" + prompt "say hello"
tell d -c ola                    # one-word prompt on default context
tell d --ctx "say hello"         # multi-word → prompt on default context
```

## File mentions (`@path`)

Any `@path` token in the prompt is expanded before the model call (`expand_mentions`, `Tell.ts:842-845`): files inline as `File:` blocks, directories as trees. Applies to positional text, `-i` stdin, and multi-word `--ctx` alike. Missing/binary targets warn on stderr and pass through intact; `\@` is literal. Targets outside the cwd need interactive confirmation even with `-y`. Full rules: [mentions.md](mentions.md).

```bash
tell 'ache o bug em @server.ts'
tell 'liste @src e sugira testes'
tell --ctx "revise @a.ts com cuidado" "resuma em uma frase"
```

Prompt `@N` tokens do not conflict with `--ctx @N`: context refs are flag values, never prompt tokens (an unmatched `@0` in the prompt just warns and passes through).

## Exit codes and streams

* `0`: answer printed to stdout (visible text only, tags stripped).
* `1`: usage error (`missing prompt`, bad `--ctx` ref, `-n` without name), model error (`Model error [(status)]: …` via `format_model_error`, `Tell.ts:473-482`), or context write/summarize failure path.
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
tell --ctx myproj "continue the project"
tell --ctx myproj -n "start over"
tell -l                          # combined contexts + conversations listing
tell --history @0                # cat the most recent context
tell -l %0                       # cat the most recent conversation
tell --history "kafka consumer"  # search both stores
tell --ctx @0 "resume the most recent"
tell --ctx '#a1b2c3' "resume by hash prefix"
```

Sources: `Tell.ts:83-107`, `Tell.ts:484-544`, `Tell.ts:655-752`.
