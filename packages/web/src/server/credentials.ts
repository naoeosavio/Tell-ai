/**
 * Credential redaction for the Web sandbox (Node only, no network).
 *
 * The sandbox must not forward a credential value to a model or a client.
 * A lexical rule blocks known credential names. A shell glob, a loop or a
 * rename can reach the file without the name. The redactor is the second
 * line. It remembers every value that the server saw in a credential-named
 * file, also after a rename. This module owns that memory.
 */

import { collect_sensitive_file_secrets, create_secret_redactor, type Redactor } from '@tell-ai/core';
import fs from 'fs';

/** Max bytes of one served file that the credential check reads. */
export const CREDENTIAL_CHECK_BYTES = 1024 * 1024;

/** Options for `create_credential_guard`. */
export type CredentialGuardOptions = {
  /** Workspace root the scan walks. */
  cwd: string;
  /** Boot-time secret values (provider keys and scrubbed environment values). */
  base_secrets: readonly string[];
};

/** Cached credential boundary for one workspace. */
export type CredentialGuard = {
  /** Adds the current values of the credential-named files to the cache. */
  refresh: () => void;
  /** Masks every cached secret and its encoded forms. */
  redact: Redactor;
  /** True when the text contains a cached credential value. */
  has_credential_material: (text: string) => boolean;
};

/**
 * Creates a credential guard with a lifetime cache.
 *
 * The guard scans the credential-named files at creation. Call `refresh`
 * before each command. The cache keeps the values that the server saw, so a
 * rename cannot remove a value from the mask set.
 *
 * @param options - Workspace root and the boot-time secret values.
 * @returns The guard with refresh, redact and the content check.
 */
export function create_credential_guard(options: CredentialGuardOptions): CredentialGuard {
  const secrets = new Set<string>(options.base_secrets.filter((value) => value.length > 0));
  let cached: Redactor | undefined;

  function refresh(): void {
    for (const value of collect_sensitive_file_secrets(options.cwd)) {
      secrets.add(value);
    }
    cached = undefined;
  }

  function redactor(): Redactor {
    if (cached === undefined) {
      cached = create_secret_redactor([...secrets]);
    } else {
      // The cache is current.
    }
    return cached;
  }

  function redact(text: string): string {
    return redactor()(text);
  }

  function has_credential_material(text: string): boolean {
    return redact(text) !== text;
  }

  refresh();
  return { refresh, redact, has_credential_material };
}

/**
 * Reads the head of a file for the credential check.
 *
 * The function reads at most `CREDENTIAL_CHECK_BYTES` bytes. A read error
 * returns an empty string. The caller reads the file again for the response;
 * a file that the head cannot read also fails there.
 *
 * @param file_path - Absolute path inside the workspace.
 * @param max_bytes - Byte budget of the check (default `CREDENTIAL_CHECK_BYTES`).
 * @returns The decoded head, or an empty string on a read error.
 */
export function read_file_head(file_path: string, max_bytes: number = CREDENTIAL_CHECK_BYTES): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file_path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) {
      return '';
    } else {
      const size = Math.min(stats.size, max_bytes);
      const buffer = Buffer.alloc(size);
      const read = fs.readSync(fd, buffer, 0, size, 0);
      return buffer.subarray(0, read).toString('utf8');
    }
  } catch {
    // The endpoint reports the real read error on its own open.
    return '';
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    } else {
      // No descriptor to close.
    }
  }
}
