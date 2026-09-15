# Command execution

The model proposes commands by wrapping them in `<RUN>…</RUN>` tags. The CLI extracts them with SDK `extract_runs`, confirms, runs each under `/bin/bash`, and feeds results back according to the mode. `<think>` blocks are stripped before extraction, so commands inside reasoning never execute.

## Response handling per round (`run_response_loop`, `Tell.ts:594-628`)

1. `tell_silently` (model call, `Thinking...` on stderr).
2. `remember_assistant` + optional incremental context save.
3. `strip_think_tags` → `extract_runs(response)` → `{ scripts, visible }`.
4. `should_finish(scripts, state)`: no scripts or chain limit reached → `finish_round` (warn + print `visible`), break.
5. `run_scripts` → `remember_command_result` → optional context save.
6. Non-chain: `handle_final_answer` (print `visible`, else one more model call with tags stripped), break. Chain: `remember_command_round`, `build_feedback`, next model call with `chain: true`.

`visible` is printed to stdout; command output is echoed to stderr (dimmed when TTY) and embedded in the feedback string, never printed to stdout directly.

## `run_script` / `run_scripts` (`Tell.ts:422-458`)

Per script:

* `--no-exec`: stderr `Command execution disabled (--no-exec).`, result recorded as `Command execution disabled — not run:\n<script>`, `failed: false`. No confirmation, no process. Overrides `-y`.
* Confirmation (`confirm_command`): skip → stderr `Command skipped by user.`, result `Skipped by user:\n<script>`, `failed: false`.
* Execute (`execute_command`, `Tell.ts:109-136`): `/bin/bash`, `cwd: process.cwd()`, `maxBuffer: 32MiB`, `timeout: 120s`. Stdout+stderr echoed to stderr. Success → `Executed command:\n<script>\nOutput:\n<output>`; failure → `Command failed (exit code N):\n<script>\nOutput:\n<output>`, `failed: true`. `SIGTERM`-on-timeout reports exit 124 with `Command timed out after 120s`.
* `run_scripts` appends each result to the history log file and joins results with blank lines for the next prompt. A failed command prefixes the next prompt with `The command above FAILED. Analyze the error output and try a corrected approach.` (`build_feedback`, `Tell.ts:589-592`).

## Confirmation (`confirm_command`, `Tell.ts:394-420`)

* `is_high_risk_script` → label `High-risk command requested`, else `Command requested`; script echoed to stderr.
* `-y` approves only non-high-risk scripts that stay inside the working directory. High-risk with `-y` still prompts.
* Outside-cwd gate (`script_touches_outside_cwd`): with `-y`, any command referencing a path that resolves outside the working directory (reads included, mirroring the `@path` mention gate) needs confirmation. Tokens matched: absolute `/…`, `~/…`, `$HOME/…`, `../…`, `./…`, bare `..`/`~`, after `=`, inside quotes; resolution reuses `is_outside_cwd` from `mentions.ts` (lexical + symlink/realpath). When cwd IS `$HOME`, `~/x` resolves inside and stays allowed.
* `--require-approval` makes the approval posture explicit: combined with `-y` the behavior is unchanged (safe commands auto-run, high-risk asks); alone every command asks, same as the default. It never weakens the gate and is forwarded by `-w`/`--web` to seed the sandbox's Require Approval toggle.
* Non-TTY stdin: always reject (return `false`) — automation cannot be tricked into approving.
* TTY prompt `Execute this command? [y/N]` accepts `y`/`yes` (case-insensitive); anything else rejects. Auto-rejects after `EXEC_TIMEOUT` (120s).

```bash
tell d "run ls -la"        # asks before executing
tell -y d "run ls -la"     # auto-approves safe commands; high-risk and outside-cwd still ask
tell -y --require-approval d "run ls -la"  # same as -y, posture explicit (forwarded to -w)
tell --no-exec d "run ls"  # never executes
```

`-y` is for disposable/sandboxed environments. The high-risk guard is heuristic, not a sandbox. See [security.md](security.md).

## What is blocked

`is_high_risk_script` (`Tell.ts:361-392`) normalizes backslash-newlines and whitespace, then matches: `sudo/doas/pkexec`, `rm -rf` (any `-rf` flag combo), `git clean -[xfd]`, `mkfs/shutdown/reboot`, `dd … of=`, `chmod|chown` on privileged paths (non-recursive included; recursive `-R` anywhere), `curl|wget|base64 … | sh|bash|python|perl|ruby|php|node`, process substitution `<(curl|wget|base64…)` / `sh … <(…)`, network/decode-coupled interpreter one-liners (`node|python|perl|ruby|php -e/-c/-r … http…|urllib|requests|socket|base64|eval|exec|system|popen`), `curl|wget|base64 … ;|&&|| … interpreter`, `crontab` / `systemctl --user enable`, writes/redirects into `/etc /boot /dev /proc /sys /usr /bin /sbin /lib* /var/spool/cron /etc/cron* ~/.config/autostart ~/.local/share/systemd/user` via `cp|mv|ln|sed -i|tee|>`. Full pattern table in [security.md](security.md).

Deliberately allowed: local-only interpreter one-liners such as `node -e "console.log(1)"` — only network/decode-coupled inline code is high-risk (asserted in `test-tell-security.js:179-183`).

## Limits

* One command per `<RUN>` block; multiple blocks run sequentially in order.
* Each command: 120s timeout, 32MiB output cap.
* Chain mode: at most 8 command rounds per invocation (see [chain-mode.md](chain-mode.md)).

Sources: `Tell.ts:109-136`, `Tell.ts:361-458`, `Tell.ts:594-628`.
