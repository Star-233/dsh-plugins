// Composition test for the isolate seam and the bridge (S2).
//
// This is the test that FAILS before `bridge.js` exists — and that is the point.
// v0.3 shipped a green suite whose fixture mounted compaction on the ROOT
// context, while production mounts it inside a `cordis:group` with
// `isolate: { compaction: true }`. The fixture could not reproduce the real
// composition, so COMPACTION-UNAVAILABLE shipped as dead code.
//
// Here a REAL `Loader` (`ctx.plugin(Loader)`, the way dsh-app-boot applies it)
// builds a real entry tree from real modules:
//
//   group-a (isolate compaction/toolResultPruner)   group-b (isolate, unbridged)
//     ├── provider  → ctx.provide('compaction')       └── provider
//     ├── inside    → the group CAN read it
//     └── bridge    → the patch under test
//   outside         → a host-plane context CANNOT read it, before or after
//
// The fix is not "the host plane can read ctx.compaction" — it still cannot, and
// should not. The fix is that the engine becomes ADDRESSABLE PER MOUNT under a
// name only a bridged preset publishes. `servicesWithin` below mirrors the
// host's own `agentPresets.serviceFor` read path
// (`withinFiber(impl.fiber, mount.fiber)` in dsh-agent-preset-registry).
//
//   node composition.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE_SERVICE, PRUNER_SERVICE } from './bridge.js';
import { load } from './test-runtime.mjs';

const { Context } = await load('cordis/lib/index.js');
const { default: Loader, Group } = await load('cordis-plugin-loader/lib/index.js');

const dir = mkdtempSync(join(tmpdir(), 'dsh-compaction-policy-'));
const dirUrl = pathToFileURL(`${dir}/`).href;
const write = (file, body) => writeFileSync(join(dir, file), body);

const probe = (globalThis.__compactionPolicyProbe = {});

write('provider.mjs', `export const name = 'probe-provider';
export function apply(ctx) {
  ctx.provide('compaction', { tag: 'engine' });
  ctx.provide('toolResultPruner', { tag: 'pruner', pruneSession() {} });
}
`);
write('inside.mjs', `export const inject = ['compaction'];
export function apply(ctx) {
  globalThis.__compactionPolicyProbe.insideEngine = ctx.get('compaction')?.tag ?? null;
  globalThis.__compactionPolicyProbe.insidePruner = ctx.get('toolResultPruner')?.tag ?? null;
  globalThis.__compactionPolicyProbe.insideBridged = ctx.get('frugalCompaction')?.tag ?? null;
}
`);
write('outside.mjs', `export function apply(ctx) {
  globalThis.__compactionPolicyProbe.outsideEngine = ctx.get('compaction')?.tag ?? null;
  globalThis.__compactionPolicyProbe.outsidePruner = ctx.get('toolResultPruner')?.tag ?? null;
  globalThis.__compactionPolicyProbe.bridged = ctx.get('frugalCompaction')?.tag ?? null;
}
`);

/** The host's `withinFiber`: fiber membership by object identity. */
function withinFiber(fiber, root) {
  let current = fiber;
  while (true) {
    if (current === root) return true;
    const parent = current.parent.fiber;
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * The host's `agentPresets.serviceFor(agent, name)` read path, without the agent:
 * the implementation of `name` published anywhere inside `mountFiber`.
 * @returns the published value, or undefined.
 */
function servicesWithin(ctx, mountFiber, name) {
  let found;
  for (const key of Object.getOwnPropertySymbols(ctx.reflect.store)) {
    const impl = ctx.reflect.store[key];
    if (impl === undefined || impl.name !== name) continue;
    if (!withinFiber(impl.fiber, mountFiber)) continue;
    found = impl.value;
  }
  return found;
}

const ctx = new Context();
await ctx.plugin(Loader, { baseUrl: dirUrl });
const loader = ctx.get('loader');
assert.ok(loader, 'the loader is applied the way the host applies it (ctx.plugin(Loader))');
loader.builtins.group = Group;

// 1. The production shape: the engine lives in an entry-local isolate realm.
await loader.create({
  id: 'group-a', name: 'cordis:group', group: true,
  isolate: { compaction: true, toolResultPruner: true },
  config: [
    { id: 'provider', name: './provider.mjs' },
    { id: 'inside', name: './inside.mjs' },
  ],
});
await loader.await();
const groupA = loader.resolve('group-a');

assert.equal(probe.insideEngine, 'engine', 'a row INSIDE the isolate group reads ctx.compaction');
assert.equal(probe.insidePruner, 'pruner');
assert.equal(probe.insideBridged, null, 'nothing is republished before the bridge mounts');

// 2. The v0.3 bug, reproduced: a host-plane row cannot see the isolated service.
await loader.create({ id: 'outside', name: './outside.mjs' });
await loader.await();
assert.equal(probe.outsideEngine, null, 'isolate really does hide ctx.compaction from the host plane');
assert.equal(probe.outsidePruner, null, 'and hides ctx.toolResultPruner too');

// 3. An unbridged sibling preset: the policy row must NOT find an engine here.
await loader.create({
  id: 'group-b', name: 'cordis:group', group: true,
  isolate: { compaction: true, toolResultPruner: true },
  config: [{ id: 'provider-b', name: './provider.mjs' }],
});
await loader.await();
const groupB = loader.resolve('group-b');
assert.equal(servicesWithin(ctx, groupA.fiber, ENGINE_SERVICE), undefined, 'unbridged preset A has no policy engine');
assert.equal(servicesWithin(ctx, groupB.fiber, ENGINE_SERVICE), undefined, 'unbridged preset B has none either');

// 4. The patch: one row inside group A republishes the engine for its own mount.
await loader.create({ id: 'bridge', name: pathToFileURL(join(import.meta.dirname, 'bridge.js')).href }, 'group-a');
await loader.await();

const published = servicesWithin(ctx, groupA.fiber, ENGINE_SERVICE);
assert.equal(published?.tag, 'engine', 'after the bridge the engine is addressable inside group A');
assert.equal(servicesWithin(ctx, groupA.fiber, PRUNER_SERVICE)?.tag, 'pruner', 'the pruner is republished too');
assert.equal(servicesWithin(ctx, groupB.fiber, ENGINE_SERVICE), undefined, 'group B is still NOT taken over');
assert.equal(ctx.get(ENGINE_SERVICE), undefined, 'the host plane still cannot read the isolated name directly');

// 5. A second bridge in the other preset must not collide: fresh label per mount.
await loader.create({ id: 'bridge-b', name: pathToFileURL(join(import.meta.dirname, 'bridge.js')).href }, 'group-b');
await loader.await();
assert.equal(servicesWithin(ctx, groupB.fiber, ENGINE_SERVICE)?.tag, 'engine', 'the second preset publishes its own engine');
assert.equal(servicesWithin(ctx, groupA.fiber, ENGINE_SERVICE)?.tag, 'engine', 'group A is unaffected by the second bridge');

rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({
  check: 'composition',
  insideGroup: probe.insideEngine,
  hostPlaneDirect: null,
  perMountAfterBridge: published.tag,
  unbridgedPreset: 'not governed',
  twoBridges: 'independent',
}));
console.log('composition: isolate blind spot reproduced; the bridge makes the engine per-mount addressable');
