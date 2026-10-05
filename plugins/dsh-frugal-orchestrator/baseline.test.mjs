import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { replayTelemetry, unionMilliseconds } from './lib/telemetry.js';

assert.equal(unionMilliseconds([[0, 10], [5, 15], [20, 24]]), 19);
assert.equal(replayTelemetry([]).lastCompaction, null);
assert.equal(replayTelemetry([]).modelMs, null);

// ── Always-on: a synthetic session that carries the same contract ───────────
// The counts below are what `replayTelemetry` must keep reporting, expressed in
// COMMITTED events instead of one machine's private export: 24 delegations,
// 17 one-shot + 7 continuable catalog entries, no continuation, no compaction.
// A clean checkout (and therefore CI) can always run this part.
let clock = 1_700_000_000_000;
const at = () => (clock += 1_000);

/** One delegation: its catalog entry, the `subagent` call and the tool result. */
function delegation(index, mode, { continued = false } = {}) {
  const arguments_ = continued
    ? { agent_id: `child-${index}`, prompt: 'carry on' }
    : { prompt: `task ${index}` };
  return [
    { type: 'subagent/catalog', data: { mode }, time: at() },
    { type: 'tool/call', data: { callId: `call-${index}`, name: 'subagent', arguments: arguments_ }, time: at() },
    { type: 'tool/result', data: { message: { toolCallId: `call-${index}` } }, time: at() },
  ];
}

const synthetic = [
  ...Array.from({ length: 17 }, (_, index) => delegation(index, 'one-shot')).flat(),
  ...Array.from({ length: 7 }, (_, index) => delegation(100 + index, 'continuable')).flat(),
];
{
  const telemetry = replayTelemetry(synthetic);
  assert.equal(telemetry.created, 24, 'every call without agent_id is a create');
  assert.equal(telemetry.continued, 0, 'a call without agent_id is never a continuation');
  const catalog = synthetic.filter((event) => event.type === 'subagent/catalog');
  assert.equal(catalog.filter((event) => event.data.mode === 'one-shot').length, 17);
  assert.equal(catalog.filter((event) => event.data.mode === 'continuable').length, 7);
  assert.equal(telemetry.lastCompaction, null, 'no compaction event stays null — never an inferred success');
  assert.equal(telemetry.lastPrune, null);
  assert.ok(telemetry.wallMs > 0, 'the synthetic session spans real time');
  console.log('baseline replay: synthetic session — 24 creates, 0 follow-ups, 17 one-shot, 7 continuable, no compaction/prune');
}

// The other half of the contract: a continuation and a real compaction/prune
// must be OBSERVED, so the "no compaction" assertion above cannot pass by
// accident (a parser that drops everything would fail here).
{
  const telemetry = replayTelemetry([
    ...delegation(1, 'continuable', { continued: true }),
    { type: 'compaction/end', data: { reason: 'threshold' }, time: at() },
    { type: 'compaction/prune', data: {}, time: at() },
  ]);
  assert.equal(telemetry.created, 0, 'a call WITH agent_id is a continuation, not a create');
  assert.equal(telemetry.continued, 1);
  assert.equal(telemetry.lastCompaction?.reason, 'threshold');
  assert.equal(telemetry.lastPrune?.type, 'compaction/prune');
  console.log('baseline replay: synthetic continuation + compaction/prune observed');
}

// ── Optional: the author's real export, only when this checkout has it ──────
// `analysis/` is deliberately gitignored (it holds real session content), so a
// clean clone never has this file. The synthetic replay above is the part that
// has to hold everywhere; this run is the stricter, local-only evidence.
const privateExport = new URL('../../analysis/session-45218d47/session.v4.jsonl', import.meta.url);
if (existsSync(privateExport)) {
  const events = readFileSync(privateExport, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const telemetry = replayTelemetry(events);
  assert.equal(telemetry.created, 24);
  assert.equal(telemetry.continued, 0);
  const catalog = events.filter((event) => event.type === 'subagent/catalog');
  assert.equal(catalog.filter((event) => event.data.mode === 'one-shot').length, 17);
  assert.equal(catalog.filter((event) => event.data.mode === 'continuable').length, 7);
  assert.equal(telemetry.lastCompaction, null);
  assert.equal(telemetry.lastPrune, null);
  console.log(`baseline replay: ran-local on the private export (${events.length} events)`);
} else {
  console.log(`baseline replay: skipped-local — no private export at ${privateExport.pathname}; the synthetic replay above is authoritative`);
}
console.log('the context-budget arithmetic now lives in @nu11dev/dsh-compaction-policy (policy.test.mjs)');
