# Contributing to tell-ai

Thanks for helping improve tell-ai. This repo is a bun monorepo with four packages: `tell-ai` (CLI), `@tell-ai/sdk` (browser-safe AI provider layer), `@tell-ai/core` (shared runtime: Node executor/loop plus a browser-safe pure surface), and `@tell-ai/web` (sandbox server + browser client).

## Quick start

```bash
bun install
bun run build
bun run lint
bun run check
bun run test
```

`bun run ci` runs the full gate (build + lint + check + test). Per-package commands use filters, e.g. `bun run --filter @tell-ai/web build`. Formatting/linting is Biome v2.2.6 (`biome.json`): single quotes, 2-space indent, 120-char lines.

## Pull requests

1. Fork, branch from `main` (`feat/...`, `fix/...`).
2. Keep changes focused; add or update tests under `test/` where it applies.
3. Add a `CHANGELOG_AI.md` entry under `## Unreleased` in every touched package (the release script reads the first version heading; `Unreleased` never matches it).
4. Run before pushing: `bun run build && bun run lint && bun run check && bun run test` (or `bun run ci`).
5. Describe what changed and how you verified it. Link related issues and the task file under `tasks/` when one exists.
6. Sign off your commits (DCO): `git commit -s -m "feat: ..."`. By signing off you certify the [Developer Certificate of Origin](https://developercertificate.org/) (you wrote the change or have the right to submit it).

## Licenses (inbound = outbound)

Contributions are accepted under the license of the package they touch — no CLA, no copyright transfer:

| Code you touch | License your contribution enters under |
|---|---|
| `packages/cli/`, `packages/web/`, root docs/tests | GPL-3.0 (`LICENSE`) |
| `packages/sdk/` | MIT (`packages/sdk/LICENSE`) |
| `packages/core/` | MIT (`packages/core/LICENSE`, per the `docs/core-provenance.md` signoff) |

GPL-3.0 requires modified distributed versions to share source under the same terms, so improvements flow back to the community. If you cannot agree to that, limit your change to `packages/sdk/` or `packages/core/`.

## Browser-safe surfaces (`sdk`, `core`)

`@tell-ai/sdk/src` and the `@tell-ai/core` browser entry (`src/browser.ts` plus everything it reaches) must stay free of Node builtins (`node:*`, `fs`, `path`, `os`) and of ambient environment access (`process.env` — inject it as a parameter instead). The gates enforce it:

- `test/test-core-package.js` fails the build on any builtin import in the browser entry or bundle.
- `test/test-core-browser.js` executes the built `dist/browser.cjs` in a `vm` context with no `process`/`Buffer`/`require`.
- Use top-level `import type` / `export type` in browser-graph files — never mixed inline (`import { type X, value }`): the bundler keeps a mixed statement as a side-effect import, which once dragged a bare `@tell-ai/sdk` (and its Node builtins) into `dist/browser.*`.

When touching these surfaces, run `bun run test:core` (includes both gates) and `bun run test:fuzz` (seeded property suite, 41 checks).

## Tests

Suites live in `test/` and run with plain `node` (`node --test` where noted). The aggregate `npm test` covers sdk, core-api, env, runtime, tellrc, security, context, stream, mentions, cli-adapters, fuzz, core and web. Notable gates:

- `test/test-core-package.js` — `BLOCKED:` means stop; provenance, export order and builtin rules are hard failures.
- `test/test-fuzz-coverage.js` (`bun run test:fuzz`) — deterministic (mulberry32); every failure prints seed + minimal input.
- `test/test-live-model.js` (`bun run test:live-model`) — opt-in, needs `OPENROUTER_API_KEY`, self-skips without it.

## Do not commit

`.env*` (except `.env.example`), `.tell/`, `dist/`, `node_modules/`, `*.key`, `*.pem`, editor/OS artifacts. Never commit API keys or tokens.

## Reporting security issues

Command-execution and prompt-injection guards are load-bearing (`isHighRiskScript`). Do not open a public issue for a bypass — contact the maintainer privately with a repro, expected vs actual behavior, and package version.
