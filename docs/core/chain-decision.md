# Chain confirm validator

`validate_chain_decision_payload` (`src/chain-decision.ts`) is the pure, fail-closed gate in front of every Web chain transition. It accepts exactly one identifier (`decisionId` or `approvalId`), a non-negative integer `expectedVersion` and `decision: 'approve'|'skip'` — and nothing else:

```ts
import { validate_chain_decision_payload } from '@tell-ai/core';

validate_chain_decision_payload({ decisionId: 'abc', expectedVersion: 3, decision: 'approve' });
// { ok: true, value: { decision_id: 'abc', expected_version: 3, decision: 'approve' } }
```

Any `script`, `command`, `path` or other extra field is rejected — the client never supplies free scripts; the server keeps the pending command. Exactly-one-of the two id kinds is required; both or neither is an error.

## Boundary with the Web chain store

Stateful concerns live server-side in `packages/web/src/server/chain-store.ts`, which the server always drives through this validator first:

* `POST /api/chain` runs the model loop on the server (≤8 rounds); `GET /api/chain/:runId` replays the sequenced events; `POST …/confirm` answers a pending approval by decision id; `POST …/cancel` invalidates the run.
* Same decision id + same verdict replays without re-executing; a different verdict, stale version or unknown id is 409; high-risk/`--no-exec` is 403 without execution; cancel wins over in-flight confirms; entries expire after 15 min and restarts drop everything.
* `no-exec` denies with `reason: 'disabled'` / `source: '--no-exec'` (never `reason: 'no-exec'`). `/api/tell`, `/api/execute` and `/api/risk-check` stay stable beside the chain routes.

Full route reference: `../../packages/web/README.md` + `../web-sandbox.md`.

Sources: `packages/core/src/chain-decision.ts`, `packages/web/src/server/chain-store.ts`, `test/test-core-chain-decision.js` (validator), `test/test-web-backend.js` (store), `test/test-web-sandbox.js` (live routes).
