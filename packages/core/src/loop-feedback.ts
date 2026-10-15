/**
 * One owner for the command-feedback protocol shared by every host.
 *
 * Pure text helpers on purpose: no builtin imports, no environment, no I/O. The Node
 * hosts (CLI, Web server) import this through `@tell-ai/core`; the browser
 * bundle imports the same module through the `browser` condition of the main
 * entry, so the Web fallback loop can never drift from the server wording.
 */

/** Follow-up instruction for rounds that may still request a command. */
export const COMMAND_FEEDBACK_INSTRUCTION =
  'Request another command with <RUN> tags if needed; otherwise answer without <RUN> tags.';

/** Self-heal preamble prepended to a failed round feedback. */
export const COMMAND_FEEDBACK_FAILED_PREAMBLE =
  'The command above FAILED. Analyze the error output and try a corrected approach.';

/** Kind of command outcome a feedback text describes. */
export type CommandFeedbackKind = 'executed' | 'failed' | 'skipped' | 'cancelled';

/** Parsed pieces of a command-feedback text. */
export type ParsedCommandFeedback = {
  /** Outcome the text reports. */
  kind: CommandFeedbackKind;
  /** Script the feedback talks about. */
  script: string;
  /** Reported output (empty when the text carries none). */
  output: string;
  /** Exit code when the text states one, null otherwise. */
  exit_code: number | null;
};

/** Options for `format_command_feedback`. */
export type CommandFeedbackOptions = {
  /** Appends the follow-up instruction and the self-heal preamble (default false). */
  with_instruction?: boolean;
};

/** Header of the executed-command record. */
export const EXECUTED_HEADER = 'Executed command:';
/** Header of the cancelled-command record. */
export const CANCELLED_HEADER = 'Command cancelled:';
/** Header of the skipped-command record. */
export const SKIPPED_HEADER = 'Skipped by user:';
/** Separator between the script and the output inside a record. */
export const OUTPUT_SEPARATOR = '\nOutput:\n';
/** Matches the failed-command header with its optional exit code. */
const FAILED_HEADER_PATTERN = /^Command failed(?: \(exit code (\d+)\))?:\n/;

/**
 * Formats the canonical record of one executed command.
 *
 * This is the wording every host stores in its log, context and chat history
 * when a script actually ran — success or failure — so only the core may
 * assemble it.
 *
 * @param script - Script that ran.
 * @param output - Combined, already redacted output.
 * @returns The executed record text.
 */
export function format_executed_command(script: string, output: string): string {
  return `${EXECUTED_HEADER}\n${script}${OUTPUT_SEPARATOR}${output}`;
}

/**
 * Formats the canonical record of one failed command.
 *
 * A null exit code (an executor error with no status) drops the parenthetical,
 * keeping the header recognizable by `split_context_turns`.
 *
 * @param script - Script that ran.
 * @param output - Combined, already redacted output.
 * @param exit_code - Exit code, or null when no status is known.
 * @returns The failed record text.
 */
export function format_failed_command(script: string, output: string, exit_code: number | null): string {
  if (exit_code === null) {
    return `Command failed:\n${script}${OUTPUT_SEPARATOR}${output}`;
  } else {
    return `Command failed (exit code ${exit_code}):\n${script}${OUTPUT_SEPARATOR}${output}`;
  }
}

/**
 * Formats the canonical record of one command outcome.
 *
 * Dispatches on the exit code: 0 reports `Executed command:`, anything else
 * `format_failed_command`. Hosts that report a failure with the executed
 * wording (the Web chain) call `format_executed_command` directly.
 *
 * @param script - Script that ran.
 * @param output - Combined, already redacted output.
 * @param exit_code - Exit code, or null when no status is known.
 * @returns The record text.
 */
export function format_command_result(script: string, output: string, exit_code: number | null): string {
  if (exit_code === 0) {
    return format_executed_command(script, output);
  } else {
    return format_failed_command(script, output, exit_code);
  }
}

/**
 * Formats the record of one command the user declined to run.
 *
 * @param script - Script that was skipped.
 * @returns The skip record text.
 */
export function format_command_skipped(script: string): string {
  return `${SKIPPED_HEADER}\n${script}`;
}

/**
 * Formats the record of one command cancelled before it produced output.
 *
 * @param script - Script whose execution was cancelled.
 * @returns The cancelled record text.
 */
export function format_cancelled_command(script: string): string {
  return `${CANCELLED_HEADER}\n${script}`;
}

/**
 * Formats a non-execution status marker for one requested script.
 *
 * Approval/denial/no-executor states carry a `Command <status>:` header with no
 * output — the same wording vocabulary the hosts render. Keeping it here means
 * one module owns every header a timeline can contain.
 *
 * @param status - Command status (`denied`, `awaiting_approval`, `requested`, `skipped`).
 * @param script - Script that was not executed.
 * @returns The status marker text.
 */
export function format_command_status(status: string, script: string): string {
  return `Command ${status}:\n${script}`;
}

/**
 * Formats the follow-up prompt for one finished command round.
 *
 * Wraps `format_command_result` with the round preamble and the continuation
 * instruction, so the model receives one protocol for success and for
 * self-healing after a failure.
 *
 * @param script - Script that ran.
 * @param output - Combined, already redacted output.
 * @param exit_code - Exit code, or null when no status is known.
 * @param options - `with_instruction` adds preamble plus continuation line.
 * @returns The feedback text.
 */
export function format_command_feedback(
  script: string,
  output: string,
  exit_code: number | null,
  options: CommandFeedbackOptions = {},
): string {
  const record = format_command_result(script, output, exit_code);
  if (options.with_instruction !== true) {
    return record;
  } else if (exit_code === 0) {
    return `${record}\n\n${COMMAND_FEEDBACK_INSTRUCTION}`;
  } else {
    return `${COMMAND_FEEDBACK_FAILED_PREAMBLE}\n\n${record}\n\n${COMMAND_FEEDBACK_INSTRUCTION}`;
  }
}

/**
 * Strips the round preamble and the continuation line from a feedback text.
 *
 * @param text - Raw feedback text.
 * @returns The bare record text.
 */
function strip_feedback_extras(text: string): string {
  let bare = text;
  const suffix = `\n\n${COMMAND_FEEDBACK_INSTRUCTION}`;
  if (bare.endsWith(suffix)) {
    bare = bare.slice(0, bare.length - suffix.length);
  } else {
    // No continuation line — nothing to trim from the tail.
  }
  const preamble = `${COMMAND_FEEDBACK_FAILED_PREAMBLE}\n\n`;
  if (bare.startsWith(preamble)) {
    bare = bare.slice(preamble.length);
  } else {
    // No self-heal preamble — nothing to trim from the head.
  }
  return bare;
}

/**
 * Splits a record into its script and output halves.
 *
 * @param record - Record text without header.
 * @returns The script (trimmed) and the raw output.
 */
function split_record(record: string): { script: string; output: string } {
  const separator = record.indexOf(OUTPUT_SEPARATOR);
  if (separator === -1) {
    return { script: record.trim(), output: '' };
  } else {
    return {
      script: record.slice(0, separator).trim(),
      output: record.slice(separator + OUTPUT_SEPARATOR.length),
    };
  }
}

/**
 * Parses a command-feedback text back into its pieces.
 *
 * Recognizes every wording this module formats: executed, failed (with or
 * without an exit code), skipped and cancelled records, plus the full round
 * feedback with its preamble and continuation line. Anything else is not
 * feedback.
 *
 * @param text - Candidate feedback text.
 * @returns The parsed pieces, or null when the text is not a feedback record.
 */
export function parse_command_feedback(text: string): ParsedCommandFeedback | null {
  const bare = strip_feedback_extras(text);
  if (bare.startsWith(`${SKIPPED_HEADER}\n`)) {
    return { kind: 'skipped', script: bare.slice(SKIPPED_HEADER.length).trim(), output: '', exit_code: null };
  } else if (bare.startsWith(`${CANCELLED_HEADER}\n`)) {
    return { kind: 'cancelled', script: bare.slice(CANCELLED_HEADER.length).trim(), output: '', exit_code: null };
  } else if (bare.startsWith(`${EXECUTED_HEADER}\n`)) {
    const parts = split_record(bare.slice(EXECUTED_HEADER.length));
    return { kind: 'executed', script: parts.script, output: parts.output, exit_code: 0 };
  } else {
    const failed = FAILED_HEADER_PATTERN.exec(bare);
    if (failed === null) {
      return null;
    } else {
      const parts = split_record(bare.slice(failed[0].length));
      const code = failed[1];
      return {
        kind: 'failed',
        script: parts.script,
        output: parts.output,
        exit_code: code === undefined ? null : Number(code),
      };
    }
  }
}
