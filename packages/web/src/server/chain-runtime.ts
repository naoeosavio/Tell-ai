/**
 * Pure chain helpers for the Web server (`server.ts`).
 *
 * The loop, TTL, replay, auth and concurrency stay in the host; everything
 * that shapes wording or budgets comes from `@tell-ai/core` here, so the
 * server chain and the core primitive loop speak one protocol. No builtins,
 * no environment reads, no state — every budget arrives as a parameter.
 */

import type { PermissionClass } from '@tell-ai/core';
import { classify_script, combine_output, format_command_result, truncate_output } from '@tell-ai/core';
import { extract_runs } from '@tell-ai/sdk';

/**
 * Extracts every `<RUN>` script from a model answer, trimmed and non-empty.
 *
 * Single owner for tag scanning on the server (the SDK parser, never a
 * second regex): the first entry runs, the rest are reported skipped.
 *
 * @param text - Raw model answer (reasoning already stripped by the caller).
 * @returns All requested scripts in order.
 */
export function extract_run_scripts(text: string): string[] {
  return extract_runs(text)
    .scripts.map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Tails huge output before it enters the model context.
 *
 * @param text - Already capped and redacted output.
 * @param max_chars - Tail budget (host-resolved).
 * @returns The tail with a truncation marker, or the text itself.
 */
export function tail_chain_output(text: string, max_chars: number): string {
  if (text.length > max_chars) {
    return `…[truncated]\n${text.slice(-max_chars)}`;
  } else {
    return text;
  }
}

/** Input for `build_chain_command_record` (all budgets explicit). */
export type ChainCommandRecordInput = {
  /** Script that ran (or failed to run). */
  script: string;
  /** Raw standard output. */
  stdout: string;
  /** Raw standard error. */
  stderr: string;
  /** Exit code, or null when no status is known (executor error). */
  exit_code: number | null;
  /** Delivered output cap in bytes (host-resolved). */
  max_bytes: number;
  /** Model-context tail budget in chars (host-resolved). */
  max_tail_chars: number;
  /** Host redactor (runs before the tail, like the core boundary). */
  redact: (value: string) => string;
};

/** One chain command record: model message, stored output, core verdict. */
export type ChainCommandRecord = {
  /** Model-visible record (`Executed command:` or `Command failed…`). */
  message: string;
  /** Stored output (capped + redacted, untailored). */
  output: string;
  /** True unless the exit code is exactly 0. */
  failed: boolean;
};

/**
 * Builds the chain record for one finished command.
 *
 * Join order, redaction boundary and wording are the core's
 * (`combine_output`, `format_command_result`): a non-zero exit (or a missing
 * status) records the failed variant with the FAILED self-healing preamble,
 * never the executed wording.
 *
 * @param input - Script, streams, status and host budgets.
 * @returns The message for the model plus the stored output and verdict.
 */
export function build_chain_command_record(input: ChainCommandRecordInput): ChainCommandRecord {
  const output = input.redact(truncate_output(combine_output(input.stdout, input.stderr), input.max_bytes));
  if (input.exit_code === 0) {
    return {
      message: format_command_result(input.script, tail_chain_output(output, input.max_tail_chars), 0),
      output,
      failed: false,
    };
  } else {
    return {
      message: format_command_result(input.script, tail_chain_output(output, input.max_tail_chars), input.exit_code),
      output,
      failed: true,
    };
  }
}

/** Input for `decide_chain_gate` (host policy as data, no environment). */
export type ChainGateInput = {
  /** Server runs with `--no-exec`. */
  no_exec: boolean;
  /** Server runs with `--require-approval` (`-y` still auto-runs low scripts). */
  require_approval: boolean;
  /** Server auto-runs low scripts (`-y`, task mode forces it). */
  auto_execute: boolean;
  /** Graded class of the script (one table, same as the CLI). */
  permission_class: PermissionClass;
};

/** Verdict of the chain approval gate (texts stay at the call sites). */
export type ChainGateDecision =
  | { action: 'execute' }
  | { action: 'park' }
  | { action: 'deny'; reason: 'no-exec' | 'high-risk' };

/**
 * Decides one chain command without running it.
 *
 * Mirrors the core fail-closed order: `--no-exec` denies first, `forbidden`
 * denies second, `high` denies unless `--require-approval` parks it. Web
 * supervised mode (`-y --require-approval`) is the only run that executes a
 * medium script; every other medium parks on the pending machinery, and only
 * an auto-executed low script runs outright.
 *
 * @param input - Host policy flags and the permission class.
 * @returns The gate verdict (call sites keep their exact texts).
 */
export function decide_chain_gate(input: ChainGateInput): ChainGateDecision {
  if (input.no_exec) {
    return { action: 'deny', reason: 'no-exec' };
  } else if (input.permission_class === 'forbidden') {
    return { action: 'deny', reason: 'high-risk' };
  } else if (input.permission_class === 'high') {
    if (input.require_approval) {
      return { action: 'park' };
    } else {
      return { action: 'deny', reason: 'high-risk' };
    }
  } else if (input.permission_class === 'medium') {
    if (input.auto_execute && input.require_approval) {
      return { action: 'execute' };
    } else {
      return { action: 'park' };
    }
  } else if (input.auto_execute) {
    return { action: 'execute' };
  } else {
    return { action: 'park' };
  }
}

/**
 * Classifies one script for the Web gate (strict reads, host cwd).
 *
 * Single call site for the class the gate consumes: the Web passes the
 * strict rule set to the one table and resolves paths against its anchored
 * working directory.
 *
 * @param script - Command script to classify.
 * @param cwd - Server working directory.
 * @returns The graded class.
 */
export function classify_web_script(script: string, cwd: string): PermissionClass {
  return classify_script(script, { cwd, strict: true }).class;
}

/**
 * Builds the follow-up message for an answer with extra `<RUN>` tags.
 *
 * The server runs only the first script. A per-extra `Skipped by user:`
 * message asks the model to retry the whole answer. One instruction stops
 * that loop and asks for the final text.
 *
 * @param scripts - Scripts that were ignored (never empty).
 * @returns The instruction for the model.
 */
export function format_extras_instruction(scripts: readonly string[]): string {
  const list = scripts.map((script) => `- ${script}`).join('\n');
  return `Only the first <RUN> block ran. The extra blocks below were ignored. Do not repeat them. If the goal is complete, answer now in plain text without <RUN> tags.\n${list}`;
}

/**
 * Checks the execution concurrency guard before starting one command.
 *
 * @param active - Commands currently running on this server.
 * @param max - Host concurrency cap.
 * @returns True when one more command may start.
 */
export function can_start_chain_execution(active: number, max: number): boolean {
  if (active < max) {
    return true;
  } else {
    return false;
  }
}
