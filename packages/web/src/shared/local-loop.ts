// The browser-side chain loop, built on the core's primitive loop.
//
// The Web client used to run its own hand-rolled iteration: ask the server,
// look for a `<RUN>` script, run it, feed the output back, repeat. That
// protocol is owned by `@tell-ai/core` (`run_primitive_loop`) and now ships
// in the browser entry, so the fallback loop and the server chain run the
// SAME iteration: the same round cap, the same feedback wording, the same
// fail-closed stops.
//
// What stays on this side is the transport: the model call and the command
// execution are the server's job (the provider keys never reach the
// browser), so they arrive as injected callbacks. This module owns only
// the protocol glue.
//
// No React here on purpose — the App wires the callbacks to its state, and
// the sandbox suite exercises this module directly.

import { type CancellationToken, chain_limit_notice, run_primitive_loop, type TellResult } from '@tell-ai/core';

/** What one round produced: the model text and the command it asked for. */
export type LocalLoopRound = {
  /** The model's answer for this round (already stripped of `<RUN>` tags). */
  text: string;
  /** The script the model asked to run, or null when it answered directly. */
  script: string | null;
  /** Delegation request (`<DELEGATE>`/`<SUBTASK>`), or null when absent. */
  delegation?: { kind: 'research' | 'build'; objective: string } | null;
};

/** What one executed command produced. */
export type LocalLoopExecution = {
  /** Combined command output (already redacted and capped by the server). */
  output: string;
  /** The command exit code (0 means success). */
  exit_code: number;
};

/** Injected transport for the local loop. */
export type LocalLoopOptions = {
  /** The first user message of the run (the prompt that starts the chain). */
  message: string;
  /** One round: asks the model and reports the command it asked for. */
  ask: (message: string) => Promise<LocalLoopRound>;
  /** Runs a command the model asked for. */
  execute: (script: string) => Promise<LocalLoopExecution>;
  /**
   * Decides whether the command may run right now. Returning false holds
   * the command for the user (the loop stops, fail-closed) and the caller
   * resumes the chain after the decision.
   */
  may_execute: (script: string) => Promise<boolean>;
  /** Runs a delegation (`<DELEGATE>`/`<SUBTASK>`) and returns the record. */
  delegate?: (kind: 'research' | 'build', objective: string) => Promise<string>;
  /** Round cap for this run (the core clamps it to at least 1). */
  max_rounds: number;
  /** Cancellation token — the App maps its abort signal onto it. */
  cancellation?: CancellationToken;
};

/** What the local loop produced. */
export type LocalLoopResult = {
  /** The core's outcome (`completed`, `awaiting_approval`, `cancelled`, …). */
  status: TellResult['status'];
  /** The last model text of the run. */
  text: string;
  /** The command that was held for the user, when the loop stopped there. */
  pending_script: string | null;
  /** How many rounds actually ran. */
  rounds: number;
  /** True when the round cap cut the chain short (the core's own notice). */
  truncated: boolean;
  /** The commands the loop reported, in order. */
  commands: TellResult['commands'];
};

/**
 * Runs the browser-side chain on the core's primitive loop.
 *
 * The injected single turn owns one round: it asks the model and, when the
 * model asks for a command, runs it (or holds it for the user). The core
 * owns everything else — the round cap, the feedback wording fed back to
 * the model, the fail-closed stops and the cancellation boundary.
 *
 * A command the user must approve stops the loop (`awaiting_approval`): the
 * core never executes anything on its own, and the caller resumes the chain
 * with the decision it took.
 *
 * @param options - The message, the transport callbacks and the round cap.
 * @returns The loop outcome.
 */
export async function run_local_loop(options: LocalLoopOptions): Promise<LocalLoopResult> {
  let rounds = 0;
  let pending_script: string | null = null;

  const single_turn = {
    run: async (message: string): Promise<TellResult> => {
      rounds += 1;
      const round = await options.ask(message);
      const timeline = [`User:\n${message}`, `Assistant:\n${round.text}`];
      if (round.delegation !== undefined && round.delegation !== null) {
        // Delegation wins over `<RUN>`: the tag is consumed here, the record
        // becomes the next message via the core loop branch.
        if (options.delegate === undefined) {
          return { status: 'completed', text: round.text, timeline, commands: [] };
        }
        const record = await options.delegate(round.delegation.kind, round.delegation.objective);
        timeline.push(record);
        return {
          status: 'completed',
          text: round.text,
          timeline,
          commands: [],
          delegation: { kind: round.delegation.kind, record, summary: record },
        };
      }
      if (round.script === null) {
        return { status: 'completed', text: round.text, timeline, commands: [] };
      }
      const allowed = await options.may_execute(round.script);
      if (!allowed) {
        // Held for the user: the core stops here (fail-closed) and the
        // command stays visible in `commands`.
        pending_script = round.script;
        return {
          status: 'awaiting_approval',
          text: round.text,
          timeline,
          commands: [{ script: round.script, status: 'awaiting_approval' }],
        };
      }
      const execution = await options.execute(round.script);
      const failed = execution.exit_code !== 0;
      return {
        status: 'completed',
        text: round.text,
        timeline,
        commands: [
          {
            script: round.script,
            status: failed ? 'failed' : 'executed',
            output: execution.output,
            exit_code: execution.exit_code,
          },
        ],
      };
    },
  };

  const result = await run_primitive_loop(options.message, {
    runtime_options: options.cancellation !== undefined ? { cancellation: options.cancellation } : {},
    single_turn,
    max_rounds: options.max_rounds,
  });

  // The core records the cap in the timeline (its own notice): that is the
  // signal that the chain wanted another round and did not get one.
  const budget = Math.max(1, Math.floor(options.max_rounds));
  const last = result.timeline[result.timeline.length - 1];
  const truncated = last !== undefined && last === chain_limit_notice(budget);

  return {
    status: result.status,
    text: result.text,
    pending_script,
    rounds,
    truncated,
    commands: result.commands,
  };
}
