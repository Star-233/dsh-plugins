/**
 * Engine access, measurement, and range selection for the policy row.
 *
 * Every function here is host-facing (it touches `ctx` services) but carries no
 * policy: the numbers come from `./policy.js`.
 *
 * @module @nu11dev/dsh-compaction-policy/lib/engine
 */

import { ENGINE_SERVICE, PRUNER_SERVICE } from '../bridge.js';
import { importFromBases, requireFromBases } from './resolve.js';

/** One classified failure, kept out of the turn-terminating path. */
export function policyError(message, code = 'COMPACTION-POLICY') {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** `ctx.get` that never throws (a cordis proxy can refuse an un-injected name). */
export function serviceOf(ctx, name) {
  try {
    return ctx?.get?.(name);
  } catch {
    return undefined;
  }
}

/**
 * The bridged engine and pruner for ONE agent's preset mount.
 *
 * `agentPresets.serviceFor(agent, name)` is the host's own per-mount read path
 * (`serviceForAgent` scans the service store for an implementation owned by a
 * fiber inside the agent's preset mount). Because the bridge republishes under a
 * per-mount isolate label, this returns `undefined` for every agent whose preset
 * carries no bridge row — which is exactly the takeover switch.
 * @param ctx - the host-plane row context.
 * @param agent - the agent whose mount is queried.
 * @returns `{ engine, pruner }`, or undefined when this preset is not bridged.
 */
export function enginesFor(ctx, agent) {
  if (agent === undefined || agent === null) return undefined;
  const registry = serviceOf(ctx, 'agentPresets');
  if (typeof registry?.serviceFor !== 'function') return undefined;
  let engine;
  try {
    engine = registry.serviceFor(agent, ENGINE_SERVICE);
  } catch {
    return undefined;
  }
  if (engine === undefined || engine === null) return undefined;
  let pruner;
  try {
    pruner = registry.serviceFor(agent, PRUNER_SERVICE);
  } catch {
    pruner = undefined;
  }
  return { engine, pruner: pruner ?? undefined };
}

/** The canonical request header the meter should price: the route plus its tools. */
export function headerFor(config, pending) {
  return {
    config,
    ...(Array.isArray(pending?.tools) && pending.tools.length > 0 ? { tools: pending.tools } : {}),
  };
}

/** Tokens of the messages and prompt that are not on the durable surface yet. */
export function pendingTokens(meter, pending) {
  if (meter === undefined || pending === undefined) return 0;
  let total = 0;
  for (const message of pending.messages ?? []) total += meter.estimateMessage(message);
  if (typeof pending.prompt === 'string' && pending.prompt.length > 0) {
    total += meter.estimateMessage({ role: 'system', content: [{ type: 'text', text: pending.prompt }] });
  }
  return total;
}

/**
 * Price the next request: the replayed surface under the projected header, plus
 * everything the loop assembled for this step.
 * @returns `{ measurement, pressureTokens, anchored }`, or undefined without a meter.
 */
export function measurePressure(ctx, agent, config, pending) {
  const meter = serviceOf(ctx, 'tokenMeter');
  if (typeof meter?.measure !== 'function') return undefined;
  const measurement = meter.measure(agent.session, headerFor(config, pending));
  return {
    measurement,
    extraTokens: pendingTokens(meter, pending),
    anchored: measurement?.baseline?.kind === 'usage',
  };
}

/** Tool-call/result pairing checks, resolved from the host's own package. */
async function pairingModule() {
  const loaded = requireFromBases('@deepseek-ai/dsh-compaction');
  const module = loaded.ok ? loaded.module : await importFromBases('@deepseek-ai/dsh-compaction');
  if (typeof module?.toolPairingBalancedBefore !== 'function' || typeof module?.toolPairingBalancedAfter !== 'function') {
    throw policyError('public tool-pairing checks unavailable', 'COMPACTION-UNAVAILABLE');
  }
  return module;
}

/**
 * Pick the oldest safe range to replace: keep `retainTokens` of the tail, never
 * cut the leading system prompt, and never split a tool call from its result.
 *
 * Positions, not numeric seq order: a replacement can land a fresh high-seq node
 * at an older range's position.
 * @param session - agent session whose surface is read.
 * @param measurement - the measurement the surface was priced from.
 * @param retainTokens - tail budget kept verbatim.
 * @param query - `sessionQuery` service used to re-read the surface.
 * @param signal - cancellation.
 * @returns `{ start, end }` surface seqs, or null when there is no safe range.
 */
export async function selectSafeRange(session, measurement, retainTokens, query, signal) {
  const priced = measurement?.nodes ?? [];
  const nodes = session.surface.nodes;
  if (nodes.length !== priced.length || nodes.some((seq, i) => seq !== priced[i].seq)) {
    throw policyError('surface changed during selection');
  }
  if (!nodes.length) return null;
  if (typeof query?.observeSession !== 'function') {
    throw policyError('sessionQuery.observeSession is required to select a range', 'SESSION-QUERY-UNAVAILABLE');
  }
  const observation = await query.observeSession(session.id, { signal, projectionMode: 'none' });
  let events;
  try {
    events = observation.events;
  } finally {
    observation[Symbol.dispose]?.();
  }
  if (session.seq !== events.length) throw policyError('surface changed while reading selection');
  const first = events[nodes[0]]?.type === 'system/message' ? 1 : 0;
  let tail = 0;
  let keep = priced.length;
  for (let i = priced.length - 1; i >= first; i -= 1) {
    tail += priced[i].tokens;
    keep = i;
    if (tail >= retainTokens) break;
  }
  const { toolPairingBalancedBefore: before, toolPairingBalancedAfter: after } = await pairingModule();
  while (keep > first && !before(session, nodes[keep])) keep -= 1;
  if (keep <= first || !before(session, nodes[first]) || !after(session, nodes[keep - 1])) return null;
  return { start: nodes[first], end: nodes[keep - 1] };
}

/** Model-free tool-result pruning; a no-op when the preset mounts no pruner. */
export function prune(pruner, session) {
  try {
    return pruner?.pruneSession?.(session);
  } catch {
    return undefined;
  }
}
