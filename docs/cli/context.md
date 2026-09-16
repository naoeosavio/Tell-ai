# Context (`-c`, `--ctx`, `-n`)

Contexts no longer have their own lister: `-l` is inherited by `--history` (see [history.md](history.md)), which lists contexts and conversations together and reopens entries by `@N`/`%N`.

Explicit design: the first word of `--ctx` is the ref only when it is `@N` (recency) or `%id` (use-or-create); the rest of the value is prompt text for the addressed context. Without a ref, the value is prompt text for the default context. A **single bare token followed by a positional prompt is a hard error** — naming a context requires `%`. Unnamed contexts are never saved.

> **Breaking change (v0.6):** the bare-name form was removed. `--ctx myproj "prompt"` used to mean "use-or-create context `myproj`"; it is now an error — use `--ctx %myproj "prompt"`. `--ctx myproj` alone still runs, but now means *prompt text* for the default context. The `#hash` prefix is gone too: `@N` and `%id` are the only refs, and a `%<hex>` prefix resumes a hash-named context (`%a1b2c3` replaces `#a1b2c3`).

## `ContextPlan` (`Tell.ts`)

```ts
type ContextPlan =
  | { $: 'none' }                                                         // no flag: fresh, delete default
  | { $: 'default'; file: string; promptFromRef?: string }                // -c | bare --ctx | bare prompt text
  | { $: 'existing'; file: string; label: string; promptFromRef?: string } // resolved @N / %id
  | { $: 'create'; file: string; label: string; promptFromRef?: string };  // --ctx %id -n | missing %id
```

`promptFromRef` carries the text after a ref (or the whole bare value) so it is prepended to the positional prompt without ever reaching `expand_mentions` as a mention token.

Built by `build_context_plan(opts, model, entries, has_positional_prompt)`:

* `opts.name` (`-n`): requires `--ctx %id`; always returns `create` (explicit reset, even if the id exists).
* `opts.ctx === true || opts.context` (`-c` / bare `--ctx`): `default`.
* `typeof opts.ctx === 'string'`: `resolve_context_ref`.
* Otherwise: `none`.

`has_positional_prompt` is `input.parts.length > 0` — the positional prompt with a leading positional model spec already stripped, so `tell g --ctx ola` still treats `ola` as prompt text.

`run_tell` then: `save_context = plan.$ !== 'none'`; `context_path` is the plan file (or the default hash path for `none`, which is deleted); `previous_context` is read only for `default`/`existing`; `create` always starts empty.

## `--ctx` grammar

Entries are listed newest-first (`list_context_entries`); index `0` is `@0`, mirroring `git stash@{0}`.

| Input | Behavior |
|-------|----------|
| `--ctx @N` | Recency index. Must exist, else `No context at index N (have M saved contexts)`. |
| `--ctx @N <words>` | `@N` addresses the context, `<words>` is the prompt for it. |
| `--ctx %id` | Use-or-create over the id namespace (= file names): exact id or unique hex prefix resumes, otherwise creates `<id>.txt`. |
| `--ctx %id <words>` | Same, with `<words>` as the prompt. |
| `--ctx <multi-word>` | `default` plan with `promptFromRef` = the value; a positional prompt is appended. Nothing saved under a generated id. |
| `--ctx <token>` (no positional prompt) | Prompt text for the default context (this used to be a bare name). |
| `--ctx <token> <positional>` | Hard error — naming a context requires `%`: `Invalid context reference "…" — naming a context requires %: use --ctx %<id>`. |
| `--ctx %id -n` | Explicit reset: starts empty even if `%id` exists. `-n` with a bare token is the same hard error. |
| `-c` | Default per-directory + model context (unchanged). |

Refs are consumed before `expand_mentions`, so `@N` never triggers a `mention "@N" not found` warning. Any real `@path` mention in the remaining prompt text still expands (see [mentions.md](mentions.md)).

Id validation (`sanitize_context_name`): trimmed, no whitespace, charset `^[A-Za-z0-9._-]{1,100}$`. This blocks path traversal (`%../../evil` rejected; covered by `test_name_reset_path_traversal_name_rejected`). `-n` without a valid `%id` is `error: -n/--name requires a context id: --ctx %<id> -n`, exit 1, no model call.

No conflict with `@path` file mentions: only `@<digits>` opens a ref, so a leading `@file` in `--ctx` stays prompt text and is expanded by `expand_mentions` (`--ctx "@a.ts explain"` works). An `@N` ref is a flag value resolved by `resolve_context_ref`; `@file` mentions are prompt tokens — different namespaces by construction.

Stderr notices: `Created context: <label>` for `create`, `Using context: <label>` for `existing`. `none`/`default` are silent (legacy behavior). Labels come from context file names, so they are echoed through `sanitize_label` (ANSI/OSC/C1 controls and newlines stripped) — a poisoned store cannot spoof the terminal or forge extra stderr lines. The same applies to the ids listed by the ambiguous-`%<hex>` error.

## Files and listing

* Dir: `~/.ai/tell_context/` (`context_dir`).
* Default file: `sha256("<cwd>\n<model_label>") + ".txt"` (`context_file`), where `model_label` is `vendor:model:thinking[:fast]` (`model_label`). Same directory + same resolved label share one file; different model → different file. Because the file name IS the id, `--ctx %<hash>` addresses the default context through the same namespace.
* Named file: `<id>.txt` (`named_context_file`).
* `-l/--list` is gone: listing lives in `--history` ([history.md](history.md)) — `@N | id | age | preview`, newest first. `short_id` truncates 16+ hex ids to 8 chars, leaves names intact (`history.ts`). `format_age`: `just now` / `Nm ago` / `Nh ago` / `Nd ago` (`history.ts`). Preview: first user turn, 60 chars max (`preview_from_text`, `history.ts` — handles both `User: text` and `User:\ntext` layouts). Empty → `No saved contexts.`.

## Persistence mechanics

* Prompt prefix: when `previous_context` is non-empty, the model receives `Previous context:\n<ctx>\n\nUser:\n<full_prompt>`; the in-memory timeline starts as `User:\n<full_prompt>`.
* Incremental saves (`save_incremental_context`): after the assistant turn and after each executed command (chain), recompute the full turn from the timeline (`conversation_text` = `timeline.join('\n')`, think-tags stripped) and overwrite the file. Overwrite — not append — so chain rounds appear exactly once (regression test `test_incremental_context_saves_do_not_duplicate_turns_on_chain`).
* Budget: `write_context` truncates to the last `MAX_CONTEXT_CHARS` (64K) with an `[older context truncated]` marker (`limit_context`). `maybe_summarize_context` instead AI-summarizes `previousContext` via SDK `summarize_context` when `previous + turn` exceeds the budget, falling back to plain concatenation. Write failures warn on stderr; summarize failures set exit 1.
* Stored context is untrusted data: it is fed back as prompt text, never rescanned for `<RUN>`. A poisoned file containing `<RUN>echo PWN</RUN>` does not auto-execute (tests `test_poisoned_named_context_does_not_autoexecute`, injection test in security suite).

## Worked examples

```bash
tell -c "remember that this project uses PostgreSQL"
tell -c "now add a users table migration"   # Previous context: …

tell --ctx %myproj "seed the project"       # Created context: myproj
tell --ctx %myproj "continue"               # Using context: myproj
tell --ctx %myproj -n "start over"          # Created context: myproj (empty)

tell d --ctx ola                            # prompt text on the default context (no name)
tell d --ctx "what did I say?"              # multi-word prompt on the default context
tell d --ctx @0 "resume most recent"        # @N ref + prompt
tell d --ctx %a1b2c3 "resume by hash"       # unique hex-prefix resume

tell --history @0                            # cat the most recent context (from history)
```

Sources: `packages/cli/src/Tell.ts` (`sanitize_context_name`, `split_ctx_value`, `resolve_context_ref`, `build_context_plan`, `run_tell`); tests `test/test-tell-context.js`, `test/test-tell-security.js`.
