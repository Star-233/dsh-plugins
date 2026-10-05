// Unit tests for the pure policy math (S1).
//
//   node policy.test.mjs
import assert from 'node:assert/strict';
import {
  POLICY_DEFAULTS, clampThreshold, estimatePromptTokens, exceedsThreshold, fitOutputTokens,
  isTokenCount, overrideForAgent, parsePercentOverride, parseThresholdOverride, resolveReserveTokens, resolveRetentionTokens,
  resolveThresholdTokens,
} from './lib/policy.js';

// ── reserve: window - reserve, not window - output cap ────────────────────────
assert.equal(resolveReserveTokens(256000), 38400, '256k window reserves max(15%, 16384) = 38400');
assert.equal(resolveReserveTokens(200000), 30000);
assert.equal(resolveReserveTokens(8192), 16384, 'small windows keep the 16384 floor');
assert.equal(resolveReserveTokens(undefined), undefined);
assert.equal(resolveReserveTokens(0), undefined);
assert.equal(resolveReserveTokens(-5), undefined);

// ── threshold ─────────────────────────────────────────────────────────────────
assert.equal(resolveThresholdTokens({ contextWindow: 256000 }), 217600, "the plan headline number");
assert.equal(resolveThresholdTokens({ contextWindow: 256000, thresholdTokens: 90000 }), 90000);
assert.equal(resolveThresholdTokens({ contextWindow: 256000, thresholdPercent: '80%' }), 204800);
assert.equal(resolveThresholdTokens({ contextWindow: 256000, thresholdPercent: 80 }), 204800, 'percent field: a bare number is a percent');
assert.equal(resolveThresholdTokens({ contextWindow: 256000, thresholdPercent: '-1' }), 217600, '-1 = no override (ompi)');
assert.equal(resolveThresholdTokens({ contextWindow: 256000, thresholdPercent: '' }), 217600);
assert.equal(resolveThresholdTokens({ contextWindow: 256000, thresholdPercent: '200%' }), 255999, 'clamped below the window');
assert.equal(resolveThresholdTokens({ contextWindow: 2000 }), 1, 'reserve larger than window clamps to 1');
assert.equal(resolveThresholdTokens({ contextWindow: 256000, thresholdTokens: 1 }), 1);
assert.equal(resolveThresholdTokens({ contextWindow: undefined }), undefined);
assert.equal(clampThreshold(256000, 256000), 255999);
assert.equal(clampThreshold(0, 256000), 1);
assert.equal(parseThresholdOverride(90000), 90000);
assert.equal(parseThresholdOverride('90000'), 90000);
assert.equal(parseThresholdOverride('80%'), undefined, 'the absolute parser refuses a percent');
assert.equal(parseThresholdOverride('-1'), undefined);
assert.equal(parseThresholdOverride(''), undefined);
assert.equal(parseThresholdOverride('abc'), undefined);
assert.equal(parseThresholdOverride(undefined), undefined);
assert.equal(parsePercentOverride(80, 256000), 204800);
assert.equal(parsePercentOverride('80%', 256000), 204800);
assert.equal(parsePercentOverride('80', 256000), 204800);
assert.equal(parsePercentOverride(200, 256000), 256000);
assert.equal(parsePercentOverride(-1, 256000), undefined);
assert.equal(parsePercentOverride('', 256000), undefined);
assert.equal(parsePercentOverride(0, 256000), undefined);

// ── retention ─────────────────────────────────────────────────────────────────
assert.equal(resolveRetentionTokens({ thresholdTokens: 217600 }), 20000);
assert.equal(resolveRetentionTokens({ thresholdTokens: 5000 }), 4999, 'retention never blocks compaction');
assert.equal(resolveRetentionTokens({ thresholdTokens: 5000, keepRecentTokens: 100 }), 100);
assert.equal(resolveRetentionTokens({ thresholdTokens: undefined }), 0);

// ── estimate: usage anchors are trusted, local estimates are inflated ─────────
assert.equal(estimatePromptTokens({ totalTokens: 1000, extraTokens: 500, anchored: true }), 1500);
assert.equal(estimatePromptTokens({ totalTokens: 1000, extraTokens: 500, anchored: false }), 1650);
assert.equal(estimatePromptTokens({ totalTokens: 0, extraTokens: 0, anchored: false }), 0);
assert.equal(estimatePromptTokens({ totalTokens: undefined, extraTokens: undefined }), 0);
assert.equal(estimatePromptTokens({ totalTokens: 10000, extraTokens: 0, anchored: false, policy: { estimateMarginDivisor: 5 } }), 12000);

// ── fit: the model's cap is a wish, narrow it only when it would not fit ──────
assert.equal(fitOutputTokens({ contextWindow: 256000, promptTokens: 20000, desiredOutputCap: 256000 }), 235936);
assert.equal(fitOutputTokens({ contextWindow: 256000, promptTokens: 20000, desiredOutputCap: 32768 }), 32768, 'a smaller wish is untouched');
assert.equal(fitOutputTokens({ contextWindow: 256000, promptTokens: 255000, desiredOutputCap: 256000 }), 1024, 'floor keeps the request dispatchable');
assert.equal(fitOutputTokens({ contextWindow: 256000, promptTokens: 300000, desiredOutputCap: 256000 }), 1024);
assert.equal(fitOutputTokens({ contextWindow: 256000, promptTokens: 0, desiredOutputCap: 256000 }), 255936);
assert.equal(fitOutputTokens({ contextWindow: 256000, promptTokens: 20000, desiredOutputCap: 256000, policy: { fitHeadroomTokens: 4096 } }), 231904, "pi 4096 gap is configurable");
assert.equal(fitOutputTokens({ contextWindow: undefined, promptTokens: 0, desiredOutputCap: 1 }), undefined);
assert.equal(fitOutputTokens({ contextWindow: 256000, promptTokens: 0, desiredOutputCap: undefined }), undefined);
assert.equal(fitOutputTokens({ contextWindow: 256000, promptTokens: 1000, desiredOutputCap: 0 }), undefined);

// ── per-agent overrides and the pressure predicate ────────────────────────────
assert.equal(overrideForAgent({ a: '80%' }, 'a'), '80%');
assert.equal(overrideForAgent({ a: '80%' }, 'b'), undefined);
assert.equal(overrideForAgent(undefined, 'a'), undefined);
assert.equal(exceedsThreshold(217600, 217600), true);
assert.equal(exceedsThreshold(217599, 217600), false);
assert.equal(exceedsThreshold(undefined, 217600), false);
assert.equal(exceedsThreshold(100, undefined), false);

// ── defaults are complete and frozen ──────────────────────────────────────────
assert.ok(Object.isFrozen(POLICY_DEFAULTS));
assert.equal(isTokenCount(1), true);
assert.equal(isTokenCount(0), false);
assert.equal(isTokenCount(1.5), false);

console.log(JSON.stringify({
  check: 'policy', window: 256000,
  reserve: resolveReserveTokens(256000),
  threshold: resolveThresholdTokens({ contextWindow: 256000 }),
  fitAt20k: fitOutputTokens({ contextWindow: 256000, promptTokens: 20000, desiredOutputCap: 256000 }),
}));
console.log('policy: reserve/threshold/fit/clamp/override math passed');
