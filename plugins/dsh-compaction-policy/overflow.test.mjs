// S5: a provider-confirmed context overflow is recovered by one forced
// compaction plus a retry, and never more than the configured budget.
//
//   node overflow.test.mjs
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
const { createUserMessage, createSystemMessage } = await load('dsh-llm/lib/index.js');

async function observeEvents(query, session, signal) {
  const observation = await query.observeSession(session.id, { signal, projectionMode: 'none' });
  try {
    return observation.events;
  } finally {
    observation[Symbol.dispose]();
  }
}

let failSummary = false;
let summaries = 0;

const ctx = new Context();
ctx.logger.level = 0;
await ctx.plugin(SessionStore);
await ctx.plugin(SessionProjectionRegistry);
ctx.provide('llm', {
  imageRequestPricing: () => undefined,
  fileRequestText: () => 'file',
  resolveModelInfo: async () => ({ context: { contextWindow: 256000 }, defaultMaxTokens: 256000 }),
  async *stream() {
    summaries += 1;
    if (failSummary) throw new Error('summary unavailable');
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Goal: keep going.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
});
await ctx.plugin(TokenMeter);
await ctx.plugin(SessionQueryEngine);
await ctx.plugin(BasicCompactionEngine, { thresholdRatio: 0.75, headroomTokens: 32768, retainRatio: 0.16, maxTokens: 16384, auto: false });
await ctx.plugin(ToolResultPruner, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
ctx.provide('agentPresets', {
  serviceFor(agent, name) {
    if (agent.__bridged !== true) return undefined;
    if (name === 'frugalCompaction') return ctx.get('compaction');
    if (name === 'frugalToolResultPruner') return ctx.get('toolResultPruner');
    return undefined;
  },
});

const POLICY_CONFIG = {
  reserveRatio: 0.15, reserveFloorTokens: 16384, thresholdPercent: '', thresholdTokens: 0,
  desiredOutputCap: 0, workerOutputCap: 0, fitHeadroomTokens: 64, minFittedOutputTokens: 1024,
  estimateMarginDivisor: 10, keepRecentTokens: 20000, compactionRetries: 2, maxOverflowRetries: 1,
  agentThresholdOverrides: '', skipFitTargets: '', diagnostics: false,
};

const signal = new AbortController().signal;
const OVERFLOW = { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'prompt is longer than the context window' };

function fixture(ctx, id, textSize, bridged = true) {
  const session = ctx.sessions.create(id);
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'fake', model: 'model', maxTokens: 256000 } } });
  session.append('turn/start', { turn: 1 });
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Keep the goal.') }, { surfaceOp: 'append' });
  for (let i = 0; i < 10; i += 1) {
    session.append('user/message', createUserMessage({ source: { kind: 'test' }, content: [{ type: 'text', text: `${i}${'a'.repeat(textSize)}` }] }), { surfaceOp: 'append' });
  }
  return { id, session, ctx, __bridged: bridged, options: { provider: 'fake', model: 'model' } };
}

const requestError = (agent, failure) => ctx.waterfall(
  'agent/request-error',
  { agent, turn: 1, step: 1, failure, signal },
  async () => undefined,
);

applyPolicy(ctx, { ...POLICY_CONFIG });

// ── 1. overflow → forced compaction → retry ──────────────────────────────────
const agent = fixture(ctx, 'overflow', 100000);
const before = summaries;
const action = await requestError(agent, OVERFLOW);
assert.deepEqual(action, { kind: 'retry' }, 'the overflow earns a retry');
assert.equal(summaries, before + 1, 'one forced summary ran');
const events = await observeEvents(ctx.sessionQuery, agent.session);
assert.ok(events.some((e) => e.type === 'compaction/start'), 'a real compaction transaction ran');
assert.ok(events.some((e) => e.type === 'compaction/end' && e.data.error === undefined));

// ── 2. the budget is per agent and released when the agent goes idle ─────────
const again = await requestError(agent, OVERFLOW);
assert.equal(again, undefined, 'a second overflow keeps the original error (budget spent)');
assert.equal(summaries, before + 1, 'no second summary');
ctx.emit('agent/status', { agent, status: 'idle' });
// Grow the surface again: the point of the idle release is that the budget is
// refilled, and the recovery then has real work to do (without the release this
// call would keep the original error).
for (let i = 0; i < 8; i += 1) {
  agent.session.append('user/message', createUserMessage({ source: { kind: 'test' }, content: [{ type: 'text', text: `r${i}${'q'.repeat(100000)}` }] }), { surfaceOp: 'append' });
}
const third = await requestError(agent, OVERFLOW);
assert.deepEqual(third, { kind: 'retry' }, 'going idle releases the budget');

// ── 3. a different failure is left to the host ───────────────────────────────
const other = fixture(ctx, 'other-failure', 100000);
const untouched = await requestError(other, { code: 'QUOTA_EXCEEDED', message: 'quota' });
assert.equal(untouched, undefined, 'only CONTEXT_WINDOW_EXCEEDED is handled here');

// ── 4. unbridged presets are not recovered ───────────────────────────────────
const ungoverned = fixture(ctx, 'ungoverned', 100000, false);
assert.equal(await requestError(ungoverned, OVERFLOW), undefined);

// ── 5. a failing summary preserves the original error ────────────────────────
failSummary = true;
const doomed = fixture(ctx, 'overflow-failure', 100000);
const kept = await requestError(doomed, OVERFLOW);
assert.equal(kept, undefined, 'a failed recovery does not retry into the same wall');
const doomedEvents = await observeEvents(ctx.sessionQuery, doomed.session);
assert.ok(doomedEvents.some((e) => e.type === 'compaction/end' && typeof e.data.error === 'string'), 'the failed transaction is durable');
failSummary = false;

// ── 6. no safe range still preserves the original error ──────────────────────
const empty = { id: 'empty', session: ctx.sessions.create('empty'), ctx, __bridged: true, options: { provider: 'fake', model: 'model' } };
empty.session.append('request/header', { reason: 'initial', header: { config: { provider: 'fake', model: 'model', maxTokens: 256000 } } });
empty.session.append('turn/start', { turn: 1 });
empty.session.append('user/message', createUserMessage({ source: { kind: 'test' }, content: [{ type: 'text', text: 'z'.repeat(400000) }] }), { surfaceOp: 'append' });
assert.equal(await requestError(empty, OVERFLOW), undefined, 'nothing cuttable means no retry');

// ── 7. a larger configured budget is honored ─────────────────────────────────
const budgetCtx = new Context();
budgetCtx.logger.level = 0;
await budgetCtx.plugin(SessionStore);
await budgetCtx.plugin(SessionProjectionRegistry);
budgetCtx.provide('llm', {
  imageRequestPricing: () => undefined,
  fileRequestText: () => 'file',
  resolveModelInfo: async () => ({ context: { contextWindow: 256000 }, defaultMaxTokens: 256000 }),
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Goal: keep going.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
});
await budgetCtx.plugin(TokenMeter);
await budgetCtx.plugin(SessionQueryEngine);
await budgetCtx.plugin(BasicCompactionEngine, { thresholdRatio: 0.75, headroomTokens: 32768, retainRatio: 0.16, maxTokens: 16384, auto: false });
budgetCtx.provide('agentPresets', {
  serviceFor(agent2, name) {
    if (agent2.__bridged !== true) return undefined;
    return name === 'frugalCompaction' ? budgetCtx.get('compaction') : undefined;
  },
});
applyPolicy(budgetCtx, { ...POLICY_CONFIG, maxOverflowRetries: 2 });
const budgeted = fixture(budgetCtx, 'budgeted', 100000);
const budgetedError = (agent2) => budgetCtx.waterfall('agent/request-error', { agent: agent2, turn: 1, step: 1, failure: OVERFLOW, signal }, async () => undefined);
/** Give the recovery something to cut again (a real overflow arrives with content). */
const grow = (session, count) => {
  for (let i = 0; i < count; i += 1) {
    session.append('user/message', createUserMessage({ source: { kind: 'test' }, content: [{ type: 'text', text: `g${i}${'q'.repeat(100000)}` }] }), { surfaceOp: 'append' });
  }
};
assert.deepEqual(await budgetedError(budgeted), { kind: 'retry' }, 'first recovery');
grow(budgeted.session, 8);
assert.deepEqual(await budgetedError(budgeted), { kind: 'retry' }, 'second recovery under a budget of 2');
grow(budgeted.session, 8);
assert.equal(await budgetedError(budgeted), undefined, 'the third overflow keeps the error');

console.log(JSON.stringify({
  check: 'overflow',
  firstOverflow: 'retry after one compaction',
  budget: 'per agent, released on idle',
  otherCodes: 'untouched',
  failedRecovery: 'original error preserved',
}));
console.log('overflow: forced compaction + retry, budget honored, failures never swallowed');
