# History (`-l`, `--history`)

`-l/--history` is the single lister for everything `tell` stores on disk: saved contexts (`~/.ai/tell_context/`) and conversation logs (`~/.ai/tell_history/`). It replaced the old `-l, --list` (contexts-only) flag. It runs before prompt/stdin handling — no prompt, no API key, no network — and never sends anything off the machine: it reads and greps `~/.ai/` locally.

## Grammar

| Invocation | Behavior |
|------------|----------|
| `tell -l` / `tell --history` | Combined listing: `Contexts:` table (`@N \| id \| age \| preview`) followed by `Conversations:` table (`%N \| date \| model \| preview`), both newest first. |
| `tell --history @N` | Reprints context N in full — the same file `--ctx @N` would resume. |
| `tell --history %N` | Reprints conversation N in full (its `conversation_<timestamp>.txt` log). |
| `tell --history "term"` | Case-insensitive search over both directories; hits printed as `@N context …` / `%N conversation …` rows with the matched line (highlighted on TTY, clipped to ~120 chars). |

`%N` inside `--history` is always a conversation (`%` needs no shell quoting — `#` starts a shell comment, so the old `#N` form required quotes). Context refs are `@N`/`%id` inside `--ctx` — namespaces per flag, documented in [context.md](context.md); the `#hash` prefix was removed with the `--ctx` re-grammar.

## Invariant

`--history @N` opens the same file `--ctx @N` addresses: both index `list_context_entries()` newest-first (`@0` = most recent, mirroring `git stash@{0}`). `%N` indexes conversation logs newest-first (mtime), matching the recency order of the listing.

## Previews and columns

* Context rows reuse the old listing columns: `short_id` truncates 16+ hex ids to 8 chars; `format_age` prints `just now` / `Nm ago` / `Nh ago` / `Nd ago`.
* Preview: first user turn of the store, 60 chars max. Handles both `User: text` and `User:\ntext` layouts, so the preview shows the actual prompt text, not the bare marker line.
* Conversation rows show the ISO timestamp from the filename (`YYYY-MM-DD HH:MM`), the model label (`vendor:model:thinking[:fast]`, or `(unknown)`), and the same preview style.

## Exit codes

| Case | Exit |
|------|------|
| Listing, valid `@N`/`%N`, empty term (prints a hint) | 0 |
| Invalid `@N` | 1 — `No context at index N (have M saved contexts)` |
| Invalid `%N` | 1 — `No conversation at index N (have M conversations)` |
| Search without matches | 1 — `No matches for "term" in contexts or conversations.` |

## Security

* Echoed content is sanitized: `show_entry`, listings and search snippets strip ANSI escape sequences (CSI/OSC), C0 and 8-bit C1 control characters before printing — conversation logs replay raw command stdout/stderr, so a poisoned log cannot spoof the terminal or touch the clipboard (OSC 52) via `--history`. The C1 range (`U+0080`–`U+009F`) matters because some terminals read `U+009B`/`U+009D` as CSI/OSC.
* Stores stay private: `~/.ai/tell_history` and `~/.ai/tell_context` are tightened to `0700` dirs / `0600` files on every write, not just at creation — a store left world-readable by an older version (or a lax umask) is repaired the next time `tell` writes to it.
* Files that vanish between `readdir` and `stat` (dangling symlinks, concurrent removal) are skipped instead of crashing; listing order is stable on equal mtimes (name tie-break), so `@N`/`%N` refs don't flip between calls.

## Examples

```bash
tell -l                          # both tables
tell --history @0                # cat the most recent context
tell -l %0                       # cat the most recent conversation
tell --history "kafka consumer"  # search contexts + conversations
tell -l %0                       # re-read a search hit in full
```

## Implementation

New module `packages/cli/src/history.ts`: `list_sessions()`, `search_contexts()`, `search_sessions()`, `print_history_list()`, `print_search_results()`, `show_entry()`. The module only reads; `Tell.ts` injects the existing `ContextEntry[]` from `list_context_entries()` (shared type + `short_id`), so context indexing stays single-sourced. Tests: `test/test-tell-context.js` (`test_history_*`, plus the adapted `test_context_list_shows_saved_entries`).

Sources: `packages/cli/src/history.ts`, `run_history_dispatch` in `Tell.ts`.
