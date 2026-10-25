# Chain mode (`--chain`)

Without `--chain`, the CLI runs at most one command round: execute the requested scripts, then print the visible text or ask once for a final answer. With `--chain`, it loops — run commands, feed output back, repeat — until the model answers without `<RUN>` tags or the 8-round limit is hit.

```bash
tell --chain "find out why the build is failing and fix it"
npm run build 2>&1 | tell --chain -i "fix the build errors"
tell -c --chain "migrate the schema, then verify"   # + persistent context
```

## Loop (`run_response_loop` delegates to `create_core_runtime`)

State: `ConversationState` — `firstPrompt` (unwrapped; the runtime composes `Previous context:` from seeded storage), `timeline[]`, `autoContinue (= --chain)`, `execMode`, `saveContext`, `coreConfig`.

```
runtime = create_core_runtime({ config, model: cli_model_port, storage: seeded,
  executor: cli_executor, approval: cli_approval, risk: permissive_port,
  system, callbacks: file_mirrors, max_rounds: chain ? 8 : 1 })
result = runtime.run(firstPrompt)
chain && declined && under cap → runtime.run(feedback) again (merged)
render result.text once (non-stream); default mode with commands but empty
text asks once more without `<RUN>` (legacy final answer)
```

The first call uses `{ chain: autoContinue }` so the system prompt advertises multi-step behavior only in chain mode; the single fixed system covers every round. The system prompt itself comes from the SDK `get_system_prompt({ chain, cwd, platform })`, called in `Tell.ts`. Streaming, reasoning display and raw-response capture live inside the model port (`create_cli_model` in `src/core-adapters.ts`); log/context files are mirrored from the runtime callbacks (`Assistant:` raw, legacy result lines, overwrite saves).

## Feedback and termination

* `conversation_text` = `timeline.join('\n')` (mirrored from callbacks for logs, context saves and resume prompts).
* Chain feedback is owned by `packages/core/src/loop-feedback.ts` (`format_command_result`, re-exported by `loop.ts` as `build_loop_feedback`): `Executed command:\n<script>\nOutput:\n<output>` (or the `Command failed (exit code N)` variant with the `FAILED` self-healing prefix) plus `Request another command with <RUN> tags if needed; otherwise answer without <RUN> tags.` Cancelled and skipped rounds use `Command cancelled:` / `Skipped by user:` from the same owner, and `split_context_turns` (`runtime-limits.ts`) splits every one of those headers, so context truncation never cuts a record in half. History travels through the storage port; declines resume with the legacy conversation-plus-instruction prompt.
* Stop when no scripts are requested, approval declines without chain resume, or the 8-round cap is hit (stderr warns `Chain limit reached (8); asking for final answer.` + `ignoring further requested commands.`).
* Default (non-chain) mode runs at most one command round (`max_rounds: 1`); when commands ran but the visible answer is empty, one extra model call without `<RUN>` guarantees a visible answer. Guarantees a visible answer even when the model only emitted commands.

## Context interplay

Chain alone does not persist across invocations (`saveContext = false` without `-c`/`--ctx`). `-c --chain` reads previous context once, then `save_incremental_context` overwrites the file after the assistant turn and after every command round — full-timeline recompute, so each round is stored exactly once. Final AI summarization via `maybe_summarize_context` applies on top when over budget. See [context.md](context.md).

## Failure-aware example

1. `tell --chain "fix the build"` → `<RUN>npm run build</RUN>` → exit 2, TS errors.
2. Feedback: `Command failed (exit code 2): … + The command above FAILED… + full conversation + Request another command…`.
3. Model replies `<RUN>…fix…</RUN>` + repeats until clean, then a final answer without tags.

Timeouts still apply per command (120s). A hanging command reports exit 124 and the loop continues with that output as context.

## Delegation (`<DELEGATE>` research, `<SUBTASK>` build)

Chain-only (no new flag): with `--chain` the prompt gains the core-owned delegation section (`delegation_prompt_section('both')` on the CLI, appended after the SDK prompt; Web uses `'research'` or `'both'` depending on `-y`). One tag per answer at most; delegation wins over `<RUN>` (any `<RUN>` in the same answer is recorded `Skipped by user:`, never executed).

- `<DELEGATE>` is read-only: the core wraps approval with `create_read_only_approval` (sensitive paths deny first, then metacharacter/write rules, then the host approval). Deny-by-default: `cat`/`ls`/`git log` pass; `sed -i`, `rm`, `>`, `|`, `;`, `find -delete`, `git checkout`, `cat .env` deny with or without `-y`. Precision: fd duplication (`2>&1`) stays allowed and absolute paths inside the host cwd are scoped to the allowlist + host gate (see [execution.md](execution.md)).
- `<SUBTASK>` inherits the host approval (CLI in-process, Web Auto-Run with `-y`); where the host would have to ask over HTTP the tag is denied with motive (`denied`, never `skipped`).
- The parent only receives `Research result:` / `Task result:` + one host-assembled stats line (`cap(redact(text))`, 2 KiB); raw child stdout never climbs. The child runs ≤3 rounds with its own bounded storage (16 KiB) and never recurses (no runner inside). Child scripts are audited to the run log as `Child command (<status>):` (log-only, never parent context). A tag-only parent answer with no commands still asks once more for a visible answer instead of printing nothing (the model can still stay silent — the guarantee is the extra ask, not the words).
- Budget: `max_chain_steps >= 2 ? min(4, max(1, floor(max_chain/4))) : 0` (default 8 → 2; `--max-chain 1` → 0, the tag stays inert).

Sources: `packages/cli/src/Tell.ts` (`run_response_loop`), `packages/cli/src/core-adapters.ts`, `packages/core/src/loop.ts`; chain assertions in `test/test-tell-security.js:278-313`. Core reference: [../core/loop.md](../core/loop.md), [../core/loop-feedback.md](../core/loop-feedback.md).
