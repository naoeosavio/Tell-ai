# Changelog

## v0.3.2 — 2026-07-08

### Features
- Introduced `tell` CLI for querying AI models and executing approved bash commands with safety checks. Supports multiple AI providers, persistent context per directory/model, chain-mode multi-step reasoning, piped stdin, and command execution toggle. Logs full conversations and includes heuristic detection for high-risk scripts.

### Documentation
- Added comprehensive README covering installation, usage, configuration, and security considerations.

### Tests
- Added security test suite covering prompt injection, risky command handling, exec controls, chain limits, and context hygiene.

### Chores
- Initialized project configuration with `.gitignore`, `package.json`, and `tsconfig.json`.
