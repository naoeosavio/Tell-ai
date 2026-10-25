# Command execution

The model proposes commands by wrapping them in `<RUN>…</RUN>` tags. The core runtime extracts the first block, confirms through the CLI approval port, runs it under `/bin/bash` via the CLI executor port, and iterates per the mode. `<think>` blocks are stripped before extraction, so commands inside reasoning never execute. Risk classification, the scrubbed environment and the ports live in `packages/cli/src/core-adapters.ts` (delegating to `@tell-ai/core`); `Tell.ts` keeps prompting, files and rendering.

## Response handling per round (`run_response_loop` over `create_core_runtime`)

1. Model port call (`Thinking...` on stderr; live tokens on stdout with `--stream`).
2. `onText` → `remember_assistant` (raw response) + optional incremental context save.
3. The wiring strips tags, extracts the first `<RUN>` script and classifies risk.
4. No script → run completes; the visible text prints once (non-stream).
5. `onCommandOutput`/`onCommandSkip` → legacy result lines (`Executed command:` / `Command failed:` / `Skipped by user:` / `Command execution disabled — not run:`) appended to the log, mirrored to the timeline, optional context save.
6. Non-chain (`max_rounds: 1`): commands ran but visible text is empty → one more model call with tags stripped, break. Chain (`max_rounds: 8`): declined commands resume with conversation-plus-instruction feedback until clean, skipped, or capped.

`visible` is printed to stdout; command output is echoed to stderr (dimmed when TTY) and embedded in the feedback string, never printed to stdout directly.

## Per-command outcomes (mirrored from runtime callbacks)

Per command (single `<RUN>` block per round; only the first block runs):

* `--no-exec`: stderr `Command execution disabled (--no-exec).`, result recorded as `Command execution disabled — not run:\n<script>`, `failed: false`. No confirmation, no process. Overrides `-y`.
* Confirmation (`confirm_command`): skip → stderr `Command skipped by user.`, result `Skipped by user:\n<script>`, `failed: false`.
* Execute (CLI executor port, `create_cli_executor` in `src/core-adapters.ts`, a thin seam over the core `create_node_executor`): `/bin/bash`, `cwd: process.cwd()`, buffer cap 32 MiB (`--max-buffer`, the internal exec buffer — the value is forwarded to the runtime so the executor really stops at it), `timeout: 120s`, scrubbed env. Stdout+stderr echoed to stderr. Success → `Executed command:\n<script>\nOutput:\n<output>`; failure → `Command failed (exit code N):\n<script>\nOutput:\n<output>`, `failed: true`. `SIGTERM`-on-timeout reports exit 124 with `Command timed out after 120s` (the output produced before the timeout is kept).
* Results append to the history log file; chain feedback carries the converged `Executed command:` header plus the failure directive (`packages/core/src/loop.ts`).

## Confirmation (`confirm_command` + approval port)

* Risk labels come from the core permissive classifier (`is_high_risk_script` in `src/core-adapters.ts`): high-risk → `High-risk command requested`, outside-cwd → `Command touches paths outside the working directory`, else `Command requested`; script echoed to stderr. Authorization flows through `create_cli_approval` (safe auto-risk scripts approve without prompting; declines record `skipped`).
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

Core permissive classification (`assess_base_risk`, `packages/core/src/risk.ts`) normalizes backslash-newlines and whitespace, then matches: `sudo/doas/pkexec`, `rm -rf` (any `-rf` flag combo), `git clean -[xfd]`, `mkfs/shutdown/reboot`, `dd … of=`, `chmod|chown` on privileged paths (non-recursive included; recursive `-R` anywhere), `curl|wget|base64 … | sh|bash|python|perl|ruby|php|node`, process substitution `<(curl|wget|base64…)` / `sh … <(…)`, network/decode-coupled interpreter one-liners (`node|python|perl|ruby|php -e/-c/-r … http…|urllib|requests|socket|base64|eval|exec|system|popen`), `curl|wget|base64 … ;|&&|| … interpreter`, `crontab` / `systemctl --user enable`, writes/redirects into `/etc /boot /dev /proc /sys /usr /bin /sbin /lib* /var/spool/cron /etc/cron* ~/.config/autostart ~/.local/share/systemd/user` via `cp|mv|ln|sed -i|tee|>`. Full pattern table in [security.md](security.md).

Deliberately allowed: local-only interpreter one-liners such as `node -e "console.log(1)"` — only network/decode-coupled inline code is high-risk (asserted in `test-tell-security.js:179-183`).

## Limits

* One command per round (first `<RUN>` block only).
* Each command: 120s timeout, 32MiB output cap.
* Chain mode: at most 8 command rounds per invocation (see [chain-mode.md](chain-mode.md)).

## Delegation precedence (`<DELEGATE>` / `<SUBTASK>` win over `<RUN>`)

Chain-only, no new flag: with `--chain` the parent prompt gains the core-owned delegation section (appended after the SDK prompt). At most one delegation tag per answer. When a delegation tag and `<RUN>` appear together, the delegation wins and the `<RUN>` is recorded `Skipped by user:`, never executed.

* `<DELEGATE>` (research) is read-only: `create_read_only_approval` denies sensitive paths first (`.env*`, `.tell/**`, `.git/**`, `*.key`, `*.pem`, `id_rsa` family — checked on path-like tokens in the command text, so `git show HEAD:.env` denies), then metacharacters/write rules (`>`, `|`, `;`, `&&`, `$(`, backticks, `find -delete/-exec`, `git checkout`), then the host approval. Deny-by-default, with or without `-y`. Two precision rules (live 2026-10-24): fd duplication (`2>&1`, `>&2`) is not a file redirect and stays allowed — every other `>`/`&` still denies; absolute tokens lexically inside the host cwd are left to the allowlist + the host realpath gate (models are told the absolute cwd and emit it), absolute outside stays denied, and without a cwd every absolute token still denies.
* `<SUBTASK>` (build) inherits the host approval (`--no-exec` wins everywhere, `-y` auto-executes safe builds, high-risk still asks, outside-cwd still gates). Without `-y` the Web parks the child script on a nested approval (server chain `childPending`, stateless delegate `202 awaiting_approval` + confirm) instead of denying; `denied` with motive (never `skipped`) now only covers `--no-exec`, high-risk, concurrency/budget exhaustion and TTL/restart expiry.
* The parent only receives `Research result:` / `Task result:` (`cap(redact(text))`, 2 KiB) plus one host-assembled stats line. Child caps: ≤3 rounds, ≤8 KiB per command, ≤16 KiB context, ≤4 KiB objective. Parent budget: `max_chain_steps >= 2 ? min(4, max(1, floor(max_chain/4))) : 0` (`--max-chain 1` → 0, tag stays inert). Delegation does not wait for `PolicyDecision` (policy-sandbox exception, revocable).

Sources: `packages/cli/src/core-adapters.ts`, `packages/cli/src/Tell.ts` (`run_response_loop`), `packages/core/src/loop.ts`. Core reference: [../core/exec.md](../core/exec.md), [../core/risk.md](../core/risk.md), [../core/loop.md](../core/loop.md).
