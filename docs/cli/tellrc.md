# `.tellrc` — profiles, aliases, temperature and limits

The only persisted config file is INI. There is deliberately no `tell.config.json`: JSON appears only as data output, never as a competing config source. Implemented in `packages/cli/src/tellrc.ts` (no new dependency), resolved per invocation in `Tell.ts` (`resolve_invocation_tellrc`, `Tell.ts:947`; model default in `main`, `Tell.ts:1091-1094`; run wiring in `run_tell`, `Tell.ts:972`).

```ini
# ~/.tellrc (user layer)
model = s
temperature = 0.7
profile = node

[aliases]
work = openai:gpt-6.1-sol:high

[profiles.node]
prompt = Prefer bun and TypeScript, concise answers.

[policy]
denyCommands = rm -rf /, mkfs

[limits]
max_chain_steps = 4
```

```ini
# <cwd>/.tellrc (project layer — wins scalar conflicts)
model = work
system-file = ./docs/ESTILO.md

[profiles.backend]
prompt = Backend reviewer: check handlers, migrations and tests.
model = s
temperature = 0.3
deny = mkfs

[profiles.backend.aliases]
rev = s+
```

## Custom profiles (`profiles.<name>`)

Any section `profiles.<name>` with `<name>` matching `^[a-z0-9][a-z0-9_-]*$` (`PROFILE_NAME_PATTERN`, sections are lowercased before parsing) is a valid profile — `node`, `security` and `devops` are just the built-ins that ship default prompt/style data. Custom names start empty; selecting one that is defined in no layer warns `profile <name> selected but not defined` (typo protection), and an invalid selection warns `invalid profile name`. Unknown sections such as `[profiles.Bad Name!]` or `[policy.x]` still warn `unknown section` and are skipped.

Profile bodies accept `prompt`, `style`, `model`, `temperature`, `system`, `system-file` (`system_file`), deny keys (`deny` / `denycommands` / `deny_commands`, comma-separated, repeatable) and the seven limit keys. The aliases subsection `profiles.<name>.aliases` holds that profile's own aliases (`rev = s+` above). Anything else warns `unknown profile key`.

## Sources and precedence (`resolve_tellrc`)

Two file layers merge: `~/.tellrc` (`load_tellrc`, rank 1) and `<cwd>/.tellrc` (rank 2). Absence is silent. Scalar precedence is `flag > env > project .tellrc > user ~/.tellrc > default`, with per-value provenance in `ResolvedTellrc.provenance` (`flag`, `env:TELL_MODEL`, file path, `profile:<name>`).

The exception is deny data: `deny_commands` is **union-only** (monotonic). Entries accumulate from every layer including the selected profile, and no flag or lower layer can remove one (`provenance['deny_commands'] = 'union'`). This task delivers deny as data only — matching and enforcement belong to the policy sandbox.

Env layer (scalars only, never secrets): `TELL_MODEL`, `TELL_SYSTEM`, `TELL_SYSTEM_FILE`, `TELL_TEMPERATURE`, `TELL_PROFILE`. CLI flags `--profile` / `--system` / `--system-file` / `--temperature` sit on top.

## INI grammar (`parse_tellrc`)

`key = value` lines; whole-line `#` / `;` comments; sections `[aliases]`, `[profiles.<name>]` (any valid name, plus an aliases subsection `profiles.<name>.aliases`), `[policy]`, `[limits]`. Inline `#` / `;` stays in values. Unknown sections/keys and lines without `=` produce a yellow stderr warning (no secrets in warnings) and are skipped. A repeated scalar keeps the last assignment; repeated deny entries accumulate. A NUL byte anywhere rejects the parse.

Top level accepts `model`, `system`, `system-file` (`system_file`), `temperature`, `profile`. `[policy]` accepts `deny_commands` / `denycommands` / `deny` (comma-separated). `[limits]` and profile bodies accept the seven keys validated by the runtime-limits owner: `max_chain_steps`, `max_buffer_bytes`, `context_chars`, `stdin_timeout_ms`, `stdin_max_bytes`, `exec_timeout_ms`, `output_max_bytes`. Profile bodies additionally accept `prompt`, `style`, `model`, `temperature`, `system`, `system-file`, deny keys, and carry their own aliases via the `profiles.<name>.aliases` subsection. Files over 256 KB (`TELLRC_MAX_BYTES`) are ignored with a warning.

## Profile resolution (fill-if-empty defaults)

A profile is an opinionated default, never an override: `model`, `temperature`, limits, `system` and `system-file` from the active profile fill their slots **only when no explicit layer set them** (flag > env > file). Profile `system-file` beats profile inline `system`, mirroring the top-level rule. Profile aliases merge **below** file-level `[aliases]` (project > user > profile): gaps are filled, never overridden. Profile deny entries always join the monotonic union. `provenance` records `profile:<name>` sources (`system`, `system_file`, `model`, `temperature`, `limits.*`, `aliases` when only the profile provided them).

## Model aliases (`resolve_model_input`)

Custom aliases live in a per-invocation table — `MODELS` is never mutated (deep-equal before/after is pinned by test). Resolution order per input: custom alias, built-in alias, dot-prefix fast (both tables consulted after the dot), otherwise the full `vendor:model[:thinking]` spec passes through. Valid everywhere the parser already accepts a model: `-m`, `--model` (`opt_model = opts.model ?? early_tellrc.model`, `Tell.ts:1092`), and the positional slot (`parse_args` takes `custom_aliases`, `Tell.ts:553-562`; a tellrc/env model suppresses positional detection exactly like `-m` does).

## System composition and safety (`compose_system_prompt`)

`tellrc_custom_text` collects top-level file text (or inline `system`), then profile file/inline system, then profile `prompt`/`style`, and `compose_system_prompt` prepends the result as `Custom instructions:` **before** the safety prompt — config can never replace `<RUN>`, approval, injection or deny rules, which stay last. Profile system is a fill-if-empty default: it appears only when no top-level system text exists (never duplicated with a filled slot, never stacked over an explicit choice). `TellOptions.system` remains an explicit library override for direct callers; the tellrc path only ever prepends.

`system-file` gates (`load_system_file_text`): 64 KB cap (`SYSTEM_FILE_MAX_BYTES`), regular file only, NUL rejected, `~` expanded in paths only. A project-layer file must stay inside the cwd — lexical check plus `realpath` symlink-target check — otherwise it is ignored with a warning. The same gates apply to a profile `system-file` (origin tracked per field in `system_file_from`). User/flag/env files are the caller's explicit choice, so only the project gate applies to them.

## Temperature and limits

`temperature` (0..2, `TEMPERATURE_MIN/MAX`, `tellrc.ts:10-11`) is validated at every layer; invalid values warn and are ignored. The SDK (`AskInstance.ask` / `ask_stream` / `TellOptions`) forwards it only when present and throws `RangeError` outside 0..2. The CLI threads it through `ConversationState.temperature` into `create_cli_model` (`core-adapters.ts`), covering silent and streaming paths.

Limits are validated data owned by `runtime-limits`; the parser imports the owner's key list (`TELLRC_LIMIT_KEYS`) and its non-throwing validator (`validate_tellrc_limit_value`) instead of keeping a second range table, so the two layers cannot drift. The dependency is one-way — `runtime-limits.ts` never imports the tellrc schema (`RuntimeLimitTellrcLayer.limits` is structural, and only `TELLRC_LIMIT_KEYS` names are read):

| `[limits]` key | Range | Env equivalent |
|---|---|---|
| `context_chars` | 1 KB – 1 MB | `TELL_CONTEXT_MAX_CHARS` |
| `stdin_timeout_ms` | 1 – 600 000 ms, or `0` to disable the deadline | `TELL_STDIN_TIMEOUT_MS` |
| `stdin_max_bytes` | 1 KB – 32 MB | `TELL_STDIN_MAX_BYTES` |
| `exec_timeout_ms` | 1 s – 600 s | `TELL_EXEC_TIMEOUT_MS` |
| `max_chain_steps` | 1 – 128 (default 8) | `TELL_MAX_CHAIN_STEPS` |
| `max_buffer_bytes` | 1 KB – 256 MB | `TELL_MAX_BUFFER_BYTES` |
| `output_max_bytes` | 1 KB – 32 MB | `TELL_OUTPUT_MAX_BYTES` |

An unknown key warns `unknown limit <key>`; a non-integer or out-of-range value warns `invalid limit <key>` and is dropped — the file never fails the run, and no value changes a default silently. Note `stdin_timeout_ms = 0` disables the stdin deadline (the byte cap stays active) and `max_chain_steps` reaches 128 on the CLI, while the web sandbox clamps rounds to its own 8. Profiles may ship limit/model/temperature defaults, but explicit layers always win over profile data.

## `tell --web` forwarding (`launch_web`)

The Web never reads `.tellrc` directly — the CLI resolves and forwards only non-secret fields: model via `-m`, profile via `--profile`, system via `--system-file`, temperature via `--temperature` and limits via numeric flags (`--max-chain-steps`, `--max-buffer-bytes`, `--context-chars`, `--stdin-timeout-ms`, `--exec-timeout`). Explicit CLI flags/env win over tellrc; absent layers stay absent so the server keeps its own defaults. Existing flags (`--port`, `--host`, `--prompt`) are preserved. Inline system travels in a `0600` temp file removed in `finally`; keys, URLs, `TELL_KEY` and `TELL_TOKEN` never appear in args, files or `/api/config` (which exposes only `profile`, `temperature`, `limits`, `hasCustomSystem`). The forwarded temperature is applied to both the one-shot `generateText` call and the `--stream` path; out-of-range values are dropped by the web parser instead of clamping. Unforwarded model falls back to the web default `l`. Known limitations: profile aliases do **not** cross to the Web (the server resolves models against its own table); the composed system text (including profile system/prompt/style) does. `--stdin-max-bytes`/`--output-max-bytes` are CLI-only (no web target), and a disabled stdin deadline is omitted (the web parser drops non-positive values).

## Use cases

- **Personal default**: `model` + `temperature` in `~/.tellrc` instead of repeating `-m` every call.
- **Per-project convention**: repo `.tellrc` with `system-file = ./AGENTS.md` and a reviewer alias; every checkout inherits the behavior.
- **Posture profiles**: `--profile security` for audits, `devops` for idempotent operations, `node` for the bun/TS stack — or a custom `[profiles.backend]` per team workflow.
- **Team guardrail**: project `[policy] denyCommands` that no `-y` or lower layer can relax (enforced by the policy sandbox).
- **Web continuity**: `tell -w` carries profile/system/temperature/limits into the sandbox automatically.

## Tests

`test/test-tell-tellrc.js` (28 tests, `test:tellrc` — offline, no secrets, part of the `test`/`ci` aggregate since 2026-10-10): missing file, comments, duplicates, unknown section, `#`/`;` preservation, tilde, NUL, 256 KB cap, system-file gates (dir/cap/symlink/ok), precedence matrix, deny union, profile data incl. selected-but-undefined and invalid names, custom profile names, profile system fill/precedence (no duplication), profile system-file resolution, profile aliases subsection + merge order, alias resolution with `MODELS` deep-equal, temperature validation + SDK `RangeError`, limits validation plus the delegation to `runtime-limits` (seven keys, `stdin_timeout_ms = 0`, `max_chain_steps` up to 128, profile limits), safety-last composition, web `cli-args` parsing and the `launch_web` forwarding contract.

## Key constants (`tellrc.ts:6-13`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `TELLRC_MAX_BYTES` | `256 * 1024` | `.tellrc` size cap before ignore-with-warning |
| `SYSTEM_FILE_MAX_BYTES` | `64 * 1024` | `system-file` payload cap |
| `TEMPERATURE_MIN` / `TEMPERATURE_MAX` | `0` / `2` | Valid temperature interval |
| `BUILTIN_PROFILES` | `node`, `security`, `devops` | Profiles shipped with default data |
| `PROFILE_NAME_PATTERN` | `/^[a-z0-9][a-z0-9_-]*$/` | Valid custom profile names |

Sources: `packages/cli/src/tellrc.ts`, `packages/cli/src/runtime-limits.ts`, `Tell.ts:147-151`, `Tell.ts:553-562`, `Tell.ts:947-975`, `Tell.ts:1015-1045`, `Tell.ts:1106-1152`, `packages/cli/src/core-adapters.ts`, `packages/sdk/src/ask.ts`, `packages/sdk/src/tell.ts`, `packages/web/src/server/cli-args.ts`, `packages/web/src/server/server.ts`, `test/test-tell-tellrc.js`.
