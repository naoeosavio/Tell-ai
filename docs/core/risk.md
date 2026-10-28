# Base risk classification

`assess_base_risk` (`src/risk.ts`) classifies one script with observable base rules — and nothing else. It returns a `RiskAssessment` (severity, category, reasons, observable flags), never an `allow|confirm|deny` verdict. The future policy engine composes the assessment; it never replaces the classifier, the executor or the loop.

```ts
import { assess_base_risk, create_base_risk_port } from '@tell-ai/core';

assess_base_risk('sudo rm -rf /', 'permissive');
// { risky: true, severity: 'high', category: 'destructive', reasons: [...], flags: [...] }
```

## Profiles

| Profile | Host | Behavior |
|---------|------|----------|
| `permissive` (default) | CLI | Local-only interpreter one-liners pass; only network/decode-coupled eval is risky; credential-file reads are high-risk (explicit confirm) |
| `strict` | Web | Any interpreter `-c`/`-e`, `env` launches, `base64 -d`, shell expansions and credential-file access are risky (blocked outright) |

Common rules run in both profiles, including credential-file reads. `permissive_only` rules keep the CLI divergences verbatim (broad download pipes, process substitution, network-gated interpreter eval, direct privileged `chmod`); `strict_only` rules keep the Web divergences verbatim (any interpreter eval, `env`, `base64 -d`, shell expansions). The remaining divergence is test-pinned — do not "dedupe". `create_base_risk_port(profile)` wraps the classifier as a `RiskPort` for runtime injection.

## Rules

Scripts are compacted first (backslash-newlines → spaces, whitespace collapsed), then matched:

* Common (both): `sudo/doas/pkexec`, `sh -c` strings, `curl/wget/nc/ssh/ftp` clients, `printenv`, `/proc` access, `rm -rf` (any `-rf` flag combo), `git clean -f`, `mkfs/shutdown/reboot`, `dd … of=`, recursive `chmod/chown -R /`, `crontab` / `systemctl --user enable`, `cp/mv/ln` + `sed -i` + `tee` + redirects into privileged paths (`/etc /boot /dev /proc /sys /usr /bin /sbin /lib* /var/spool/cron /etc/cron* ~/.config/autostart ~/.local/share/systemd/user`), and credential-file access (`.env*` except `.env.example`, `*.key`/`*.pem`/`*.p12`, `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`, `.git/**`, `.tell/**`, `.aws/credentials`, `~/.config/*.token`). The last rule keeps command execution at parity with the file API: a model cannot read a secret through a command without explicit approval (CLI) or at all (Web), so it cannot silently send it to the provider.
* Permissive-only: download piped into a shell/interpreter, `<(curl|wget|base64…)` process substitution, `sh … <(…)` readers, network/decode-coupled interpreter one-liners (`-e/-c/-r … http…|urllib|requests|socket|base64|eval|exec|system|popen`), download chained into an interpreter.
* Strict-only: any interpreter eval flag (`python3|node|deno|bun|perl|ruby|php|lua` with `-c`/`-e`/`-r`/`--eval`/`eval`), bare `env`, `base64 -d/--decode`, `${…}` brace expansion, `$(…)` substitution, backtick pipelines.

Highest severity wins (`high` beats `medium`); the winning rule's category is reported; every match contributes its reasons and flags (deduplicated). No match → `{ risky: false, severity: 'low', category: 'general', reasons: [], flags: [] }`.

## Consumers

* CLI (`packages/cli/src/core-adapters.ts`): `assess_cli_risk` (permissive) + `is_high_risk_script` (thin boolean preserving the historical contract). High-risk or outside-cwd scripts need explicit confirmation even with `-y`. Full UX: `../cli/security.md`.
* Web (`packages/web/src/server/guards.ts`): stricter gate drives Require Approval; classification failure is fail-closed (manual approval).

Sources: `packages/core/src/risk.ts`, `src/runtime-api.ts:147-183` (`RiskAssessment`/`RiskPort`), `packages/cli/src/core-adapters.ts:59-74`, `test/test-core-risk.js`.
