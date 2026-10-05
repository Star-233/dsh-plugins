// S4: the output cap is a wish, narrowed only to what fits.
//
//   node fit.test.mjs
//
// A seeded `agent/request` waterfall is driven through the real listener. The
// assertions are about the REQUEST (what the adapter would send), not about the
// session: `request/header` must stay untouched.
import assert from 'node:assert/strict';
import { apply as applyPolicy } from './index.js';
import { load } from './test-runtime.mjs';

const { Context } = await load('cordis/lib/index.js');
const { SessionStore } = await load('dsh-session/lib/index.js');
const { SessionProjectionRegistry } = await load('dsh-session-projection/lib/index.js');
const { TokenMeter } = await load('dsh-token-meter/lib/index.js');
const { createUserMessage, createSystemMessage } = await load('dsh-llm/lib/index.js');

const WINDOW = 256000;

function makeContext(modelInfo) {
  const ctx = new Context();
  ctx.logger.level = 0;
  return (async () => {
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    ctx.provide('llm', {
      imageRequestPricing: () => undefined,
      fileRequestText: () => 'file',
      resolveModelInfo: async () => modelInfo(),
      async *stream() { throw new Error('fit must never summarize'); },
    });
    await ctx.plugin(TokenMeter);
    ctx.provide('agentPresets', {
      serviceFor(agent, name) {
        if (agent.__bridged !== true) return undefined;
        if (name === 'frugalCompaction') return { compactRegion: async () => { throw new Error('fit must never compact'); } };
        return undefined;
      },
    });
    return ctx;
  })();
}

const POLICY_CONFIG = {
  reserveRatio: 0.15, reserveFloorTokens: 16384, thresholdPercent: '', thresholdTokens: 0,
  desiredOutputCap: 0, workerOutputCap: 0, fitHeadroomTokens: 64, minFittedOutputTokens: 1024,
  estimateMarginDivisor: 10, keepRecentTokens: 20000, compactionRetries: 2, maxOverflowRetries: 1,
  agentThresholdOverrides: '', skipFitTargets: '', diagnostics: false,
};

const signal = new AbortController().signal;

function fixture(ctx, id, textSize) {
  const session = ctx.sessions.create(id);
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'fake', model: 'model', maxTokens: 256000 } } });
  session.append('turn/start', { turn: 1 });
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Be helpful.') }, { surfaceOp: 'append' });
  if (textSize > 0) session.append('user/message', createUserMessage({ source: { kind: 'test' }, content: [{ type: 'text', text: 'a'.repeat(textSize) }] }), { surfaceOp: 'append' });
  return { id, session, ctx, __bridged: true, options: { provider: 'fake', model: 'model' } };
}

/** The next request as the adapter would see it. */
const request = (ctx, agent, seed) => ctx.waterfall('agent/request', { agent, turn: 1, step: 1, signal }, async () => seed);
const SEED = { provider: 'fake', model: 'model', maxTokens: 256000 };

let modelInfo = () => ({ context: { contextWindow: WINDOW }, defaultMaxTokens: WINDOW });
const ctx = await makeContext(() => modelInfo());
applyPolicy(ctx, { ...POLICY_CONFIG });

// ── 1. decision A: the model's own capability is the wish ────────────────────
const small = fixture(ctx, 'small', 100);
const first = await request(ctx, small, { ...SEED });
assert.ok(first.maxTokens < WINDOW, 'a 256k wish under a 256k window is narrowed to what fits');
assert.ok(first.maxTokens > 250000, `a small prompt leaves almost the whole window (${first.maxTokens})`);
assert.equal(first.maxTokens + 64 + 1100 > WINDOW - 200, true, 'the fitted cap leaves only the headroom plus the prompt');
assert.equal(small.session.requestHeader().config.maxTokens, 256000, 'the durable header is not rewritten');

// ── 2. an explicit smaller wish is left alone ────────────────────────────────
const bounded = fixture(ctx, 'bounded', 100);
const explicit = await request(ctx, bounded, { ...SEED });
assert.ok(explicit.maxTokens > 250000);
const limitedCtx = await makeContext(() => modelInfo());
applyPolicy(limitedCtx, { ...POLICY_CONFIG, desiredOutputCap: 32768 });
const limited = await request(limitedCtx, fixture(limitedCtx, 'limited', 100), { ...SEED });
assert.equal(limited.maxTokens, 32768, 'a configured cap smaller than the room is kept verbatim');

// ── 3. a prompt that leaves less than the floor still asks for the floor ─────
const huge = fixture(ctx, 'huge', 1_200_000);
const squeezed = await request(ctx, huge, { ...SEED });
assert.equal(squeezed.maxTokens, 1024, 'room below the floor clamps to 1024, never to a rejected request');

// ── 4. worker split (decision B spelling) ────────────────────────────────────
const workerCtx = await makeContext(() => modelInfo());
applyPolicy(workerCtx, { ...POLICY_CONFIG, workerOutputCap: 16384 });
const worker = fixture(workerCtx, 'worker', 100);
worker.options = { ...worker.options, subagentDepth: 1 };
const workerFit = await request(workerCtx, worker, { ...SEED });
assert.equal(workerFit.maxTokens, 16384, 'a configured worker cap applies to delegated agents only');
const lead = await request(workerCtx, fixture(workerCtx, 'lead', 100), { ...SEED });
assert.notEqual(lead.maxTokens, 16384, 'the lead keeps the uncapped wish path');

// ── 5. skip condition ①: no contextWindow ────────────────────────────────────
const noWindowCtx = await makeContext(() => ({ defaultMaxTokens: WINDOW }));
applyPolicy(noWindowCtx, { ...POLICY_CONFIG });
const noWindow = await request(noWindowCtx, fixture(noWindowCtx, 'no-window', 100), { ...SEED });
assert.equal(noWindow.maxTokens, 256000, 'without a window the cap is passed through');

// ── 6. skip condition ②: configured compat list ──────────────────────────────
const compatCtx = await makeContext(() => modelInfo());
applyPolicy(compatCtx, { ...POLICY_CONFIG, skipFitTargets: 'fake/model' });
const compat = await request(compatCtx, fixture(compatCtx, 'compat', 100), { ...SEED });
assert.equal(compat.maxTokens, 256000, 'a route that stops at the window itself is never fitted');

// ── 7. skip condition ③: nobody declares a cap ───────────────────────────────
const noneCtx = await makeContext(() => ({ context: { contextWindow: WINDOW } }));
applyPolicy(noneCtx, { ...POLICY_CONFIG });
const noCap = await request(noneCtx, fixture(noneCtx, 'no-cap', 100), { provider: 'fake', model: 'model' });
assert.equal(noCap.maxTokens, undefined, 'with no declared cap anywhere the seeded envelope is untouched');

// ── 8. ungoverned presets are untouched ──────────────────────────────────────
const ungoverned = fixture(ctx, 'ungoverned', 100);
ungoverned.__bridged = false;
const untouched = await request(ctx, ungoverned, { ...SEED });
assert.equal(untouched.maxTokens, 256000, 'a preset without the bridge keeps its own envelope');

console.log(JSON.stringify({
  check: 'fit', window: WINDOW, smallPrompt: first.maxTokens, squeezed: squeezed.maxTokens,
  configuredCap: limited.maxTokens, workerCap: workerFit.maxTokens, skipped: ['no-window', 'compat-route', 'no-cap', 'ungoverned'],
}));
console.log('fit: cap follows the model, narrows to room, floors at 1024, skips the three compat cases');
