// Read-only composition verification; never print or persist the complete config.
//
// Composes the profile exactly the way `dsh` boots it, then checks the two things
// this package owns:
//   1. every agent preset's compaction mount, and whether it carries this
//      package's `bridge` row that hands the engine to the policy row (a preset
//      without it is deliberately left on the host's built-in path);
//   2. the model entries, which still decide the built-in engine's reserve in
//      those unbridged presets — a `maxTokens` at or above the context window
//      leaves them no message budget at all.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, join, basename } from 'node:path';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { packages, profile, load } from './test-runtime.mjs';

/** This package's own name, so a rename can never leave a stale literal behind. */
const SELF = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name;
/** The subpath this package exports for a preset's isolated compaction group. */
const BRIDGE = `${SELF}/bridge`;

const yaml = await load('../yaml/dist/index.js');
const cli = resolve(packages, '../../lib/bin.js');
const profileName = process.env.DSH_PROFILE_NAME ?? basename(profile);
const result = spawnSync(process.execPath, [cli, '--profile', profileName, '--dump-config'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
assert.equal(result.status, 0, `dsh --profile ${profileName} --dump-config must succeed`);
const config = yaml.parse(result.stdout.replace(/!!js\s+/g, ''));

/**
 * Drop a leading `@scope/` so both spellings of one package compare equal.
 *
 * A profile installs this bundle under its dependency KEY (`dsh-compaction-policy`)
 * while the manifest name is `@nu11dev/dsh-compaction-policy`, and a row may be
 * authored either way — both resolve from the profile. This script checks
 * COMPOSITION (is the bridge row inside the preset, is the policy row configured),
 * so it must not fail on which of two working spellings the operator wrote. Only the
 * FIRST segment loses its scope, so `@scope/pkg/bridge` cannot match `pkg/other`.
 *
 * @param specifier - a row `name` or an expected specifier.
 * @returns the specifier without its leading `@scope/`.
 */
function unscoped(specifier) {
  const text = String(specifier);
  return text.startsWith('@') ? text.slice(text.indexOf('/') + 1) : text;
}

/** Every row (id + name) anywhere in the composed config. */
function rows(value, output = []) {
  if (Array.isArray(value)) for (const child of value) rows(child, output);
  else if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && typeof value.name === 'string') output.push(value);
    for (const child of Object.values(value)) rows(child, output);
  }
  return output;
}

const all = rows(config);

// ── 1. preset compaction mount / bridge inventory ────────────────────────────
const presets = all.filter((row) => row.name === '@deepseek-ai/dsh-agent-preset' && typeof row.config?.id === 'string');
assert.ok(presets.length >= 2, 'the composed profile declares agent presets');
const inventory = presets.map((preset) => {
  const children = rows(preset.config.plugins);
  const basic = children.find((row) => row.name === '@deepseek-ai/dsh-compaction-basic' || row.id === 'compaction-basic');
  const bridge = children.find((row) => unscoped(row.name) === unscoped(BRIDGE));
  const pruner = children.find((row) => row.name === '@deepseek-ai/dsh-compaction-tool-result-pruner');
  return {
    id: preset.config.id,
    row: preset.id,
    engine: basic !== undefined,
    engineAuto: basic?.config?.auto ?? null,
    bridge: bridge !== undefined,
    pruner: pruner !== undefined,
  };
});

const bridged = inventory.filter((entry) => entry.bridge);
assert.ok(bridged.length > 0, 'at least one preset carries the bridge row');
for (const entry of bridged) {
  assert.ok(entry.engine, `${entry.id}: a bridged preset must still own a compaction engine`);
  assert.equal(entry.engineAuto, false, `${entry.id}: a bridged preset must disable the built-in auto path`);
}
for (const entry of inventory.filter((item) => !item.bridge)) {
  assert.equal(entry.engineAuto, null, `${entry.id}: an unbridged preset must keep its built-in compaction untouched`);
}
// The bridge is only meaningful INSIDE a preset's isolated group; a top-level copy
// would resolve no engine and silently do nothing.
const presetChildren = new Set(presets.flatMap((preset) => rows(preset.config.plugins)));
for (const row of all.filter((item) => unscoped(item.name) === unscoped(BRIDGE))) {
  assert.ok(presetChildren.has(row), 'every bridge row must live inside a preset, not at the top level');
}

// ── 2. the policy row the bridge talks to ────────────────────────────────────
// The composed dump shows only the row that DECLARES this plugin (the bundle's, with no
// `config`): none of the policy keys below appear anywhere in `--dump-config` output, even
// though the host demonstrably applies them (the policy log records reserve=38400 for a
// 256k window, i.e. exactly the 0.15 below). The values the operator set therefore have to
// be read from the profile's own patch — the file that is actually edited — while the dump
// stays the source for composition facts only.
assert.ok(
  all.some((row) => row.id === 'compaction-policy' && unscoped(row.name) === unscoped(SELF)),
  'the composed tree installs this bundle as compaction-policy',
);
const patchPath = join(profile, 'cordis.patch.yml');
const patch = rows(yaml.parse(readFileSync(patchPath, 'utf8').replace(/!!js\s+/g, '')));
const policy = patch.find((row) => row.id === 'compaction-policy');
assert.ok(policy, `top-level compaction-policy row (looked in ${patchPath})`);
assert.equal(policy.config.reserveRatio, 0.15, 'reserve ratio');
assert.equal(policy.config.reserveFloorTokens, 16384, 'reserve floor');
assert.equal(policy.config.fitHeadroomTokens, 64, 'fit headroom');
assert.equal(policy.config.minFittedOutputTokens, 1024, 'fitted cap floor');
assert.equal(policy.config.diagnostics, true, 'diagnostic log on');

// ── 3. model entries: an unbridged preset's reserve is still this number ─────
const BUDGET_FLOOR = 65536;
const caps = [];
for (const row of all.filter((item) => item.name === '@deepseek-ai/dsh-llm-pi-ai')) {
  for (const [route, provider] of Object.entries(row.config?.providers ?? {})) {
    for (const model of provider?.models ?? []) {
      if (model.maxTokens === undefined) continue;
      const window = model.contextWindow;
      assert.ok(Number.isInteger(window), `${route}/${model.id}: needs a contextWindow`);
      caps.push({ route: `${route}/${model.id}`, contextWindow: window, maxTokens: model.maxTokens });
      assert.ok(window - model.maxTokens >= BUDGET_FLOOR,
        `${route}/${model.id}: maxTokens ${model.maxTokens} leaves ${window - model.maxTokens} message tokens of a ${window} window (` +
        'the built-in compaction engine reserves maxTokens + headroom, so a cap this close to the window throws TargetPressureConfigError)');
    }
  }
}

// ── 4. the local bundle really is the one linked into the profile ────────────
/**
 * The profile entry that provides the package named `name`, resolved.
 *
 * A `link:` dependency is created under its DEPENDENCY KEY, which need not equal
 * the package's own manifest name: this profile installs `dsh-compaction-policy`
 * as the key while the package is named `@nu11dev/dsh-compaction-policy`.
 * Joining the manifest name onto `node_modules` therefore found nothing and this
 * script died with a bare ENOENT before reaching any assertion.
 *
 * Resolution is by manifest `name` — the key the loader's profile interception
 * layer uses — so the check stays on the property that matters: the profile runs
 * THIS checkout, not a published copy. Both conventional spellings are tried
 * first; the whole `node_modules` (one scope deep) is scanned only if neither
 * hits.
 *
 * @param name - the package's manifest name.
 * @returns the realpath of the providing entry.
 * @throws when the profile links no package with that name.
 */
function linked(name) {
  const modules = join(profile, 'node_modules');
  const direct = [join(modules, name), join(modules, name.split('/').pop())];
  for (const candidate of direct) {
    const manifest = join(candidate, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) {
      return realpathSync(candidate).toLowerCase();
    }
  }
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    const names = entry.name.startsWith('@')
      ? readdirSync(join(modules, entry.name), { withFileTypes: true }).map((child) => join(entry.name, child.name))
      : [entry.name];
    for (const relative of names) {
      const candidate = join(modules, relative);
      let declared;
      try {
        declared = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')).name;
      } catch {
        continue; // not a package directory, or an unreadable one
      }
      if (declared === name) return realpathSync(candidate).toLowerCase();
    }
  }
  throw new Error(`the profile at ${profile} links no package named ${name} (looked in ${modules}); add it to package.json — a link: entry is fine`);
}
assert.equal(linked(SELF), realpathSync(new URL('.', import.meta.url)).toLowerCase(), 'profile links this checkout');

// ── 5. presets registered at RUNTIME are invisible here ─────────────────────
// `dsh-gitbash-shell` calls agentPresets.register() at boot for its four variants
// (standard-gitbash / minimal-gitbash / code-gitbash / cordis-gitbash), so
// --dump-config cannot see them and this package cannot bridge them: they keep
// the built-in engine, and their threshold is the one the model entry's
// maxTokens buys (checked in section 3). Reported, not asserted.
const registry = all.find((row) => row.name === '@deepseek-ai/dsh-agent-preset-registry');
const runtimeNote = {
  selectedDefault: registry?.config?.selectedDefault ?? null,
  invisibleToDumpConfig: ['standard-gitbash', 'minimal-gitbash', 'code-gitbash', 'cordis-gitbash'],
  reason: 'registered at runtime by dsh-gitbash-shell; unbridged, so they keep the host built-in compaction',
};

console.log(JSON.stringify({
  command: `dsh --profile ${profileName} --dump-config`,
  presets: inventory,
  bridged: bridged.map((entry) => entry.id),
  policy: {
    row: policy.id,
    reserveRatio: policy.config.reserveRatio,
    reserveFloorTokens: policy.config.reserveFloorTokens,
    desiredOutputCap: policy.config.desiredOutputCap,
    keepRecentTokens: policy.config.keepRecentTokens,
  },
  modelCaps: caps,
  runtimeRegisteredPresets: runtimeNote,
  localBundleLinkVerified: true,
}, null, 2));
