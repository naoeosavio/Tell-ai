// The core's browser surface — what works, and what does not.
//
// Run with: bun examples/core/core-browser.ts
// Build with: bun build examples/core/core-browser.ts --target browser
//
// This file is browser-safe by construction: no Node builtin imports, no
// environment reads, no ambient storage and no ambient network. Storage is
// an injected fake through the structural contract.
//
// WHAT WORKS IN THE BROWSER (this file exercises all of it):
//   - the whole runtime: `create_core_runtime` wires the single turn, the
//     system prompt, the `<RUN>` parsing and the feedback wording;
//   - the primitive loop as the low-level seam: `run_primitive_loop` with
//     an injected single turn;
//   - the ports: risk (`assess_base_risk`), storage
//     (`createLocalStorageAdapter` / `MemoryStorageAdapter`), cancellation
//     (`create_cancellation_token`);
//   - the config and the limits: `resolve_core_config`, `load_env_layer`,
//     `parse_runtime_limits`, `truncate_output`, `truncate_context`;
//   - the command-feedback protocol: `format_command_feedback`,
//     `parse_command_feedback`;
//   - the chain-confirm payload validator: `validate_chain_decision_payload`.
//
// WHAT DOES NOT WORK IN THE BROWSER (and why):
//   - command EXECUTION: `create_node_executor` needs `child_process` and a
//     real shell. Without an executor, a requested command is REPORTED,
//     never run — the existing `TellRuntimeOptions.executor` contract, not
//     a browser special case. A command that was not executed stops the
//     loop (fail-closed).
//   - the fail-closed PATHS: `canonical_path`/`canonical_write_path` need
//     `realpath` (filesystem).
//   - the PROJECT SCAN: `build_project_context` walks the filesystem.
//   - the ENV MAPPING: `load_sdk_config_from_env`/`build_sdk_config_from_env`
//     read `process.env` and the token files.
//
// The browser host therefore injects the model, the storage and (when it
// wants commands to run) an executor — everything else is the core's.
import { createLocalStorageAdapter } from '../../packages/core/src/browser-runtime.ts';
import { resolve_core_config } from '../../packages/core/src/config.ts';
import { assess_base_risk } from '../../packages/core/src/risk.ts';
import { run_primitive_loop } from '../../packages/core/src/loop.ts';
import { format_command_feedback, parse_command_feedback } from '../../packages/core/src/loop-feedback.ts';
import { validate_chain_decision_payload } from '../../packages/core/src/chain-decision.ts';
import { create_core_runtime } from '../../packages/core/src/runtime.ts';
import { create_cancellation_token } from '../../packages/core/src/runtime-api.ts';
import { parse_runtime_limits, truncate_context, truncate_output } from '../../packages/core/src/runtime-limits.ts';

// Injected StorageLike fake (an in-memory Map behind the structural
// contract). Pass a real DOM-storage-shaped object here in production.
function fake_storage_like(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

// A model that asks for a command on the first round and answers after it.
let round = 0;
const model = {
  async ask(_message: string, _options: { system: string; stream: false }): Promise<string> {
    round += 1;
    return round === 1 ? 'Listing the files.\n<RUN>\nls -la\n</RUN>' : 'All done.';
  },
};

const storage = createLocalStorageAdapter(fake_storage_like());

// ---------------------------------------------------------------------------
// 1. The whole runtime: the host injects the model and the storage.
// ---------------------------------------------------------------------------
const runtime = create_core_runtime({
  config: resolve_core_config({ host: 'web', layers: [{}] }),
  model,
  storage,
});
const result = await runtime.run('What is in this directory?');
console.log('[runtime] status  =', result.status);
console.log('[runtime] text    =', JSON.stringify(result.text));
console.log('[runtime] command =', JSON.stringify(result.commands[0]));
console.log('[runtime] note    = the command was REPORTED, never executed (no executor in the browser)');

// ---------------------------------------------------------------------------
// 2. The primitive loop as the low-level seam: the single turn is injected.
// ---------------------------------------------------------------------------
const seen: string[] = [];
const loop_result = await run_primitive_loop('hi', {
  runtime_options: {},
  single_turn: {
    run: async (message: string) => {
      seen.push(message);
      return { status: 'completed', text: 'done', timeline: [`User:\n${message}`], commands: [] };
    },
  },
  max_rounds: 8,
});
console.log('[loop]    status  =', loop_result.status);
console.log('[loop]    rounds  =', seen.length);

// ---------------------------------------------------------------------------
// 3. Cancellation: the token the loop checks at every round boundary.
// ---------------------------------------------------------------------------
const token = create_cancellation_token();
token.cancel();
const cancelled = await run_primitive_loop('hi', {
  runtime_options: { cancellation: token },
  single_turn: {
    run: async () => {
      throw new Error('a cancelled token must stop the loop before the first round');
    },
  },
});
console.log('[cancel]  status  =', cancelled.status);

// ---------------------------------------------------------------------------
// 4. The ports, the config, the limits and the wording.
// ---------------------------------------------------------------------------
console.log('[risk]    sudo    =', assess_base_risk('sudo ls', 'strict').risky);
console.log('[config]  model   =', resolve_core_config({ host: 'web', layers: [{}] }).model);
console.log('[limits]  ok      =', parse_runtime_limits({ flags: {}, env: {}, tellrcLayers: [] }).exec_timeout_ms);
console.log('[limits]  output  =', JSON.stringify(truncate_output('x'.repeat(100), 10)));
console.log('[limits]  context =', truncate_context('y'.repeat(5000), 1024).length);
console.log('[confirm] payload =', JSON.stringify(validate_chain_decision_payload({ decisionId: 'd1', expectedVersion: 0, decision: 'approve' })));

// The feedback protocol (the wording the server chain uses too).
const feedback = format_command_feedback('ls -la', 'total 0\n', 0, { with_instruction: true });
console.log('[wording] feedback =', JSON.stringify(feedback.split('\n')[0]));
console.log('[wording] parsed   =', JSON.stringify(parse_command_feedback(feedback)));
