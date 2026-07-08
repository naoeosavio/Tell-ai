# Git Suite Examples

Building your own `tell`-powered git scripts from scratch. Each example shows the full shell code with inline commentary on prompt design, output parsing, and error handling.

Prerequisites:

```bash
npm install -g tell-ai
# API key configured (see ../README.md#api-keys)
command -v jq   # required for ai-pr.sh and ai-release.sh
command -v gh   # required for ai-pr.sh and ai-release.sh (GitHub CLI)
```

---

## ai-commit.sh — Generate Commit Messages

Reads `git diff --staged` and generates a Conventional Commits message.

### How it works

1. Capture staged diff (limit to 60k lines to avoid token overflow)
2. Craft a system prompt with strict output rules
3. Call `tell` with `--no-exec` to prevent command execution
4. Strip markdown fences and control characters
5. Confirm with user before committing

### Full script

```bash
#!/usr/bin/env bash
set -euo pipefail

MAX_LINES=60000

TMP_DIFF=$(mktemp)
git diff --staged | head -n "$MAX_LINES" > "$TMP_DIFF"

if [ ! -s "$TMP_DIFF" ]; then
  echo "No staged changes found." >&2
  exit 1
fi

DIFF_CONTENT=$(cat "$TMP_DIFF")

# ── Prompt engineering ─────────────────────────────────────────────────
# The system role, output format, and constraints are in the prompt itself.
# tell's system prompt handles bash execution; we add domain-specific rules.
PROMPT=$(cat <<EOF
You are a senior software engineer specialized in writing
high quality Git commits.

Analyze the git diff below.

Return ONLY a valid git commit message.

Rules:
- English only
- Use Conventional Commits
- Include: short title, blank line, detailed description, bullet points
- No markdown fences, no explanations, no quotes
- Max 72 chars for title, body can be multiline
- Be technical and objective

Git diff:
$DIFF_CONTENT
EOF
)

echo "Generating commit message..." >&2

# ── Call tell ──────────────────────────────────────────────────────────
# -m d       → DeepSeek V4 Pro (cheap, good for structured text)
# --no-exec  → never run commands (the AI only generates the message)
COMMIT_MSG=$(
  timeout 120 tell -m d --no-exec "$PROMPT" \
    | sed 's/^```.*//g' \
    | sed 's/^```//g' \
    | tr -cd '\11\12\15\40-\176'   # strip non-ASCII control chars
)

if [ -z "$COMMIT_MSG" ]; then
  echo "Failed to generate commit message." >&2
  exit 1
fi

echo "$COMMIT_MSG" >&2
echo >&2

# ── Confirmation ───────────────────────────────────────────────────────
read -r -p "Create commit? [Y/n] " confirm
confirm=${confirm:-Y}
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Commit canceled." >&2
  exit 0
fi

TMP_COMMIT=$(mktemp)
echo "$COMMIT_MSG" > "$TMP_COMMIT"
git commit -F "$TMP_COMMIT"
echo "Commit created successfully." >&2
```

### Key patterns

| Pattern | Why |
|---------|-----|
| `MAX_LINES=60000` | Prevents huge diffs from blowing up the context |
| `--no-exec` | The AI only generates text, no code execution needed |
| `sed + tr` cleanup | Strips markdown fences and control chars the model sometimes emits |
| `read -r -p` | Interactive confirmation — user still controls what gets committed |
| `mktemp` for diff/msg | Thread-safe temporary files |

---

## ai-pr.sh — Generate Pull Requests

Pushes the branch, analyzes the diff against the base branch, and creates a PR via `gh`.

### How it works

1. Detect base branch from remote HEAD
2. Push current branch
3. Collect commits + diff since base
4. Ask the model to return **valid JSON** with `title` and `body`
5. Parse with `jq`, confirm, then `gh pr create`

### Full script

```bash
#!/usr/bin/env bash
set -euo pipefail

MAX_LINES=60000

BASE_BRANCH=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p')
CURRENT_BRANCH=$(git branch --show-current)

# ── Auto-create branch if on base ─────────────────────────────────────
if [ "$CURRENT_BRANCH" = "$BASE_BRANCH" ]; then
  NEW_BRANCH="feat/ai-$(date +%s)"
  echo "Creating branch: $NEW_BRANCH" >&2
  git checkout -b "$NEW_BRANCH"
  CURRENT_BRANCH="$NEW_BRANCH"
fi

git push -u origin "$CURRENT_BRANCH"

COMMITS=$(git log "origin/$BASE_BRANCH..HEAD" --oneline)
DIFF=$(git diff "origin/$BASE_BRANCH...HEAD" | head -n "$MAX_LINES")

# ── Prompt: JSON output ────────────────────────────────────────────────
# Structured output makes parsing reliable. Instruct the model to return
# only JSON, nothing else. This pattern works well for any structured task.
PROMPT=$(cat <<EOF
You are a senior software engineer specialized in writing
high quality GitHub Pull Requests.

Analyze the commits and git diff below.

Return ONLY valid JSON. Required format:

{
  "title": "title here",
  "body": "markdown body here"
}

Rules:
- English only, professional tone, clear and technical
- Include: summary, main changes, risks, testing notes
- No markdown fences, no explanations outside JSON

Commits:
$COMMITS

Git diff:
$DIFF
EOF
)

echo "Generating Pull Request..." >&2

# ── Parse JSON output ──────────────────────────────────────────────────
# sed strips markdown fences from the raw response.
# `sed -n '/^{/,$p'` extracts from first `{` to end — handles models that
# prepend text before the JSON.
RESULT=$(
  timeout 180 tell -m d --no-exec "$PROMPT" \
    | sed 's/^```json//g' \
    | sed 's/^```//g'
)

JSON=$(echo "$RESULT" | sed -n '/^{/,$p')

if [ -z "$JSON" ]; then
  echo "Failed to generate PR JSON." >&2
  exit 1
fi

TITLE=$(echo "$JSON" | jq -r '.title')
BODY=$(echo "$JSON" | jq -r '.body')

if [ -z "$TITLE" ] || [ "$TITLE" = "null" ]; then
  echo "Invalid PR title." >&2
  exit 1
fi

echo "Generated PR title: $TITLE" >&2

read -r -p "Create Pull Request? [Y/n] " confirm
confirm=${confirm:-Y}
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "PR canceled." >&2
  exit 0
fi

TMP_BODY=$(mktemp)
echo "$BODY" > "$TMP_BODY"
gh pr create \
  --base "$BASE_BRANCH" \
  --head "$CURRENT_BRANCH" \
  --title "$TITLE" \
  --body-file "$TMP_BODY"

echo "Pull Request created successfully." >&2
```

### Key patterns

| Pattern | Why |
|---------|-----|
| JSON output schema in prompt | Reliable parsing — `jq` extracts fields cleanly |
| `sed -n '/^{/,$p'` | Handles models that prepend text before valid JSON |
| `jq -r .title/.body` | Extracts fields, error if null |
| Auto-create branch | Never opens a PR from `main` by accident |
| 180s timeout | PR generation may need more time for large diffs |

---

## ai-changelog.sh — Generate Changelogs

Collects commits since the last tag and generates a categorized changelog section.

### How it works

1. Detect version from `package.json` or last git tag
2. Collect up to 300 commits since last tag
3. Ask model to group by category (Features, Fixes, Refactors, etc.)
4. Merge new section with existing `CHANGELOG_AI.md`
5. Open in `$EDITOR` for review

### Full script

```bash
#!/usr/bin/env bash
set -euo pipefail

MAX_COMMITS=300
OUTPUT_FILE="CHANGELOG_AI.md"

# ── Detect version ─────────────────────────────────────────────────────
PKG_VERSION=""
if [ -f package.json ]; then
  PKG_VERSION=$(jq -r '.version // empty' package.json 2>/dev/null || true)
fi

LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)

# ── Collect commits ────────────────────────────────────────────────────
if [ -z "${LAST_TAG:-}" ]; then
  COMMITS=$(git log --max-count="$MAX_COMMITS" \
    --pretty=format:'%H%n%s%n%b%n---END---')
else
  COMMITS=$(git log "$LAST_TAG..HEAD" --max-count="$MAX_COMMITS" \
    --pretty=format:'%H%n%s%n%b%n---END---')
fi

if [ -z "$COMMITS" ]; then
  echo "No commits found since $LAST_TAG." >&2
  exit 1
fi

CURRENT_DATE=$(date +"%Y-%m-%d")

if [ -n "$PKG_VERSION" ]; then
  VERSION="v$PKG_VERSION"
elif [ -n "${LAST_TAG:-}" ]; then
  VERSION="${LAST_TAG}-next"
else
  VERSION="Unreleased"
fi

# ── Handle existing changelog ──────────────────────────────────────────
MODE="create"
EXISTING_CONTENT=""
if [ -f "$OUTPUT_FILE" ]; then
  MODE="update"
  EXISTING_CONTENT=$(tail -n +2 "$OUTPUT_FILE" \
    | sed '/^$/ { N; /^\n$/d; }' | sed '1{/^$/d}')
fi

# ── Prompt ─────────────────────────────────────────────────────────────
PROMPT=$(cat <<EOF
You are a senior software engineer specialized in writing professional changelogs.

Analyze the commits below and return ONLY the new changelog section in markdown.

Rules:
- English only
- Group changes by category (only include categories with entries):
  Features, Fixes, Refactors, Performance, Documentation, Tests, Chores, Breaking Changes
- Ignore useless commits: merge, typo, formatting only, minor lint
- Rewrite commit messages into professional changelog entries
- Remove duplicates, keep concise but informative
- No markdown fences, no explanations outside markdown
- Do NOT include the version header — only the category sections

Information:
- Last version: ${LAST_TAG:-none}
- New version: $VERSION
- Current date: $CURRENT_DATE

Commits:
$COMMITS
EOF
)

echo "Generating changelog..." >&2

NEW_SECTION=$(
  timeout 180 tell -m d --no-exec "$PROMPT" \
    | sed 's/^```markdown//g' \
    | sed 's/^```md//g' \
    | sed 's/^```//g'
)

if [ -z "$NEW_SECTION" ]; then
  echo "Failed to generate changelog." >&2
  exit 1
fi

# ── Assemble output ────────────────────────────────────────────────────
{
  echo "# Changelog"
  echo ""
  echo "## $VERSION — $CURRENT_DATE"
  echo ""
  echo "$NEW_SECTION"

  if [ "$MODE" = "update" ] && [ -n "$EXISTING_CONTENT" ]; then
    echo ""
    echo "---"
    echo ""
    echo "$EXISTING_CONTENT"
  fi
} > "$OUTPUT_FILE"

echo "Changelog ${MODE}d: $OUTPUT_FILE" >&2

read -r -p "Open changelog? [Y/n] " confirm
confirm=${confirm:-Y}
if [[ "$confirm" =~ ^[Yy]$ ]]; then
  "${EDITOR:-nvim}" "$OUTPUT_FILE"
fi
```

### Key patterns

| Pattern | Why |
|---------|-----|
| `git log --pretty=format:'%H%n%s%n%b%n---END---'` | Structured separator for grouping commits |
| `MAX_COMMITS=300` | Avoids token limits on repos with long histories |
| Merge with existing content | Appends new version on top, preserves history |
| Category-driven prompt | Forces consistent output structure |

---

## ai-release.sh — Create GitHub Releases

Extracts the latest changelog entry, generates release notes, tags the version, and creates a GitHub release.

### How it works

1. Read version from `CHANGELOG*.md` or `package.json`
2. Extract the latest changelog section with `awk`
3. Generate release notes with higher thinking budget (`-m D`)
4. Tag, push, create release via `gh` (with REST API fallback)

### Full script

```bash
#!/usr/bin/env bash
set -euo pipefail

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

require git
require jq
require gh

TELL_BIN="${TELL_BIN:-$(command -v tell || true)}"
[ -z "${TELL_BIN:-}" ] && { echo "tell not found" >&2; exit 1; }

# ── Find changelog ─────────────────────────────────────────────────────
CHANGELOG_FILE=""
for file in CHANGELOG.md CHANGELOG_AI.md docs/CHANGELOG.md; do
  if [ -f "$file" ]; then
    CHANGELOG_FILE="$file"
    break
  fi
done

# ── Extract version and section ────────────────────────────────────────
if [ -n "$CHANGELOG_FILE" ]; then
  VERSION=$(awk '
    /^##[[:space:]]+\[?[vV]?[0-9]+\.[0-9]+\.[0-9]+/ {
      v = substr($0, RSTART + 3, RLENGTH - 3)
      sub(/^\[?[vV]?/, "", v)
      sub(/\]?[[:space:]]+.*$/, "", v)
      print v; exit
    }' "$CHANGELOG_FILE")

  [ -z "$VERSION" ] && { echo "Unable to determine version from changelog." >&2; exit 1; }

  CHANGELOG_SECTION=$(awk -v ver="$VERSION" '
    function strip(v) { sub(/^[vV]/, "", v); return v }
    /^##[[:space:]]+/ {
      hver = strip(substr($0, RSTART + 3, RLENGTH - 3))
      sub(/\]?[[:space:]]+.*$/, "", hver)
      if (hver == strip(ver)) { found = 1; next }
      if (found) exit
    }
    found { print }
  ' "$CHANGELOG_FILE")

  echo "Version source: CHANGELOG ($VERSION)" >&2
else
  VERSION=$(jq -r '.version // "0.1.0"' package.json 2>/dev/null || echo "0.1.0")
  CHANGELOG_SECTION="Initial release."
  echo "Version source: package.json ($VERSION)" >&2
fi

TAG="v$VERSION"
git rev-parse "$TAG" >/dev/null 2>&1 && { echo "Tag $TAG already exists." >&2; exit 1; }

# ── Generate release notes (higher thinking = -m D) ────────────────────
RELEASE_PROMPT=$(cat <<EOF
You are a senior open-source maintainer.
Create concise GitHub Release Notes. Return ONLY markdown.

Rules:
- English only, maximum 15 lines
- Focus on most important changes
- Format: Summary, Key Changes, Breaking Changes (if any)
- No markdown fences, no explanations, no code examples

Version: $VERSION

Changelog Entry:
$CHANGELOG_SECTION
EOF
)

echo "Generating release notes..." >&2

RELEASE_NOTES=$(timeout 180 "$TELL_BIN" -m D --no-exec "$RELEASE_PROMPT")
[ -z "$RELEASE_NOTES" ] && { echo "Failed to generate release notes." >&2; exit 1; }

echo "$RELEASE_NOTES" >&2

read -r -p "Create release $TAG? [Y/n] " confirm
confirm=${confirm:-Y}
[[ ! "$confirm" =~ ^[Yy]$ ]] && { echo "Release canceled." >&2; exit 0; }

# ── Sync package.json version ──────────────────────────────────────────
if [ -f package.json ]; then
  CURRENT=$(jq -r '.version' package.json)
  if [ "$CURRENT" != "$VERSION" ]; then
    jq --arg v "$VERSION" '.version = $v' package.json > package.json.tmp
    mv package.json.tmp package.json
    git add package.json
    git commit -m "chore(release): sync package version $VERSION"
  fi
fi

# ── Tag and push ───────────────────────────────────────────────────────
git tag "$TAG"
git push origin HEAD
git push origin "$TAG"

# ── Create GitHub Release ──────────────────────────────────────────────
TMP_NOTES=$(mktemp)
echo "$RELEASE_NOTES" > "$TMP_NOTES"
gh release create "$TAG" --title "$TAG" --notes-file "$TMP_NOTES"
echo "Release $TAG created successfully." >&2
```

### Key patterns

| Pattern | Why |
|---------|-----|
| Higher thinking budget (`-m D`) | Release notes need more reasoning for summarization |
| `awk` for changelog parsing | Extracts structured version + section from markdown |
| Merge → tag → push → release | Strict ordering prevents partial states |
| `package.json` version sync | Keeps package metadata consistent with tags |

---

## Prompt Engineering Principles

These patterns apply to any `tell`-powered script:

| Principle | Example |
|-----------|---------|
| **Set a persona** | `You are a senior software engineer...` |
| **Constrain output format** | `Return ONLY valid JSON` / `Return ONLY markdown` / `No markdown fences` |
| **Be explicit about structure** | `Include: summary, main changes, risks, testing notes` |
| **Show valid examples** | Include a sample output so the model copies the format |
| **Negative rules** | `No explanations`, `No quotes`, `No code examples` |
| **Limit scope** | `Max 15 lines`, `Max 72 chars for title`, `Ignore merge/typo commits` |
| **Sanitize output** | Strip fences with `sed`, control chars with `tr`, non-ASCII with `-cd` |
| **Always confirm** | `read -r -p "Proceed? [Y/n]"` — never auto-execute destructive actions |
| **Timeouts** | `timeout 120 tell ...` — prevents hanging in CI or on network issues |
| **Fail gracefully** | Check for empty output, return exit code 1 with a clear message |
