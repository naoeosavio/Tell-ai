import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonicalizes an existing path inside a base directory, fail-closed.
 *
 * The lexical path must stay inside `base_dir` (sibling-prefix tricks
 * rejected), the base must exist, and no path segment may be a symlink —
 * a symlink inside the base pointing outside still counts as outside.
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
 * Canonicalizes a writable path inside a base directory, fail-closed.
 *
 * Same rules as `canonical_path`, except the final segment may be missing
 * (a new file): its parent chain must canonicalize inside the base. Missing
 * intermediate directories still fail closed.
 *
 * @param base_dir - Anchor directory the candidate must stay inside.
 * @param candidate - User path, resolved against `base_dir` when relative.
 * @returns The canonical parent-anchored absolute path, or null on escape.
 */
export function canonical_write_path(base_dir: string, candidate: string): string | null {
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
    const segments = relative.split(path.sep).filter((segment) => segment !== '');
    const last = segments[segments.length - 1] ?? '';
    if (last === '') {
      return null;
    } else {
      let current = real_base;
      for (const segment of segments.slice(0, -1)) {
        current = path.join(current, segment);
        try {
          if (fs.lstatSync(current).isSymbolicLink()) {
            return null;
          }
        } catch {
          return null;
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
