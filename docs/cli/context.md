# Context (`-c`, `--ctx`, `-n`)

Contexts no longer have their own lister: `-l` is inherited by `--history` (see [history.md](history.md)), which lists contexts and conversations together and reopens entries by `@N`/`%N`.

Explicit design: no value guessing. A single token after `--ctx` is always a ref/name, never a prompt. Multi-word values are prompt text for the default context. Unnamed contexts are never saved.

## `ContextPlan` (`Tell.ts:55-59`)

```ts
type ContextPlan =
  | { $: 'none' }                                        // no flag: fresh, delete default
  | { $: 'default'; file: string; promptFromRef?: string } // -c | bare --ctx | multi-word --ctx
  | { $: 'existing'; file: string; label: string }         // resolved @N / #hash / name
  | { $: 'create'; file: string; label: string };          // --ctx <new-name> [-n]
```

Built by `build_context_plan(opts, model, entries)` (`Tell.ts:315-324`):

* `opts.name` (`-n`): requires `--ctx <valid-name>`; always returns `create` (explicit reset, even if the name exists).
* `opts.ctx === true || opts.context` (`-c` / bare `--ctx`): `default`.
* `typeof opts.ctx === 'string'`: `resolve_or_create_context_ref`.
* Otherwise: `none`.

`run_tell` then (`Tell.ts:676-695`): `save_context = plan.$ !== 'none'`; `context_path` is the plan file (or the default hash path for `none`, which is deleted); `previous_context` is read only for `default`/`existing`; `create` always starts empty.

## `--ctx <ref>` resolution (`Tell.ts:267-310`)

Entries are listed newest-first (`list_context_entries`, `Tell.ts:184-198`); index `0` is `@0`, mirroring `git stash@{0}`.

| Shape | Example | Behavior |
|-------|---------|----------|
| `@N` | `--ctx @0` | Recency index. Must exist, else `No context at index N (have M saved contexts)`. |
| `#hex` | `--ctx '#a1b2c3'` | Hash-prefix match on file id (case-insensitive). Exactly one match required; zero → `No context matches hash`; 2+ → `Ambiguous context hash … matches: …`. Hex only. |
| `name` | `--ctx myproj` | Use-or-create: resumes when the id matches, else `create` at `named_context_file(name)`. |
| multi-word | `--ctx "what did I say?"` | `default` plan with `promptFromRef` = the value. Nothing saved under a generated id. |
| invalid single token | `--ctx bad/name` | Hard error `Invalid context reference … use @N, #hash-prefix, or a name`. Never reinterpreted as prompt. |

Name validation (`sanitize_context_name`, `Tell.ts:256-260`): trimmed, no whitespace, charset `^[A-Za-z0-9._-]{1,100}$`. This excludes `@`/`#` (ref syntax) and blocks path traversal (`../../evil` rejected; covered by `test_name_reset_path_traversal_name_rejected`). `-n` with a missing/invalid name is `error: -n/--name requires a context name: --ctx <name> -n`, exit 1, no model call.

No conflict with `@path` file mentions: `--ctx @N` refs are flag values resolved by `resolve_or_create_context_ref`, while `@file` mentions are prompt tokens expanded by `expand_mentions` — different namespaces by construction (see [mentions.md](mentions.md)).

Stderr notices: `Created context: <label>` for `create`, `Using context: <label>` for `existing` (`Tell.ts:668-674`). `none`/`default` are silent (legacy behavior).

## Files and listing

* Dir: `~/.ai/tell_context/` (`context_dir`, `Tell.ts:165-167`).
* Default file: `sha256("<cwd>\n<model_label>") + ".txt"` (`context_file`, `Tell.ts:169-173`), where `model_label` is `vendor:model:thinking[:fast]` (`model_label`, `Tell.ts:83-86`). Same directory + same resolved label share one file; different model → different file.
* Named file: `<name>.txt` (`named_context_file`, `Tell.ts:178-180`).
* `-l/--list` is gone: listing lives in `--history` ([history.md](history.md)) — `@N | id | age | preview`, newest first. `short_id` truncates 16+ hex ids to 8 chars, leaves names intact (`history.ts`). `format_age`: `just now` / `Nm ago` / `Nh ago` / `Nd ago` (`history.ts`). Preview: first user turn, 60 chars max (`preview_from_text`, `history.ts` — handles both `User: text` and `User:\ntext` layouts). Empty → `No saved contexts.`.

## Persistence mechanics

* Prompt prefix: when `previous_context` is non-empty, the model receives `Previous context:\n<ctx>\n\nUser:\n<full_prompt>`; the in-memory timeline starts as `User:\n<full_prompt>` (`Tell.ts:682-688`).
* Incremental saves (`save_incremental_context`, `Tell.ts:349-359`): after the assistant turn and after each executed command (chain), recompute the full turn from the timeline (`conversation_text` = `timeline.join('\n')`, think-tags stripped) and overwrite the file. Overwrite — not append — so chain rounds appear exactly once (regression test `test_incremental_context_saves_do_not_duplicate_turns_on_chain`).
* Budget: `write_context` truncates to the last `MAX_CONTEXT_CHARS` (64K) with an `[older context truncated]` marker (`limit_context`, `Tell.ts:339-347`). `maybe_summarize_context` (`Tell.ts:630-653`) instead AI-summarizes `previousContext` via SDK `summarize_context` when `previous + turn` exceeds the budget, falling back to plain concatenation. Write failures warn on stderr; summarize failures set exit 1.
* Stored context is untrusted data: it is fed back as prompt text, never rescanned for `<RUN>`. A poisoned file containing `<RUN>echo PWN</RUN>` does not auto-execute (tests `test_poisoned_named_context_does_not_autoexecute`, injection test in security suite).

## Worked examples

```bash
tell -c "remember that this project uses PostgreSQL"
tell -c "now add a users table migration"   # Previous context: …

tell --ctx myproj "seed the project"        # Created context: myproj
tell --ctx myproj "continue"                # Using context: myproj
tell --ctx myproj -n "start over"           # Created context: myproj (empty)

tell --history @0                            # cat the most recent context (from history)
tell --ctx @0 "resume most recent"
tell --ctx '#abc12' "resume by hash"
```

Sources: `Tell.ts:158-324`, `Tell.ts:326-359`, `Tell.ts:630-714`; tests `test/test-tell-context.js`, `test/test-tell-security.js:315-342`.
