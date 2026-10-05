/** Small, JSON-safe diagnostics derived from real session evidence. */
export const FRUGAL_EVENT = 'frugal/state';
export const STATE_VERSION = 1;

export function unionMilliseconds(intervals) {
  let end = -Infinity;
  let total = 0;
  for (const [from, to] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
    total += Math.max(0, to - Math.max(from, end));
    end = Math.max(end, to);
  }
  return total;
}

/** Missing evidence stays null, never inferred as a successful compaction. */
export function replayTelemetry(events, inheritedEventCount = 0) {
  const state = {
    created: 0, continued: 0, synchronous: 0, rejected: 0, steps: 0,
    modelMs: null, toolMs: null, waitMs: null, wallMs: null,
    route: null, contextWindow: null, lastCompaction: null, lastPrune: null,
    stopReason: null,
  };
  const steps = new Map();
  const calls = new Map();
  const modelIntervals = [];
  const toolIntervals = [];
  const waitIntervals = [];
  let first = null;
  let last = null;
  for (const event of events.slice(inheritedEventCount)) {
    const { type, data = {}, time } = event;
    if (Number.isFinite(time)) { first ??= time; last = time; }
    const key = `${data.turn}/${data.step}`;
    if (type === 'request/header') state.route = data.header?.config ?? null;
    if (type === 'request/context') state.contextWindow = data.contextWindow ?? data.context?.contextWindow ?? null;
    if (type === 'step/start') steps.set(key, time);
    if (type === 'assistant/message') {
      state.steps += 1;
      if (steps.has(key)) modelIntervals.push([steps.get(key), time]);
    }
    if (type === 'tool/call') {
      calls.set(data.callId, { time, name: data.name });
      let args = data.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
      if (data.name === 'subagent') {
        if (args?.agent_id) state.continued += 1;
        else state.created += 1;
        if (args?.run_in_background === false) state.synchronous += 1;
      }
    }
    if (type === 'tool/result') {
      const call = calls.get(data.message?.toolCallId);
      if (call) {
        const interval = [call.time, time];
        toolIntervals.push(interval);
        if (['wait_subagent', 'wait_agent', 'job_output'].includes(call.name)) waitIntervals.push(interval);
      }
    }
    if (type === 'compaction/end') state.lastCompaction = { at: time, ...data };
    if (type === 'compaction/prune') state.lastPrune = { at: time, type };
    if (type === 'turn/end') state.stopReason = data.reason?.kind ?? null;
    if (type === FRUGAL_EVENT && data.version === STATE_VERSION && data.kind === 'rejected') state.rejected += 1;
  }
  if (first !== null && last !== null) state.wallMs = last - first;
  if (modelIntervals.length) state.modelMs = unionMilliseconds(modelIntervals);
  if (toolIntervals.length) state.toolMs = unionMilliseconds(toolIntervals);
  if (waitIntervals.length) state.waitMs = unionMilliseconds(waitIntervals);
  return state;
}

/** Read the public immutable observation and release its lease even on failure. */
export async function observeEvents(query, session, signal) {
  if (typeof query?.observeSession !== 'function') {
    throw Object.assign(new Error('SESSION_QUERY_UNAVAILABLE: frugal requires observeSession() to restore state safely'), { code: 'SESSION_QUERY_UNAVAILABLE' });
  }
  const observation = await query.observeSession(session.id, { signal, projectionMode: 'none' });
  try {
    return { events: observation.events, inheritedEventCount: observation.inheritedEventCount };
  } finally {
    observation[Symbol.dispose]();
  }
}
