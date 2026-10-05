import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayTelemetry, unionMilliseconds } from './lib/telemetry.js';

assert.equal(unionMilliseconds([[0, 10], [5, 15], [20, 24]]), 19);
assert.equal(replayTelemetry([]).lastCompaction, null);
assert.equal(replayTelemetry([]).modelMs, null);
const original = new URL('../../analysis/session-45218d47/session.v4.jsonl', import.meta.url);
const events = readFileSync(original, 'utf8').trim().split('\n').map((s) => JSON.parse(s));
const telemetry = replayTelemetry(events);
assert.equal(telemetry.created, 24);
assert.equal(telemetry.continued, 0);
const catalog = events.filter((e) => e.type === 'subagent/catalog');
assert.equal(catalog.filter((e) => e.data.mode === 'one-shot').length, 17);
assert.equal(catalog.filter((e) => e.data.mode === 'continuable').length, 7);
assert.equal(telemetry.lastCompaction, null);
assert.equal(telemetry.lastPrune, null);
console.log('baseline replay: 24 creates, 0 follow-ups, 17 one-shot, 7 continuable, no compaction/prune');
console.log('the context-budget arithmetic now lives in @nu11dev/dsh-compaction-policy (policy.test.mjs)');
