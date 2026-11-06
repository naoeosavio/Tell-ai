/**
 * Node-only task store: ids, claim, read, reset on disk.
 *
 * One owner for the task-dir lifecycle both hosts use: the CLI (`-t/--task`)
 * and the Web sandbox (`tell-web -t`) share `~/.ai/tell_context`, so the
 * atomic claim (F4), the directory-only id listing (F6), the prompt rule for
 * a new task (F5) and the full-wipe reset (F3) must live in exactly one
 * module. Pure naming stays in `./task-naming` (browser-safe); this module
 * reads and writes the filesystem and never runs in the browser.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { truncate_context } from './runtime-limits';
import {
  find_task_id,
  format_task_id,
  is_task_id,
  next_task_number,
  resolve_task_id,
  split_task_value,
  task_name_from_ref,
} from './task-naming';

/** Name of the context file inside one task directory. */
const MAIN_CONTEXT_FILE = 'main.txt';
/** Pattern of a delegation child record (`delegate-NNN.txt`/`subtask-NNN.txt`). */
const CHILD_RECORD_PATTERN = /^(delegate|subtask)-\d+\.txt$/;
/** Claim retries before giving up (a concurrent storm should never hit 8). */
const RESERVE_MAX_ATTEMPTS = 8;

/**
 * Returns the context file path of one task id (`<context_dir>/<id>/main.txt`).
 *
 * @param context_dir - Context root (`~/.ai/tell_context`).
 * @param id - The task id.
 * @returns The `main.txt` path of the task.
 */
export function task_context_file(context_dir: string, id: string): string {
  return path.join(context_dir, id, MAIN_CONTEXT_FILE);
}

/** A task directory claimed on disk (the store's minimal plan shape). */
export type ReservedTask = {
  /** The task id (`task-NNN-name`). */
  id: string;
  /** The task directory (`<context_dir>/<id>`). */
  dir: string;
  /** The task context file (`<dir>/main.txt`). */
  file: string;
  /** True when the id already existed (a resume, not a create). */
  resumed: boolean;
};

/** Resolved pieces of one `--task` value, with the id it addresses. */
export type TaskValue = ReservedTask & {
  /** The reference after `%`, or null for a hash-named task. */
  reference: string | null;
  /** Normalized task name (from the ref, or the prompt hash). */
  name: string;
  /** Prompt text carried by this value (`rest` + prompt). */
  task_prompt: string;
};

/**
 * Computes the hash name of a prompt-derived task.
 *
 * Both hosts historically used `sha256(cwd + "\n" + prompt)` and the first
 * `8` hex characters (D6); the owner lives here so the CLI and the Web can
 * never derive a different id from the same value.
 *
 * @param cwd - Working directory the run is anchored to.
 * @param prompt - Full task prompt text.
 * @returns The first 8 hex characters of the hash.
 */
export function task_name_from_prompt(cwd: string, prompt: string): string {
  return createHash('sha256').update(`${cwd}\n${prompt}`).digest('hex').slice(0, 8);
}

/**
 * Lists the task ids that exist under a context root.
 *
 * Only directories count (F6): a stray `task-001-name.txt` file must never
 * address a task, and a directory counts even before `main.txt` exists —
 * another run may have claimed the number and still be in flight.
 *
 * @param context_dir - Context root (`~/.ai/tell_context`).
 * @returns The task ids on disk, empty when the root is missing.
 */
export function list_task_ids(context_dir: string): string[] {
  let dirents: fs.Dirent[] = [];
  try {
    dirents = fs.readdirSync(context_dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents.filter((dirent) => dirent.isDirectory() && is_task_id(dirent.name)).map((dirent) => dirent.name);
}

/**
 * Resolves one `--task` value into the task it addresses.
 *
 * Reuses the naming owners: `split_task_value` splits the raw value and
 * `task_name_from_ref` normalizes a `%ref`; the id rules are the claim rules
 * (`resolve_claim`). A new task without any prompt text fails closed (F5):
 * the CLI stops with "missing prompt" and the Web exits 2, instead of
 * creating a task that can never run.
 *
 * @param raw - The raw `-t/--task` value (empty when the flag is bare).
 * @param prompt - The positional prompt of this invocation.
 * @param cwd - Working directory for the hash name.
 * @param context_dir - Context root (the id rules read the same listing the
 * claim will see, so a caller that claims next gets the same id).
 * @returns The resolved pieces and the id it addresses.
 * @throws Error without prompt text on a brand-new task, or an empty name.
 */
export function resolve_task_value(raw: string, prompt: string, cwd: string, context_dir: string): TaskValue {
  const { first, rest } = split_task_value(raw);
  const reference = first.startsWith('%') ? first.slice(1) : null;
  const task_prompt = [rest, prompt].filter(Boolean).join(' ').trim();
  const name = reference !== null ? task_name_from_ref(reference) : task_name_from_prompt(cwd, task_prompt);
  if (name === '') {
    throw new Error('Invalid task name — use letters, digits and dashes');
  } else {
    // The name is usable; resolve the id below.
  }
  const claim = resolve_claim(reference, name, context_dir);
  if (!claim.resumed && task_prompt === '') {
    throw new Error('missing prompt — a new task needs an objective');
  } else {
    // A resume without a prompt continues from the saved context.
  }
  return {
    reference,
    name,
    task_prompt,
    id: claim.id,
    dir: claim.dir,
    file: claim.file,
    resumed: claim.resumed,
  };
}

// ---------------------------------------------------------------------------
// Disk lifecycle: claim, read, reset, release.
// ---------------------------------------------------------------------------

/**
 * Best-effort tightening of one store permission.
 *
 * `mkdir`/`open` only apply `mode` at creation, so a store written by an
 * older version (or with a lax umask) would otherwise stay group/other
 * readable forever. A chmod failure must never fail the actual write.
 *
 * @param target - File or directory to tighten.
 * @param mode - Target permission bits.
 */
function tighten_permissions(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Exotic filesystems (and some Windows setups) reject chmod.
  }
}

/**
 * Claims a task directory atomically.
 *
 * A plain `mkdir` (never `recursive`) fails with `EEXIST` when a concurrent
 * run took the number first; the claim then retries with a fresh id listing
 * so two runs can never share one task directory (F4). An existing
 * directory id resumes without claiming anything.
 *
 * @param context_dir - Context root (`~/.ai/tell_context`).
 * @param reference - The `%ref` value, or null for a hash-named task.
 * @param name - Normalized task name for this invocation.
 * @returns The claimed (or resumed) task pointer.
 * @throws Error when no number could be claimed after the retries.
 */
export function reserve_task_dir(context_dir: string, reference: string | null, name: string): ReservedTask {
  for (let attempt = 0; attempt < RESERVE_MAX_ATTEMPTS; attempt += 1) {
    const resolved = resolve_claim(reference, name, context_dir);
    if (resolved.resumed) {
      return resolved;
    } else {
      try {
        fs.mkdirSync(context_dir, { recursive: true, mode: 0o700 });
      } catch {
        // Root exists or is unwritable: the claim below surfaces the error.
      }
      try {
        fs.mkdirSync(resolved.dir, { mode: 0o700 });
        tighten_permissions(resolved.dir, 0o700);
        return resolved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          // The number was taken between the listing and this mkdir (a
          // concurrent claim, or a file shadowed it in the same window).
        } else {
          throw error;
        }
      }
    }
  }
  throw new Error('Could not allocate a task number — retry the run');
}

/**
 * Lists every id-pattern name on disk, files included (claim allocation).
 *
 * A task-named file can never be *resumed* (`list_task_ids`, F6), but its
 * name still blocks a plain `mkdir`: the number allocator reads both lists
 * so a stray `task-002-x` file pushes the next claim to `task-003` instead
 * of colliding forever.
 *
 * @param context_dir - Context root (`~/.ai/tell_context`).
 * @returns Every `task-NNN-*` name on disk, directories and files alike.
 */
function list_task_names(context_dir: string): string[] {
  let dirents: fs.Dirent[] = [];
  try {
    dirents = fs.readdirSync(context_dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents.filter((entry) => is_task_id(entry.name)).map((entry) => entry.name);
}

/**
 * Resolves one pointer over the current disk state, then dodges file shadows.
 *
 * Resume semantics read directories only (`find_task_id` over the dir list,
 * plus `resolve_task_id` for the by-name rule). A new claim takes the next
 * free number over *all* id-pattern names, so a task-named file never makes
 * the same `task-NNN-name` allocation retry until the attempt budget dies.
 *
 * @param reference - The `%ref` value, or null for a hash-named task.
 * @param name - Normalized task name.
 * @param context_dir - Context root.
 * @returns The resolved pointer (resumed or freshly numbered, unclaimed).
 */
function resolve_claim(reference: string | null, name: string, context_dir: string): ReservedTask {
  const dirs = list_task_ids(context_dir);
  const exited = reference !== null ? find_task_id(reference, dirs) : null;
  if (exited !== null) {
    const dir = path.join(context_dir, exited);
    return { id: exited, dir, file: task_context_file(context_dir, exited), resumed: true };
  } else {
    // Not an exact id on disk: the by-name rule decides resume-or-create
    // below (directories only, so a file never absorbs a task name).
  }
  const resolved = resolve_task_id(reference, name, dirs);
  if (resolved.resumed) {
    const dir = path.join(context_dir, resolved.id);
    return { id: resolved.id, dir, file: task_context_file(context_dir, resolved.id), resumed: true };
  }
  // A fresh number: skip every id-pattern name on disk (a file included) so
  // the claim above can never run into a standing EEXIST wall of shadows.
  const taken = list_task_names(context_dir);
  const shadowed = taken.includes(resolved.id);
  if (!shadowed) {
    const dir = path.join(context_dir, resolved.id);
    return { id: resolved.id, dir, file: task_context_file(context_dir, resolved.id), resumed: false };
  } else {
    // The number is taken by an entry `resolve_task_id` cannot see.
  }
  const free = format_task_id(next_task_number([...new Set([...dirs, ...taken])]), name);
  const dir = path.join(context_dir, free);
  return { id: free, dir, file: task_context_file(context_dir, free), resumed: false };
}

/**
 * Writes the empty context file of a freshly claimed task.
 *
 * Anchors the task for the other host: a task the Web opened must exist on
 * disk, or the CLI would allocate the same number again. Call this after
 * `reserve_task_dir` — the claim owns the directory, this only seeds it.
 *
 * @param task - The claimed task pointer.
 */
export function init_task_context(task: ReservedTask): void {
  try {
    fs.writeFileSync(task.file, '', { encoding: 'utf8', mode: 0o600 });
    tighten_permissions(task.file, 0o600);
  } catch (error) {
    console.error('Task context could not be created:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reads the saved task context (`main.txt`), trimmed and capped.
 *
 * @param task - The task pointer.
 * @param max_chars - Optional delivered-context cap (reuses `truncate_context`).
 * @returns The stored text, empty when the file is absent.
 */
export function read_task_context(task: ReservedTask, max_chars?: number): string {
  let text = '';
  try {
    text = fs.readFileSync(task.file, 'utf8').trim();
  } catch {
    return '';
  }
  return max_chars === undefined ? text : truncate_context(text, max_chars);
}

/**
 * Full-wipe reset of one task directory (`-n` modifier).
 *
 * Removes `main.txt` and every child record (`delegate-NNN.txt` /
 * `subtask-NNN.txt`), keeps the directory (the NNN anchor) and the history
 * files, then writes an empty `main.txt` so the task stays visible. Other
 * files in the directory never get touched.
 *
 * @param task - The task pointer to reset.
 */
export function wipe_task_dir(task: ReservedTask): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(task.dir);
  } catch {
    return;
  }
  for (const entry of names) {
    if (entry === MAIN_CONTEXT_FILE || CHILD_RECORD_PATTERN.test(entry)) {
      try {
        fs.unlinkSync(path.join(task.dir, entry));
      } catch {
        // Best effort — a missing file races nothing.
      }
    } else {
      // Other files stay.
    }
  }
  try {
    fs.mkdirSync(task.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(task.file, '', { encoding: 'utf8', mode: 0o600 });
    tighten_permissions(task.file, 0o600);
  } catch (error) {
    process.stderr.write(
      `Warning: failed to reset ${task.dir}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/**
 * Releases a task directory claimed by a run that never persisted `main.txt`.
 *
 * The number is claimed before the model is called, so every failure path
 * (bad model spec, provider error, a crash before the first save) must give
 * it back; otherwise an invisible empty task consumes the number forever.
 * Resumed tasks keep their directory, and a task whose `main.txt` exists was
 * persisted, so neither is removed.
 *
 * @param task - The claimed task plan for this invocation, if any.
 */
export function discard_unused_task(task: ReservedTask | undefined): void {
  if (task === undefined || task.resumed) {
    return;
  } else if (fs.existsSync(task.file)) {
    return;
  } else {
    try {
      fs.rmdirSync(task.dir);
    } catch {
      // The directory is gone or not empty — nothing to clean.
    }
  }
}
