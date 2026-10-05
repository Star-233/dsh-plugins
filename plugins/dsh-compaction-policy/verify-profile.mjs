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
import { readFileSync, realpathSync } from 'node:fs';
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
  const bridge = children.find((row) => row.name === BRIDGE);
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
for (const row of all.filter((item) => item.name === BRIDGE)) {
  assert.ok(presetChildren.has(row), 'every bridge row must live inside a preset, not at the top level');
}

// ── 2. the policy row the bridge talks to ────────────────────────────────────
const policy = all.find((row) => row.id === 'compaction-policy' && row.name === SELF);
assert.ok(policy, 'top-level compaction-policy row');
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
const link = realpathSync(join(profile, 'node_modules', SELF));
assert.equal(link.toLowerCase(), realpathSync(new URL('.', import.meta.url)).toLowerCase(), 'profile links this checkout');

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
