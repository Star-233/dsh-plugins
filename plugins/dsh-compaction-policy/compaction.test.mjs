// S3: the policy row drives the REAL compaction engine through a real session.
//
//   node compaction.test.mjs
//
// The engine and the pruner are mounted on a narrow context and reached through a
// fake `agentPresets.serviceFor` — the same read path the bridge feeds in
// production. The pressure threshold is the plan's 217600 for a 256000 window,
// not v0.3's 23232.
import assert from 'node:assert/strict';
import { apply as applyPolicy } from './index.js';
import { load } from './test-runtime.mjs';

const { Context } = await load('cordis/lib/index.js');
const { SessionStore } = await load('dsh-session/lib/index.js');
const { SessionProjectionRegistry } = await load('dsh-session-projection/lib/index.js');
const { TokenMeter } = await load('dsh-token-meter/lib/index.js');
const { SessionQueryEngine } = await load('dsh-session-query/lib/index.js');
const { default: BasicCompactionEngine } = await load('dsh-compaction-basic/lib/index.js');
const { default: ToolResultPruner } = await load('dsh-compaction-tool-result-pruner/lib/index.js');
const { createUserMessage, createSystemMessage, createAssistantMessage, createToolResultMessage } = await load('dsh-llm/lib/index.js');

async function observeEvents(query, session, signal) {
  const observation = await query.observeSession(session.id, { signal, projectionMode: 'none' });
  try {
    return observation.events;
  } finally {
    observation[Symbol.dispose]();
  }
}

const ctx = new Context();
ctx.logger.level = 0;
await ctx.plugin(SessionStore);
await ctx.plugin(SessionProjectionRegistry);

let streamCalls = 0;
let failSummary = false;
let streamMaxTokens = [];
ctx.provide('llm', {
  imageRequestPricing: () => undefined,
  fileRequestText: () => 'file',
  resolveModelInfo: async () => ({ context: { contextWindow: 256000 }, defaultMaxTokens: 256000 }),
  async *stream(request) {
    streamCalls += 1;
    streamMaxTokens.push(request.maxTokens);
    assert.equal(request.purpose, 'compaction');
    if (failSummary) throw new Error('fake summary failure');
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Goal: preserve task. Completed: prior evidence. Pending: verify current work.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
});
await ctx.plugin(TokenMeter);
await ctx.plugin(SessionQueryEngine);
await ctx.plugin(BasicCompactionEngine, { thresholdRatio: 0.75, headroomTokens: 32768, retainRatio: 0.16, maxTokens: 16384, auto: false });
await ctx.plugin(ToolResultPruner, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });

/** The bridge's read path, faked: only agents flagged as bridged resolve a service. */
ctx.provide('agentPresets', {
  serviceFor(agent, name) {
    if (agent.__bridged !== true) return undefined;
    if (name === 'frugalCompaction') return ctx.get('compaction');
    if (name === 'frugalToolResultPruner') return ctx.get('toolResultPruner');
    return undefined;
  },
});

const POLICY_CONFIG = {
  reserveRatio: 0.15,
  reserveFloorTokens: 16384,
  thresholdPercent: '',
  thresholdTokens: 0,
  desiredOutputCap: 0,
  workerOutputCap: 0,
  fitHeadroomTokens: 64,
  minFittedOutputTokens: 1024,
  estimateMarginDivisor: 10,
  keepRecentTokens: 20000,
  compactionRetries: 2,
  maxOverflowRetries: 1,
  agentThresholdOverrides: '',
  skipFitTargets: '',
  diagnostics: false,
};
applyPolicy(ctx, { ...POLICY_CONFIG });

const signal = new AbortController().signal;

function fixture(id, textSize, bridged = true, messages = 10) {
  const session = ctx.sessions.create(id);
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'fake', model: 'model', maxTokens: 256000 } } });
  session.append('turn/start', { turn: 1 });
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Preserve goal and evidence.') }, { surfaceOp: 'append' });
  for (let i = 0; i < messages; i += 1) {
    session.append('user/message', createUserMessage({ source: { kind: 'test' }, content: [{ type: 'text', text: `${i}${'a'.repeat(textSize)}` }] }), { surfaceOp: 'append' });
  }
  return { id, session, ctx, __bridged: bridged, options: { provider: 'fake', model: 'model' } };
}

const preStep = (agent) => ctx.waterfall('agent/pre-step', { agent, turn: 1, step: 1, signal, messages: [] }, async () => ({ kind: 'enter', messages: [] }));

// ── 1. An unbridged preset is not governed at all ────────────────────────────
const ungoverned = fixture('ungoverned', 100000, false);
const before = streamCalls;
const decision = await preStep(ungoverned);
assert.equal(decision.kind, 'enter', 'ungoverned agents keep walking the turn');
assert.equal(streamCalls, before, 'no compaction for a preset without the bridge');
assert.equal(ctx.tokenMeter.measure(ungoverned.session).totalTokens > 217600, true, 'the fixture really is over threshold');

// ── 2. A bridged preset compacts once, for real ──────────────────────────────
const agent = fixture('bridged-pressure', 100000);
assert.ok(ctx.tokenMeter.measure(agent.session).totalTokens > 217600, 'pressure is above the 217600 threshold');
const result = await preStep(agent);
assert.equal(result.kind, 'enter', 'the turn continues after compaction');
assert.equal(streamCalls, before + 1, 'exactly one summary call');
assert.deepEqual(streamMaxTokens, [16384], 'the summarizer uses the engine\'s own maxTokens');
assert.ok(ctx.tokenMeter.measure(agent.session).totalTokens < 217600, 'pressure is below the threshold afterwards');
assert.equal(agent.session.requestHeader().config.maxTokens, 256000, 'the durable header is never rewritten');
const events = await observeEvents(ctx.sessionQuery, agent.session);
assert.ok(events.some((e) => e.type === 'compaction/start'), 'a real compaction/start was logged');
assert.ok(events.some((e) => e.type === 'compaction/end' && e.data.error === undefined), 'and it ended without error');
assert.ok(events.some((e) => e.type === 'user/message' && e.data.source?.kind === 'compact-checkpoint'), 'the summary is a durable checkpoint');

// ── 3. An already-small session never calls the model ────────────────────────
const small = fixture('small', 100);
const after = streamCalls;
await preStep(small);
assert.equal(streamCalls, after, 'below the threshold nothing is summarized');

// ── 4. A summarizer failure is logged and the turn still proceeds ────────────
failSummary = true;
const failing = fixture('summary-failure', 100000);
const failed = await preStep(failing);
assert.equal(failed.kind, 'enter', 'a compaction failure never terminates the turn (pi/ompi semantics)');
assert.equal(streamCalls, after + 1, 'the summary was attempted');
const failedEvents = await observeEvents(ctx.sessionQuery, failing.session);
assert.ok(failedEvents.some((e) => e.type === 'compaction/end' && typeof e.data.error === 'string'), 'the failed transaction is durable');
failSummary = false;

// ── 5. A session with nothing safely cuttable degrades, never throws ─────────
const empty = { id: 'empty-range', session: ctx.sessions.create('empty-range'), ctx, __bridged: true, options: { provider: 'fake', model: 'model' } };
empty.session.append('request/header', { reason: 'initial', header: { config: { provider: 'fake', model: 'model', maxTokens: 256000 } } });
empty.session.append('turn/start', { turn: 1 });
empty.session.append('user/message', createUserMessage({ source: { kind: 'test' }, content: [{ type: 'text', text: 'c'.repeat(900000) }] }), { surfaceOp: 'append' });
const degraded = await preStep(empty);
assert.equal(degraded.kind, 'enter', 'no safe range degrades to "continue", never a thrown turn error');
assert.equal(ctx.tokenMeter.measure(empty.session).totalTokens > 217600, true, 'and the pressure really was over threshold');

// ── 6. A pruner that cannot free enough still ends in a real compaction ──────
const prunable = fixture('tool-pressure', 100);
prunable.session.append('step/start', { turn: 1, step: 1 });
prunable.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'fake', model: 'model' }, content: [{ type: 'tool-call', id: 'prune-call', name: 'read', arguments: '{}' }] }) }, { surfaceOp: 'append' });
prunable.session.append('tool/call', { turn: 1, step: 1, callId: 'prune-call', name: 'read', arguments: '{}' });
prunable.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'prune-call', content: [{ type: 'text', text: 'b'.repeat(900000) }], isError: false }) }, { surfaceOp: 'append' });
const prunedBefore = streamCalls;
await preStep(prunable);
const prunedEvents = await observeEvents(ctx.sessionQuery, prunable.session);
assert.ok(prunedEvents.some((e) => e.type === 'compaction/prune'), 'the pruner ran (the isolated pruner is reachable now)');
assert.ok(ctx.tokenMeter.measure(prunable.session).totalTokens < 217600, 'model-free pruning was enough');
assert.equal(streamCalls, prunedBefore, 'so no summary call was needed');

console.log(JSON.stringify({
  check: 'compaction',
  window: 256000, threshold: 217600,
  summaryCalls: streamMaxTokens, ungovernedPreset: 'untouched',
  failureSemantics: 'turn continues', noRange: 'degraded',
}));
console.log('compaction: real Session/TokenMeter/Compaction engine — threshold 217600, real start/end, failure never ends the turn');
