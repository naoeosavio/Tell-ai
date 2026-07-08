# Changelog

## v0.4.0 — 2026-07-08

### Features

- Added command confirmation timeout: prompts auto-reject after a configurable period (`EXEC_TIMEOUT`), preventing indefinite hangs.
- Ensured the assistant's visible response is always printed when the chain limit is reached or auto-continue is disabled.
- Model responses now strip `<think>` blocks before command extraction and output, preventing commands inside think tags from being executed.
- Improved model selection for Vast and Local providers by consistently using `provider.chat(model)`; added response filtering for run command extraction.

### Fixes

- Separated error handling for AI interactions and context file writes to avoid unhandled exceptions; context write failures now log and set a non-zero exit code.
- Fixed an issue where the assistant's visible response was not printed when the conversation chain limit was reached or auto-continue was disabled.

### Refactors

- Dropped the unused `messages` array and `ChatMessage` type from conversation state; narrowed the error handling scope in `runTell` to only cover the AI creation call.
- Removed the `suppressStdout` function and simplified `tellSilently`; suppressed Vercel AI SDK warnings via a global flag.
- Centralized API key and base URL configuration into a new `env` config module with typed keys, default URLs, and simplified provider key lookup.

### Performance

- Cached directory creation tracking to avoid redundant `mkdirSync` calls during conversations.
- Used the model label instead of the raw model string for context file hashing, ensuring stable filenames across runs.

### Documentation

- Added comprehensive git suite examples and integration reference covering git hooks, CI/CD, editors, bots, and self-hosted servers.
- Added a usage guide detailing model selection, command execution, piped input, chain mode, persistent context, and logging.
- Updated README with environment variable API key configuration for all providers (including Deepseek, Cerebras, OpenRouter) and self-hosted endpoint setup.

### Tests

- Added tests for command extraction with visible surrounding text and multi-command chaining.
- Removed outdated vendor-stdout-injection security test.

### Chores

- Relicensed from MIT to GPL-3.0; added LICENSE file and updated package.json license field, repository, bugs, and homepage URLs.

---

## v0.3.2 — 2026-07-08

### Features
- Introduced `tell` CLI for querying AI models and executing approved bash commands with safety checks. Supports multiple AI providers, persistent context per directory/model, chain-mode multi-step reasoning, piped stdin, and command execution toggle. Logs full conversations and includes heuristic detection for high-risk scripts.

### Documentation
- Added comprehensive README covering installation, usage, configuration, and security considerations.

### Tests
- Added security test suite covering prompt injection, risky command handling, exec controls, chain limits, and context hygiene.

### Chores
- Initialized project configuration with `.gitignore`, `package.json`, and `tsconfig.json`.
