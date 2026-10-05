/**
 * Resolution bases for the runtime packages this bundle borrows.
 *
 * The bundle is installed into a profile with `link:` and Node resolves a bare
 * specifier from the importing file's REAL path, which on a linked install is
 * outside the profile's resolution root. So every runtime package it needs is
 * resolved against the bases below instead, in this order:
 *
 *   1. `$DSH_PROFILE_DIR` — the active profile. Holds the peer packages a
 *      profile installs for itself (`@deepseek-ai/schemastery`), and the dsh
 *      install is reachable from there on a normal global install as well.
 *   2. `process.argv[1]` — the script that loaded us. When the harness runs the
 *      row, its entry script sits inside the dsh install, whose `node_modules`
 *      holds the whole runtime (`@deepseek-ai/dsh/node_modules/@deepseek-ai/...`).
 *   3. `import.meta.url` — this file, i.e. the package directory itself. That
 *      covers an install that copies the bundle into a profile that vendors the
 *      runtime packages.
 *
 * Pure `node:` builtins only, so this module is safe to import from anywhere in
 * the bundle.
 *
 * @module @nu11dev/dsh-frugal-orchestrator/lib/resolve
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * The candidate require bases, nearest-authority first.
 *
 * @returns file-URL strings usable as a `createRequire()` base.
 */
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
  // The process that loaded us: when the harness runs this row, its own entry
  // script sits inside the dsh install, whose node_modules holds the runtime.
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

/**
 * Resolve one package file from the candidate bases without loading it.
 *
 * @param specifier - bare package specifier to resolve.
 * @returns `{ ok: true, path, base }` for the first base that resolves it, else
 *   `{ ok: false, tried }` with one diagnostic per attempted base.
 */
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

/**
 * Load one package synchronously from the candidate bases.
 *
 * `require()` reaches a CommonJS package everywhere, and an ES-module package
 * on a Node that supports `require(esm)` (≥22.12) — where it also shares the
 * module instance with the host's own `import`, so a factory taken from here is
 * the factory the host's registry was built with.
 *
 * @param specifier - bare package specifier to load.
 * @returns `{ ok: true, module, base }` on the first base that loads it, else
 *   `{ ok: false, tried }` with one diagnostic per attempted base.
 */
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

/**
 * Load one package through a dynamic `import()` of its resolved file URL.
 *
 * The fallback for a host whose `require()` cannot reach an ES module; the
 * resolved file URL is the one the host itself imports, so the instance is
 * shared.
 *
 * @param specifier - bare package specifier to load.
 * @returns the module namespace, or undefined when no base resolves it.
 */
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
