/**
 * One owner for composing forwarded custom instructions before a base prompt.
 *
 * The CLI (`tellrc.ts`) and the Web server (`server.ts`) both prepend the
 * host-resolved custom system to their safety prompt. Keeping the wording here
 * means the two hosts can never drift on the prefix the model sees, and no
 * host declares the literal itself.
 *
 * Pure text helpers: no builtin imports, no environment, no I/O.
 */

/** Prefix announcing custom instructions inside a composed system prompt. */
export const CUSTOM_SYSTEM_PREFIX = 'Custom instructions:';

/**
 * Composes custom instructions before a base prompt.
 *
 * The custom text is a preamble: the base prompt (which carries the execution
 * protocol, approval and `<RUN>` rules) always runs last, so a configured
 * system can add style or domain context but never replaces safety.
 *
 * @param custom - Custom instruction text (empty or blank skips the preamble).
 * @param base - Base system prompt the custom text precedes.
 * @returns The composed system prompt.
 */
export function compose_custom_system(custom: string, base: string): string {
  if (custom.trim() === '') {
    return base;
  } else {
    return `${CUSTOM_SYSTEM_PREFIX}\n${custom}\n\n${base}`;
  }
}
