import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve `candidate` inside `baseDir`, or return null when it escapes it
 * (relative traversal, absolute paths outside, sibling-prefix tricks).
 */
export function resolveWithin(baseDir: string, candidate: string): string | null {
  const resolved = path.resolve(baseDir, candidate);
  const rel = path.relative(baseDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  try {
    if (fs.lstatSync(baseDir).isSymbolicLink()) return null;
  } catch {
    return resolved;
  }

  let realBase: string;
  try {
    realBase = fs.realpathSync(baseDir);
  } catch {
    return resolved;
  }

  let current = realBase;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
      return null;
    }
  }
  return resolved;
}
