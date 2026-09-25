# Tell Web Sandbox

The **Tell Web Sandbox** (`tell -w` / `tell --web`) turns the `tell` CLI
into a full browser-based development console. It mirrors your real shell through
pseudo-terminals (PTY), gives the AI an auto-generated system prompt built from the
project itself, and persists your session in a hidden `.tell/` folder.

You can use it to drive a project, a repository, or an entire server — right from a
browser tab, no SSH client or local terminal needed.

---

## Table of contents

- [What you get](#what-you-get)
- [Quick start (local)](#quick-start-local)
- [Where to use it](#where-to-use-it)
  - [1. Your own machine](#1-your-own-machine)
  - [2. Manage a repo from anywhere](#2-manage-a-repo-from-anywhere)
  - [3. Manage an online server](#3-manage-an-online-server)
  - [4. Via a website / hosted instance](#4-via-a-website--hosted-instance)
- [Real-world examples](#real-world-examples)
- [Execution modes](#execution-modes)
- [Session persistence (`.tell/`)](#session-persistence-tell)
- [Authentication (`TELL_TOKEN`)](#authentication-tell_token)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)

---

## What you get

| Feature | What it does |
|---------|--------------|
| **Console Interface (real PTY)** | Each pane is a persistent interactive bash session with a real TTY. `tmux`, `vim`, `htop`, `codex`, `opencode`, `claude-code`, `tell-ai` all work as in your local shell. Up to 4 tabs / 4 panes each. |
| **AI Chat & Workspace** | General chat that manages the session: ask questions, request changes, and let the AI run commands through the `<RUN>` bridge (`/api/execute`). |
| **File Explorer & Editor** | Browse the project tree and open/edit files directly in the browser. The explorer and the settings panes each collapse to their own title bar (chevron), so you can fold one without losing the other; the choice persists. |
| **Auto-generated system prompt** | The sandbox builds a persistent system prompt from the project: directory tree (up to 4 levels), `README.md`, and `AGENTS.md`/`agent.md` if present. |
| **Session persistence** | Auto-saved to `.tell/` (chat, model, prompt, tabs/panes, scrollback, keys used, files changed, stats) and restored on your next visit. |

---

## Quick start (local)

```bash
npm install -g tell-ai
npm install -g @tell-ai/web      # the web sandbox server (tell-web)

cd /path/to/your/project
tell --web                       # open http://localhost:3000
```

> `-w` / `--web` enables the auto-generated project context. You can run the sandbox
> in another directory with `--cwd <path>` (created with a warning if it does not
> exist) and fill the chat inbox by passing a prompt, e.g.
> `tell -w --no-exec "ola"` (never auto-sent and never a chat message).
> Unsent inbox text is kept in the persisted session, so a reload restores
> what you typed; a fresh boot `--prompt` takes over the box.

Open **http://localhost:3000**. You get a dashboard with three areas:

1. **AI Chat & Workspace** — the general chat that manages the session.
2. **Console Interface** — the mirror of your shell (click the tab or the
   *Console Interface* button to maximize it).
3. **File explorer + editor** — browse and edit files on disk.

Click into any pane and run anything you would type in your own terminal:

```bash
tmux new-session -d -s work && tmux attach
codex                          # interactive CLI AI engine
opencode                       # another one
claude-code                    # and another
```

---

## Where to use it

The sandbox runs wherever you can run `node` and has access to a working directory.
That makes it useful in several very different situations.

### 1. Your own machine

The simplest case: a nicer UI for your local shell, with the AI assistant attached.

```bash
cd ~/my-project
tell --web
```

Use the panes for long-running interactive work (servers, dev servers, `tmux`
sessions) while the chat handles questions and edits. Sessions survive page reloads
via `.tell/`.

### 2. Manage a repo from anywhere

Run the sandbox **on the machine that holds the repository** (or on any machine you
have shell access to), then drive it from a browser on another device. You get full
git operations without installing anything on your laptop:

```bash
# On the server / machine that owns the repo:
cd /srv/git/my-repo
tell --web --model g

# From your browser anywhere: review the diff, edit files, commit and push.
# In a pane:
git status
git diff
git add -A && git commit -m "fix: typo in docs" && git push
```

The file explorer and editor are great for quick fixes; the panes give you a real
shell for `git`, `npm`, build tools, and migrations.

### 3. Manage an online server

Run it on a VPS / cloud instance to administer it with a graphical terminal instead
of remembering SSH flags. Useful for servers that lack a desktop:

```bash
# On the VPS, inside a tmux session so it survives disconnects:
tmux new -s tell
cd /opt/my-app
tell --web --model g
# detach with Ctrl-b d

# Reconnect to your work anytime:
tmux attach -t tell
```

Day-to-day ops become point-and-click:

- Read the config tree and edit files (e.g. `nginx.conf`, `.env`, `systemd` units)
- Tail logs live: `tail -f /var/log/my-app/app.log`
- Restart services: `systemctl restart my-app`
- Run one-off maintenance: `npm run migrate`, `docker compose up -d`

### 4. Via a website / hosted instance

Expose the sandbox so you can reach it from any browser, through a tunnel or a
reverse proxy. Pick the option that fits your setup.

> Whenever the sandbox is reachable from another device, start it with a token:
> `TELL_TOKEN=$(openssl rand -hex 32) tell --web` — see
> [Authentication](#authentication-tell_token).

**A. SSH reverse tunnel (no extra software on the server):**

```bash
# Server:
tell --web

# Your laptop:
ssh -L 3000:localhost:3000 user@your-server
# now open http://localhost:3000
```

**B. Cloudflare Tunnel (public URL):**

```bash
# Server:
tell --web
cloudflared tunnel --url http://localhost:3000
# Cloudflare prints something like https://random-words.trycloudflare.com
```

**C. ngrok:**

```bash
ngrok http 3000
```

For tunnel or reverse-proxy hostnames, set the public hostname explicitly
(e.g. `TELL_ALLOWED_HOSTS=random-words.trycloudflare.com`) so DNS-rebinding
protection does not reject the forwarded `Host` header.

**D. Systemd + reverse proxy (Nginx/Caddy) — always-on:**

`/etc/systemd/system/tell-web.service`:

```ini
[Unit]
Description=Tell Web Sandbox
After=network.target

[Service]
WorkingDirectory=/opt/my-app
Environment=PORT=3000
Environment=TELL_MODEL=g
# Generate once with `openssl rand -hex 32`; clients paste it in the browser prompt.
Environment=TELL_TOKEN=replace-with-generated-token
# Public proxy hostname, required when the browser does not use localhost/IP.
Environment=TELL_ALLOWED_HOSTS=tell.example.com
# Optional: per-pane terminal scrollback budget in chars (default 262144 = 256KB).
Environment=TELL_SCROLLBACK_MAX=262144
ExecStart=/usr/bin/tell --web
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tell-web
```

Then put Nginx/Caddy in front with a real domain and **TLS**. Exposing a shell on the
public internet without authentication is dangerous — see
[Security notes](#security-notes).

---

## Real-world examples

**Example 1 — Fix a bug from a phone.**

You are away from your desk. Open the tunnel URL, go to the repo tab, search the
failing file, edit it in the browser, then in a pane run:

```bash
npm test
git add -A && git commit -m "fix: offset bug" && git push
```

**Example 2 — Run interactive AI CLIs in panes.**

Give each pane a different engine and let the general chat coordinate:

```bash
# pane 1
codex
# pane 2
opencode
# pane 3
claude-code
# pane 4 (or the chat) — tell-ai
tell -m d "review the current diff"
```

Each pane is a real terminal, so these tools render their full interactive UIs,
spinners, and prompts correctly.

**Example 3 — Keep long tasks alive with tmux.**

Start a build or a test server, detach, and come back later — the PTY session stays
alive even after you close the browser. An idle shell is garbage-collected after
~5 minutes without a connection, but panes running a program (`htop`, `opencode`,
`vim`, background jobs) are kept while the process is detected (Linux procfs);
explicitly closing the pane/tab still kills it immediately. Your scrollback is
saved (budget per pane: `TELL_SCROLLBACK_MAX`, default 256KB):

```bash
tmux new -s build
npm run dev
# Ctrl-b d to detach, close the browser, come back:
tmux attach -t build
```

**Example 4 — Admin an online service end-to-end.**

Edit `nginx.conf`, reload it, watch the log, and restart — all in parallel panes:

```bash
# pane 1
vim /etc/nginx/sites-available/my-site
# pane 2
sudo nginx -t && sudo systemctl reload nginx
# pane 3
tail -f /var/log/nginx/access.log
```

> `sudo` is blocked by the safety guard, so run Nginx under a user that owns the
> config, or run the whole sandbox with the privileges you need.

**Example 5 — Let the AI manage the repo through the chat.**

In the chat: *"run the linters, fix whatever fails, and commit the changes"*. The AI
drafts `<RUN>` commands, you authorize them (or enable Auto-Run), and each command
runs through the sandbox bridge with output fed back to the model.

---

## Execution modes

The chat header controls how AI-requested commands run:

- **Chain Mode** (seeded by `--chain`) — iterate through `<RUN>` steps until
  the final answer, feeding each command's output back to the model.
- **Auto-Run** (seeded by `-y`/`--yes`) — scripts execute immediately.
- **Require Approval** — risky commands show a confirmation card first; safe ones
  follow Auto-Run (run directly when on, confirmation card when off). Combine
  both toggles for "auto the safe, approve the risky". With `--chain`, each
  held command pauses for your approval.
- **No-Exec** (seeded by `--no-exec`) — nothing executes; confirming a command
  just records what would have run and the chain continues with that feedback.

Reasoning headers (🧠) are collapsed by default; `--think` starts them expanded
and any manual expand/collapse persists for future messages.

The reply transport has its own toggle in **Settings → Agent Runtime**
(`Stream` / `No Stream`). The client sends `stream: <boolean>` on `/api/tell`
and the server honors it per request; `--stream` only seeds the toggle on the
first visit and stays the fallback when the field is absent. Both modes produce
the same accumulated text — the toggle changes the transport (NDJSON vs one
JSON body), so logs, context and `<RUN>` extraction stay identical.

Precedence: `No-Exec` > per-command risk gate. These are client-side toggles
whose last choice is remembered in `localStorage` (survives page reloads;
`localStorage` → first-visit only, server flags like `-y`/`--no-exec` seed the
default); high-risk commands (`sudo`, `rm -rf`, `curl|sh`, …) are always
blocked server-side — see [Security notes](#security-notes).

---

## Session persistence (`.tell/`)

Everything auto-saves to a hidden folder in the working directory:

```
.tell/session.json                 # current state (atomic writes, debounced ~1.5s)
.tell/history/<timestamp>.json     # snapshots ("Snapshot Now" button in Settings)
.tell/latest -> history/...        # symlink to the most recent snapshot
```

Restored on your next visit: chat messages, selected model, system prompt, terminal
tabs/panes and their scrollback. The server additionally tracks:

- **Keys used** — provider names only, **never the actual key values**.
- **Files changed** — files edited via the browser editor plus `git status --porcelain`
  collected at snapshot time.
- **Usage stats** — commands run, AI turns, snapshots.

The *Session & History* panel in Settings shows stats, keys, changed files, and the
history list.

---

## Authentication (`TELL_TOKEN`)

The workspace `.env` is ignored unless `TELL_TRUST_WORKSPACE_ENV=true` is set
before startup. Only enable this for a trusted workspace: otherwise a cloned
repository could redirect provider URLs or change security-sensitive settings.

By default the sandbox binds to `127.0.0.1` (localhost only) and needs no
authentication. To make it reachable from other devices, expose the port
explicitly **and** protect it with a token:

```bash
# 1. Generate a strong token
openssl rand -hex 32
# or, without openssl:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Start the sandbox with it (bind on all interfaces)
TELL_TOKEN=<generated-token> tell --web --host 0.0.0.0
```

With `TELL_TOKEN` set:

- Every `/api/*` endpoint requires `Authorization: Bearer <token>`.
  Only `GET /api/auth/status` (tells the login page whether a token is
  needed) and `POST /api/auth/verify` (checks the token) are public —
  `GET /api/config` also requires auth so it can't leak `cwd`/model info.
- The terminal WebSocket requires the same token (`?token=` on the upgrade
  request) and only accepts same-origin connections. Public tunnel/proxy
  hostnames must be listed in `TELL_ALLOWED_HOSTS`; `localhost` and IP literals
  are accepted by default.
- The command bridge enforces limits even with a valid token: 10 commands/min
  per IP, max 2 concurrent commands, 200 KB output truncation, per-command
  timeout (`--exec-timeout`, default 120 s).

**Logging in from the browser:** open the page and a dedicated login screen
asks for the token (animated Tell logo included). The main environment —
chat, files, terminal — only loads after a successful login. The token is
never written to `localStorage`, `sessionStorage` or cookies. REST requests
send it in the `Authorization` header; the terminal WebSocket carries it in
the upgrade query string, so avoid exposing query strings in proxy logs.

- Wrong or rotated token? The login shows a generic `Invalid token` — just
  paste the correct one. After 3 failures the form waits 5 s (30 s after 5),
  and the server blocks the IP with `429` after 5 attempts in 15 minutes.
- To log out: click **Sair** in the top bar (wipes the token from memory and
  returns to the login screen). Any `401` mid-session (rotated token) does
  the same automatically.
- `curl`/API clients: `-H "Authorization: Bearer <token>"`.

> `TELL_TOKEN` also blocks read/write access to secret-looking files
> independently: `.env*`, `.tell/**`, `.git/**`, `*.key` and `*.pem` always
> answer `403`, even for authenticated clients.

---

## Security notes

- **It is a shell in a browser.** Anyone who reaches the port can run commands as the
  user running `tell-web`. By default the server listens only on `127.0.0.1`;
  use `--host 0.0.0.0` (plus `TELL_TOKEN`) only when you really need remote
  access, and keep TLS in front (reverse proxy or tunnel). See
  [Authentication](#authentication-tell_token).
- **High-risk and obfuscated commands are blocked** by the sandbox guard: `sudo`,
  `rm -rf`, writes to system paths (`/etc`, `/boot`, `/usr`), network clients
  (`curl`, `wget`, `ssh`), `printenv`, shell `-c`, crontab manipulation, `mkfs`,
  `dd of=`, interpreter eval (`python/node/perl/ruby -c/-e`), `env`-launched
  commands, `base64 -d` payloads, and shell expansion (`${…}`, `$(…)`, backticks
  with pipes). This is a heuristic, not a security boundary — treat it as
  best-effort.
- **Sensitive files are never served** through the file API (`.env*`, `.tell/`,
  `.git/`, `*.key`, `*.pem`) and cannot be overwritten via the editor API.
- **API keys come from the environment** (`OPENAI_API_KEY`, etc.). The sandbox never
  stores key values — only the provider names you used. The server captures
  provider configuration in memory and purges credential/loader variables from
  its own environment; commands and PTY panes receive a scrubbed child
  environment without provider keys, `TELL_TOKEN`, or process-loader variables.
- **Abuse limits are built in**: 1 MB request body cap (HTTP 413), rate limits on
  the AI chat and command bridge (10/min per IP), a 16 KB terminal WebSocket
  frame cap, at most 8 clients per pane, and a maximum of 12 concurrent PTY
  sessions (extra connections are rejected).
- For untrusted or adversarial use, run the sandbox **inside a container or VM**
  (see below) so damage is contained.

**Docker (quick isolation):**

```bash
docker run --rm -it -p 3000:3000 \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e TELL_TOKEN=$(openssl rand -hex 32) \
  -v $PWD:/workspace \
  -w /workspace \
  node:22 bash -c "npm i -g tell-ai @tell-ai/web && tell --web"
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `403 Forbidden: Host is not allowed` | A tunnel or reverse proxy forwards a public hostname. Add it to `TELL_ALLOWED_HOSTS` and restart the server. |
| `401 Unauthorized` / login screen keeps rejecting | The server runs with `TELL_TOKEN`. Paste the exact value into the login form (nothing is stored — a stale token can't linger; just retype). After too many tries wait 15 min (`429` + `Retry-After`). |
| `Failed to load native module: pty.node` | `node-pty` is a native module. Run `npm rebuild node-pty` (from `packages/web`) or install build tools (`python3`, `make`, `g++`). |
| Port already in use | Set another port: `PORT=3100 tell --web` |
| Wrong model | Set `TELL_MODEL` (e.g. `TELL_MODEL=g tell --web`) or pick the model in the chat header. |
| Terminal looks blank / no prompt | Refresh the page; the PTY reconnects. Check the `.tell/` scrollback restore if a session exists. |
| `tell: command not found` for `tell-web` | Install the web server: `npm install -g @tell-ai/web` |
| Session not restored | The server must run from the same working directory (`.tell/` lives there). |
