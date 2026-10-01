# Tell Web

Tell AI web sandbox: chat with models, file explorer/viewer,
command execution and PTY terminal — all anchored to a working directory (`--cwd`).

## Requirements

Node.js `>=22` (see `engines` in `package.json`).

## Run

```sh
npm i
npm run dev      # vite frontend + tsx server (development)
npm run build    # tsup (server.js) + vite build (assets) → dist/
npm start        # node dist/server.js (production)
```

## CLI

```sh
tell-web --cwd <path> --prompt <text> -m <model> --chain --stream --think --require-approval -y/--no-exec
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
| `--stream` | off | Seed the Stream toggle (Settings → Agent Runtime) and keep NDJSON as the server fallback |
| `--think` | off | Start reasoning headers expanded (manual collapse/expand persists) |
| `--require-approval` | off | Seed the Require Approval toggle (classification stays client-side) |
| `-y, --yes` | off | Seed Auto-Run on the first visit (off by default: a fresh browser never auto-executes) |
| `--no-exec` | off | Server-enforced: `/api/execute` returns `403` and the No-Exec toggle is locked |
| `-h, --help` | — | Help |

## Streaming (`--stream`)

`/api/tell` replies become `application/x-ndjson` with one event per line:
`reasoning`, `reasoning_end`, `text`, `done`, `error`. The client appends text
to the assistant message as it arrives (throttled) and shows a collapsible
reasoning header — 🧠 `Thinking… Ns` while the model reasons, then 🧠
`Thought for N seconds ›`. Reasoning headers are collapsed by default;
`--think` seeds them expanded. Expanding/collapsing a header persists the
choice for future messages.

The transport itself is a runtime choice: **Settings → Agent Runtime** has a
`Stream` / `No Stream` toggle. The client sends `stream: <boolean>` in the
`/api/tell` body, the server honors it per request, and the choice persists in
`localStorage` — `--stream` only seeds it on the first visit and stays the
fallback for requests that omit the field (curl/API clients). Without streaming
the model still runs, but `/api/tell` returns the single-JSON response (no live
reasoning timer; the header falls back to the static `Thought for N seconds`
label). Log, context and `<RUN>` extraction are identical in both modes.

## Execution modes (chat toggles)

The chat header has execution toggles (client-side). Their last choice
persists in `localStorage` across page reloads; server flags (`--chain`, `-y`,
`--require-approval`, `--no-exec`) seed the default on the first visit only:

| Toggle | Effect |
|---|---|
| `Chain Mode (–chain)` | Continue iterating through `<RUN>` steps until the final answer |
| `Auto-Run (-y)` | AI-requested `<RUN>` scripts execute immediately, no confirmation card |
| `Require Approval` | Risky commands show the confirmation card; safe ones follow Auto-Run (run directly when on, confirm card when off) |
| `No-Exec` | Nothing is ever executed — the confirm card records what would have run |

Auto-Run is **opt-in**: unless the server was started with `-y`, a fresh browser
asks before every command. Precedence: `No-Exec` > per-command risk gate, and
`--no-exec` is a server invariant (`/api/execute` answers `403`), so the locked
toggle wins over an older stored Auto-Run preference. Enabling No-Exec switches
Auto-Run off. With `--chain`, each held command still pauses for approval
(Require Approval) or is recorded as not-run (No-Exec) while the loop continues
with the feedback. The risk gate is fail-closed: if classification fails, the
command goes to manual approval.

## Sidebar panes

The sidebar stacks the file explorer (top) and the settings panel (bottom).
Each pane folds to its own title bar through the chevron in its header, and the
collapsed/expanded state persists in `localStorage` (`theme-config-v3`) next to
`sidebarCollapsed`/`threadsCollapsed`. Collapsing the explorer hands its height
to settings (and vice versa), and the settings resize handle only exists while
the settings pane is open. The sidebar wrapper owns the single outer divider, so
the `Files` header stays aligned on either side and in both collapse states. The
navbar's global toggle still hides the whole sidebar at once.

## Agent notifications and feed

The navbar badge lives on the `Agent` button: `!` while a command awaits
authorization, or the number of retained Agent Feed errors. It disappears while
the Agent view is active and stays on the Agent (not on `Terminal`) otherwise.

**Settings → Appearance & Theme → Custom layout → Agent Feed** accepts `Top`,
`Bottom`, `Left`, `Right`, and `Hidden`. `Hidden` only suppresses the panel: the
retained lines and the navbar badge are preserved, so restoring a position shows
the same log. The choice persists in `theme-config-v3` (`customAgentFeed`).

## Envs (see `.env.example`)

`PORT`, `TELL_MODEL`, `TELL_TOKEN` (enables the secure mode below),
`TELL_ALLOWED_HOSTS` (comma-separated public hostnames for tunnels/proxies;
`localhost` and IP literals are always accepted) + vendor keys (`GEMINI_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`,
`CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, `ALIBABA_API_KEY`, `ZHIPU_API_KEY`,
`META_API_KEY`, `MIMO_API_KEY`, …).

A workspace `.env` is ignored by default. Set `TELL_TRUST_WORKSPACE_ENV=true`
before starting the server only when that workspace is trusted; otherwise a
repository can redirect provider keys or authentication settings.

`TELL_SCROLLBACK_MAX` (bytes/chars per terminal pane, default `262144` = 256KB)
caps the PTY scrollback buffer. Panes running a program (`htop`, `opencode`,
`vim`, background jobs) survive the 5min idle GC — it re-arms while a child
process or a foreign foreground process is detected (Linux procfs); explicit
pane/tab close still kills immediately. Daemonized (double-forked) processes
are not detected.

## Secure mode (`TELL_TOKEN`)

Without `TELL_TOKEN` the sandbox is open to anything that can reach the port, so
it is meant for `127.0.0.1` and nothing more. Set a token to put the whole
surface behind one credential:

```sh
openssl rand -hex 32                      # keep the output
export TELL_TOKEN=<paste it here>
tell-web --cwd ~/project
# open http://127.0.0.1:3000 and paste the token in the login screen
```

- **API** — every `/api/*` route requires `Authorization: Bearer <token>`,
  including `/api/config` (it would otherwise leak `cwd` and the model). The
  route match is case-insensitive, so `/API/config` needs the same token as
  `/api/config`, and the comparison is constant-time. Missing or wrong token →
  `401` plus `WWW-Authenticate: Bearer realm="tell-web"`.
- **Bootstrap routes** — only `GET /api/auth/status` (tells the client whether a
  token is required, so it can show the isolated login screen) and
  `POST /api/auth/verify` are public. The verify endpoint is same-origin only
  and rate-limited to 5 attempts per 15 min per IP; only failed or malformed
  attempts count, so a reload with the correct token never locks you out.
  `429` carries `Retry-After: 900`. The token itself is never logged.
- **Browser** — the token lives in memory only (never `localStorage`), so every
  reload asks for it again; file downloads go through the authenticated API
  fetch path instead of a bare link.
- **Terminal** — WebSocket upgrades cannot carry headers, so panes pass
  `?token=<value>` on `/api/terminal` (same constant-time check).
- **Children** — commands and PTY panes inherit a scrubbed environment without
  `TELL_TOKEN`, provider keys, or loader-injection variables, so a
  model-requested `<RUN>` cannot read the credential back out.

### Host and origin checks (DNS rebinding)

Independently of the token, the server only answers to hosts it recognizes:

- `TELL_ALLOWED_HOSTS` lists the public hostnames you serve it under (tunnels,
  reverse proxies). `localhost` and IP literals are always accepted, as is the
  address bound with `--host`.
- An unlisted `Host` is refused with `403 Forbidden: Host is not allowed` on both
  HTTP and the terminal upgrade; a cross-site `Origin` is rejected on the WS
  upgrade and on the auth endpoints. Without this, a malicious page on your
  network could point a browser at the sandbox and ride your session
  (DNS rebinding).

Bind to `0.0.0.0` only together with both of these: `TELL_TOKEN` and
`TELL_ALLOWED_HOSTS`.

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
| GET | `/api/config` | `defaultModel`, `autoExecute`, `requireApproval`, `noExec`, `chain`, `yes`, `stream`, `think`, `cwd`, `initialPrompt` (requires auth when `TELL_TOKEN` is set) |
| GET | `/api/context` | Generated system prompt (tree + README + conventions) |
| POST | `/api/tell` | `{messages, modelAlias?, systemPrompt?, stream?}` (400 invalid payload, 429); NDJSON event stream when `stream` is `true`, JSON otherwise. Missing `stream` falls back to the server's boot `--stream` |
| GET/PUT | `/api/session` | Persisted state + server facts + live scrollbacks |
| GET | `/api/session/history` | List snapshots |
| GET/DELETE | `/api/session/history/:name` | Read/delete snapshot (`:name` must end in `.json`) |
| POST | `/api/session/snapshot` | `{success, name, gitChanges, history}` |
| WS | `/api/terminal?paneId=&cols=&rows=` | PTY (`?token=` when `TELL_TOKEN`) |

Sensitive files never exposed: `.env*` (except the `.env.example` template), `.tell/**`, `.git/**`, `*.key`, `*.pem`. Workspace symlinks are rejected by file, context, and session APIs; `.tell` is stored with private directory/file modes.

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
