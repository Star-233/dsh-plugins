// Read-only composition verification; never print or persist the complete config.
//
// This package owns orchestration only. The context budget / compaction policy
// moved to the companion package in v0.4, so this script checks the gate row no
// longer carries (or produces) any output-cap override, and that both local
// bundles are the ones the profile links.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, join, basename } from 'node:path';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packages, profile, load } from './test-runtime.mjs';

/** Both package names come from the manifests, so a rename cannot leave a literal behind. */
const SELF = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name;
/** The companion package sits beside this one in the repository. */
const COMPANION_DIR = 'dsh-compaction-policy';
const COMPANION = JSON.parse(readFileSync(new URL(`../${COMPANION_DIR}/package.json`, import.meta.url), 'utf8')).name;
/** The subpath a preset's isolated compaction group imports. */
const BRIDGE = `${COMPANION}/bridge`;

const yaml = await load('../yaml/dist/index.js');
const cli = resolve(packages, '../../lib/bin.js');
const profileName = process.env.DSH_PROFILE_NAME ?? basename(profile);
const result = spawnSync(process.execPath, [cli, '--profile', profileName, '--dump-config'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
assert.equal(result.status, 0, `dsh --profile ${profileName} --dump-config must succeed`);
const config = yaml.parse(result.stdout.replace(/!!js\s+/g, ''));
function rows(value, output = []) {
  if (Array.isArray(value)) for (const child of value) rows(child, output);
  else if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && typeof value.name === 'string') output.push(value);
    for (const child of Object.values(value)) rows(child, output);
  }
  return output;
}
const all = rows(config);
const gate = all.find((row) => row.id === 'frugal-gate');
assert.ok(gate, 'composed top-level gate row');
// The SHIPPED defaults are what every user gets: they must stay empty, because a
// provider/model written here would force the author's private route onto every
// install. Empty = inherit (the delegation service completes a partial route, and
// an all-empty route is passed as no override at all).
const shipped = rows(yaml.parse(readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8')));
const shippedGate = shipped.find((row) => row.id === 'frugal-gate');
assert.ok(shippedGate, 'the bundle ships the gate row');
for (const key of ['subagentProvider', 'subagentModel', 'subagentReasoningEffort']) {
  assert.equal(shippedGate.config[key], '', `the shipped ${key} default is empty (= inherit)`);
  assert.equal(typeof gate.config[key], 'string', `the composed ${key} stays a string`);
}
const shippedPreset = shipped.find((row) => row.id === 'preset-frugal');
const shippedSubagent = rows(shippedPreset?.config?.plugins).find((row) => row.id === 'tool-subagent');
assert.ok(shippedSubagent, 'the bundle ships the child delegation row');
assert.equal(shippedSubagent.config.agentOptions, undefined,
  'the bundled preset keeps no route fallback: an empty route inherits the parent');
// The COMPOSED values are the operator's own: a profile override may name a real
// route, so they are reported (not asserted) — the shipped default above is the
// part this package is responsible for.
console.log(`  composed child route: provider=${JSON.stringify(gate.config.subagentProvider)} `
  + `model=${JSON.stringify(gate.config.subagentModel)} effort=${JSON.stringify(gate.config.subagentReasoningEffort)}`);
// v0.4: the gate must not size any request any more.
for (const key of Object.keys(gate.config)) {
  assert.ok(!/maxTokens$/i.test(key) && !/budget/i.test(key), `the gate must not configure ${key}`);
}
const preset = all.find((row) => row.id === 'preset-frugal');
assert.ok(preset, 'bundle preset declaration');
const children = rows(preset.config.plugins);
const basic = children.find((row) => row.id === 'compaction-basic');
assert.equal(basic?.config?.auto, false, 'the bridged preset disables the built-in auto compaction');
assert.ok(children.some((row) => row.name === BRIDGE), 'the preset carries the policy bridge');
/**
 * The profile entry that provides the package named `name`, resolved.
 *
 * A `link:` dependency is created under its DEPENDENCY KEY, which is not
 * required to equal the package's own manifest name: this profile installs
 * `dsh-frugal-orchestrator` and `dsh-compaction-policy` as keys while both
 * packages are named `@nu11dev/…`. Joining the manifest name onto
 * `node_modules` therefore found nothing and this script died with a bare
 * ENOENT before it could check anything it cared about.
 *
 * Resolution is by manifest `name` — the key the loader's profile interception
 * layer actually uses — so the assertion stays on the property that matters:
 * the profile runs THIS checkout, not a published copy. Both conventional
 * spellings are tried first and the whole `node_modules` (one scope deep) is
 * scanned only if neither hits.
 *
 * @param name - the package's manifest name.
 * @returns the realpath of the providing entry, lower-cased for comparison.
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
const here = fileURLToPath(new URL('.', import.meta.url));
assert.equal(linked(SELF), realpathSync(here).toLowerCase());
const mirror = realpathSync(join(here, '..', COMPANION_DIR)).toLowerCase();
assert.equal(linked(COMPANION), mirror, 'the policy package next to this one is what the profile links');
console.log(JSON.stringify({
  command: `dsh --profile ${profileName} --dump-config`,
  gate: {
    id: gate.id,
    provider: gate.config.subagentProvider,
    model: gate.config.subagentModel,
    reasoningEffort: gate.config.subagentReasoningEffort,
    tools: gate.config.orchestratorTools,
    maxTokensKeys: Object.keys(gate.config).filter((key) => /maxTokens$/i.test(key)),
  },
  preset: preset.config.id,
  compaction: { engine: basic?.id, auto: basic?.config?.auto, bridge: true },
  localBundleLinksVerified: [SELF, COMPANION],
}, null, 2));
