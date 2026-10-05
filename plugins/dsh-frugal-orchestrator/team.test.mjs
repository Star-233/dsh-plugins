import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { load } from './test-runtime.mjs';
import { observeEvents } from './lib/telemetry.js';
import { TEAM_TOOLS } from './lib/team.js';
const { Context } = await load('cordis/lib/index.js');
const { ToolRuntime, defineTool } = await load('dsh-tools/lib/index.js');
const { SystemPrompt } = await load('dsh-system-prompt/lib/index.js');
const { createScope, scopeTarget } = await load('dsh-scope/lib/index.js');
const { SessionStore } = await load('dsh-session/lib/index.js');
const { SessionProjectionRegistry } = await load('dsh-session-projection/lib/index.js');
const { SessionQueryEngine } = await load('dsh-session-query/lib/index.js');
const { TokenMeter } = await load('dsh-token-meter/lib/index.js');
const { TeamService } = await load('dsh-experimental-agent-team/lib/index.js');
const { LocalAttachmentStore } = await load('dsh-attachment-local/lib/index.js');
const nativeTools = await load('dsh-experimental-tool-agent-team/lib/index.js');
const { createUserMessage } = await load('dsh-llm/lib/index.js');
const { apply, Config } = await import('./index.js');

/**
 * The REAL attachment service, writing into a temporary `DSH_HOME`.
 *
 * It is loaded before the gate is mounted on purpose: the image bridge is
 * installed per agent (and resolves the live service from the agent scope), so
 * this harness has to look like a host that ships attachments while still not
 * touching the user's own store.
 */
const imagesHome = mkdtempSync(join(tmpdir(), 'frugal-team-images-'));
process.env.DSH_HOME = imagesHome;

/**
 * A real, decodable 1x1 PNG (IHDR + deflate'd IDAT + IEND, real CRCs). The real
 * store decodes the bytes, so a signature-only fixture would be refused.
 */
function png1x1() {
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      let value = (crc ^ byte) & 0xff;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crc = value ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0xff, 0x00, 0x00]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The Lead catalog: the host's own Team surface PLUS the plugin's read half. */
const LEAD_CATALOG = [...TEAM_TOOLS, 'read_delivered_images'].sort();

const ctx = new Context();
ctx.logger.level = 0;
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(SessionStore);
await ctx.plugin(SessionProjectionRegistry);
await ctx.plugin(SessionQueryEngine);
await ctx.plugin(LocalAttachmentStore, { dshHome: imagesHome });
let failFlush = false;
ctx.on('session/flush', () => { if (failFlush) throw new Error('injected flush failure'); });
const live = new Map();
ctx.reflect.provide('agents', { get: (id) => live.get(id), list: () => [...live.values()], roots: () => [...live.values()].filter((a) => !a.session.header.parentSession) });
ctx.reflect.provide('agentPresets', { composedPreset: () => 'frugal' });
ctx.reflect.provide('sessionPersistence', { open: async () => { throw new Error('fixture target not persisted'); } });
ctx.reflect.provide('llm', {
  imageRequestPricing: () => undefined, fileRequestText: () => 'file',
  resolveModelInfo: async () => ({ context: { contextWindow: 256000 }, defaultMaxTokens: 256000 }),
});
await ctx.plugin(TokenMeter);
let command;
ctx.reflect.provide('commands', { register: (value) => { command = value; return () => {}; } });
const presetKey = { id: 'frugal' };
let preset;
await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(runtimeCtx) { preset = createScope(runtimeCtx, presetKey); } });
await preset.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(scoped) {
  for (const name of ['subagent', 'subagent_fork', 'workflow', 'ask_user_question', 'read', 'edit', 'bash', 'skill']) scoped.tools.register(defineTool({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: name }] }, execute: async () => name }));
  scoped.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'fallback Lead persona', complete: true });
} });
const signal = new AbortController().signal;
async function actor(id, parent) {
  const agent = { id, session: ctx.sessions.create(id, { meta: parent ? { parentSession: parent.id, delegationDepth: 1 } : {} }), options: {}, status: 'idle', inbox: { hasPending: false }, runMaintenance: (job) => job(signal) };
  await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(runtimeCtx) { agent.ctx = createScope(runtimeCtx, agent, { parent: presetKey }).ctx; } });
  agent.steer = (message) => agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message], removedCount: 0 });
  live.set(id, agent);
  return agent;
}
const lead = await actor('team-lead');
const epochs = new Map();
const starts = [];
let deliveries = 0;
let queueDelivery = false;
let finishBeforeReceipt = false;
function begin(agent, parent) {
  const runId = `epoch-${agent.id}-${agent.session.seq}`;
  epochs.set(agent.id, runId);
  agent.status = 'running';
  ctx.emit(scopeTarget(ctx.subagents, parent), 'subagent/start', { id: agent.id, provider: 'spawn', local: true, runId });
}
function finish(agent) {
  const turn = agent.session.seq + 1;
  agent.session.append('turn/start', { turn });
  const own = agent.session.snapshotEvents(agent.session.inheritedEventCount);
  const pending = [];
  for (const e of own) if (e.type === 'agent/inbox/spliced' && e.data.target === 'next-turn') pending.splice(e.data.start, e.data.removedCount ?? 0, ...e.data.inserted);
  agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: pending.length, inserted: [] });
  for (const message of pending) agent.session.append('user/message', message, { surfaceOp: 'append' });
  agent.session.append('step/start', { turn, step: 1 });
  agent.session.append('turn/end', { turn, reason: { kind: 'completed' } });
  agent.status = 'idle';
  ctx.emit(scopeTarget(ctx.subagents, lead), 'subagent/end', { id: agent.id, provider: 'spawn', local: true, runId: epochs.get(agent.id), stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'evidence supplied' }] });
}
ctx.reflect.provide('subagents', {
  getProvider: () => ({ prepareContinuable() {} }), list: () => ['spawn', 'fork'],
  listChildren: async (id) => starts.filter((s) => s.request.parent.id === id).map((s) => ({ id: s.childId, mode: 'continuable', label: s.label })),
  async startContinuable(spec) {
    const state = ctx.sessionProjections.snapshot(lead.session).values.frugal.data;
    assert.equal(state.budget.reservations.length, 1, 'intent precedes native roster side effects');
    starts.push(spec);
    const child = await actor(spec.childId, spec.request.parent);
    const message = createUserMessage({ content: spec.request.prompt, source: { kind: 'test-initial' } });
    child.steer(message);
    begin(child, spec.request.parent);
    await ctx.serial('agent/created', { agent: child });
    if (finishBeforeReceipt) finish(child);
    return { childId: child.id, messageId: message.id };
  },
  [Symbol.for('dsh.subagent.deliverPrompt')]: async function(parent, id, content, source) {
    deliveries += 1;
    if (queueDelivery) throw new Error('injected delivery deferral');
    const child = live.get(id);
    const message = createUserMessage({ content, source });
    child.steer(message);
    if (child.status === 'idle') begin(child, parent);
    if (finishBeforeReceipt) finish(child);
    return message.id;
  },
  drainContinuableChildren: async () => {}, interrupt() {},
});
await ctx.plugin(TeamService);
await ctx.plugin(nativeTools, {});
const config = Config({ defaultCoordinationMode: 'team', subagentProvider: 'cheap', subagentModel: 'worker', subagentReasoningEffort: 'high', diagnostics: false });
await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply: (scoped) => apply(scoped, config) });
await ctx.serial('agent/created', { agent: lead });
const assemble = (agent) => ctx.systemPrompt.assemble({ agent, scope: agent });
const names = (assembly) => assembly.tools.map((tool) => tool.name).sort();
const call = (name, args = {}, agent = lead) => ctx.tools.execute({ name, arguments: args, agent, callId: `${name}-${Math.random()}`, signal });
const invoke = (rawInput, agent = lead) => command.handler({ agent, signal, rawInput });
assert.deepEqual(names(await assemble(lead)), LEAD_CATALOG);
assert.ok((await assemble(lead)).sections[0].text.includes('当前会话已经由用户启用 Team 模式'));
const create = (name) => call('spawn_teammate', { name, description: `${name} role`, prompt: 'return verifiable evidence' });
const first = await create('executor');
assert.equal(first.isError, false, JSON.stringify(first));
const executor = live.get(starts[0].childId);
const second = await create('reviewer');
assert.equal(second.isError, false, JSON.stringify(second));
const reviewer = live.get(starts[1].childId);
assert.deepEqual(names(await assemble(lead)), LEAD_CATALOG);
for (const worker of [executor, reviewer]) {
  const assembly = await assemble(worker);
  const text = assembly.sections.map((s) => s.text).join('\n');
  assert.ok(text.includes(`Team 队友 ${worker === executor ? 'executor' : 'reviewer'}`));
  assert.ok(!text.includes('fallback Lead persona'));
  for (const denied of ['subagent', 'subagent_fork', 'workflow', 'spawn_teammate', 'interrupt_agent']) {
    assert.ok(!names(assembly).includes(denied));
    assert.ok(ctx.tools.guardReason({ name: denied, agent: worker }));
  }
  assert.ok(names(assembly).includes('read') && names(assembly).includes('send_message'));
  assert.ok(ctx.tools.get('send_message', worker).parameters.properties.target, 'native Team schema wins over inherited controls');
  const route = await ctx.waterfall('agent/request', { agent: worker, signal }, async () => ({ provider: 'expensive', model: 'lead', reasoningEffort: 'medium', maxTokens: 256000 }));
  assert.deepEqual(route, { provider: 'cheap', model: 'worker', reasoningEffort: 'high', maxTokens: 256000 }, 'the seeded cap is carried through, not forced');
}
const tooManyActive = await create('third');
assert.equal(tooManyActive.error.info.code, 'CONCURRENCY-LIMIT');
assert.equal(starts.length, 2, 'native side effect not invoked when concurrency is full');
const duplicate = await create('executor');
assert.equal(duplicate.error.info.code, 'MEMBER-EXISTS');
assert.equal(starts.length, 2);
assert.equal((await invoke('mode subagent')).kind, 'error');
finish(executor); finish(reviewer);
finishBeforeReceipt = true;
const quick = await call('send_message', { target: 'executor', message: 'second round' });
assert.equal(quick.value.status, 'accepted');
assert.equal(starts.length, 2);
const status = JSON.parse((await invoke('status')).text);
assert.equal(status.budget.members.find((m) => m.id === executor.id).status, 'settled', 'end-before-receipt settles the carrying epoch');
finishBeforeReceipt = false;
queueDelivery = true;
const queued = await call('send_message', { target: 'executor', message: 'third round' });
assert.equal(queued.value.status, 'queued');
assert.equal((await invoke('mode subagent')).kind, 'error', 'queued receipt blocks a mode switch');
const state = ctx.sessionProjections.snapshot(lead.session).values.frugal.data;
assert.equal(state.budget.members.length, 2);
assert.equal(state.budget.counters.created, 2);
assert.equal(state.budget.counters.continued, 2);
assert.ok(deliveries >= 2);
// The native task board continues to own revisions, dependencies and write scopes.
const task = await call('team_task_create', { subject: 'verify', description: 'proof required', write_scopes: ['src/'] });
assert.equal(task.isError, false, JSON.stringify(task));
const claim = await call('team_task_update', { task_id: task.value.id, expected_revision: task.value.revision, action: 'claim' }, reviewer);
assert.equal(claim.isError, false, JSON.stringify(claim));
const stale = await call('team_task_update', { task_id: task.value.id, expected_revision: task.value.revision, action: 'complete' }, reviewer);
assert.equal(stale.isError, true, 'stale CAS is still refused by the native board');
const done = await call('team_task_update', { task_id: task.value.id, expected_revision: claim.value.revision, action: 'complete' }, reviewer);
assert.equal(done.isError, false);
const waited = await call('wait_agent', { timeout_ms: 10000 });
assert.equal(waited.value.noProgress.reason, 'no-active-peer', 'native wait never wakes idle teammates');
const ownEvents = (await observeEvents(ctx.sessionQuery, lead.session)).events;
assert.ok(ownEvents.some((e) => e.type === 'team/message/queued' && e.data.message.id === queued.value.messageId));
assert.ok(ownEvents.some((e) => e.type === 'team/message/delivered' && e.data.messageId === quick.value.messageId));
assert.ok(ctx.sessionProjections.snapshot(lead.session).values.frugal.telemetry);
// Restored Team root pins its mode before the first assembly even if new defaults changed.
config.defaultCoordinationMode = 'subagent';
const restoredLead = await actor('restored-team-lead');
restoredLead.session.append('frugal/state', { version: 1, state: { version: 1, mode: 'team', enabled: true, budget: { members: [], reservations: [], counters: { created: 0, continued: 0, rejected: 0 } }, health: null, warning: null } });
await ctx.serial('agent/created', { agent: restoredLead });
const restoredAssembly = await assemble(restoredLead);
assert.deepEqual(names(restoredAssembly), LEAD_CATALOG);
assert.ok(restoredAssembly.sections[0].text.includes('当前会话已经由用户启用 Team 模式'));
const restoredRoute = await ctx.waterfall('agent/request', { agent: restoredLead, signal }, async () => ({ provider: 'expensive', model: 'lead', reasoningEffort: 'high', maxTokens: 256000 }));
assert.deepEqual(restoredRoute, { provider: 'expensive', model: 'lead', reasoningEffort: 'high', maxTokens: 256000 });
assert.equal(ctx.sessionProjections.snapshot(restoredLead.session).values.frugal.data.health, null, 'the context-budget health panel moved to @nu11dev/dsh-compaction-policy');

// ── The live minimum wait, enforced on the HOST's own `wait_agent` ──────────
// `minWaitTimeoutMs` is volatile, so the real write goes through the same
// symbol-based writer the Loader uses, followed by `loader/volatile-update`.
{
  const { waitAgentGuardReason, teamWaitContract } = await import('./lib/team.js');
  // The real ref is keyed by `Symbol.for(...)`, not a locally created symbol:
  // the Loader and the ref have to agree across module instances.
  const WRITE = Symbol.for('cosmokit.volatile.write');
  const leadSection = async () => (await assemble(lead)).sections[0].text;

  assert.equal(teamWaitContract({ minMs: 0 }), '', 'no minimum adds no paragraph');
  assert.ok(teamWaitContract({ minMs: 300000 }).includes('timeout_ms: 300000'), 'the recommended call is spelled out');
  assert.ok(teamWaitContract({ minMs: 300000 }).includes('10000'), 'the host floor stays visible');
  assert.equal(waitAgentGuardReason({ name: 'send_message', arguments: {} }, { minMs: 300000 }), undefined, 'other tools pass');
  assert.equal(waitAgentGuardReason({ name: 'wait_agent', arguments: { timeout_ms: 300000 } }, { minMs: 300000 }), undefined, 'at the minimum is allowed');
  assert.equal(waitAgentGuardReason({ name: 'wait_agent', arguments: { timeout_ms: 10000 } }, { minMs: 0 }), undefined, 'no minimum never denies');

  const before = await leadSection();
  assert.ok(!before.includes('最低等待'), 'with a blank field the Lead prompt says nothing about a minimum');
  const loose = await call('wait_agent', { timeout_ms: 10000 });
  assert.equal(loose.isError, false, 'and the host floor 10000 is still accepted');

  config.minWaitTimeoutMs[WRITE]('300000');
  ctx.emit('loader/volatile-update', [['minWaitTimeoutMs']]);
  const withMin = await leadSection();
  assert.ok(withMin.includes('最低等待：300000 ms'), 'the Lead prompt now states the live minimum');
  assert.ok(withMin.includes('timeout_ms: 300000'), 'and the value to pass');
  assert.ok(names(await assemble(lead)).includes('wait_agent'), 'the guarded tool is still the host one');

  const denied = await call('wait_agent', { timeout_ms: 10000 });
  assert.equal(denied.isError, true, 'a wait below the configured minimum is refused');
  assert.ok(JSON.stringify(denied).includes('FRUGAL-WAIT-MIN'), JSON.stringify(denied));
  assert.ok(JSON.stringify(denied).includes('300000'), 'the refusal names the value to pass');
  const omitted = await call('wait_agent', {});
  assert.equal(omitted.isError, true, 'omitting timeout_ms would use the host default 30000, so it is refused too');
  const atMin = await call('wait_agent', { timeout_ms: 300000 });
  assert.equal(atMin.isError, false, 'the minimum itself is accepted');
  assert.equal(atMin.value.noProgress.reason, 'no-active-peer', 'the minimum is a deadline, not a forced sleep: noProgress is immediate');
  const unrelated = await call('list_agents', {});
  assert.equal(unrelated.isError, false, 'only wait_agent is constrained');

  config.minWaitTimeoutMs[WRITE]('');
  ctx.emit('loader/volatile-update', [['minWaitTimeoutMs']]);
  const cleared = await call('wait_agent', { timeout_ms: 10000 });
  assert.equal(cleared.isError, false, 'clearing the field drops the plugin lower bound again');
  assert.ok(!(await leadSection()).includes('最低等待'), 'and the paragraph goes with it');

  // A typo must not become a silent bound: reported, and the tool keeps working.
  config.minWaitTimeoutMs[WRITE]('abc');
  ctx.emit('loader/volatile-update', [['minWaitTimeoutMs']]);
  assert.equal((await call('wait_agent', { timeout_ms: 10000 })).isError, false, 'an invalid value leaves no lower bound');
  assert.ok(!(await leadSection()).includes('最低等待'));
  config.minWaitTimeoutMs[WRITE]('');
  ctx.emit('loader/volatile-update', [['minWaitTimeoutMs']]);
}
// ── The image bridge over the REAL native roster ────────────────────────────
// The subagent-mode case lives in images-local.test.mjs; this one has to prove
// the Team half: a teammate is depth 0 yet must deliver, and the Lead's `target`
// is a ROSTER entry whose id has to be the same identity the teammate recorded
// itself under (its session id). A tracker, or mixing agent id with roster id,
// would answer `undefined` here.
{
  const shot = join(imagesHome, 'team-shot.png');
  const bytes = png1x1();
  writeFileSync(shot, bytes);

  const teammate = executor;
  const delivered = await call('deliver_images', { paths: [shot], note: 'Team 截图' }, teammate);
  assert.notEqual(delivered.isError, true, JSON.stringify(delivered));
  assert.equal(delivered.value.count, 1, JSON.stringify(delivered));
  assert.equal(delivered.value.child, teammate.session.id, 'the teammate records its own session id');
  assert.equal(delivered.value.delivered[0].media_type, 'image/png');
  assert.equal(delivered.value.delivered[0].bytes, bytes.length);
  assert.match(String(delivered.value.delivered[0].image_id ?? delivered.value.delivered[0].ref?.attachmentId), /^sha256:/);

  // The Lead resolves the roster by NAME and by the roster member's ID; both
  // have to land on the record the teammate wrote.
  const byName = await call('read_delivered_images', { target: 'executor' });
  assert.notEqual(byName.isError, true, JSON.stringify(byName));
  const named = (byName.content ?? []).filter((item) => item.type === 'image');
  assert.equal(named.length, 1, `the Lead gets the teammate image as a native image block: ${JSON.stringify(byName)}`);
  assert.equal(named[0].attachment.bytes, bytes.length);
  assert.equal(named[0].attachment.mediaType, 'image/png');

  const byId = await call('read_delivered_images', { target: teammate.id, include_read: true });
  assert.notEqual(byId.isError, true, `the roster id must resolve to the same child: ${JSON.stringify(byId)}`);
  assert.equal((byId.content ?? []).filter((item) => item.type === 'image').length, 1,
    'the roster member id and the recorded child session id are the same identity');
  const reread = await call('read_delivered_images', { target: 'executor' });
  assert.equal((reread.content ?? []).filter((item) => item.type === 'image').length, 0, 'and it is not re-injected by default');

  // Roles are not interchangeable in Team mode either.
  assert.equal((await call('deliver_images', { paths: [shot] })).isError, true, 'the Lead has no delivery tool');
  assert.equal((await call('read_delivered_images', { target: 'executor' }, teammate)).isError, true,
    'a teammate cannot read deliveries back');

  // A foreign Lead cannot see another roster's child, by name or otherwise.
  const foreign = await call('read_delivered_images', { target: 'executor' }, restoredLead);
  assert.equal(foreign.isError, true, `a foreign Lead cannot read another roster child: ${JSON.stringify(foreign)}`);
  assert.match(JSON.stringify(foreign), /IMAGE-NOT-A-DIRECT-CHILD/);
  assert.equal((await call('read_delivered_images', { target: 'nobody' })).isError, true, 'an unknown roster name is refused');

  // The record stays metadata-only and keyed by (parent session, child session).
  const storeDir = join(imagesHome, 'frugal-orchestrator', 'image-deliveries');
  const files = readdirSync(storeDir);
  assert.equal(files.length, 1, JSON.stringify(files));
  const raw = readFileSync(join(storeDir, files[0]), 'utf8');
  const record = JSON.parse(raw);
  assert.equal(record.parent, lead.session.id, 'the parent is the Lead SESSION id, not a roster label');
  assert.equal(record.child, teammate.session.id, 'the child is the durable session id the teammate reported');
  assert.ok(!/base64/.test(raw) && !raw.includes(bytes.toString('base64').slice(0, 24)), 'no image bytes on disk');
}

console.log('native Team runtime/tools + real scope: Lead/worker catalogs, persona/route, durable admission, reuse, quick settlement, queued receipt, task CAS, restore-first-request, wait, the live wait minimum, and the image bridge over the real roster (teammate delivers, Lead reads by name and by roster id, foreign Lead refused, metadata-only records) passed');
