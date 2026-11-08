/**
 * Task-mode naming: one pure owner for `task-NNN-name` ids.
 *
 * Browser-safe on purpose (no builtin, no filesystem, no environment): the
 * CLI and the Web server both resolve task ids with these helpers, so the
 * numbering can never drift between the two hosts. Callers read the existing
 * ids from `~/.ai/tell_context/`; this module only formats them.
 */

/** Shape of a task id: `task-` plus at least three digits plus a kebab name. */
const TASK_ID_PATTERN = /^task-(\d{3,})-(.+)$/;

/** Prefix of a task number inside a task reference. */
const TASK_NUMBER_PREFIX = /^(?:task-)?\d{3,}-/i;

/** Longest task name kept in the id (the `task-NNN-` prefix is extra). */
const TASK_NAME_MAX_CHARS = 50;

/** Characters that a task name may contain after normalization. */
const TASK_NAME_SEPARATOR = /[^a-z0-9-]+/g;

/**
 * Returns true when a value is a task id (`task-NNN-name`).
 *
 * @param value - Candidate id.
 * @returns True for a task id.
 */
export function is_task_id(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

/**
 * Converts a human name to a task name (lowercase kebab).
 *
 * The result starts with a letter. A name that starts with a digit gets the
 * `n-` prefix, so `task-001-2fa` never looks like a number prefix.
 *
 * @param raw - User or model supplied name.
 * @returns The normalized name, or an empty string when nothing remains.
 */
export function to_task_name(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(TASK_NAME_SEPARATOR, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TASK_NAME_MAX_CHARS)
    .replace(/-+$/g, '');
  if (slug === '') {
    return '';
  } else {
    return /^[0-9]/.test(slug) ? `n-${slug}` : slug;
  }
}

/**
 * Normalizes a `%ref` value into the task name it addresses.
 *
 * A full id (`%task-007-fix-build`) and its short forms (`%007-fix-build`,
 * `%fix-build`) resolve to the same name.
 *
 * @param reference - The value after `%`.
 * @returns The normalized task name.
 */
export function task_name_from_ref(reference: string): string {
  return to_task_name(reference.replace(TASK_NUMBER_PREFIX, ''));
}

/**
 * Splits a `--task` value into its first word and the remaining text.
 *
 * The first word is a task reference only when it starts with `%`; every
 * other value is prompt text.
 *
 * @param value - Raw `--task` value.
 * @returns The first word and the remaining text.
 */
export function split_task_value(value: string): { first: string; rest: string } {
  const trimmed = value.trim();
  const separator = trimmed.search(/\s/);
  if (separator === -1) {
    return { first: trimmed, rest: '' };
  } else {
    return { first: trimmed.slice(0, separator), rest: trimmed.slice(separator + 1).trim() };
  }
}

/**
 * Computes the next free task number.
 *
 * Numbers are never reused: the result is the highest saved number plus one,
 * or `1` when no task exists.
 *
 * @param ids - Existing context ids (task and non-task).
 * @returns The next task number.
 */
export function next_task_number(ids: string[]): number {
  let highest = 0;
  for (const id of ids) {
    const match = TASK_ID_PATTERN.exec(id);
    if (match?.[1] !== undefined) {
      highest = Math.max(highest, Number(match[1]));
    } else {
      // Not a task id: it cannot own a task number.
    }
  }
  return highest + 1;
}

/**
 * Formats a task id from a number and a name.
 *
 * @param number - Task number (`1` becomes `001`).
 * @param name - Normalized task name.
 * @returns The task id.
 */
export function format_task_id(number: number, name: string): string {
  return `task-${String(number).padStart(3, '0')}-${name}`;
}

/**
 * Finds the saved task id that a reference addresses.
 *
 * The exact id wins. The `task-` prefix is optional in the reference.
 *
 * @param reference - The value after `%` (or a full id).
 * @param ids - Existing context ids.
 * @returns The matching task id, or null when no task matches.
 */
export function find_task_id(reference: string, ids: string[]): string | null {
  const wanted = reference.trim().toLowerCase();
  if (wanted === '') {
    return null;
  } else {
    const tasks = ids.filter(is_task_id);
    return (
      tasks.find((id) => id.toLowerCase() === wanted) ??
      tasks.find((id) => id.toLowerCase() === `task-${wanted}`) ??
      null
    );
  }
}

/** Result of resolving a task reference or a new task name. */
export type TaskResolution = {
  /** The resolved task id. */
  id: string;
  /** True when the id already exists (a resume, not a create). */
  resumed: boolean;
};

/**
 * Resolves the task id for one invocation.
 *
 * Order: an exact reference match resumes; a task that already has the same
 * name resumes; otherwise a new id takes the next free number. A resume never
 * allocates a number, so names stay stable across sessions.
 *
 * @param reference - The `%ref` value, or null when the name comes from a hash.
 * @param name - Normalized task name for this invocation.
 * @param ids - Existing context ids.
 * @returns The resolved id and whether it is a resume.
 */
export function resolve_task_id(reference: string | null, name: string, ids: string[]): TaskResolution {
  if (reference !== null) {
    const found = find_task_id(reference, ids);
    if (found !== null) {
      return { id: found, resumed: true };
    } else {
      // Not saved yet: fall through to create with this name.
    }
  }
  const by_name = ids.filter(is_task_id).find((id) => TASK_ID_PATTERN.exec(id)?.[2] === name);
  if (by_name !== undefined) {
    return { id: by_name, resumed: true };
  } else {
    return { id: format_task_id(next_task_number(ids), name), resumed: false };
  }
}
