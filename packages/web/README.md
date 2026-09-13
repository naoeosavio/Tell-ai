# Tell Web

Tell AI web sandbox: chat with models, file explorer/viewer,
command execution and PTY terminal — all anchored to a working directory (`--cwd`).

## Requirements

Node.js `>=20` (see `engines` in `package.json`).

## Run

```sh
npm i
npm run dev      # vite frontend + tsx server (development)
npm run build    # tsup (server.js) + vite build (assets) → dist/
npm start        # node dist/server.js (production)
```

## CLI

```sh
tell-web --cwd <path> --prompt <text> -m <model> --chain --stream --think -y/--no-exec
tell-web --help
```

| Flag | Default | Description |
|---|---|---|
| `--cwd <path>` | current cwd | Sandbox directory |
| `--prompt <text>` | — | Fill the chat inbox (never auto-sent, never a message) |
| `-m, --model <id>` | `TELL_MODEL` or `l` | Model shortcode or spec |
| `--port <n>` | `PORT` or `3000` | TCP port |
| `--host <addr>` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN) |
| `--exec-timeout <ms>` | `120000` (max `600000`) | Timeout per command |
| `--chain` | off | Continue after output until final answer |
| `--stream` | off | Stream responses as NDJSON instead of one JSON body |
| `--think` | off | Start reasoning headers expanded (manual collapse/expand persists) |
| `-y, --yes` | off | Auto-confirm execution |
| `--no-exec` | off | Disable automatic execution |
| `-h, --help` | — | Help |

## Streaming (`--stream`)

`/api/tell` replies become `application/x-ndjson` with one event per line:
`reasoning`, `reasoning_end`, `text`, `done`, `error`. The client appends text
to the assistant message as it arrives (throttled) and shows a collapsible
reasoning header — 🧠 `Thinking… Ns` while the model reasons, then 🧠
`Thought for N seconds ›`. Reasoning headers are collapsed by default;
`--think` seeds them expanded. Expanding/collapsing a header persists the
choice for future messages. Without `--stream`, `/api/tell` keeps returning
the single-JSON response.

## Execution modes (chat toggles)

The chat header has execution toggles (client-side). Their last choice
persists in `localStorage` across page reloads; server flags (`--chain`, `-y`,
`--no-exec`) seed the default on the first visit only:

| Toggle | Effect |
|---|---|
| `Chain Mode (–chain)` | Continue iterating through `<RUN>` steps until the final answer |
| `Auto-Run (-y)` | AI-requested `<RUN>` scripts execute immediately, no confirmation card |
| `Require Approval` | Risky commands show the confirmation card; safe ones follow Auto-Run (run directly when on, confirm card when off) |
| `No-Exec` | Nothing is ever executed — the confirm card records what would have run |

Precedence: `No-Exec` > per-command risk gate. Enabling No-Exec switches
Auto-Run off. With `--chain`, each held command still pauses for approval
(Require Approval) or is recorded as not-run (No-Exec) while the loop continues
with the feedback. The risk gate is fail-closed: if classification fails, the
command goes to manual approval.

## Envs (see `.env.example`)

`PORT`, `TELL_MODEL`, `TELL_TOKEN` (`Bearer` auth on `/api/*` except the public
`GET /api/auth/status` + `POST /api/auth/verify`, and `?token=` on WS;
token lives only in browser memory — retyped on every connection) + vendor keys (`GEMINI_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`,
`CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, …).

`TELL_SCROLLBACK_MAX` (bytes/chars per terminal pane, default `262144` = 256KB)
caps the PTY scrollback buffer. Panes running a program (`htop`, `opencode`,
`vim`, background jobs) survive the 5min idle GC — it re-arms while a child
process or a foreign foreground process is detected (Linux procfs); explicit
pane/tab close still kills immediately. Daemonized (double-forked) processes
are not detected.

## Endpoints `/api/*`

| Method | Route | Notes |
|---|---|---|
| GET | `/api/status` | Workspace file tree |
| GET | `/api/file?path=` | Content + `mtime` (403 traversal/sensitive, 413 >10MB) |
| GET | `/api/file/raw?path=` | Download bytes |
| POST | `/api/save-file` | `{path, content, expectedMtime}` (409 if changed on disk) |
| POST | `/api/execute` | `{command}` — blocks high-risk patterns, 429 (10/min, max 2 concurrent) |
| POST | `/api/risk-check` | `{command}` → `{highRisk}` — classify without executing (drives Require Approval gating) |
| GET | `/api/models` | Models/aliases + `keysStatus` per vendor |
| GET | `/api/auth/status` | Public: `{authRequired}` only (drives the isolated login screen) |
| POST | `/api/auth/verify` | Public + rate-limited (5/15min/IP): `{token}` → `200`/`401` generic/`429` + `Retry-After` |
| GET | `/api/config` | `defaultModel`, `autoExecute`, `chain`, `yes`, `stream`, `think`, `cwd`, `initialPrompt` (requires auth when `TELL_TOKEN` is set) |
| GET | `/api/context` | Generated system prompt (tree + README + conventions) |
| POST | `/api/tell` | `{messages, modelAlias?, systemPrompt?}` (400 invalid payload, 429); NDJSON event stream when `--stream`, JSON otherwise |
| GET/PUT | `/api/session` | Persisted state + server facts + live scrollbacks |
| GET | `/api/session/history` | List snapshots |
| GET/DELETE | `/api/session/history/:name` | Read/delete snapshot (`:name` must end in `.json`) |
| POST | `/api/session/snapshot` | `{success, name, gitChanges, history}` |
| WS | `/api/terminal?paneId=&cols=&rows=` | PTY (`?token=` when `TELL_TOKEN`) |

Sensitive files never exposed: `.env*` (except the `.env.example` template), `.tell/**`, `.git/**`, `*.key`, `*.pem`.

## `.tell/` layout (local, git-ignored)

```
.tell/
  session.json   # current session
  history/       # snapshots *.json
  latest -> history/<snapshot>  # symlink (repaired if dangling)
```

## License

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

This package is licensed under the **GNU General Public License v3.0** — see the [LICENSE](../../LICENSE) file for more details.
