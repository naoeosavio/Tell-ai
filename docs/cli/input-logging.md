# Stdin and logging

## Piped input

`read_stdin` (`Tell.ts:138-156`): returns `''` immediately when stdin is a TTY; otherwise collects piped bytes until `end` with a 30s `STDIN_TIMEOUT` guard (rejects on timeout; `main` swallows read errors to `''`).

Capture rule (`parse_args`, `Tell.ts:484-498`): `readStdin = !isTTY && (opts.input || parts.length === 0)`.

```bash
npm run build 2>&1 | tell --chain -i "what should I fix first?"
git diff --staged | tell --input "review this change"
cat error.log | tell "explain this error"   # -i optional: no positional prompt
echo "explain this" | tell                  # stdin becomes the prompt
```

With `-i/--input`, `format_prompt` wraps the two halves (`Tell.ts:500-508`):

```
User request:
<positional prompt>

Input:
<stdin>
```

Without `-i`, user text and stdin are joined with a plain newline. Either half may be empty; a fully empty prompt (and no `--ctx` prompt text) is `error: missing prompt`, exit 1.

Piped content is untrusted data: it travels inside the user message, and the system prompt's injection policy (see [security.md](security.md)) tells the model to treat tool/paste output as data, never as instructions. Literal `<RUN>` text typed by the user is likewise only data — only model-emitted `<RUN>` blocks execute (asserted by the `USER_PROMPT_PWN` test).

## History logs

`log_file` (`Tell.ts:158-163`): `~/.ai/tell_history/conversation_<ISO-timestamp>.txt` (`:` → `-`). Created per invocation via `ensure_dir` (mkdir cached in `CREATED_DIRS`, `Tell.ts:75-81`).

Appended (`append_log`, `Tell.ts`): `Model: <label>\nUser:\n<prompt>`, then `Assistant:\n<response>` per round (`remember_assistant`) and each command result (`run_scripts`). The logged `<prompt>` is the post-expansion text — `@path` mentions already inlined (see [mentions.md](mentions.md)). Logs are append-only and local-only; they are read back exclusively by `--history` (listing, `%N` cat, search — see [history.md](history.md)), never by the conversation loop — context files are memory, logs are observability.

## Filesystem summary

| Path | Written when | Read back? |
|------|--------------|------------|
| `~/.ai/tell_history/conversation_*.txt` | always | yes, via `--history` `%N` / search) |
| `~/.ai/tell_context/<sha256>.txt` | `-c` / `--ctx` (default plan) | yes, next `-c` / `--ctx` in same cwd+model |
| `~/.ai/tell_context/<name>.txt` | `--ctx %id` | yes, next `--ctx %id|@N` |

`fs.rmSync(context_path, { force: true })` on the `none` plan deletes only the default file for this cwd+model; `%id` contexts are untouched (see [context.md](context.md)).

Sources: `Tell.ts:75-81`, `Tell.ts:138-163`, `Tell.ts:326-329`, `Tell.ts:484-508`, `Tell.ts:695-698`.
