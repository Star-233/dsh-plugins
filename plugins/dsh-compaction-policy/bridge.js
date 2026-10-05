/**
 * Compaction-policy bridge — a row that lives INSIDE a preset's compaction group.
 *
 * WHY THIS ROW EXISTS (the v0.3 blind spot):
 * A preset mounts its compaction engine in a `cordis:group` whose
 * `isolate: { compaction: true, toolResultPruner: true }` gives each name an
 * ENTRY-LOCAL symbol (`compaction#<entry id>`). Cordis resolves a service
 * through the CALLER's isolate table, so only rows inside that group can read
 * `ctx.compaction`. A top-level policy row — and `agent.ctx`, which is the
 * mount's SIBLING, not its descendant — reads `undefined` forever. v0.3
 * therefore threw COMPACTION-UNAVAILABLE every time it crossed its threshold,
 * and its tool-result pruning silently did nothing. Both were dead code that
 * the offline suite could not see, because the fixture mounted compaction on the
 * ROOT context.
 *
 * WHY IT DOES NOT JUST `ctx.provide('compaction', …)` AT THE ROOT:
 * a root-visible name is a single store slot shared by the whole process, so a
 * second bridged preset would either collide or silently serve the first
 * preset's engine, and the policy row could no longer tell a bridged preset from
 * an untouched official one.
 *
 * WHAT IT DOES INSTEAD: republishes the engine under a FRESH, per-mount isolate
 * label (`ctx.isolate(name)`), so the implementation stays owned by this
 * preset's subtree and is addressable per agent through the host's own
 * `agentPresets.serviceFor(agent, name)` — the same read path the browser RPCs
 * use to reach services a preset mounted behind an isolate realm. The bridge row
 * is therefore the TAKEOVER SWITCH: an un-restated official preset keeps its own
 * built-in compaction path.
 *
 * Names differ from the service names on purpose: republishing `compaction`
 * itself would shadow whatever a nested row expects to read.
 *
 * @module @nu11dev/dsh-compaction-policy/bridge
 */

/** Per-mount name the policy row resolves for the compaction engine. */
export const ENGINE_SERVICE = 'frugalCompaction';

/** Per-mount name the policy row resolves for the tool-result pruner. */
export const PRUNER_SERVICE = 'frugalToolResultPruner';

/** Cordis plugin name (the row's `id` in the preset is separate). */
export const name = 'compaction-policy-bridge';

/** The bridge needs the engine it republishes; the pruner is optional. */
export const inject = ['compaction'];

/**
 * Republish this mount's engine (and pruner) under per-mount names.
 *
 * `ctx.isolate(name)` mints a label unique to this call, so two mounts never
 * share a store slot; `provide` keeps the implementation owned by this row's
 * fiber, which is what makes `agentPresets.serviceFor` find it for this preset's
 * agents only.
 * @param ctx - the bridge row's context, inside the isolated compaction group.
 */
export function apply(ctx) {
  const engineScope = ctx.isolate(ENGINE_SERVICE);
  engineScope.provide(ENGINE_SERVICE, ctx.compaction);
  const pruner = ctx.get('toolResultPruner');
  if (pruner !== undefined) {
    const prunerScope = ctx.isolate(PRUNER_SERVICE);
    prunerScope.provide(PRUNER_SERVICE, pruner);
  }
}
