import assert from 'node:assert/strict';
import { MemberBudgets, emptyBudgetState } from './lib/budgets.js';
import { foldCoordination, Coordination } from './lib/coordination.js';
import { FRUGAL_EVENT } from './lib/telemetry.js';
import { load } from './test-runtime.mjs';
const persisted = [];
const state = emptyBudgetState();
const budget = new MemberBudgets({ state, limits: () => ({ maxMembers: 3, maxConcurrent: 2 }), persist: async () => { persisted.push(structuredClone(state)); } });
const token1 = await budget.reserve('subagent', null, 'executor');
assert.equal(persisted.at(-1).reservations.length, 1, 'intent is durable before side effects');
const token2 = await budget.reserve('subagent', null, 'reviewer');
await assert.rejects(budget.reserve('subagent', null, 'observer'), { code: 'CONCURRENCY-LIMIT' });
await budget.accepted(token1, 'a');
await budget.accepted(token2, 'b');
const steering = await budget.reserve('subagent', 'a', 'executor');
assert.equal(steering.slot, false, 'steering an active member does not consume a new slot');
await budget.accepted(steering, 'a');
budget.settle('subagent', 'a', 'stop');
const resume = await budget.reserve('subagent', 'a', 'executor');
assert.equal(resume.slot, true);
await budget.accepted(resume, 'a');
assert.equal(state.members.length, 2, 'three work rounds reuse the same two members');
budget.settle('subagent', 'a', 'stop');
budget.settle('subagent', 'b', 'stop');
const third = await budget.reserve('subagent', null, 'third');
await budget.accepted(third, 'c');
budget.settle('subagent', 'c', 'stop');
await assert.rejects(budget.reserve('subagent', null, 'fourth'), { code: 'MEMBER-LIMIT' });
const failureState = emptyBudgetState();
const failure = new MemberBudgets({ state: failureState, limits: () => ({ maxMembers: 3, maxConcurrent: 2 }), persist: async () => {} });
const failed = await failure.reserve('team', null, 'executor');
await failure.rejected(failed, true);
assert.equal(failureState.reservations.length, 0, 'proven pre-admission failure releases reservation');
const ambiguous = await failure.reserve('team', null, 'executor');
await failure.rejected(ambiguous, false);
assert.equal(failureState.reservations.length, 1, 'lost receipt survives restore and blocks unsafe retry');
const forkEvents = [{ type: FRUGAL_EVENT, data: { version: 1, state: { version: 1, mode: 'team', budget: state, health: null } } }];
assert.equal(foldCoordination(forkEvents, 1).mode, null, 'fork does not inherit parent mode/ledger');
assert.throws(() => foldCoordination([{ type: FRUGAL_EVENT, data: { version: 2 } }]), { code: 'STATE-VERSION' });

const { Context } = await load('cordis/lib/index.js');
const { SessionStore } = await load('dsh-session/lib/index.js');
const { SessionQueryEngine } = await load('dsh-session-query/lib/index.js');
const ctx = new Context();
ctx.logger.level = 0;
await ctx.plugin(SessionStore);
await ctx.plugin(SessionQueryEngine);
ctx.on('session/flush', () => {}); // deterministic in-memory durability sink
let catalogChildren = [];
ctx.reflect.provide('subagents', { listChildren: async () => catalogChildren });
const settings = { defaultCoordinationMode: 'subagent', maxMembers: 3, maxConcurrent: 2 };
const controller = new Coordination({ ctx, settings: () => settings, governs: () => true, reconcile: () => {} });
function actor(id) {
  return { id, session: ctx.sessions.create(id), status: 'idle', inbox: { hasPending: false }, runMaintenance: (job) => job(new AbortController().signal) };
}
const a = actor('mode-a');
const b = actor('mode-b');
ctx.reflect.provide('agentTeams', { spawnTeammate() {}, listMembers: (agent) => [{ id: agent.id, name: 'lead', role: 'lead', status: 'inactive' }], listTasks: () => [] });
await controller.run(a, async () => {});
await controller.run(b, async () => {});
await controller.switchMode(a, 'team');
assert.equal(controller.mode(a), 'team');
assert.equal(controller.mode(b), 'subagent');
settings.defaultCoordinationMode = 'team';
assert.equal(controller.mode(b), 'subagent', 'new defaults do not alter pinned sessions');
const restored = new Coordination({ ctx, settings: () => settings, governs: () => true, reconcile: () => {} });
await restored.run(a, async () => {});
assert.equal(restored.mode(a), 'team', 'mode restored from own log');
a.inbox.hasPending = true;
await assert.rejects(controller.switchMode(a, 'subagent'), /MODE-BUSY/);
a.inbox.hasPending = false;
await controller.run(a, async (entry) => { await entry.budget.reserve('team', null, 'unreceipted'); });
await assert.rejects(controller.switchMode(a, 'subagent'), /派发预留/);
// Persistence failure cannot leave a locally dispatchable reservation.
const rollbackState = emptyBudgetState();
let compensations = 0;
const rollback = new MemberBudgets({ state: rollbackState, limits: () => settings, persist: async () => { throw new Error('flush failed'); }, changed: () => { compensations += 1; } });
await assert.rejects(rollback.reserve('team', null, 'unstarted'), /flush failed/);
assert.equal(rollbackState.reservations.length, 0);
assert.equal(compensations, 1);
const abortState = emptyBudgetState();
const abort = new AbortController();
const abortBudget = new MemberBudgets({ state: abortState, limits: () => settings, persist: async () => abort.abort() });
await assert.rejects(abortBudget.reserve('team', null, 'unstarted', abort.signal), { name: 'AbortError' });
assert.equal(abortState.reservations.length, 0, 'abort after durable intent proves no dispatch occurred');
const checkpointState = emptyBudgetState();
const cp = new MemberBudgets({ state: checkpointState, limits: () => settings, persist: async () => {} });
const cycle = await cp.reserve('subagent', null, 'executor');
await cp.accepted(cycle, 'cp');
const soft = { checkpointSteps: 2, checkpointMinutes: 8 };
assert.equal(cp.checkpoint('cp', soft, cycle.at), false);
const cpRestored = new MemberBudgets({ state: cp.snapshot(), limits: () => settings, persist: async () => {} });
assert.equal(cpRestored.checkpoint('cp', soft, cycle.at), true, 'step count survives restore');
assert.equal(cpRestored.checkpoint('cp', soft, cycle.at), false, 'alert de-duplicates in the same work cycle');
const supplemental = await cpRestored.reserve('subagent', 'cp', 'executor');
await cpRestored.accepted(supplemental, 'cp');
assert.equal(cpRestored.checkpoint('cp', soft, cycle.at), false, 'active steering does not reset checkpoint');
cpRestored.settle('subagent', 'cp', 'completed');
await cpRestored.accepted(await cpRestored.reserve('subagent', 'cp', 'executor'), 'cp');
assert.equal(cpRestored.state.members[0].alerted, false, 'new execution cycle resets alert');
assert.throws(() => foldCoordination([{ type: FRUGAL_EVENT, data: { version: 1, state: { version: 1, mode: 'team', budget: {} } } }]), { code: 'STATE-SHAPE' });
// A mode whose durability commit fails is rolled back in memory and in its newest snapshot.
const c = actor('mode-c');
await controller.run(c, async () => {});
settings.defaultCoordinationMode = 'subagent';
await controller.switchMode(c, 'subagent');
const disposeFailure = ctx.on('session/flush', () => { throw new Error('mode flush failed'); });
await assert.rejects(controller.switchMode(c, 'team'), /mode flush failed/);
assert.equal(controller.mode(c), 'subagent');
disposeFailure();
// --- receipts and slot release on a failed dispatch -------------------------------
// Two tools answer to `subagent`: this bundle reports `agent_id`, the host's
// @deepseek-ai/dsh-tool-subagent reports `subagentId`. Reading only one of them
// made every dispatch look receipt-less AFTER its child was already created.
const { dispatchMemberId, releaseFailedDispatch } = await import('./lib/team.js');
assert.equal(dispatchMemberId({ kind: 'continuable', agent_id: 'own-child' }), 'own-child');
assert.equal(dispatchMemberId({ kind: 'continuable', subagentId: 'host-child' }), 'host-child', "the host's continuable value names the child `subagentId`");
assert.equal(dispatchMemberId({ kind: 'background', jobId: 'job-1' }), undefined, 'a background job names no resumable member');
assert.equal(dispatchMemberId({ kind: 'foreground', runId: 'run-1', output: [] }), undefined, 'a foreground run names no resumable member');
assert.equal(dispatchMemberId({ kind: 'continuable', agent_id: '', subagentId: '' }), undefined, 'an empty id is not a member');
assert.equal(dispatchMemberId(undefined), undefined);

const dispatch = actor('dispatch');
await controller.run(dispatch, async () => {});
await controller.run(dispatch, async (entry) => {
  const nothingCreated = await entry.budget.reserve('subagent', null, 'worker');
  await releaseFailedDispatch(controller, entry, nothingCreated, 'subagent');
  assert.deepEqual(entry.budget.counts('subagent'), { members: 0, active: 0 }, 'a failed dispatch that created nothing returns its slot');
  assert.deepEqual(entry.budget.state.reservations, [], 'and leaves no reservation behind');

  catalogChildren = [{ id: 'child-1', mode: 'continuable', label: 'worker' }];
  const childCreated = await entry.budget.reserve('subagent', null, 'worker');
  await releaseFailedDispatch(controller, entry, childCreated, 'subagent');
  const counts = entry.budget.counts('subagent');
  assert.equal(counts.active, 1, 'the child the failed call really did create still holds exactly one slot');
  assert.equal(counts.members, 1, 'and is recovered as a reusable member rather than lost');
  assert.deepEqual(entry.budget.state.reservations, [], 'a reconciled failure keeps no reservation');

  const third = await entry.budget.reserve('subagent', null, 'worker');
  await releaseFailedDispatch(controller, entry, third, 'subagent');
  assert.deepEqual(entry.budget.state.reservations, [], 'reconciling twice in a row stays clean');
});

console.log('admission: total/concurrency/reuse, durable-before-dispatch, proven rollback and unknown receipts passed');
console.log('coordination: persistent per-session modes, legacy/fork isolation and busy switch refusal passed');
console.log('dispatch failure: both receipt shapes resolve, and a failed dispatch returns its slot');
