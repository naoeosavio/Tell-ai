tell-ai
======

One-shot terminal assistant.

What It Includes
----------------

- `tell` — terminal CLI for one prompt at a time

Usage
-----

```bash
npm install -g tell-ai
```

Run a prompt:

```bash
tell "explain this directory"
tell d "run ls -la"
tell -m d "run ls -la"
tell -m --help
```

Command execution is interactive by default:

```bash
tell d "run ls -la"       # asks before executing
tell -y d "run ls -la"    # executes without confirmation
tell --no-exec d "run ls" # never executes requested commands
```

`-y`/`--yes` is intended for disposable or sandboxed environments. The CLI blocks known high-risk command patterns, but this is a heuristic guard, not a security boundary. Do not use automatic execution in production, critical hosts, or trusted workstations unless it is contained by a real sandbox such as a container or VM.

Persistent context across sessions:

```bash
tell -c "remember that this project uses PostgreSQL"
tell -c "now add a users table migration"   # remembers the previous message
```

Context is stored per working directory and model under `~/.ai/tell_context`.
Without `-c`, each invocation starts fresh.

Multi-step chain mode — the assistant can run a command, see its output, and continue with follow-up commands until it reaches a final answer:

```bash
tell --chain "find out why the build is failing and fix it"
```

Include piped input with a prompt:

```bash
npm run build 2>&1 | tell --chain  -i "what should I fix first?"
git diff --staged | tell --input "review this change"
```

Tell logs conversations under `~/.ai/tell_history`.

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

This project is licensed under the **GNU General Public License v3.0** - see the [LICENSE](LICENSE) file for more details.