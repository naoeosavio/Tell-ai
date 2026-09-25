# tell-ai

One-shot terminal assistant, powered by an AI that can execute bash commands. Ask a question, get an answer — and optionally, a command executed for you.

## What it includes

| Package | Description | License |
|---|---|---|
| [`tell-ai`](./packages/cli/README.md) | The `tell` terminal CLI — one prompt at a time, with optional command execution | GPL-3.0 |
| [`@tell-ai/sdk`](./packages/sdk/README.md) | Browser-safe AI provider library: model resolution, multi-vendor dispatch, RUN/think tag handling, context summarization | MIT |
| [`@tell-ai/web`](./packages/web/README.md) | Web sandbox server (`tell-web`): browser chat + file explorer + real PTY terminals, launched via `tell --web` | GPL-3.0 |

The CLI bundles the SDK and resolves API keys from your environment; the SDK works in Node, Bun, and the browser with all configuration injected. The web sandbox lives in `packages/web/` (tracked outside the bun workspaces) and is documented in [docs/web-sandbox.md](docs/web-sandbox.md).

## Quick start

```bash
npm install -g tell-ai
tell "explain this directory"
tell d "run ls -la"   # asks before executing
```

Set your API keys with environment variables (see the [CLI README](./packages/cli/README.md#api-keys)).

## Key ideas

- **One-shot by default** — no conversation loop unless you ask for one (`-c` persistent context, `--chain` multi-step reasoning).
- **Interactive execution** — the model proposes `<RUN>...</RUN>` commands and you approve them; `-y` auto-executes, `--no-exec` never executes.
- **10+ vendors through short aliases** — `g` for GPT-5.6 Sol, `o` for Claude Opus 5, `d` for DeepSeek V4 Flash, and more, with thinking-level suffixes (`+`, `++`).
- **Browser-safe SDK** — ships a self-contained ESM bundle and a script-tag global, no build step needed for the web.

## Development

Monorepo (bun workspaces `packages/*`) plus the web sandbox in `packages/web/`. All commands run from the root:

```bash
npm run build       # SDK (ESM+CJS+types+2 browser bundles) + CLI (minified .mjs) + web (server + assets)
npm run lint        # tsc --noEmit in SDK + CLI + web
npm run format      # biome check --write packages/
npm run check       # biome check packages/
npm test            # security + context + web suites
npm run test:web    # web backend harness + packages/web suite only
npm run ci          # build + lint + check + test
```

Requirements: [bun](https://bun.sh) (package manager and runner), Node.js >= 20 (web sandbox, `node-pty` native module), TypeScript.

## Documentation

- [CLI docs](./docs/cli/README.md) — flags, context, execution, chain mode, security
- [SDK build variants](./docs/sdk/imports.md) — Node ESM/CJS vs browser ESM vs IIFE global
- [Usage guide](./docs/usage.md), [integrations](./docs/integrations.md) — git hooks, CI/CD, bots, self-hosted models
- [Web sandbox](./docs/web-sandbox.md) — `tell --web` quick start, hosting scenarios, auth, `.tell/` sessions ([package README](./packages/web/README.md))

## CLI examples

Include piped input with a prompt:

```bash
npm run build 2>&1 | tell --chain  -i "what should I fix first?"
git diff --staged | tell --input "review this change"
```

Tell logs conversations under `~/.ai/tell_history`.

Web Sandbox
-----------

Launch a browser-based terminal + AI console from any working directory:

```bash
tell --web                      # open http://localhost:3000
tell -w --cwd /path/to/project  # run the sandbox in another working directory (created if missing)
tell -w --no-exec "ola"         # start the chat pre-seeded with "ola", auto-execution off
tell -w -m g --chain -y "go"    # pick model (g), chain mode, auto-confirm execution
```

The sandbox mirrors your real shell through PTY panes (tmux/codex/opencode/claude-code
work), generates a system prompt from the project tree + README/AGENTS, and persists
sessions in `.tell/`. Run it locally, on a repo/server you manage remotely, or expose
it via a tunnel/reverse proxy.

Source and API reference: [`packages/web/`](./packages/web/README.md) (`bun run --filter @tell-ai/web dev`
for development, `npm run build` for `packages/web/dist/`).

Full guide (quick start, where to use it, real-world examples, security):
[docs/web-sandbox.md](docs/web-sandbox.md)

### Flag interactions

| Flags | Reads context? | Deletes? | Writes? | Loop? |
|-------|--------|---------|--------|------|
| *(none)* | no | yes | no | no |
| `-c` | yes | no | yes (final) | no |
| `--chain` | no | yes | no | yes (8 rounds) |
| `-c --chain` | yes | no | yes (incremental) | yes (8 rounds) |

API Keys
--------

Set environment variables (preferred) or use `~/.config/<vendor>.token` files as fallback.

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_API_KEY="..."        # or GEMINI_API_KEY
export XAI_API_KEY="..."
export DEEPSEEK_API_KEY="..."
export FIREWORKS_API_KEY="..."
export CEREBRAS_API_KEY="..."
export MOONSHOTAI_API_KEY="..."
export OPENROUTER_API_KEY="..."
export META_API_KEY="..."
export MIMO_API_KEY="..."
```

Token files (fallback):

```bash
~/.config/openai.token
~/.config/anthropic.token
~/.config/google.token
~/.config/xai.token
~/.config/deepseek.token
~/.config/fireworks.token
~/.config/cerebras.token
~/.config/moonshotai.token
~/.config/openrouter.token
~/.config/meta.token
~/.config/mimo.token
```

Self-hosted endpoints (optional):

```bash
export VAST_BASE_URL="http://..."
export LOCAL_OPENAI_BASE_URL="http://localhost:8080/v1"
```

Security Tests
--------------

Run the prompt-injection and command-execution safety checks with:

```bash
npm run test:security
```

License
-------

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

The repository is licensed under the **GNU General Public License v3.0** — see [LICENSE](LICENSE). The `@tell-ai/sdk` package is separately licensed under MIT (see `packages/sdk/LICENSE`).