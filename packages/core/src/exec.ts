import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import type { CancellationToken, CommandExecutor, ExecutorOptions, ExecutorResult, Redactor } from './runtime-api';
import { DEFAULT_EXEC_TIMEOUT_MS, DEFAULT_MAX_BUFFER_BYTES } from './runtime-limits';
import { is_sensitive_rel_path } from './read-only';

/** Explicit shell for every executed script (mirrors the CLI executor). */
export const EXEC_SHELL = '/bin/bash';

/** Default per-command timeout (owned by `./runtime-limits`, aliased for the port API). */
export const EXEC_DEFAULT_TIMEOUT_MS = DEFAULT_EXEC_TIMEOUT_MS;

/**
 * Default internal exec buffer in bytes (owned by `./runtime-limits`).
 *
 * This is the cap the executor accumulates into, not the delivered-output cap
 * the host applies afterwards (`DEFAULT_OUTPUT_MAX_BYTES`).
 */
export const EXEC_MAX_OUTPUT_BYTES = DEFAULT_MAX_BUFFER_BYTES;

/** Exit code reported when a command exceeds its timeout (mirrors the CLI). */
export const EXEC_TIMEOUT_EXIT_CODE = 124;

/**
 * Formats the canonical timeout message for one script.
 *
 * The script travels with the message because it becomes model context: the
 * model needs to see *what* timed out to correct itself. Every host (core
 * executor, CLI transport, Web sandbox) reports timeouts this way.
 *
 * @param script - Script that exceeded its timeout.
 * @param timeout_ms - Timeout budget in milliseconds.
 * @returns The timeout message.
 */
export function format_timeout_message(script: string, timeout_ms: number): string {
  const seconds = Math.round(timeout_ms / 1000);
  return `Command timed out after ${seconds}s:\n${script}`;
}

/** Exit code reported when a command is cancelled mid-run. */
export const EXEC_CANCELLED_EXIT_CODE = 130;

/** Grace delay before SIGKILL after SIGTERM, in milliseconds. */
export const EXEC_KILL_GRACE_MS = 2_000;

/** Marker replacing redacted secret values in scripts and outputs. */
export const EXEC_REDACTED_MARKER = '[redacted]';

/**
 * Environment names never forwarded to a child process.
 *
 * Reuses the CLI/Web denylist verbatim: provider-agnostic loader
 * variables (`TELL_KEY`, `TELL_TOKEN`), dynamic-loader and interpreter
 * preload variables (`NODE_OPTIONS`, `BASH_ENV`, `LD_PRELOAD`, ...).
 */
export const SENSITIVE_ENV_NAMES: ReadonlySet<string> = new Set([
  'BASH_ENV',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ENV',
  'GPG_AGENT_INFO',
  'GPG_KEY',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'PERL5LIB',
  'PYTHONPATH',
  'RUBYLIB',
  'SSH_AUTH_SOCK',
  'TELL_KEY',
  'TELL_TOKEN',
]);

/**
 * Environment name suffixes never forwarded (vendor keys, package tokens).
 *
 * Matches `*_API_KEY`, `*_APIKEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, and
 * friends, case-insensitively, so per-vendor keys (`AZURE_OPENAI_APIKEY`)
 * and `CUSTOM_API_KEY` never reach an executed command.
 */
export const SENSITIVE_ENV_SUFFIX =
  /(?:^|_)(?:ACCESS_KEY(?:_ID)?|API_?KEY|AUTH_TOKEN|CREDENTIALS?|PASSWORD|PASSWD|PRIVATE_KEY|SECRET(?:_KEY)?|TOKEN)$/i;

/**
 * Shortest secret worth masking in an output.
 *
 * A shorter value would match almost every character and shred the output
 * the model has to read, so such values are dropped instead of masked.
 */
export const EXEC_MIN_SECRET_LENGTH = 4;

/**
 * True when a URL-shaped value carries inline credentials.
 *
 * `postgres://user:password@host/db` is a credential, not just an address.
 *
 * @param value - Candidate environment value.
 * @returns Whether the value embeds user/password credentials.
 */
function has_inline_credentials(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(value);
}

/**
 * True when an environment entry must never reach a child process.
 *
 * @param name - Environment variable name.
 * @param value - Environment variable value.
 * @returns Whether the entry is sensitive.
 */
function is_sensitive_env(name: string, value: string): boolean {
  if (SENSITIVE_ENV_NAMES.has(name) || SENSITIVE_ENV_SUFFIX.test(name)) {
    return true;
  } else if (/_URL$/i.test(name) && has_inline_credentials(value)) {
    return true;
  } else {
    return false;
  }
}

/** Defaults injected into every `create_node_executor` command. */
export type NodeExecutorDefaults = {
  /** Override shell (defaults to `EXEC_SHELL`). */
  shell?: string;
  /** Fallback working directory (defaults to `process.cwd()`). */
  cwd?: string;
  /** Fallback timeout in milliseconds. */
  timeout_ms?: number;
  /** Fallback output cap in bytes. */
  max_output_bytes?: number;
  /** Extra environment merged under `options.env` before scrubbing. */
  env?: Record<string, string>;
};

/**
 * Returns a scrubbed environment for a child process.
 *
 * Every name in `SENSITIVE_ENV_NAMES` or matching
 * `SENSITIVE_ENV_SUFFIX` is dropped; entries with `undefined` values are
 * dropped too. Non-secret content is preserved verbatim.
 *
 * @param env - Candidate environment (usually `process.env` merged with options).
 * @returns The sanitized environment forwarded to `spawn`.
 */
export function sanitize_exec_env(env: Record<string, string | undefined>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
    } else if (is_sensitive_env(name, value)) {
    } else {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

/**
 * Resolves a working directory to its real path, fail-closed.
 *
 * @param cwd - Candidate directory (defaults to `process.cwd()`).
 * @returns The canonical absolute directory.
 * @throws When the directory is missing or its realpath cannot be proven.
 */
export function resolve_exec_cwd(cwd?: string): string {
  const candidate = cwd ?? process.cwd();
  const resolved = path.resolve(candidate);
  try {
    const stats = fs.statSync(resolved);
    if (stats.isDirectory()) {
      return fs.realpathSync(resolved);
    } else {
      throw new Error(`exec cwd is not a directory: ${candidate}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('exec cwd is not a directory')) {
      throw error;
    } else {
      throw new Error(`exec cwd is unusable: ${candidate}`);
    }
  }
}

/**
 * Creates a redactor masking known secret values.
 *
 * Each non-empty secret value found verbatim in a script or output is
 * replaced with `EXEC_REDACTED_MARKER`. Values shorter than
 * `EXEC_MIN_SECRET_LENGTH` are ignored: masking them would replace almost
 * every character and destroy the output. Non-secret content is preserved.
 *
 * @param secrets - Secret values to mask (empty or too short entries are ignored).
 * @returns A `Redactor` for the runtime redaction boundary.
 */
export function create_secret_redactor(secrets: readonly string[]): Redactor {
  const values = secrets.filter((secret) => secret.length >= EXEC_MIN_SECRET_LENGTH);
  return (value: string): string => {
    let redacted = value;
    for (const secret of values) {
      if (redacted.includes(secret)) {
        redacted = redacted.split(secret).join(EXEC_REDACTED_MARKER);
      } else {
        // Secret absent — nothing to mask.
      }
    }
    return redacted;
  };
}

/**
 * Collects secret values from an environment record for redaction.
 *
 * Any variable dropped by `sanitize_exec_env` with a non-empty value is
 * treated as a secret to mask in outputs.
 *
 * @param env - Environment record to harvest secrets from.
 * @returns The secret values worth redacting.
 */
export function collect_exec_secrets(env: Record<string, string | undefined>): string[] {
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === '') {
    } else if (is_sensitive_env(name, value)) {
      secrets.push(value);
    } else {
      // Non-secret variable — never used as a redaction source.
    }
  }
  return secrets;
}

/** Max sensitive files scanned in the workspace for redaction sources. */
export const SENSITIVE_SCAN_MAX_FILES = 64;
/** Max bytes read from one sensitive file for redaction sources. */
export const SENSITIVE_SCAN_MAX_BYTES = 64 * 1024;
/** Max directory depth walked by the sensitive-file scan. */
export const SENSITIVE_SCAN_MAX_DEPTH = 3;
/** Directories never descended into by the sensitive-file scan. */
const SENSITIVE_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', '.git']);
/** Longest single line kept as a secret candidate. */
const SENSITIVE_SCAN_MAX_LINE = 512;
/** Min length for a value whose key name does not look sensitive (avoid masking `true`/`3000`). */
const SENSITIVE_SCAN_PLAIN_VALUE_MIN = 12;
/** Min length for a standalone line in a key file (PEM body, raw key). */
const SENSITIVE_SCAN_LINE_MIN = 8;

/**
 * Extracts the secret-looking values from one sensitive file's text.
 *
 * `KEY=value` lines contribute the value (quotes stripped) when the key name
 * looks sensitive or the value is long; other lines contribute themselves
 * when they look like payload (key material, tokens) and not like a PEM
 * header or a comment. Values shorter than `EXEC_MIN_SECRET_LENGTH` are
 * skipped by `create_secret_redactor`.
 *
 * @param text - File content (already byte-capped).
 * @returns The candidate secret strings.
 */
function extract_file_secret_values(text: string): string[] {
  const values: string[] = [];
  for (const raw_line of text.split(/\r?\n/)) {
    const line = raw_line.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    } else {
      const equals = line.indexOf('=');
      if (equals !== -1) {
        const key = line.slice(0, equals).trim();
        const value = line
          .slice(equals + 1)
          .trim()
          .replace(/^['"]|['"]$/g, '');
        // A sensitive-named key (API_KEY, TOKEN, SECRET, PASSWORD, URL with
        // inline credentials) keeps its short value; other keys need a
        // long/unusual value before it is treated as a secret, so `true`,
        // `development` or `3000` are not shredded out of every output.
        if (value !== '' && (is_sensitive_env(key, value) || value.length >= SENSITIVE_SCAN_PLAIN_VALUE_MIN)) {
          values.push(value);
        }
      } else if (
        line.length >= SENSITIVE_SCAN_LINE_MIN &&
        line.length <= SENSITIVE_SCAN_MAX_LINE &&
        !line.startsWith('-----')
      ) {
        values.push(line);
      }
    }
  }
  return values;
}

/**
 * Collects secrets from credential-named files under a workspace.
 *
 * A command can reach `.env`/keys through shell globs or recursive scans even
 * when the literal name never appears in the script (the lexical rules are a
 * speed bump). Masking the file contents in the output the model receives is
 * the second line: the executor boundary redacts these values the same way it
 * redacts provider keys. Bounded (depth 3, 64 files, 64 KiB each), skips
 * symlinks and `node_modules`/`dist`/`.git`, and never follows the network.
 *
 * @param cwd - Workspace root to scan.
 * @returns The candidate secret values (deduplicated).
 */
export function collect_sensitive_file_secrets(cwd: string): string[] {
  const base = path.resolve(cwd);
  const secrets = new Set<string>();
  let files = 0;

  const scan_dir = (dir: string, depth: number): void => {
    if (depth > SENSITIVE_SCAN_MAX_DEPTH || files >= SENSITIVE_SCAN_MAX_FILES) {
      return;
    } else {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files >= SENSITIVE_SCAN_MAX_FILES) {
          return;
        } else if (entry.isSymbolicLink()) {
          // Never follow links: the scan must not escape the workspace.
        } else if (entry.isDirectory()) {
          if (!SENSITIVE_SCAN_SKIP_DIRS.has(entry.name)) {
            scan_dir(path.join(dir, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          const full = path.join(dir, entry.name);
          const rel = path.relative(base, full);
          if (is_sensitive_rel_path(rel)) {
            try {
              const fd = fs.openSync(full, 'r');
              try {
                const buffer = Buffer.alloc(SENSITIVE_SCAN_MAX_BYTES);
                const read = fs.readSync(fd, buffer, 0, SENSITIVE_SCAN_MAX_BYTES, null);
                for (const value of extract_file_secret_values(buffer.subarray(0, read).toString('utf8'))) {
                  secrets.add(value);
                }
                files += 1;
              } finally {
                fs.closeSync(fd);
              }
            } catch {
              // Unreadable file: skip it, the run continues.
            }
          }
        }
      }
    }
  };

  scan_dir(base, 0);
  return [...secrets];
}

/**
 * Cuts a text to a UTF-8 byte budget without splitting a character.
 *
 * The exec cap is counted in bytes, so the cut must be too — slicing by
 * characters would deliver up to four times the budget for multi-byte text.
 *
 * @param text - Text to cut.
 * @param max_bytes - Byte budget.
 * @returns The cut text.
 */
function cut_to_bytes(text: string, max_bytes: number): string {
  if (max_bytes <= 0) {
    return '';
  }
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= max_bytes) {
    return text;
  }
  let end = max_bytes;
  while (end > 0 && ((buffer[end - 1] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  if (end > 0 && ((buffer[end - 1] ?? 0) & 0xc0) === 0xc0) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString('utf8');
}

/**
 * Kills a spawned process group (detached `spawn`), then the leader.
 *
 * @param pid - Process id of the group leader.
 */
function kill_process_group(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already exited — nothing to kill.
      }
    }
  }
}

/** Inputs for the internal shell runner (grouped to stay within param limits). */
type ShellRunInput = {
  /** Approved script (the caller already authorized it). */
  script: string;
  /** Explicit shell binary. */
  shell: string;
  /** Canonical working directory. */
  cwd: string;
  /** Already sanitized environment. */
  env: Record<string, string>;
  /** Timeout budget in milliseconds. */
  timeout_ms: number;
  /** Combined stdout/stderr cap in bytes. */
  max_output_bytes: number;
  /** Structural cancellation token. */
  token?: CancellationToken;
};

/**
 * Runs one script through the explicit shell with caps and cancellation.
 *
 * @param input - Script, shell, cwd, env, caps and token in one object.
 * @returns The raw process result (redaction happens at the runtime boundary).
 */
function run_shell_process(input: ShellRunInput): Promise<ExecutorResult> {
  const { script, shell, cwd, env, timeout_ms, max_output_bytes, token } = input;
  return new Promise<ExecutorResult>((resolve, reject) => {
    const child = spawn(shell, ['-c', script], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdout_bytes = 0;
    let stderr_bytes = 0;
    let settled = false;
    let timed_out = false;

    const finish = (result: ExecutorResult): void => {
      if (settled) {
        return;
      } else {
        settled = true;
        cleanup();
        resolve(result);
      }
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      } else {
        settled = true;
        cleanup();
        reject(error);
      }
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      unsubscribe_cancel();
    };

    const kill_late = (): void => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          // No group leader — the TERM above already covered it.
        }
      } catch {
        // Already gone — nothing to force.
      }
    };

    const on_bytes = (chunk: Buffer, kind: 'stdout' | 'stderr'): void => {
      const text = chunk.toString('utf8');
      if (kind === 'stdout') {
        stdout_bytes += chunk.length;
        stdout += text;
      } else {
        stderr_bytes += chunk.length;
        stderr += text;
      }
      if (stdout_bytes + stderr_bytes > max_output_bytes) {
        kill_process_group(child.pid);
        setTimeout(kill_late, EXEC_KILL_GRACE_MS);
        const truncated = cut_to_bytes(`${stdout}\n${stderr}`, max_output_bytes);
        finish({ stdout: truncated, stderr: `output exceeded ${max_output_bytes} bytes`, exit_code: 1 });
      } else {
        // Within budget — keep collecting.
      }
    };

    const timeout = setTimeout(
      () => {
        timed_out = true;
        kill_process_group(child.pid);
        setTimeout(kill_late, EXEC_KILL_GRACE_MS);
        finish({
          stdout,
          stderr: format_timeout_message(script, timeout_ms),
          exit_code: EXEC_TIMEOUT_EXIT_CODE,
        });
      },
      Math.max(1, Math.floor(timeout_ms)),
    );

    const unsubscribe_cancel: () => void =
      token?.on_cancel(() => {
        kill_process_group(child.pid);
        setTimeout(kill_late, EXEC_KILL_GRACE_MS);
        fail(new Error('cancelled'));
      }) ?? (() => {});

    if (token?.cancelled === true) {
      fail(new Error('cancelled'));
    } else {
      child.stdout?.on('data', (chunk: Buffer) => on_bytes(chunk, 'stdout'));
      child.stderr?.on('data', (chunk: Buffer) => on_bytes(chunk, 'stderr'));
      child.on('error', (error: Error) => {
        fail(error);
      });
      child.on('close', (code: number | null) => {
        if (timed_out) {
          return;
        } else if (code === null) {
          finish({ stdout, stderr, exit_code: EXEC_CANCELLED_EXIT_CODE });
        } else {
          finish({ stdout, stderr, exit_code: code });
        }
      });
    }
  });
}

/**
 * Creates the Node command executor (the runtime `CommandExecutor` port).
 *
 * The executor runs the approved script through the explicit shell in the
 * canonical cwd, with timeout, output cap, process-group kill, structural
 * cancellation and a scrubbed environment. Raw `stdout`/`stderr` are
 * returned untouched here — the single redaction boundary in
 * `createTellRuntime` masks them immediately after, before feedback,
 * callbacks, logs, context, cache, `TellResult` or JSON.
 *
 * @param defaults - Fallback shell/cwd/timeout/cap/env (options win per call).
 * @returns A `CommandExecutor` for `create_core_runtime`/`createTellRuntime`.
 */
export function create_node_executor(defaults: NodeExecutorDefaults = {}): CommandExecutor {
  return async (options: ExecutorOptions): Promise<ExecutorResult> => {
    const shell = defaults.shell ?? EXEC_SHELL;
    const cwd = resolve_exec_cwd(options.cwd ?? defaults.cwd);
    const timeout_ms = options.timeout_ms ?? defaults.timeout_ms ?? EXEC_DEFAULT_TIMEOUT_MS;
    const max_output_bytes = options.max_output_bytes ?? defaults.max_output_bytes ?? EXEC_MAX_OUTPUT_BYTES;
    const merged: Record<string, string | undefined> = {
      ...process.env,
      ...(defaults.env ?? {}),
      ...(options.env ?? {}),
    };
    const env = sanitize_exec_env(merged);
    if (options.cancellation?.cancelled === true) {
      throw new Error('cancelled');
    } else {
      return run_shell_process({
        script: options.script,
        shell,
        cwd,
        env,
        timeout_ms,
        max_output_bytes,
        ...(options.cancellation !== undefined ? { token: options.cancellation } : {}),
      });
    }
  };
}
