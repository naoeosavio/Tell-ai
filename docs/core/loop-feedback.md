# Command-feedback wording

`src/loop-feedback.ts` owns the command-feedback protocol shared by every host — the exact headers the model sees, the CLI logs, the Web chain messages and the offline fallback loop store. Pure text helpers on purpose: no builtin imports, no environment, no I/O. The browser bundle imports the same module through the `browser` condition of the main entry, so the Web fallback loop can never drift from the server wording.

## Records

| Helper | Text |
|---|---|
| `format_executed_command(script, output)` | `Executed command:\n<script>\nOutput:\n<output>` |
| `format_failed_command(script, output, exit_code)` | `Command failed (exit code N):\n<script>\nOutput:\n<output>` (null code drops the parenthetical) |
| `format_command_result(script, output, exit_code)` | Dispatches on the exit code: 0 → executed, else failed |
| `format_command_skipped(script)` | `Skipped by user:\n<script>` |
| `format_cancelled_command(script)` | `Command cancelled:\n<script>` |
| `format_command_status(status, script)` | `Command <status>:\n<script>` (denied / awaiting_approval / requested / skipped markers) |

## Round feedback

`format_command_feedback(script, output, exit_code, { with_instruction: true })` wraps the record for the next model turn: the record, plus the `COMMAND_FEEDBACK_FAILED_PREAMBLE` (`The command above FAILED. Analyze the error output and try a corrected approach.`) when the exit code is non-zero, plus the `COMMAND_FEEDBACK_INSTRUCTION` (`Request another command with <RUN> tags if needed; otherwise answer without <RUN> tags.`). The loop (`loop.ts:45-47`) builds every follow-up prompt through this helper — no host assembles the wording itself.

## Parser

`parse_command_feedback(text)` parses any wording this module formats back into `{ kind, script, output, exit_code }` (`executed` / `failed` / `skipped` / `cancelled`; exit code `null` when the text states none). It strips the round preamble and continuation line first, so full round feedback parses the same as a bare record. Anything else returns `null`. `split_context_turns` ([runtime-limits.md](runtime-limits.md)) recognizes every header here, so context truncation never cuts a record in half.

Sources: `packages/core/src/loop-feedback.ts`, `packages/core/src/loop.ts:45-47`, `test/test-core-loop-feedback.js`.
