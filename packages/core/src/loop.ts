import { COMMAND_FEEDBACK_INSTRUCTION, format_command_feedback } from './loop-feedback';
import type { CancellationToken, RuntimeCommand, TellResult, TellRuntime, TellRuntimeOptions } from './runtime-api';
import { DEFAULT_MAX_CHAIN_STEPS } from './runtime-limits';

/** Default model→command rounds per run (owned by `./runtime-limits`). */
export const LOOP_MAX_ROUNDS = DEFAULT_MAX_CHAIN_STEPS;

/** Chain-limit notice recorded when rounds run out (CLI `finish_round` wording). */
export const CHAIN_LIMIT_NOTICE = `Chain limit reached (${LOOP_MAX_ROUNDS}); ignoring further requested commands.`;

/**
 * Builds the chain-limit notice for the round cap actually in effect.
 *
 * The notice must name the budget the run really had (`--max-chain N`),
 * never the default.
 *
 * @param max_rounds - Round cap of the running loop.
 * @returns The notice recorded in the timeline.
 */
export function chain_limit_notice(max_rounds: number): string {
  return `Chain limit reached (${max_rounds}); ignoring further requested commands.`;
}

/** Follow-up instruction for rounds that may still request a command (owned by `./loop-feedback`). */
export const CONTINUE_INSTRUCTION = COMMAND_FEEDBACK_INSTRUCTION;

/** Options for `run_primitive_loop` (ports arrive inside the injected runner). */
export type CoreLoopOptions = {
  /**
   * The host options the loop reads.
   *
   * Only the cancellation token matters here: the ports themselves are
   * already baked into the injected `single_turn` runner, so the loop never
   * constructs a runtime of its own. Partial on purpose — a browser host has
   * no `TellRuntimeOptions` to build (no model, no executor); it passes the
   * token alone.
   */
  runtime_options: Partial<TellRuntimeOptions>;
  /**
   * Injected single-turn runner (`createTellRuntime` on Node, a hand-made
   * turn in the browser).
   *
   * The loop never builds one: it stays import-pure and Node-free, and the
   * host owns the wiring (including the SDK main entry on Node).
   */
  single_turn: TellRuntime;
  /** Round cap (defaults to `LOOP_MAX_ROUNDS`, minimum 1). */
  max_rounds?: number;
};

/**
 * Builds the self-healing follow-up prompt from a round command result.
 *
 * Delegates the wording to `format_command_feedback` (`./loop-feedback`, the
 * single owner) so every consumer (CLI chain, Web chain) sees one protocol:
 * an `Executed command` (or `Command failed`) header with the redacted
 * script and output, a FAILED preamble when the exit code is non-zero, then
 * the continuation instruction. History itself travels through the storage
 * port, so only the new feedback is returned. Raw output never reaches
 * here — the SDK redaction boundary already ran right after the executor
 * returned.
 *
 * @param script - Redacted command script of the finished round.
 * @param output - Redacted combined command output.
 * @param exit_code - Command exit code (0 means success).
 * @returns The next user message for the model.
 */
function build_loop_feedback(script: string, output: string, exit_code: number): string {
  return format_command_feedback(script, output, exit_code, { with_instruction: true });
}

/**
 * Merges one SDK round into the aggregated run (skips the repeated `User:` line).
 *
 * @param aggregated - Timeline accumulator owned by the loop.
 * @param round_timeline - Timeline of the finished round.
 * @param first_round - True for round one (keeps its `User:` line).
 */
function merge_timeline(aggregated: string[], round_timeline: string[], first_round: boolean): void {
  const entries = first_round ? round_timeline : round_timeline.slice(1);
  for (const entry of entries) {
    aggregated.push(entry);
  }
}

/**
 * Runs the single primitive exec/loop: at most eight model→command rounds.
 *
 * Each round delegates to the SDK single-turn wiring (storage, thinking/text
 * callbacks, approval, executor, redaction boundary), so the core never
 * duplicates turn logic and the SDK never grows a second loop. The loop only
 * iterates: it feeds redacted command output + exit code back until the
 * model answers without a script, a command is not executed
 * (`denied`/`skipped`/`awaiting_approval`/`cancelled`), cancellation fires,
 * or the round cap is hit. Executor failures self-heal through the FAILED
 * feedback variant. No `PolicyDecision` is fabricated here: without an
 * explicit approval the SDK wiring already fails closed, and the loop stops
 * on whatever non-executed status it reports.
 *
 * Cancellation travels with the runner: the token from `runtime_options` is
 * checked at every round boundary *and* forwarded to the single turn, so a
 * cancel that fires mid-round still aborts before the command runs (the
 * runner owns the executor boundary, the loop owns the round boundary).
 *
 * @param message - Initial user message.
 * @param options - Injected single-turn runner plus the round cap.
 * @returns The aggregated `TellResult` (contract type reused from the SDK).
 */
export async function run_primitive_loop(message: string, options: CoreLoopOptions): Promise<TellResult> {
  const runtime_options = options.runtime_options;
  const single_turn = options.single_turn;
  const max_rounds =
    options.max_rounds !== undefined && Number.isFinite(options.max_rounds)
      ? Math.max(1, Math.floor(options.max_rounds))
      : LOOP_MAX_ROUNDS;
  const token: CancellationToken | undefined = runtime_options.cancellation;

  const timeline: string[] = [];
  const commands: RuntimeCommand[] = [];
  let text = '';
  let first_round = true;
  let current_message = message;

  for (let round = 1; round <= max_rounds; round += 1) {
    if (token?.cancelled) {
      return { status: 'cancelled', text, timeline, commands };
    } else {
      // Still live — run the next single turn below.
    }
    const round_result = await single_turn.run(
      current_message,
      token !== undefined ? { cancellation: token } : undefined,
    );
    merge_timeline(timeline, round_result.timeline, first_round);
    first_round = false;
    text = round_result.text;
    for (const command of round_result.commands) {
      commands.push(command);
    }

    if (round_result.status === 'cancelled') {
      return { status: 'cancelled', text, timeline, commands };
    } else if (round_result.status === 'awaiting_approval') {
      return { status: 'awaiting_approval', text, timeline, commands };
    } else if (round_result.status === 'failed' && round_result.commands.length === 0) {
      return { status: 'failed', text, timeline, commands };
    } else {
      // Completed or failed-with-command — inspect the command below.
    }
    const last = round_result.commands[round_result.commands.length - 1];
    if (round_result.delegation !== undefined) {
      // Delegation consumed one parent round: the record becomes the next
      // message (same shape as command feedback), unless the budget ran out
      // or cancellation fired.
      if (token?.cancelled) {
        return { status: 'cancelled', text, timeline, commands };
      } else if (round === max_rounds) {
        timeline.push(chain_limit_notice(max_rounds));
        return { status: 'completed', text, timeline, commands };
      } else {
        current_message = round_result.delegation.record;
      }
    } else if (last === undefined) {
      return { status: 'completed', text, timeline, commands };
    } else if (last.status === 'executed' || last.status === 'failed') {
      if (round === max_rounds) {
        timeline.push(chain_limit_notice(max_rounds));
        return { status: 'completed', text, timeline, commands };
      } else {
        current_message = build_loop_feedback(last.script, last.output ?? '', last.exit_code ?? 1);
      }
    } else {
      // Confirm pauses, deny ends: non-executed commands stop the loop and
      // stay visible in `commands` (never hidden).
      return { status: 'completed', text, timeline, commands };
    }
  }
  return { status: 'completed', text, timeline, commands };
}
