# Usage

## Quick start

```bash
npm install -g tell-ai
tell "explain this directory"
```

## Model selection

The first positional argument is auto-detected as a model alias if it matches a known shortcut. Otherwise use `-m`:

```bash
tell d "run ls -la"           # positional model alias
tell -m d "run ls -la"        # explicit model flag
tell -m deepseek:deepseek-v4-pro:medium "run ls -la"   # full spec
```

### Model aliases

```
Alias  Model
-----  ------------------------------------------------
g--    openai:gpt-5.5:none
g-     openai:gpt-5.5:low
g      openai:gpt-5.5:medium
g+     openai:gpt-5.5:xhigh
G      openai:gpt-5.5:xhigh
p      openai:gpt-5.5-pro:medium
p+     openai:gpt-5.5-pro:high
p++    openai:gpt-5.5-pro:xhigh
P      openai:gpt-5.5-pro:xhigh
s--    anthropic:claude-sonnet-4-6:none
s-     anthropic:claude-sonnet-4-6:low
s      anthropic:claude-sonnet-4-6:medium
s+     anthropic:claude-sonnet-4-6:high
s++    anthropic:claude-sonnet-4-6:max
S      anthropic:claude-sonnet-4-6:high
o--    anthropic:claude-opus-4-8:none
o-     anthropic:claude-opus-4-8:low
o      anthropic:claude-opus-4-8:medium
o+     anthropic:claude-opus-4-8:high
o++    anthropic:claude-opus-4-8:max
O      anthropic:claude-opus-4-8:high
f--    anthropic:claude-fable-5:none
f-     anthropic:claude-fable-5:low
f      anthropic:claude-fable-5:medium
f+     anthropic:claude-fable-5:high
f++    anthropic:claude-fable-5:max
F      anthropic:claude-fable-5:high
i-     google:gemini-3.1-pro-preview:low
i      google:gemini-3.1-pro-preview:medium
i+     google:gemini-3.1-pro-preview:high
I      google:gemini-3.1-pro-preview:high
l-     google:gemini-3.1-flash-lite-preview:low
l      google:gemini-3.1-flash-lite-preview:medium
l+     google:gemini-3.1-flash-lite-preview:high
L      google:gemini-3.1-flash-lite-preview:high
x-     xai:grok-4-0709:low
x      xai:grok-4-0709:medium
X      xai:grok-4-0709:high
d-     deepseek:deepseek-v4-pro:low
d      deepseek:deepseek-v4-pro:medium
d+     deepseek:deepseek-v4-pro:high
D      deepseek:deepseek-v4-pro:high
df-    deepseek:deepseek-v4-flash:low
df     deepseek:deepseek-v4-flash:medium
df+    deepseek:deepseek-v4-flash:high
DF     deepseek:deepseek-v4-flash:high
z--    fireworks:glm-5p2:none
z-     fireworks:glm-5p2:low
z      fireworks:glm-5p2:medium
z+     fireworks:glm-5p2:high
z++    fireworks:glm-5p2:max
Z      fireworks:glm-5p2:high
k      moonshotai:kimi-k2.7-code:none
K      moonshotai:kimi-k3:max
q      local:/root/model:none
v      vast:/root/model:none
```

**Thinking budgets** (suffix): none, low, medium (default), high, xhigh, max.

**Fast mode**: prefix with `.` (e.g. `.g`) to disable reasoning tokens. Append `:fast` to full specs.

Full specs use the format `vendor:model:thinking` (e.g. `openai:gpt-5.5:high`).

List all aliases from the CLI:

```bash
tell -m --help
```

## Command execution

The AI can run bash commands by wrapping them in `<RUN>...</RUN>` tags. By default you confirm each command interactively.

```bash
tell d "run ls -la"        # asks before executing
tell -y d "run ls -la"     # auto-executes (high-risk still requires confirmation)
tell --no-exec d "run ls"  # never executes, shows what would run
```

**High-risk patterns** are always blocked even with `-y`: `sudo`, `rm -rf`, `mkfs`, `dd of=`, `curl|sh`, writes to system paths (`/etc`, `/boot`, `/usr`), crontab manipulation, etc. Commands time out after 120s.

## Piped input (stdin)

```bash
npm run build 2>&1 | tell -i "what should I fix first?"
git diff --staged | tell --input "review this change"
cat error.log | tell "explain this error"
```

Without `-i`, stdin is captured only when no prompt arguments are given:

```bash
echo "explain this" | tell    # stdin becomes the prompt
```

## Chain mode (`--chain`)

The assistant can run commands, see their output, and continue with follow-up commands until it reaches a final answer. Up to 8 command rounds.

```bash
tell --chain "find out why the build is failing and fix it"
npm run build 2>&1 | tell --chain -i "fix the build errors"
```

## Persistent context (`-c`)

Keep conversation history across invocations per directory and model. Stored at `~/.ai/tell_context/`.

```bash
tell -c "remember that this project uses PostgreSQL"
tell -c "now add a users table migration"   # remembers the previous message
```

Without `-c`, each invocation starts fresh. Context is automatically truncated at 200,000 characters.

## Logging

Conversations are logged to `~/.ai/tell_history/` with timestamps.

## Environment variables

| Variable          | Description                    | Default |
|-------------------|--------------------------------|---------|
| `TELL_MODEL`      | Default model alias            | `g`     |
| `DEBUG`           | Enable debug output            | unset   |

## Smart explorer (`-E` / `--explore`)

Gathers project context before prompting to reduce hallucinations about file paths. The AI receives:

- **Project structure**: directory tree (depth 4, max 200 entries), respecting `.gitignore`
- **Git context**: current branch and changed files
- **Project metadata**: type (Node.js, Rust, etc.), scripts, dependency counts

```bash
tell -E "add a users table migration"
tell --explore --chain "refactor the auth module"
```

Context is capped at ~6000 characters. Works in chain mode (sent with every system prompt round).

## Self-hosted models

```bash
export VAST_BASE_URL="http://..."
tell v "summarize this file"

export LOCAL_OPENAI_BASE_URL="http://localhost:8080/v1"
tell q "explain this code"
```
