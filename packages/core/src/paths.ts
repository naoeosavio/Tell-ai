import fs from 'fs';
import path from 'path';

/**
 * True when the path itself is a symbolic link.
 *
 * @param candidate - Path to inspect.
 * @returns Whether `lstat` reports a symlink.
 */
function is_symlink(candidate: string): boolean {
  try {
    return fs.lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Canonicalizes an existing path inside a base directory, fail-closed.
 *
 * The lexical path must stay inside `base_dir` (sibling-prefix tricks
 * rejected), the base must exist and must not be a symlink itself, and no
 * path segment may be a symlink — a symlink inside the base pointing
 * outside still counts as outside.
 *
 * @param base_dir - Anchor directory the candidate must stay inside.
 * @param candidate - User path, resolved against `base_dir` when relative.
 * @returns The canonical absolute path, or null when it escapes, is missing, or touches a symlink.
 */
export function canonical_path(base_dir: string, candidate: string): string | null {
  const base = path.resolve(base_dir);
  const resolved = path.resolve(base, candidate);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  } else if (is_symlink(base)) {
    return null;
  } else {
    let real_base = '';
    try {
      real_base = fs.realpathSync(base);
    } catch {
      return null;
    }
    let current = real_base;
    const segments = relative.split(path.sep).filter((segment) => segment !== '');
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          return null;
        }
      } catch {
        return null;
      }
    }
    try {
      return fs.realpathSync(resolved);
    } catch {
      return null;
    }
  }
}

/**
 * Reports whether a candidate stays lexically inside a base directory.
 *
 * Pure and I/O-free: it answers only "is this path inside the base" for the
 * purpose of choosing an error message. Containment is still decided by
 * `canonical_path` (fail-closed, realpath); a false from this helper must
 * never be read as "outside", and a true never authorizes a read.
 *
 * @param base_dir - Anchor directory the candidate must stay inside.
 * @param candidate - User path, resolved against `base_dir` when relative.
 * @returns Whether the lexical resolution stays inside the base.
 */
export function is_path_inside_base(base_dir: string, candidate: string): boolean {
  const base = path.resolve(base_dir);
  const resolved = path.resolve(base, candidate);
  const relative = path.relative(base, resolved);
  if (relative === '') {
    return true;
  } else {
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }
}

/**
 * Reports whether a candidate has any filesystem target on its lexical path.
 *
 * Answers "does something exist here" without judging containment, so a host
 * can tell an absent file from a symlink that escapes (both rejected by
 * `canonical_path`) when choosing between 404 and 403. Never authorizes a
 * read: containment stays with `canonical_path`.
 *
 * @param base_dir - Anchor directory the candidate resolves against.
 * @param candidate - User path, resolved against `base_dir` when relative.
 * @returns Whether `lstat` finds a target on the lexical path.
 */
export function has_lexical_target(base_dir: string, candidate: string): boolean {
  const base = path.resolve(base_dir);
  const resolved = path.resolve(base, candidate);
  try {
    fs.lstatSync(resolved);
    return true;
  } catch {
    return false;
  }
}

/** Options for `canonical_write_path`. */
export type CanonicalWriteOptions = {
  /**
   * Allows missing intermediate directories: past the first segment that
   * does not exist the walk keeps accumulating the path without touching
   * the filesystem (nothing deeper can exist), so the host can create the
   * tree (`mkdir -p`) before writing. Symlinked segments are still
   * rejected, and escapes never are.
   */
  create_parents?: boolean;
};

/**
 * Canonicalizes a writable path inside a base directory, fail-closed.
 *
 * Same rules as `canonical_path`, except the final segment may be missing
 * (a new file): its parent chain must canonicalize inside the base. Missing
 * intermediate directories still fail closed unless `create_parents` is set.
 *
 * @param base_dir - Anchor directory the candidate must stay inside.
 * @param candidate - User path, resolved against `base_dir` when relative.
 * @param options - `create_parents` tolerates a missing parent chain.
 * @returns The canonical parent-anchored absolute path, or null on escape.
 */
export function canonical_write_path(
  base_dir: string,
  candidate: string,
  options: CanonicalWriteOptions = {},
): string | null {
  const base = path.resolve(base_dir);
  const resolved = path.resolve(base, candidate);
  const relative = path.relative(base, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  } else {
    let real_base = '';
    try {
      real_base = fs.realpathSync(base);
    } catch {
      return null;
    }
    // A symlinked base would move the whole anchor outside what the caller
    // validated, so it never counts as inside.
    if (is_symlink(base)) {
      return null;
    } else {
      const segments = relative.split(path.sep).filter((segment) => segment !== '');
      const last = segments[segments.length - 1] ?? '';
      if (last === '') {
        return null;
      } else {
        let current = real_base;
        let parent_missing = false;
        for (const segment of segments.slice(0, -1)) {
          current = path.join(current, segment);
          if (parent_missing) {
            // Deeper than the first missing directory: nothing can exist, so
            // keep accumulating the path without touching the filesystem.
          } else {
            try {
              if (fs.lstatSync(current).isSymbolicLink()) {
                return null;
              } else {
                // Existing real directory — keep walking.
              }
            } catch (error) {
              if (options.create_parents === true && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                parent_missing = true;
              } else {
                return null;
              }
            }
          }
        }
        const target = path.join(current, last);
        try {
          if (fs.lstatSync(target).isSymbolicLink()) {
            return null;
          } else {
            return fs.realpathSync(target);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return target;
          } else {
            return null;
          }
        }
      }
    }
  }
}
