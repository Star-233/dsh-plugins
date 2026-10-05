/**
 * Resolution bases for the runtime packages this bundle borrows.
 *
 * The bundle is installed into a profile with `link:` and Node resolves a bare
 * specifier from the importing file's REAL path, which on a linked install is
 * outside the profile's resolution root. So every runtime package it needs is
 * resolved against the bases below instead, in this order:
 *
 *   1. `$DSH_PROFILE_DIR` — the active profile.
 *   2. `process.argv[1]` — the script that loaded us.
 *   3. `import.meta.url` — this file.
 *
 * Pure `node:` builtins only.
 *
 * @module @nu11dev/dsh-compaction-policy/lib/resolve
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** The candidate require bases, nearest-authority first. */
export function resolutionBases() {
  const bases = [];
  const profile = process.env.DSH_PROFILE_DIR;
  if (typeof profile === 'string' && profile.length > 0) {
    try {
      bases.push(pathToFileURL(`${profile.replace(/[\\/]+$/, '')}/`).href);
    } catch {
      // A malformed DSH_PROFILE_DIR just falls through to the next base.
    }
  }
  if (typeof process.argv[1] === 'string' && process.argv[1].length > 0) {
    try {
      bases.push(pathToFileURL(process.argv[1]).href);
    } catch {
      // Same story.
    }
  }
  bases.push(import.meta.url);
  return bases;
}

/** Resolve one package file from the candidate bases without loading it. */
export function resolveFromBases(specifier) {
  const tried = [];
  for (const base of resolutionBases()) {
    try {
      return { ok: true, path: createRequire(base).resolve(specifier), base };
    } catch (error) {
      tried.push(`${base}: ${describeThrown(error)}`);
    }
  }
  return { ok: false, tried };
}

/** Load one package synchronously from the candidate bases. */
export function requireFromBases(specifier) {
  const tried = [];
  for (const base of resolutionBases()) {
    try {
      return { ok: true, module: createRequire(base)(specifier), base };
    } catch (error) {
      tried.push(`${base}: ${describeThrown(error)}`);
    }
  }
  return { ok: false, tried };
}

/** Load one package through a dynamic `import()` of its resolved file URL. */
export async function importFromBases(specifier) {
  const resolved = resolveFromBases(specifier);
  if (!resolved.ok) return undefined;
  return import(pathToFileURL(resolved.path).href);
}

/** One thrown value rendered without letting coercion escape. */
export function describeThrown(value) {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return String(value);
  } catch {
    return '<unprintable>';
  }
}
