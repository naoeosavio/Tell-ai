# Integrations

A catalog of where and how to use `tell` — from git automation to chat bots, code assistants, server management, and CI/CD pipelines.

---

## 1. Git Workflow

Four scripts that turn `tell` into a complete git automation suite. Each reads the repo state, crafts a prompt, calls `tell --no-exec`, parses the output, and confirms with the user before acting.

| Script | What it does | Model | Output format |
|--------|-------------|-------|---------------|
| `ai-commit.sh` | Generates Conventional Commits from staged diff | `tell -m d` | plain text |
| `ai-pr.sh` | Creates Pull Requests from branch diff | `tell -m d` | JSON `{title, body}` |
| `ai-changelog.sh` | Generates changelog from commit history | `tell -m d` | markdown (categories) |
| `ai-release.sh` | Creates GitHub Releases from changelog | `tell -m D` | markdown (release notes) |

**Full source code and prompt engineering breakdown:** [`docs/examples/git-suite.md`](examples/git-suite.md)

**Quick setup:**

```bash
# Place scripts in PATH
cp ai-commit.sh ai-pr.sh ai-changelog.sh ai-release.sh /usr/local/bin/
chmod +x /usr/local/bin/ai-*.sh
```

---

## 2. Code Assistant

Everyday developer workflows using `tell` directly from the terminal.

### Code Review

```bash
# Review staged changes before committing
git diff --staged | tell -i "review this change for bugs, security issues, and missing tests"

# Review entire branch
git diff main...HEAD | tell -i "code review this PR diff"

# Focused review by severity
git diff | tell -i "only flag critical bugs and security problems"
```

### Error Explanation

```bash
# Build errors
npm run build 2>&1 | tell -i "explain what's failing and how to fix it"

# Test failures
npm test 2>&1 | tell -i "why are these tests failing?"

# TypeScript / lint errors
npx tsc --noEmit 2>&1 | tell -i "summarize the errors by category"

# Container failures
docker compose logs 2>&1 | tell -i "what's wrong with this stack?"

# CI logs
cat ci-failure.log | tell -i "what caused the CI failure?"
```

### Build Fixing (Chain Mode)

```bash
# Let the model fix errors iteratively
npm run build 2>&1 | tell -i --chain "fix every build error one at a time"

# Full cycle: lint → build → test
npm run lint 2>&1 | tell -i --chain "fix all lint errors, then verify the build passes"
```

### Refactoring

```bash
# Simple rename
tell --chain "rename getCwd to getCurrentWorkingDirectory everywhere in src/"

# Structural refactor
tell --chain "extract the authentication logic from src/app.ts into src/auth.ts"

# Modernize patterns
tell "modernize this code: $(cat src/legacy.ts)"
```

### Code Explanation

```bash
# Explain a function
tell "explain how this middleware works: $(cat src/auth.ts)"

# Explain a regex or complex pattern
tell "break down what this regex matches: $(cat src/parser.ts)"

# Architecture overview
ls -R src/ | tell -i "summarize this project's architecture"

# Dependency analysis
cat package.json | tell -i "what does this project do and what are its main dependencies?"
```

### Documentation

```bash
# Generate README section
cat src/ | tell -i "write an API reference in markdown"

# Document a function
tell "write JSDoc for this function: $(cat -)"
```

---

## 3. Telegram Bot

A polling bot that bridges Telegram messages to `tell` and sends responses back.

### Prerequisites

1. Chat with [@BotFather](https://t.me/BotFather) — `/newbot` — copy the token
2. Get your user ID: message [@userinfobot](https://t.me/userinfobot)

### Bot script

**File:** `/usr/local/bin/tell-telegram-bot.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

TOKEN="${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN not set}"
ALLOWED="${TELEGRAM_ALLOWED_USERS:?TELEGRAM_ALLOWED_USERS not set}"
MODEL="${TELEGRAM_MODEL:-d}"
API="https://api.telegram.org/bot$TOKEN"
OFFSET=0

# Send a message back
send_message() {
  local chat_id="$1" text="$2"
  curl -sS -X POST "$API/sendMessage" \
    -d "chat_id=$chat_id" \
    -d "text=$2" \
    -d "parse_mode=Markdown" \
    > /dev/null
}

echo "Bot started (model=$MODEL, polling every 2s)" >&2

while true; do
  UPDATES=$(curl -sS --max-time 10 "$API/getUpdates?offset=$OFFSET&timeout=5" 2>/dev/null || true)

  RESULTS=$(echo "$UPDATES" | jq -r '.result // []')
  COUNT=$(echo "$RESULTS" | jq 'length')

  for ((i = 0; i < COUNT; i++)); do
    UPDATE=$(echo "$RESULTS" | jq ".[$i]")
    UPDATE_ID=$(echo "$UPDATE" | jq '.update_id')
    CHAT_ID=$(echo "$UPDATE" | jq '.message.chat.id')
    USER_ID=$(echo "$UPDATE" | jq '.message.from.id')
    TEXT=$(echo "$UPDATE" | jq -r '.message.text // empty')

    OFFSET=$((UPDATE_ID + 1))

    if [ -z "$TEXT" ]; then
      send_message "$CHAT_ID" "Send me a question and I'll ask the AI."
      continue
    fi

    # Access control
    if ! echo "$ALLOWED" | grep -qw "$USER_ID"; then
      send_message "$CHAT_ID" "Access denied."
      continue
    fi

    # Show typing indicator
    curl -sS -X POST "$API/sendChatAction" \
      -d "chat_id=$CHAT_ID" \
      -d "action=typing" > /dev/null 2>&1 || true

    # Generate response
    RESPONSE=$(timeout 60 tell -m "$MODEL" --no-exec "$TEXT" 2>&1 || echo "Error: request timed out")

    send_message "$CHAT_ID" "$RESPONSE"
  done

  sleep 2
done
```

### Run as a systemd service

**File:** `~/.config/systemd/user/tell-bot.service`

```ini
[Unit]
Description=Tell Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/tell/bot.env
ExecStart=/usr/local/bin/tell-telegram-bot.sh
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

**File:** `~/.config/tell/bot.env`

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_ALLOWED_USERS="123456789 987654321"
TELEGRAM_MODEL=d
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now tell-bot
systemctl --user status tell-bot
```

---

## 4. Server & VM Management

Use `tell` over SSH to analyze remote servers, parse logs, and generate configurations.

### Remote Health Checks

```bash
# System health
ssh host "uptime; free -h; df -h; cat /proc/loadavg" \
  | tell -i "is this server healthy? flag anything concerning"

# Process list
ssh host "ps aux --sort=-%mem | head -20" \
  | tell -i "what's consuming the most memory?"

# Disk usage
ssh host "du -sh /var/* | sort -rh" \
  | tell -i "which directories are taking the most space?"

# Service status
ssh host "systemctl status nginx postgresql redis --no-pager" \
  | tell -i "are any of these services failing?"
```

### Log Analysis

```bash
# System logs
ssh host "journalctl -u nginx --since '1 hour ago' --no-pager" \
  | tell -i "find anomalies, errors, and suspicious requests"

# Auth logs (security)
ssh host "tail -1000 /var/log/auth.log" \
  | tell -i "are there any signs of intrusion or brute force?"

# Docker logs
ssh host "docker logs myapp --tail 500" \
  | tell -i "what errors or warnings are in these logs?"

# Combined analysis
ssh host "
  echo '=== CPU ==='; top -bn1 | head -5;
  echo '=== MEMORY ==='; free -h;
  echo '=== DISK ==='; df -h /;
  echo '=== NETWORK ==='; ss -tlnp
" | tell -i "summarize this server's state in 5 bullet points"
```

### Configuration Generation

```bash
# Docker Compose stacks
tell --chain "write a docker-compose.yml for a Node.js app with PostgreSQL, Redis, and nginx reverse proxy"

# Nginx config
tell "generate an nginx config that proxies /api to localhost:3000 and serves static from /var/www"

# Systemd units
tell "write a systemd service file for a Node.js app that starts after postgresql"

# Firewall rules
tell "generate nftables rules to allow only ports 22, 80, and 443"
```

### Provisioning Assistance

```bash
# Generate a setup script
tell --chain "write a bash script that sets up a Ubuntu server with: Docker, fail2ban, ufw, unattended-upgrades"

# Diagnose a failing server
ssh host "dmesg -T | tail -200; systemctl --failed" \
  | tell -i "diagnose what's wrong and suggest fixes"
```

---

## 5. Where to Plug In

Concrete integration points — copy the snippet, edit the path, and it works.

### Git

#### Git Hooks

**File:** `.git/hooks/prepare-commit-msg`

```bash
#!/usr/bin/env bash
# Auto-generate commit message if none was provided (-m not used)
if [ "$2" = "" ]; then
  tell -m d --no-exec "$(cat <<'EOF'
Write a Conventional Commits message for this diff. English, max 72 chars title.
EOF
  ) < /dev/null 2>/dev/null || true
fi
```

```bash
chmod +x .git/hooks/prepare-commit-msg
```

Apply globally to all repos:

```bash
mkdir -p ~/.git-hooks
cp .git/hooks/prepare-commit-msg ~/.git-hooks/
git config --global core.hooksPath ~/.git-hooks
```

#### Git Aliases

**File:** `~/.gitconfig`

```ini
[alias]
  review = "!git diff | tell -i 'code review this diff'"
  explain-error = "!tell -i 'explain this error in simple terms'"
  commitlog = "!git log --oneline -50 | tell -i 'summarize recent work'"
```

### LazyGit

**File:** `~/.config/lazygit/config.yml`

```yaml
customCommands:
  - key: 'C'
    context: 'files'
    description: '✦ AI Commit'
    command: 'ai-commit.sh'
    output: terminal
  - key: 'P'
    context: 'localBranches'
    description: '✦ AI Pull Request'
    command: 'ai-pr.sh'
    output: terminal
  - key: 'P'
    context: 'status'
    description: '✦ AI Pull Request'
    command: 'ai-pr.sh'
    output: terminal
  - key: 'L'
    context: 'localBranches'
    description: '✦ AI Changelog'
    command: 'ai-changelog.sh'
    output: terminal
  - key: 'R'
    context: 'localBranches'
    description: '✦ AI Release'
    command: 'ai-release.sh'
    output: terminal
```

### Shell

**File:** `~/.zshrc` or `~/.bashrc`

```bash
# tell shortcuts
alias t='tell'
alias td='tell d'
alias ts='tell s'
alias to='tell o'
alias tf='tell -c'
alias tbuild='npm run build 2>&1 | tell -i --chain "fix the build"'

# git AI
alias gcai='ai-commit.sh'
alias gpai='ai-pr.sh'
alias gclog='ai-changelog.sh'
alias grel='ai-release.sh'

# pipe helpers
alias review='git diff | tell -i "review this change"'
alias explain='tell -i "explain this error"'
```

### Makefile

**File:** `Makefile`

```makefile
.PHONY: commit pr changelog release review lint-fix explain

commit:      @ai-commit.sh
pr:          @ai-pr.sh
changelog:   @ai-changelog.sh
release:     @ai-release.sh
review:
	@git diff | tell -i "code review this diff — focus on bugs and security"

lint-fix:
	@npm run lint 2>&1 | tell -i --chain "fix all lint errors"

explain:
	@npm run build 2>&1 | tell -i "what's failing and how to fix it?"
```

### Justfile

**File:** `justfile`

```just
commit:      ai-commit.sh
pr:          ai-pr.sh
changelog:   ai-changelog.sh
release:     ai-release.sh
review:      git diff | tell -i "code review"
lint-fix:    npm run lint 2>&1 | tell -i --chain "fix all lint errors"
```

### CI / CD

#### GitHub Actions — Auto Changelog

**File:** `.github/workflows/changelog.yml`

```yaml
name: AI Changelog

on:
  push:
    branches: [main]

jobs:
  changelog:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g tell-ai
      - name: Generate changelog
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        run: ai-changelog.sh
      - name: Commit changelog
        run: |
          git config user.name "github-actions"
          git config user.email "actions@github.com"
          git add CHANGELOG_AI.md
          git diff --staged --quiet || git commit -m "docs: update changelog [skip ci]"
          git push
```

#### GitHub Actions — CI Failure Diagnoser

**File:** `.github/workflows/diagnose.yml`

```yaml
name: AI Diagnose

on:
  workflow_run:
    workflows: [CI]
    types: [completed]

jobs:
  diagnose:
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g tell-ai
      - name: Fetch logs
        run: |
          gh run view ${{ github.event.workflow_run.id }} --log-failed > ci-fail.log
        env:
          GH_TOKEN: ${{ github.token }}
      - name: Diagnose
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        run: |
          tell -m d --no-exec "$(cat <<PROMPT
          You are a CI/CD engineer. Analyze these CI failure logs.
          Explain the root cause in 3-5 bullet points and suggest fixes.
          $(cat ci-fail.log)
          PROMPT
          )" > diagnosis.md
      - name: Comment on PR
        run: |
          gh pr comment ${{ github.event.workflow_run.head_branch }} --body-file diagnosis.md
        env:
          GH_TOKEN: ${{ github.token }}
```

#### GitLab CI

**File:** `.gitlab-ci.yml`

```yaml
ai-changelog:
  image: node:20
  stage: deploy
  only:
    - main
  before_script:
    - npm install -g tell-ai
  script:
    - ai-changelog.sh
    - |
      git config user.email "ci@gitlab.com"
      git config user.name "GitLab CI"
      git add CHANGELOG_AI.md
      git diff --staged --quiet || git commit -m "docs: update changelog"
      git push origin main
  variables:
    DEEPSEEK_API_KEY: $DEEPSEEK_API_KEY
```

### Editors

#### Neovim

**File:** `~/.config/nvim/lua/plugins/tell.lua`

```lua
-- AI Commit from Neovim
vim.api.nvim_create_user_command('AiCommit', function()
  vim.fn.jobstart('ai-commit.sh', { term = true })
end, {})

-- Ask tell about current file
vim.api.nvim_create_user_command('TellFile', function()
  local path = vim.fn.expand('%:p')
  vim.fn.jobstart({ 'tell', 'd', 'explain this file: ' .. path }, { term = true })
end, {})

-- Ask tell about visual selection
vim.api.nvim_create_user_command('Tell', function(opts)
  local lines = vim.fn.getline(opts.line1, opts.line2)
  local text = table.concat(lines, '\n')
  vim.fn.jobstart({ 'tell', 'd', text }, { term = true })
end, { range = true })

-- Ask tell about error under cursor (diagnostic)
vim.api.nvim_create_user_command('TellDiagnostic', function()
  local diag = vim.diagnostic.get(0, { lnum = vim.fn.line('.') - 1 })
  if #diag == 0 then return end
  local msg = diag[1].message
  local code = vim.fn.getline('.')
  vim.fn.jobstart({ 'tell', 'd', 'Explain this error for: ' .. code .. '\nError: ' .. msg }, { term = true })
end, {})

vim.keymap.set('n', '<leader>gc', ':AiCommit<CR>', { desc = 'AI Commit' })
vim.keymap.set('n', '<leader>tf', ':TellFile<CR>', { desc = 'Explain file' })
vim.keymap.set('v', '<leader>tt', ':Tell<CR>', { desc = 'Explain selection' })
vim.keymap.set('n', '<leader>td', ':TellDiagnostic<CR>', { desc = 'Explain diagnostic' })
```

#### VSCode / Cursor

**File:** `.vscode/tasks.json`

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "AI Commit",
      "type": "shell",
      "command": "ai-commit.sh",
      "presentation": { "reveal": "always", "panel": "dedicated" }
    },
    {
      "label": "AI PR",
      "type": "shell",
      "command": "ai-pr.sh",
      "presentation": { "reveal": "always", "panel": "dedicated" }
    },
    {
      "label": "Tell: explain file",
      "type": "shell",
      "command": "tell d 'explain this file' < ${file}",
      "presentation": { "reveal": "always", "panel": "dedicated" }
    },
    {
      "label": "Tell: explain selection",
      "type": "shell",
      "command": "tell d '${selectedText}'",
      "presentation": { "reveal": "always", "panel": "dedicated" }
    },
    {
      "label": "Tell: fix lint errors",
      "type": "shell",
      "command": "npm run lint 2>&1 | tell -i --chain 'fix all lint errors'",
      "presentation": { "reveal": "always", "panel": "dedicated" }
    }
  ]
}
```

**File:** `.vscode/keybindings.json`

```json
[
  { "key": "ctrl+shift+g c", "command": "workbench.action.tasks.runTask", "args": "AI Commit" },
  { "key": "ctrl+shift+g p", "command": "workbench.action.tasks.runTask", "args": "AI PR" },
  { "key": "ctrl+shift+t f", "command": "workbench.action.tasks.runTask", "args": "Tell: explain file" },
  { "key": "ctrl+shift+t s", "command": "workbench.action.tasks.runTask", "args": "Tell: explain selection" },
  { "key": "ctrl+shift+t l", "command": "workbench.action.tasks.runTask", "args": "Tell: fix lint errors" }
]
```

### tmux

**File:** `~/.tmux.conf`

```tmux
# Open tell in a split pane
bind T split-window -h "tell d"
bind C split-window -h "ai-commit.sh"

# Ask about the output in the current pane
bind A capture-pane -p | tell -i "summarize this"
```

### cron / systemd timer

```bash
# Daily changelog generation
0 9 * * * cd ~/projects/myapp && ai-changelog.sh

# Hourly health check
0 * * * * ssh host "uptime; free -h; df -h" | tell -m d --no-exec "check health, respond with OK or warn"
```

### Docker

```dockerfile
# Dockerfile entrypoint that explains runtime errors
FROM node:20
COPY . /app
WORKDIR /app
RUN npm install -g tell-ai
RUN npm install
CMD npm start 2>&1 | tell -i "explain any startup errors"
```

---

## 6. Use Cases & Ideas

Beyond the integrations above — what `tell` can be wired into.

| Domain | Idea |
|--------|------|
| **CI/CD** | Summarize failed CI runs in PR comments |
| **Security** | Scan git diff for secrets, hardcoded credentials, or vulnerable patterns |
| **Database** | Review migration files for breaking changes or performance risks |
| **I18n** | Extract hardcoded strings from source and generate translation keys |
| **Monitoring** | Pipe alert logs to `tell` for human-readable incident summaries |
| **On-call** | Auto-generate postmortem drafts from incident logs |
| **Docs** | Generate API documentation from TypeScript types or OpenAPI specs |
| **Testing** | Suggest missing test cases for a newly changed file |
| **Dependencies** | Summarize `npm outdated` / `bun update` changelogs |
| **Config** | Generate Dockerfile, docker-compose, or k8s manifests from natural language |
| **Code review** | Auto-comment on PRs with suggestions and risk assessment |
| **Releases** | Compare two git tags and write a migration guide |
| **Learning** | Ask `tell` to explain a new codebase from its README, package.json, and file tree |
| **Slack / Discord** | Same polling pattern as the Telegram bot — swap the API calls |
| **CLI tools** | Pipe any command output to `tell` for human-friendly explanations |
