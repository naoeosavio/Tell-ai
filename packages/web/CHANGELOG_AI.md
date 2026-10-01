# Changelog

## v0.3.0 — 2026-10-01

### Features
- Add Alibaba Qwen, Z.ai GLM, Meta and Xiaomi model vendor support to the exposed catalog, replacing the Fireworks AI vendor.
- `tell-web` accepts `--require-approval` (forwarded by `tell -w`): exposes it in `/api/config` so the client seeds the Require Approval toggle on the first visit, following the same first-visit seeding pattern as `autoExecute`/`chain`/`think`. Classification stays client-side through `/api/risk-check`.
- Auto-Run is now opt-in: `parseCliArgs` returns `autoExecute: yes && !noExec`, so a fresh browser does not execute model commands unless the server was started with `-y`. `--no-exec` is also a server invariant: `/api/execute` returns `403`, `/api/config` exposes `noExec`, and the browser locks the No-Exec toggle instead of restoring an older Auto-Run preference.
- Add `--stream`: `/api/tell` replies become `application/x-ndjson` with one `ChatStreamEvent` per line (`reasoning`, `reasoning_end`, `text`, `done`, `error`). The client appends text to the in-flight assistant message as it arrives (throttled to 100ms) and drives a live reasoning timer for the header. Without `--stream`, `/api/tell` keeps returning the single-JSON response.
- Rework the thought panel into a collapsible reasoning header: 🧠 `Thinking… Ns` while the model reasons (pulsing), then 🧠 `Thought for N seconds ›`. `--think` seeds headers expanded on first visit; expanding/collapsing persists for future messages in `localStorage` alongside the execution toggles.
- `/api/config` now exposes `stream` and `think` booleans for first-visit seeding.
- Add a runtime **Stream / No Stream** toggle under Settings → Agent Runtime: the client sends `stream: <boolean>` on `POST /api/tell` and the new pure guard `resolveStreamMode` honors it per request, falling back to the boot `--stream` when the field is absent (`curl`/API clients keep the old behavior). The choice persists in `localStorage` (`tell-exec-toggles-v1`) alongside the execution toggles, so `--stream` only seeds the first visit. Both modes accumulate the same text — only the transport differs — so logs, context and `<RUN>` extraction are unchanged.
- Add per-pane collapse in the sidebar: `FileExplorer` and `SettingsPanel` now take `collapsed`/`onToggleCollapsed` and fold to their own title bar (chevron), so the file tree and the settings can be minimized independently — the navbar toggle still hides the whole sidebar. The state persists in `theme-config-v3` (`explorerCollapsed`, `settingsCollapsed`) and the pane layout is decided by the new pure `resolveSidebarPaneLayout` in `src/shared/sidebar-layout.ts` (also hosts `clampSettingsHeightPx`, now shared with `normalizeConfig`).
- The navbar notification now lives on the **Agent** button instead of `Terminal`: `!` marks a command awaiting authorization and a number counts retained Agent Feed errors, hidden while the Agent view is active.
- Settings → Custom layout adds `Hidden` to the Agent Feed positions (`Top`/`Bottom`/`Left`/`Right`/`Hidden`). `Hidden` persists in `theme-config-v3` and suppresses only the panel: retained lines and the Agent badge survive, and restoring a position shows the same log.
- Move shell command authorization prompts into the chat message stream: a pending command renders as an approval card inside the chat flow and the chat is scrolled to the bottom when the request arrives, so an authorization ask is never missed.
- Make the terminal scrollback buffer configurable per pane (carried in the PTY handshake and on session restore) and keep active panes out of the idle GC: `scheduleGcTimer` is cancelled on activity/reconnect and only re-armed on disconnect, so abandoned panes still expire.
- Add an auto-growing chat input textarea (height follows `scrollHeight` up to a cap) and wire Vite dev HMR through the server (`hmr: { server }` in middleware mode).
- Model setup errors still surface as a JSON 500 before headers are sent; once streaming, failures become an `error` event so the client keeps the partial answer.
- `/api/tell` (non-streaming) forwards `handle.providerOptions` from `@tell-ai/sdk`, so explicit vendor options such as Anthropic `effort: 'max'` reach the provider on server-side `generateText()` calls too.
- New direct `meta` and `xiaomi` vendors wired end to end: `load_sdk_config_from_env` reads `META_API_KEY`/`META_BASE_URL` and `MIMO_API_KEY`/`MIMO_BASE_URL` (env-only, no token files), `/api/models` reports them in `keysStatus`, the model list now shows the Meta (`m`, `mc`) and Xiaomi (`mi`, `mif`) families, and both vendors count as keyed in the submit guard and appear in the Settings credentials grid (`Meta`, `Xiaomi MiMo`). `.env.example` lists the two new key variables.
- Refresh the exposed catalog to 142 aliases, including `h` (Claude Haiku 4.5), OpenRouter-confirmed GPT-6.1 Sol Pro / GPT-6 Astra Pro / Qwen3.8 27B ids and preserved legacy families.
- Add `TELL_ALLOWED_HOSTS` for tunnels/reverse proxies. HTTP requests and terminal upgrades reject unlisted `Host` values, closing DNS-rebinding access to the shell; `localhost` and IP literals remain accepted.
- Load a workspace `.env` only when `TELL_TRUST_WORKSPACE_ENV=true` is set before startup, preventing a cloned repository from silently redirecting provider endpoints or weakening auth.
- Provider keys and base URLs are captured once at boot, `/api/models` reads from that captured config, and the credential environment is purged before the server accepts requests.

### Security
- API bearer auth is case-insensitive at the route boundary: `/API/config`, `/Api/Config`, and other Express case variants now require the same `Authorization: Bearer` token as `/api/config`.
- Valid logins no longer consume the five-attempt brute-force quota; only failed or malformed logins are counted, so a reload cannot lock the correct token out.
- File, context, and `.tell` access reject symlinked roots, components, and targets. Reads/writes use `O_NOFOLLOW|O_NONBLOCK`, so a workspace symlink or FIFO cannot escape the boundary or block the event loop.
- `.tell` directories and session/history files use `0700`/`0600`; existing permissive stores are repaired on load/listing. `latest` may only point to a regular file inside `.tell/history`.
- Commands and PTY panes receive scrubbed environments without provider keys, `TELL_TOKEN`, credential/token variables, or loader-injection variables.
- High-risk command blocking now includes all network clients, `printenv`, shell `-c` (including absolute `/bin/bash`), every `/proc` reference, and long/uppercase `rm`/`git clean` forms.
- WebSocket inputs are capped at 16 KiB, panes at 8 clients, slow clients are disconnected, replay is bounded, exited PTYs close their sockets, and rejected panes are reclaimed instead of consuming `MAX_SESSIONS`.
- Optimistic saves cannot recreate a file or parent directory that was deleted before the request; a conflict returns `409` without filesystem side effects.
- Production no longer serves `dist/server.js` as a static asset, and authenticated downloads use the API fetch path.

### Fixes
- Suppress raw provider error logging and sanitize error messages before emission.
- Strict `/api/tell` payload validation returns `400` for non-object bodies, invalid roles, and non-string `systemPrompt` instead of reaching provider calls or returning `500`.
- Snapshot creation persists the incremented snapshot counter, so the next `/api/session` read agrees with the created snapshot.
- Manual command confirmation now checks `res.ok`; a blocked, rate-limited, or failed request is reported as an error instead of feeding empty "Executed command" output back to the model.
- The `Files` pane no longer draws its own `border-r` on top of the sidebar's side-aware border, removing the duplicate/misplaced divider on left and right layouts; the header is a single fixed-height bar shared by the expanded and collapsed states.
- `FileViewer` downloads carry the in-memory bearer token via `apiFetch`, fixing downloads in authenticated mode.

### Refactors
- Extract the NDJSON wire codec into `src/shared/chat-stream.ts` (pure, shared by the server encoder and the browser decoder, no React/DOM/node dependencies) and the reasoning header label helpers into `src/shared/reasoning-header.ts`.
- Extract the agent notification logic into shared pure helpers (`resolve_agent_notification`), shared by the navbar badge and the tests.
- Replace the Fireworks AI vendor with the Alibaba and Zhipu providers in the exposed catalog.
- The Agent Feed auto-open effects moved from `AgentFeed` to `App`, so error/approval events still update the feed state while the panel is unmounted in the `Hidden` placement.

### Tests
- Extend `test/test-web-backend.js` cli section: `--require-approval` detected, default off, never swallowed as a value flag, `-y --require-approval --no-exec` combo (`--no-exec` wins `autoExecute`).
- Extend `test/test-web-sandbox.js` with a codec suite (`encode`/`decode`/`consume_chat_stream`: round-trips, partial trailing lines, malformed-line error surfacing, error-event rejection) and a reasoning-header suite (live counter, frozen duration singular/plural, open-state resolution). `test-web-backend.js` covers `--stream`/`--think` parsing defaults and independence.
- Cover the Stream/No Stream override: `test-web-backend.js` exercises `resolveStreamMode` (booleans win in both directions; `undefined`/`null`/`'yes'`/`1`/`{}` fall back to the boot default) and `test-web-sandbox.js` round-trips `streamMode` in `tell-exec-toggles-v1` (including an explicit `false`, which is not "unset").
- Add a live `tell transport` suite to `test-web-sandbox.js`: a local OpenAI-compatible stub (SSE + single JSON) with two spawned bundles (`--stream` off/on) proves the body's `stream` overrides the boot default in both directions, that `stream:true` produces `application/x-ndjson` with a final `done` event, and that the streamed text equals the single-JSON reply. No network, no provider key. `waitForServer` was hoisted so the live suites (routes, transport, initial prompt) share one implementation.
- Add a `sidebar pane layout` suite to `test-web-sandbox.js`: all four collapse combinations of `resolveSidebarPaneLayout` (who grows, when the resizer is rendered), the "never both" invariant, and `clampSettingsHeightPx` bounds/junk handling.
- Add an `agent notification` suite to `test-web-sandbox.js` for the pure `resolve_agent_notification`: no badge while the Agent is visible, `!` precedence for a pending command, the retained-error count, and the empty case.
- Add an `/api/models` suite to `test-web-sandbox.js`: 142 aliases total, OpenRouter-confirmed OpenAI/Qwen ids, the new `h` alias, no MiniMax entry, and boolean credential status for `alibaba`, `zhipu`, `meta` and `xiaomi`.
- Security regressions cover API path case variants, DNS-rebinding `Host` rejection, valid-login quota behavior, WebSocket payload/client limits, PTY exit socket cleanup, bounded replay, secret-free command/PTY environments, `--no-exec` server enforcement, trusted vs untrusted workspace `.env`, symlink read/write/context/`.tell` escapes, private mode repair, FIFO non-blocking reads, deleted-file optimistic-save conflicts, and production `server.js` non-disclosure. The live sandbox suite passes 159/159.
- Build regressions pin the workspace `esbuild` override (`^0.28.1`, above GHSA-g7r4-m6w7-qqqr) and the Web Node engine (`>=22`). `bun audit` reports no vulnerabilities.

### Documentation
- Document `TELL_ALLOWED_HOSTS`, the `TELL_TRUST_WORKSPACE_ENV` opt-in, `-y` Auto-Run default, server-enforced `--no-exec`, scrubbed child environments, WebSocket/PTY limits, private `.tell` modes, and the DNS-rebinding `403` troubleshooting case.
- Update `docs/web-sandbox.md` and `packages/web/README.md` for the security, configuration and environment changes, and refresh the contributing guidelines.
- Document the independent sidebar pane collapsing and its state persistence.
- Document chain mode, execution toggle persistence and the new CLI flags (`--stream`, `--think`, `--require-approval`).

### Chores
- Raise the Web `engines.node` requirement to `>=22`, matching the SDK's `ai` dependency and current Vite support.
- Force `esbuild` to `^0.28.1` through the root workspace override, removing GHSA-g7r4-m6w7-qqqr from `bun audit`.

---

## v0.2.1 — 2026-09-08

### Features
- Add per-command risk gating for approval mode via `/api/risk-check`
- Introduce Require Approval and No-Exec safety modes for execution control
- Implement session management and terminal layout features
- `--prompt` fills the chat inbox instead of injecting a chat message: `/api/config` exposes `initialPrompt`, which the client puts in the input box (never auto-sent); unsent inbox text persists as `session.draft` through the existing session pipeline, so a reload restores what was typed and a fresh boot prompt wins over it

### Fixes
- Update development script server entry path
- Collapse chain feedback cards by default

### Refactors
- Rework terminal placement hidden option into a dedicated full-width action button
- Consolidate web sandbox tests into a unified root suite
- Improve Toast component structure, theme readability, and terminal layout functions

### Documentation
- Correct package license identifier and add a dedicated License section
- Update web server path references
- Document chat-header execution modes, precedence, and safety controls

### Tests
- Add comprehensive test suite for web backend functionality including routing, security guards, and session persistence
- Enhance existing test cases for authentication, chain feedback, chat threads, and terminal layouts

### Chores
- Update TypeScript configuration and Vite setup for improved module resolution

---

## v0.2 — 2026-09-08

### Features
- Add isolated login screen with in-memory-only token authentication and rate limiting
- Introduce multi-directional terminal docking, controlled tab state, and flexible layout configuration
- Add agent feed panel with auto-expansion on errors and clipboard support
- Implement chat thread management with persistence, duplication, forking, and title generation
- Add chat message editing, resend capabilities, and global toast notifications
- Implement per-command risk gating and execution safety modes (Require Approval, No-Exec)
- Add session snapshot management, history restore, and file conflict detection
- Overhaul file explorer and viewer with tree filtering, icons, and binary detection

### Fixes
- Collapse chain feedback cards by default
- Align classic layout default sidebar to the right
- Guard against undefined model spec parts and prevent UI crashes on missing tabs
- Harden terminal WebSocket connections, reconnection backoff, and idle resource cleanup

### Refactors
- Consolidate sandbox tests into a unified root suite
- Streamline terminal layout helpers and Toast component architecture
- Extract pure chat rendering helpers and session management modules

### Documentation
- Rewrite project README and add comprehensive web-sandbox guide
- Document execution mode toggles, CLI flags, and correct license identifiers

### Tests
- Add comprehensive unit test suite covering PTY, server routes, security guards, and chat/terminal rules

### Chores
- Configure project metadata, build pipeline, and production bundling for the web package
