// Offline harness for the gate's DELEGATION surface
// (plugins/dsh-frugal-orchestrator/lib/delegation.js, wired through index.js).
//
// What is REAL here:
//   @deepseek-ai/cordis         — Context, effect-scoped registration, dispatch
//   @deepseek-ai/dsh-scope      — createScope + scopeTarget, so every lifecycle
//                                 event is dispatched through the SAME
//                                 scope-filtered carrier the subagent seam uses
//                                 (`createLifecycleEmitter(ctx, parent =>
//                                 scopeTarget(this, parent))`)
//   @deepseek-ai/dsh-tools      — the real ToolRuntime: registration into the
//                                 agent's own layer, argument validation, the
//                                 guard pipeline, and `execute()`
//
// What is FAKE: the `ctx.subagents` service. The real SubagentRuntime cannot be
// constructed without the live agent/agent-persistence/session-query stack, so
// this harness reproduces its published contract instead: `getProvider`,
// `startContinuable` ({ childId, messageId }), `sendMessage`, `listChildren`,
// and the `subagent/start` | `subagent/end` payloads (a fresh `runId` per
// residency epoch, emitted before the creating call resolves, exactly as
// `createActivationObserver` does). Error codes come from the documented
// vocabulary (`NOT_RESUMABLE`, `UNAUTHORIZED`, `PERSISTENCE_UNAVAILABLE`).
//
// It never talks to a model, a live dsh process, or the user's profile.
//
//   node delegation.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Point DSH_PROFILE_DIR at a profile whose node_modules holds schemastery. */
function ensureProfileDir() {
  const configured = process.env.DSH_PROFILE_DIR;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  const root = join(homedir(), '.dsh', 'profiles');
  if (!existsSync(root)) throw new Error(`no dsh profiles under ${root}; set DSH_PROFILE_DIR`);
  for (const entry of readdirSync(root)) {
    const candidate = join(root, entry);
    if (existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'schemastery'))) {
      process.env.DSH_PROFILE_DIR = candidate;
      return candidate;
    }
  }
  throw new Error(`no profile under ${root} has @deepseek-ai/schemastery; set DSH_PROFILE_DIR`);
}

/** Locate the `@deepseek-ai` directory that ships the dsh runtime packages. */
function findDshPackages(profileDir) {
  const candidates = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0) candidates.push(value);
  };
  for (const dir of (process.env.PATH ?? '').split(delimiter)) push(join(dir, 'node_modules', '@deepseek-ai'));
  push(process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai'));
  push(join(dirname(dirname(process.execPath)), 'lib', 'node_modules', '@deepseek-ai'));
  push(join(profileDir, 'node_modules', '@deepseek-ai'));
  for (const base of candidates) {
    const nested = join(base, 'dsh', 'node_modules', '@deepseek-ai');
    if (existsSync(join(nested, 'dsh-tools', 'lib', 'index.js'))) return nested;
  }
  throw new Error('cannot locate @deepseek-ai/dsh-tools; set DSH_TOOLS_DIR or run this where dsh is installed');
}

const profileDir = ensureProfileDir();
const packages = process.env.DSH_TOOLS_DIR ?? findDshPackages(profileDir);
/** Import one runtime module by path inside the install. */
const load = (relative) => import(pathToFileURL(join(packages, relative)).href);

// The gate's diagnostic log is its documented observable surface.
const logHome = mkdtempSync(join(tmpdir(), 'frugal-gate-delegation-'));
process.env.DSH_HOME = logHome;

const { Context } = await load('cordis/lib/index.js');
const { ToolRuntime, defineTool } = await load('dsh-tools/lib/index.js');
const { SystemPrompt } = await load('dsh-system-prompt/lib/index.js');
const { createScope, scopeTarget } = await load('dsh-scope/lib/index.js');
const { apply: applyGate, Config } = await import('./index.js');

const SCHEMA = Config({});
/** @returns the plain default behind a possibly-volatile schema field. */
function schemaDefault(key) {
  let value = SCHEMA[key];
  for (let step = 0; step < 4 && value !== null && typeof value === 'object' && typeof value.get === 'function'; step += 1) value = value.get();
  return value;
}

const WRITE = Symbol('cosmokit.volatile.write');
/** @returns a frozen reference whose value only its writer changes. */
function volatileRef(value) {
  let current = value;
  return Object.freeze({ get: () => current, [WRITE]: (next) => { current = next; } });
}
/** Build the row config the settings document would hand `apply`. */
function liveConfig(overrides = {}) {
  const plain = {
    presetId: 'frugal',
    orchestratorTools: schemaDefault('orchestratorTools'),
    orchestratorSystemPrompt: schemaDefault('orchestratorSystemPrompt'),
    includeGlobalAgentsMd: false,
    includeProjectAgentsMd: true,
    includeSkills: false,
    includeRuntimeContext: false,
    // A PROFILE-level route (the shipped default is empty = inherit).
    subagentProvider: 'fixture-provider',
    subagentModel: 'fixture/model-1',
    subagentReasoningEffort: 'low',
    orchestratorProvider: '',
    orchestratorModel: '',
    orchestratorReasoningEffort: '',
    diagnostics: true,
    ...overrides,
  };
  const config = {};
  const refs = {};
  for (const [key, value] of Object.entries(plain)) {
    refs[key] = volatileRef(value);
    config[key] = refs[key];
  }
  return { config, refs };
}

/** One registered tool, minimal but valid for the real ToolRuntime. */
const presetTool = (name) => defineTool({
  name,
  description: `tool ${name}`,
  parameters: {},
  output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: name }] },
  execute: async () => name,
});

/** Register tools in a context's OWN layer, the way a tool plugin does. */
async function register(ctx, ...names) {
  await ctx.plugin({
    name: `register-${names.join('-')}`,
    inject: ['tools'],
    apply(toolCtx) {
      for (const name of names) toolCtx.tools.register(presetTool(name));
    },
  });
}

/**
 * The fake `ctx.subagents` service.
 *
 * `emit` publishes one lifecycle edge through the REAL scope carrier for the
 * given delegating parent, exactly like `createLifecycleEmitter`.
 * @param emit - `(name, info, parentKey) => void`.
 * @returns the service plus its knobs and the calls it recorded.
 */
function fakeSubagents() {
  /** Filled in by `mount()`: routes an edge through the real scope carrier. */
  const hub = { emit: () => {} };
  let runs = 0;
  let messages = 0;
  const state = {
    created: [],
    sent: [],
    interrupts: [],
    catalogReads: [],
    catalog: [],
    catalogFailure: undefined,
    /** Set to a factory to control one sendMessage call. */
    sendGate: undefined,
    /**
     * Called inside `sendMessage` AFTER the resume opened its epoch and BEFORE
     * the call resolves: the window in which `materialize()` (start) and even a
     * whole fast epoch (end) happen while the delivery is still in flight.
     */
    sendHook: undefined,
    /** Set to a value/function to make sendMessage reject. */
    sendFailure: undefined,
    /** The epoch currently open per child, as the real observer would track it. */
    epochs: new Map(),
  };
  const provider = {
    name: 'spawn',
    capabilities: {
      agentOptions: true, outputSchema: false, depthLimit: true, toolFilter: true, persona: true,
    },
    inheritsParentContext: false,
    async prepareContinuable() {
      return {};
    },
    async start() {
      throw new Error('the gate must never use the one-shot start path');
    },
  };
  const openEpoch = (parent, childId) => {
    runs += 1;
    const runId = `run-${runs}`;
    state.epochs.set(childId, runId);
    hub.emit('subagent/start', { runId, provider: 'spawn', id: childId, local: true }, parent);
    return runId;
  };
  const service = {
    getProvider: (name) => (name === 'spawn' ? provider : undefined),
    list: () => ['spawn'],
    resolveMaxDepth: (configured) => (configured === undefined ? 1 : configured),
    async startContinuable(spec) {
      state.created.push(spec);
      const childId = spec.childId ?? `child-${state.created.length}`;
      // The real manager materializes the child (and publishes the epoch's start
      // edge) BEFORE `startContinuable` resolves with the ids.
      openEpoch(spec.request.parent, childId);
      messages += 1;
      return { childId, messageId: `msg-${messages}` };
    },
    async sendMessage(sender, targetId, content, options) {
      const record = { sender, targetId, content, options };
      state.sent.push(record);
      if (state.sendGate !== undefined) await state.sendGate(record);
      if (state.sendFailure !== undefined) {
        const failure = typeof state.sendFailure === 'function' ? state.sendFailure(record) : state.sendFailure;
        if (failure !== undefined) throw failure;
      }
      const live = state.epochs.has(targetId);
      if (!live) openEpoch(sender, targetId);
      if (state.sendHook !== undefined) await state.sendHook(record);
      messages += 1;
      record.messageId = `msg-${messages}`;
      return record.messageId;
    },
    async listChildren(parentSessionId) {
      state.catalogReads.push(parentSessionId);
      if (state.catalogFailure !== undefined) throw state.catalogFailure;
      return state.catalog;
    },
    interrupt(...args) {
      state.interrupts.push(args);
    },
  };
  return { service, provider, state, openEpoch, hub };
}

/**
 * Mount one governed agent on the real stack.
 * @param options - `{ config, subagents, extraAgents, preset }`.
 * @returns the harness handles.
 */
async function mount(options) {
  const root = new Context();
  root.logger.level = 4;
  await root.plugin(SystemPrompt, {});
  await root.plugin(ToolRuntime, {});
  const { SessionStore } = await load('dsh-session/lib/index.js');
  const { SessionQueryEngine } = await load('dsh-session-query/lib/index.js');
  await root.plugin(SessionStore);
  await root.plugin(SessionQueryEngine);
  root.on('session/flush', () => {});

  root.reflect.provide('agentPresets', { composedPreset: () => options.preset ?? 'frugal' });
  const living = new Set();
  root.reflect.provide('agents', {
    get: (id) => [...living].find((agent) => agent.session.id === id),
    list: () => [...living],
    roots: () => [...living].filter((agent) => (agent.session?.header?.delegationDepth ?? 0) === 0),
  });
  root.reflect.provide('subagents', options.subagents.service);
  if (options.llm !== undefined) root.reflect.provide('llm', options.llm);

  const presetKey = { kind: 'preset', id: options.preset ?? 'frugal' };
  const orchestrator = { id: 'orchestrator', session: root.sessions.create('s-root'), options: {} };
  const child = { id: 'child', session: root.sessions.create('s-child', { meta: { delegationDepth: 1 } }), options: {} };
  let presetScope;
  let agentScope;
  let childScope;
  await root.plugin({
    name: 'agent-runtime',
    inject: ['tools', 'systemPrompt'],
    apply(runtimeCtx) {
      presetScope = createScope(runtimeCtx, presetKey);
      agentScope = createScope(runtimeCtx, orchestrator, { parent: presetKey });
      childScope = createScope(runtimeCtx, child, { parent: presetKey });
    },
  });
  orchestrator.ctx = agentScope.ctx;
  child.ctx = childScope.ctx;

  // The preset's own delegation row + the ask tool: the inherited names a
  // restriction may name (and the names this gate's own layer shadows).
  await register(presetScope.ctx, 'subagent', 'ask_user_question');
  await register(agentScope.ctx, ...(options.ownLayer ?? ['spawn_teammate']));
  await register(childScope.ctx, 'structured_output');

  await root.plugin({
    name: 'frugal-gate',
    inject: ['tools', 'systemPrompt'],
    apply: (ctx) => applyGate(ctx, options.config),
  });
  living.add(orchestrator);
  living.add(child);
  await root.serial('agent/created', { agent: orchestrator });
  await root.serial('agent/created', { agent: child });

  const registry = root.get('tools');
  let callSeq = 0;
  const call = (name, args, agent = orchestrator) => registry.execute({
    name,
    callId: `${name}-${callSeq += 1}`,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  });
  const callWith = (name, args, signal, agent = orchestrator) => registry.execute({
    name, callId: `${name}-${callSeq += 1}`, arguments: args, agent, signal,
  });
  const names = async (agent) => (await root.systemPrompt.assemble({ agent, scope: agent })).tools.map((entry) => entry.name).sort();
  // Both the harness and the fake service publish through the SAME carrier the
  // real `createLifecycleEmitter` uses for a delegating parent.
  const emitLifecycle = (name, info, parent) => {
    root.emit(scopeTarget(options.subagents.service, parent), name, info);
    // A settled epoch releases the child, exactly as `watchSettlement` does: the
    // next delivery to that child therefore cold-resumes into a NEW epoch.
    if (name === 'subagent/end' && options.subagents.state.epochs.get(info?.id) === info?.runId) {
      options.subagents.state.epochs.delete(info.id);
    }
  };
  options.subagents.hub.emit = emitLifecycle;
  return {
    root, registry, orchestrator, child, agentScope, childScope, call, callWith, names, emitLifecycle, living,
  };
}

/** The rendered text of one tool result. */
const textOf = (result) => result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');

const ORCHESTRATOR_TOOLS = ['ask_user_question', 'subagent', 'wait_subagent'];

// ── The catalog: three tools, registered into the agent's own layer ─────────
{
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents });
  assert.deepEqual(await h.names(h.orchestrator), ORCHESTRATOR_TOOLS, 'the orchestrator sees exactly three tools');
  assert.deepEqual(await h.names(h.child), ['ask_user_question', 'structured_output'],
    'a child keeps execution tools and cannot delegate again');

  const waitDefinition = h.registry.get('wait_subagent', h.orchestrator);
  assert.ok(waitDefinition.description.includes('wait_agent'), 'the wait tool says it is not the Agent Teams wait_agent');
  assert.deepEqual(waitDefinition.parameters.required, ['agent_ids']);
  assert.equal(waitDefinition.parameters.properties.agent_ids.type, 'array');
  const subagentDefinition = h.registry.get('subagent', h.orchestrator);
  assert.deepEqual(subagentDefinition.parameters.required, ['prompt']);
  assert.ok(subagentDefinition.description.includes('agent_id'), 'the create tool documents continuation by agent_id');
  console.log('  catalog: orchestrator = three own-layer tools; child untouched');
}

// ── Creation goes through startContinuable(spawn) and returns immediately ───
{
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents });
  const result = await h.call('subagent', { prompt: 'audit the parser\nsecond line' });
  assert.equal(result.isError, false, textOf(result));
  assert.equal(result.value.kind, 'continuable');
  assert.equal(result.value.agent_id, 'child-1');
  assert.equal(result.value.message_id, 'msg-1');
  assert.equal(result.value.accepted, true);
  assert.equal(result.value.continued, false);

  const [spec] = subagents.state.created;
  assert.equal(spec.provider, 'spawn', 'the real spawn provider is fixed');
  assert.equal(spec.label, 'audit the parser', 'a missing description defaults to the prompt first line');
  assert.equal(spec.request.parent, h.orchestrator);
  assert.equal(spec.request.maxDepth, 1, 'the frugal delegation budget is kept');
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: 'audit the parser\nsecond line' }]);
  assert.deepEqual(spec.request.agentOptions, {
    provider: 'fixture-provider', model: 'fixture/model-1', reasoningEffort: 'low',
  }, 'the live child route from Config is passed through');
  assert.ok(spec.request.persona.includes('子 agent'), 'the child persona is passed (the preset persona is complete: true)');
  assert.equal(spec.request.toolFilter, undefined);
  assert.ok(spec.signal instanceof AbortSignal, 'the call signal owns pre-acceptance work');

  const text = textOf(result);
  assert.ok(text.includes('subagent({ agent_id: "child-1", prompt:'), `the render teaches continuation: ${text}`);
  assert.ok(text.includes('wait_subagent({ agent_ids: ["child-1"] })'), 'the render teaches waiting');
  assert.ok(!/use send_message to/i.test(text), 'the render never sends the parent to send_message');
  console.log('  create: startContinuable(spawn) + id/message_id, continuation guidance in the render');
}

// ── An explicit description wins; a follow-up continues the SAME child ──────
{
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents });
  await h.call('subagent', { prompt: 'x', description: '  short label  ' });
  assert.equal(subagents.state.created[0].label, 'short label');

  const again = await h.call('subagent', { agent_id: 'child-1', prompt: 'now also check the lexer' });
  assert.equal(again.isError, false, textOf(again));
  assert.equal(again.value.continued, true);
  assert.equal(again.value.agent_id, 'child-1');
  assert.equal(subagents.state.created.length, 1, 'continuing never creates a second child');
  assert.equal(subagents.state.sent.length, 1);
  const [sent] = subagents.state.sent;
  assert.equal(sent.targetId, 'child-1');
  assert.deepEqual(sent.content, [{ type: 'text', text: 'now also check the lexer' }]);
  assert.equal(sent.sender, h.orchestrator, 'the live parent is the sender the service authorizes');
  assert.ok(textOf(again).includes('continued subagent child-1'));
  console.log('  continue: sendMessage to the same id, no second child');
}

// ── `run_in_background: false` is refused BEFORE any side effect ────────────
{
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents });
  const result = await h.call('subagent', { prompt: 'x', run_in_background: false });
  assert.equal(result.isError, true, 'a foreground delegation is refused');
  assert.ok(textOf(result).includes('wait_subagent'), `the refusal names the wait tool: ${textOf(result)}`);
  assert.equal(subagents.state.created.length, 0, 'nothing was created before the refusal');
  const continued = await h.call('subagent', { agent_id: 'child-1', prompt: 'x', run_in_background: false });
  assert.equal(continued.isError, true, 'the refusal also covers a follow-up');
  assert.equal(subagents.state.sent.length, 0, 'and no message was delivered');
  console.log('  refuse: run_in_background:false → parameter error, zero side effects');
}

// ── Service failures keep their code and never become a new child ───────────
{
  const subagents = fakeSubagents();
  subagents.state.catalog = [{ id: 'child-9', mode: 'one-shot', label: 'legacy' }];
  subagents.state.sendFailure = Object.assign(new Error('subagent "child-9" has no supported continuation state'), {
    name: 'SubagentError', code: 'NOT_RESUMABLE',
  });
  const h = await mount({ config: liveConfig().config, subagents });
  const result = await h.call('subagent', { agent_id: 'child-9', prompt: 'x' });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.ok(text.includes('NOT_RESUMABLE'), `the typed code survives: ${text}`);
  assert.ok(text.includes('subagent({ prompt:'), 'and the message says how to proceed');
  assert.equal(subagents.state.created.length, 0, 'a NOT_RESUMABLE target is never replaced by a fresh child');
  console.log('  service errors: code preserved, no silent re-dispatch');
}

// ── A provider that cannot create continuable children fails closed ─────────
{
  const subagents = fakeSubagents();
  subagents.provider.prepareContinuable = undefined;
  const h = await mount({ config: liveConfig().config, subagents });
  const result = await h.call('subagent', { prompt: 'x' });
  assert.equal(result.isError, true);
  assert.ok(textOf(result).includes('prepareContinuable'), textOf(result));
  assert.equal(subagents.state.created.length, 0);
  console.log('  provider without prepareContinuable: explicit error, no downgrade');
}

// ── wait_subagent: settle, timeout, cache, stale epochs, abort, multiple ────
{
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents });
  const created = await h.call('subagent', { prompt: 'first task' });
  const childId = created.value.agent_id;
  const epoch1 = subagents.state.epochs.get(childId);

  // Still running: the wait reports the timeout and does not cancel anything.
  const timedOut = await h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 120 });
  assert.equal(timedOut.isError, false, textOf(timedOut));
  assert.equal(timedOut.value.timed_out, true);
  assert.equal(timedOut.value.pending, 1);
  assert.equal(timedOut.value.results[0].status, 'running');
  assert.equal(subagents.state.interrupts.length, 0, 'a timeout never cancels the child');
  assert.equal(subagents.state.sent.length, 0);

  // The real end edge settles it, and the closing output is reported.
  h.emitLifecycle('subagent/end', {
    runId: epoch1, provider: 'spawn', id: childId, local: true, stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'audit done: 3 findings' }],
  }, h.orchestrator);

  const settled = await h.call('wait_subagent', { agent_ids: [childId] });
  assert.equal(settled.value.timed_out, false);
  assert.equal(settled.value.settled, 1);
  assert.equal(settled.value.results[0].status, 'settled');
  assert.equal(settled.value.results[0].stop_reason, 'completed');
  assert.equal(settled.value.results[0].output, 'audit done: 3 findings');
  assert.ok(textOf(settled).includes('audit done: 3 findings'), 'the render carries the closing output');

  // Waiting again on a settled child is free and never blocks.
  const cachedStart = Date.now();
  const cached = await h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 60000 });
  assert.equal(cached.value.results[0].status, 'settled');
  assert.equal(cached.value.results[0].output, 'audit done: 3 findings');
  assert.ok(Date.now() - cachedStart < 1000, 'a settled child returns its cached result immediately');

  // A follow-up invalidates that cache: the previous answer is not the answer
  // to the new work.
  const follow = await h.call('subagent', { agent_id: childId, prompt: 'deeper pass' });
  assert.equal(follow.value.continued, true);
  const running = await h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 100 });
  assert.equal(running.value.timed_out, true);
  assert.equal(running.value.results[0].status, 'running', 'the new work is not settled by the old result');
  assert.equal(running.value.settled, 0);

  // Cold resume: the follow-up re-opened an epoch; its end settles the new work.
  const epoch2 = subagents.state.epochs.get(childId);
  assert.notEqual(epoch2, epoch1, 'the fake opened a new residency epoch, like a cold resume does');
  h.emitLifecycle('subagent/end', {
    runId: epoch2, provider: 'spawn', id: childId, local: true, stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'deeper pass: 1 more finding' }],
  }, h.orchestrator);
  const settledAgain = await h.call('wait_subagent', { agent_ids: [childId] });
  assert.equal(settledAgain.value.results[0].output, 'deeper pass: 1 more finding');

  // Abort ends the wait, not the child. The signal is cancelled WHILE the wait
  // is running (a pre-aborted signal is refused by the registry itself), and the
  // runtime's own cancellation policy surfaces the call as aborted.
  const follow2 = await h.call('subagent', { agent_id: childId, prompt: 'third pass' });
  assert.equal(follow2.value.continued, true);
  const controller = new AbortController();
  const before = Date.now();
  const pendingWait = h.callWith('wait_subagent', { agent_ids: [childId], timeout_ms: 60000 }, controller.signal);
  const abortTimer = setTimeout(() => controller.abort(), 40);
  const aborted = await pendingWait;
  clearTimeout(abortTimer);
  assert.ok(Date.now() - before < 5000, 'the wait ends as soon as the call is cancelled');
  assert.equal(aborted.isError, true, 'the runtime reports the cancelled call');
  assert.match(textOf(aborted), /abort/i);
  assert.equal(subagents.state.interrupts.length, 0, 'aborting the wait does not interrupt the child');
  // The child kept running: its own epoch still settles for the next wait.
  const epoch3 = subagents.state.epochs.get(childId);
  h.emitLifecycle('subagent/end', {
    runId: epoch3, provider: 'spawn', id: childId, local: true, stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'third answer' }],
  }, h.orchestrator);
  const afterAbort = await h.call('wait_subagent', { agent_ids: [childId] });
  assert.equal(afterAbort.value.results[0].status, 'settled');
  assert.equal(afterAbort.value.results[0].output, 'third answer');
  console.log('  wait: timeout / settle / cache / invalidated cache / cold resume / abort');
}

// ── An end that lands while sendMessage is in flight cannot settle new work ──
{
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents });
  const created = await h.call('subagent', { prompt: 'first' });
  const childId = created.value.agent_id;
  const epoch1 = subagents.state.epochs.get(childId);
  h.emitLifecycle('subagent/end', {
    runId: epoch1, provider: 'spawn', id: childId, local: true, stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'first answer' }],
  }, h.orchestrator);

  // Hold the next sendMessage open: the OLD epoch's end arrives in that window,
  // which must not be read as "the new work finished".
  let release;
  const sendStarted = Promise.withResolvers();
  subagents.state.sendGate = () => new Promise((resolve) => { release = resolve; sendStarted.resolve(); });
  const pendingFollow = h.call('subagent', { agent_id: childId, prompt: 'second' });
  await sendStarted.promise;
  h.emitLifecycle('subagent/end', {
    runId: epoch1, provider: 'spawn', id: childId, local: true, stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'STALE first answer' }],
  }, h.orchestrator);
  const duringFlight = await h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 80 });
  assert.equal(duringFlight.value.results[0].status, 'pending', 'the in-flight delivery is pending, never settled');
  release();
  const followResult = await pendingFollow;
  assert.equal(followResult.value.continued, true);

  const afterAccept = await h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 80 });
  assert.equal(afterAccept.value.timed_out, true);
  assert.equal(afterAccept.value.results[0].status, 'running',
    'the stale end that arrived before acceptance did not settle the new delivery');

  const epoch2 = subagents.state.epochs.get(childId);
  h.emitLifecycle('subagent/end', {
    runId: epoch2, provider: 'spawn', id: childId, local: true, stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'second answer' }],
  }, h.orchestrator);
  const settled = await h.call('wait_subagent', { agent_ids: [childId] });
  assert.equal(settled.value.results[0].output, 'second answer');
  console.log('  race: an end during delivery never settles the new work');
}

// ── A resume epoch that OPENS AND CLOSES before the call resolves ───────────
{
  // The real cold-resume ordering (`SubagentContinuations.sendMessage` ->
  // `deliverFollowup` -> `coldResume` -> `materialize`) publishes the new
  // epoch's `start` BEFORE the inbox acceptance, and the acceptance is only
  // visible to this tool when `sendMessage` resolves. A child that finishes that
  // fast therefore ends its epoch while the delivering call is still in flight:
  // exactly one `end` exists, its sequence number is below the acceptance, and
  // it is still THIS delivery's own settlement. Losing it keeps the child
  // "running" forever and the closing output unreachable.
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents });
  const created = await h.call('subagent', { prompt: 'round one' });
  const childId = created.value.agent_id;
  h.emitLifecycle('subagent/end', {
    runId: subagents.state.epochs.get(childId), provider: 'spawn', id: childId, local: true,
    stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'round one done' }],
  }, h.orchestrator);

  // The child is idle, so the follow-up cold-resumes it: sendMessage opens the
  // new epoch and the hook closes it before sendMessage returns.
  subagents.state.sendHook = () => {
    const epoch = subagents.state.epochs.get(childId);
    subagents.state.epochs.delete(childId);
    h.emitLifecycle('subagent/end', {
      runId: epoch, provider: 'spawn', id: childId, local: true, stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'FAST round two' }],
    }, h.orchestrator);
  };
  const follow = await h.call('subagent', { agent_id: childId, prompt: 'round two' });
  subagents.state.sendHook = undefined;
  assert.equal(follow.isError, false, textOf(follow));
  assert.equal(follow.value.continued, true);

  const started = Date.now();
  const settled = await h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 60000 });
  const elapsed = Date.now() - started;
  assert.equal(settled.value.timed_out, false, 'the finished round is not timed out');
  assert.equal(settled.value.results[0].status, 'settled',
    `the epoch that closed before acceptance still settles it: ${JSON.stringify(settled.value.results[0])}`);
  assert.equal(settled.value.results[0].output, 'FAST round two',
    'and it reports that round\'s own closing output, not the cached first round');
  assert.equal(settled.value.settled, 1);
  assert.ok(elapsed < 1000, `the settled state is read from the observed end, not awaited: ${elapsed}ms`);
  console.log('  race: an epoch that opens AND closes before acceptance still settles the delivery');
}

// ── A rejected delivery does not erase what the child actually did ─────────
{
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents });
  const created = await h.call('subagent', { prompt: 'first' });
  const childId = created.value.agent_id;
  h.emitLifecycle('subagent/end', {
    runId: subagents.state.epochs.get(childId), provider: 'spawn', id: childId, local: true,
    stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'first answer' }],
  }, h.orchestrator);
  assert.equal((await h.call('wait_subagent', { agent_ids: [childId] })).value.results[0].status, 'settled');

  subagents.state.sendFailure = Object.assign(new Error('cannot deliver to that child'), { code: 'UNAUTHORIZED' });
  const rejected = await h.call('subagent', { agent_id: childId, prompt: 'again' });
  assert.equal(rejected.isError, true, textOf(rejected));
  assert.ok(textOf(rejected).includes('UNAUTHORIZED'), 'the service code survives a rejected delivery');
  subagents.state.sendFailure = undefined;

  const after = await h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 300 });
  assert.equal(after.value.timed_out, false,
    'one rejected sendMessage must not leave the child pending forever');
  assert.equal(after.value.results[0].status, 'settled',
    'a delivery that was never accepted is not outstanding work — the observed result still stands');
  assert.equal(after.value.results[0].output, 'first answer');
  assert.equal(subagents.state.interrupts.length, 0);

  // The bookkeeping is intact: the next delivery is a normal new round.
  const ok = await h.call('subagent', { agent_id: childId, prompt: 'third' });
  assert.equal(ok.value.continued, true);
  h.emitLifecycle('subagent/end', {
    runId: subagents.state.epochs.get(childId), provider: 'spawn', id: childId, local: true,
    stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'third answer' }],
  }, h.orchestrator);
  const third = await h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 300 });
  assert.equal(third.value.results[0].output, 'third answer');
  console.log('  failure: a rejected follow-up never pollutes the child\'s observed state');
}

// ── The child LLM route is resolved BEFORE a child is materialized ─────────
{
  const subagents = fakeSubagents();
  const routeCalls = [];
  const h = await mount({
    config: liveConfig().config,
    subagents,
    llm: {
      async resolveCallConfig(config) {
        routeCalls.push(config);
        return config;
      },
    },
  });
  const created = await h.call('subagent', { prompt: 'x' });
  assert.equal(created.isError, false, textOf(created));
  assert.deepEqual(routeCalls, [{
    provider: 'fixture-provider', model: 'fixture/model-1', reasoningEffort: 'low',
  }], 'the configured child route goes through the public llm.resolveCallConfig');
  assert.equal(subagents.state.created.length, 1);

  const bad = Object.assign(new Error('LLM provider "fixture-provider" is not registered'), { code: 'UNKNOWN_PROVIDER' });
  const broken = fakeSubagents();
  const h2 = await mount({
    config: liveConfig().config,
    subagents: broken,
    llm: { resolveCallConfig: async () => { throw bad; } },
  });
  const failed = await h2.call('subagent', { prompt: 'x' });
  assert.equal(failed.isError, true, 'an unusable configured route is refused');
  const text = textOf(failed);
  assert.ok(text.includes('fixture-provider') && text.includes('UNKNOWN_PROVIDER'), `the route failure is actionable: ${text}`);
  assert.equal(broken.state.created.length, 0,
    'a bad route is found BEFORE a child is materialized (nothing is created or persisted)');
  assert.equal(broken.state.sent.length, 0);

  // Boundary, asserted rather than assumed: when this scope cannot see the llm
  // service the route is NOT faked as validated — creation still goes to the
  // service, which validates at materialization time (every earlier block in
  // this file runs without an `llm` service for exactly that reason).
  const noLlm = fakeSubagents();
  const h3 = await mount({ config: liveConfig().config, subagents: noLlm });
  assert.equal((await h3.call('subagent', { prompt: 'x' })).isError, false);
  console.log('  route: llm.resolveCallConfig preflights the child route before materialization');
}

// ── The LLM provider id is never mistaken for the delegation provider ──────
{
  // The live Config names an LLM provider ("fixture-provider"); the delegation
  // provider is the runtime's own "spawn". A scope that only has the LLM name
  // must be refused loudly instead of being used as a delegation provider.
  const subagents = fakeSubagents();
  const onlyLlmProvider = {
    ...subagents.service,
    getProvider: (name) => (name === 'fixture-provider' ? subagents.provider : undefined),
    list: () => ['fixture-provider'],
  };
  const h = await mount({ config: liveConfig().config, subagents: { ...subagents, service: onlyLlmProvider } });
  const result = await h.call('subagent', { prompt: 'x' });
  assert.equal(result.isError, true, 'the delegation provider is fixed to spawn');
  assert.ok(textOf(result).includes('spawn'), textOf(result));
  assert.equal(subagents.state.created.length, 0,
    'the LLM provider id never becomes a delegation provider');
  console.log('  providers: the LLM route and the delegation provider stay separate');
}

// ── Concurrent follow-ups are serialised per child; one wait covers both ────
{
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents });
  const created = await h.call('subagent', { prompt: 'first' });
  const childId = created.value.agent_id;
  let releaseFirst;
  // Hold the FIRST follow-up open: the second one has to queue behind it, and a
  // wait started in that window sees the first delivery as still pending.
  const firstStarted = Promise.withResolvers();
  subagents.state.sendGate = (record) => (record === subagents.state.sent[0]
    ? new Promise((resolve) => { releaseFirst = resolve; firstStarted.resolve(); })
    : Promise.resolve());
  const first = h.call('subagent', { agent_id: childId, prompt: 'A' });
  const second = h.call('subagent', { agent_id: childId, prompt: 'B' });
  await firstStarted.promise;
  const waiter = h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 60 });
  const waited = await waiter;
  assert.equal(waited.value.timed_out, true);
  assert.equal(waited.value.results[0].status, 'pending', 'the in-flight delivery is pending');
  assert.equal(subagents.state.sent.length, 1, 'the second delivery waits for the first (per-child queue)');
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(subagents.state.sent.length, 2, 'both follow-ups were delivered (a create sends nothing)');
  assert.deepEqual(subagents.state.sent.map((record) => record.content[0].text), ['A', 'B'], 'deliveries keep their order');
  const epoch = subagents.state.epochs.get(childId);
  h.emitLifecycle('subagent/end', {
    runId: epoch, provider: 'spawn', id: childId, local: true, stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'A+B done' }],
  }, h.orchestrator);
  const final = await h.call('wait_subagent', { agent_ids: [childId] });
  assert.equal(final.value.results[0].output, 'A+B done', 'one wait settles the whole current batch');
  console.log('  concurrency: per-child delivery queue, one wait covers the batch');
}

// ── Several children at once ────────────────────────────────────────────────
{
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents });
  const one = (await h.call('subagent', { prompt: 'one' })).value.agent_id;
  const two = (await h.call('subagent', { prompt: 'two' })).value.agent_id;
  h.emitLifecycle('subagent/end', {
    runId: subagents.state.epochs.get(two), provider: 'spawn', id: two, local: true,
    stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'two done' }],
  }, h.orchestrator);
  const both = await h.call('wait_subagent', { agent_ids: [one, two], timeout_ms: 100 });
  assert.equal(both.value.timed_out, true);
  assert.equal(both.value.settled, 1);
  assert.equal(both.value.pending, 1);
  assert.deepEqual(both.value.results.map((entry) => entry.status), ['running', 'settled']);
  assert.equal(both.value.results[1].output, 'two done');
  console.log('  multiple children: one wait reports each id independently');
}

// ── Unknown / invalid / unavailable: never faked as finished ────────────────
{
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents });
  subagents.state.catalog = [
    { id: 'persisted-continuable', createdAt: 1, mode: 'continuable', label: 'old child' },
    { id: 'persisted-oneshot', createdAt: 2, mode: 'one-shot' },
  ];
  const result = await h.call('wait_subagent', {
    agent_ids: ['persisted-continuable', 'persisted-oneshot', 'not-mine', 's-root'],
    timeout_ms: 60,
  });
  assert.equal(result.isError, false, textOf(result));
  assert.deepEqual(result.value.results.map((entry) => entry.status), ['unknown', 'unknown', 'invalid', 'invalid']);
  const [continuable, oneShot] = result.value.results;
  assert.ok(continuable.detail.includes('subagent({ agent_id: "persisted-continuable"'), continuable.detail);
  assert.ok(!/completed/i.test(continuable.detail), 'an unobserved persisted child is never called completed');
  assert.ok(oneShot.detail.includes('one-shot'), oneShot.detail);
  assert.equal(result.value.settled, 0);
  assert.equal(result.value.timed_out, false, 'a classified-unknown id ends the wait immediately');
  assert.deepEqual(subagents.state.catalogReads, ['s-root'], 'the catalog is read once, for the calling agent');

  subagents.state.catalogFailure = new Error('session query unavailable');
  const unavailable = await h.call('wait_subagent', { agent_ids: ['persisted-continuable'], timeout_ms: 60 });
  assert.equal(unavailable.value.results[0].status, 'unavailable');
  assert.ok(unavailable.value.results[0].detail.includes('session query unavailable'));
  console.log('  unknown ids: unknown/invalid/unavailable, with an actionable next step');
}

// ── Events for someone else's child never reach this agent's tracker ───────
{
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents });
  const foreign = { id: 'other', session: { id: 's-other', header: {} }, options: {} };
  h.emitLifecycle('subagent/start', { runId: 'foreign-run', provider: 'spawn', id: 'foreign-child', local: true }, foreign);
  h.emitLifecycle('subagent/end', {
    runId: 'foreign-run', provider: 'spawn', id: 'foreign-child', local: true, stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'not mine' }],
  }, foreign);
  subagents.state.catalog = [{ id: 'foreign-child', createdAt: 1, mode: 'continuable', label: 'foreign' }];
  const result = await h.call('wait_subagent', { agent_ids: ['foreign-child'], timeout_ms: 60 });
  assert.equal(result.value.results[0].status, 'unknown',
    'the parent-scoped listener never records another parent\'s run');
  console.log('  scope: lifecycle events are admitted only for the dispatching parent');
}

// ── Argument handling ───────────────────────────────────────────────────────
{
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents });
  for (const args of [{}, { agent_ids: [] }, { agent_ids: ['a', ''] }, { agent_ids: 'child-1' }]) {
    const result = await h.call('wait_subagent', args);
    assert.equal(result.isError, true, `agent_ids=${JSON.stringify(args.agent_ids)} is rejected`);
  }
  const tooLong = await h.call('wait_subagent', { agent_ids: ['a'], timeout_ms: 3_600_001 });
  assert.equal(tooLong.isError, true);
  assert.ok(textOf(tooLong).includes('3600000'), textOf(tooLong));
  const atMax = await h.call('wait_subagent', { agent_ids: ['a'], timeout_ms: 3_600_000 });
  assert.notEqual(atMax.isError, true, 'the documented maximum itself is accepted');
  const negative = await h.call('wait_subagent', { agent_ids: ['a'], timeout_ms: -1 });
  assert.equal(negative.isError, true);
  const fractional = await h.call('wait_subagent', { agent_ids: ['a'], timeout_ms: 1.5 });
  assert.equal(fractional.isError, true);
  const noPrompt = await h.call('subagent', { description: 'x' });
  assert.equal(noPrompt.isError, true, 'prompt is required');
  const wrongAgent = await h.call('wait_subagent', { agent_ids: ['a'] }, h.child);
  assert.equal(wrongAgent.isError, true, 'the tool only serves the agent whose layer registered it');

  // ── A deployment that sets `minWaitTimeoutMs` (blank stays "no lower bound") ──
  const { resolveWaitBudget } = await import('./lib/delegation.js');
  const blank = resolveWaitBudget('');
  assert.deepEqual({ minMs: blank.minMs, defaultMs: blank.defaultMs, maxMs: blank.maxMs, invalid: blank.invalid },
    { minMs: 0, defaultMs: 30_000, maxMs: 3_600_000, invalid: undefined },
    'blank means no plugin lower bound, and the documented default is unchanged');
  assert.equal(resolveWaitBudget('0').minMs, 0, '0 is treated as blank, not as a zero-millisecond wait');
  assert.equal(resolveWaitBudget(undefined).minMs, 0);
  const fiveMinutes = resolveWaitBudget('300000');
  assert.deepEqual({ minMs: fiveMinutes.minMs, defaultMs: fiveMinutes.defaultMs }, { minMs: 300_000, defaultMs: 300_000 },
    'the effective default follows the minimum up');
  assert.equal(resolveWaitBudget('20000').defaultMs, 30_000, 'a minimum below the host default leaves the default at 30000');
  // A typo must never become a silent bound (or a silent "no bound"): it is
  // reported, and the wait keeps working with no plugin minimum.
  for (const bad of ['abc', '-1', '1.5', '3600001', '30000000000000000000', '  ']) {
    const resolved = resolveWaitBudget(bad);
    assert.equal(resolved.minMs, 0, `${JSON.stringify(bad)} does not become a lower bound`);
    if (bad.trim()) assert.ok(resolved.invalid?.includes('CONFIG-INVALID'), `${JSON.stringify(bad)} is reported`);
  }
  const strict = await mount({ config: liveConfig({ minWaitTimeoutMs: '300000' }).config, subagents: fakeSubagents() });
  const short = await strict.call('wait_subagent', { agent_ids: ['a'], timeout_ms: 30_000 });
  assert.equal(short.isError, true, 'an explicit wait below the configured minimum is rejected');
  assert.ok(textOf(short).includes('300000'), textOf(short));
  assert.ok(textOf(short).includes('minWaitTimeoutMs'), 'the rejection names the config field');
  assert.ok(textOf(short).includes('300000 or more'), 'the rejection says which value to pass');
  const enough = await strict.call('wait_subagent', { agent_ids: ['a'], timeout_ms: 300_000 });
  assert.notEqual(enough.isError, true, 'a wait at the minimum is accepted');
  const omitted = await strict.call('wait_subagent', { agent_ids: ['a'] });
  assert.notEqual(omitted.isError, true, 'omitting timeout_ms uses the raised default, not a rejection');
  const strictTools = (await strict.root.systemPrompt.assemble({ agent: strict.orchestrator, scope: strict.orchestrator })).tools;
  const waitSchema = JSON.stringify(strictTools.find((tool) => tool.name === 'wait_subagent'));
  assert.ok(waitSchema.includes('300000'), 'the tool description states the live default/minimum');
  assert.ok(waitSchema.includes('minimum'), 'and says that a minimum is configured');
  console.log('  arguments: required/empty/capped/bound-to-one-agent');
}

// ── The allow list drives everything, including the own-layer names ────────
{
  // wait_subagent removed from the list: it must vanish from the catalog AND be
  // denied, while NOT tripping the restrict() typo fallback (it lives in the
  // agent's own layer, which a restriction cannot name).
  const config = liveConfig({ orchestratorTools: 'subagent, ask_user_question' });
  const subagents = fakeSubagents();
  const h = await mount({ config: config.config, subagents });
  assert.deepEqual(await h.names(h.orchestrator), ['ask_user_question', 'subagent']);
  assert.match(
    h.registry.guardReason({ name: 'wait_subagent', callId: 'g', arguments: {}, agent: h.orchestrator }),
    /not available to this orchestrator/,
  );
  const gateLog = await import('node:fs').then((fs) => fs.readFileSync(join(logHome, 'frugal-gate.log'), 'utf8'));
  // The own-layer name must never be reported as an unknown/typo name. (An
  // unrelated fallback can still happen in this harness: it has no attachment
  // service, so the image reader cannot be registered.)
  assert.ok(!/CONFIG-UNKNOWN[^\n]*names=\[[^\]]*wait_subagent[^\]]*\]/.test(gateLog), 'the own-layer name is never reported as an unknown/typo name');
  assert.match(gateLog, /CONFIG-FALLBACK|tools=\[/, 'the diagnostic log records the applied tool list');
  // A real typo still falls back to the built-in trio.
  config.refs.orchestratorTools[WRITE]('subagent, wait_subagentt');
  h.root.emit('loader/volatile-update', [['orchestratorTools']]);
  assert.deepEqual(await h.names(h.orchestrator), ORCHESTRATOR_TOOLS, 'a typo falls back to the built-in trio');
  console.log('  allow list: own-layer names are exempt from restrict(), typos still fail safe');
}

// ── A missing subagents service fails the governed agent CLOSED ────────────
{
  const subagents = fakeSubagents();
  const h = await mount({ config: liveConfig().config, subagents, }) ;
  // A second mount with the service absent: the setup must throw, loudly.
  const bare = new Context();
  bare.logger.level = 4;
  await bare.plugin(SystemPrompt, {});
  await bare.plugin(ToolRuntime, {});
  bare.reflect.provide('agentPresets', { composedPreset: () => 'frugal' });
  const { SessionStore } = await load('dsh-session/lib/index.js');
  const { SessionQueryEngine } = await load('dsh-session-query/lib/index.js');
  await bare.plugin(SessionStore);
  await bare.plugin(SessionQueryEngine);
  bare.on('session/flush', () => {});
  const agent = { id: 'no-service', session: bare.sessions.create('s-bare'), options: {} };
  await bare.plugin({
    name: 'bare-runtime',
    inject: ['tools', 'systemPrompt'],
    apply(runtimeCtx) {
      const scope = createScope(runtimeCtx, agent, { parent: { kind: 'preset', id: 'frugal' } });
      agent.ctx = scope.ctx;
    },
  });
  await bare.plugin({
    name: 'frugal-gate',
    inject: ['tools', 'systemPrompt'],
    apply: (ctx) => applyGate(ctx, liveConfig().config),
  });
  await assert.rejects(
    bare.serial('agent/created', { agent }),
    /CONFIG-TOOLS-UNAVAILABLE/,
    'a governed agent without the subagents service is never created silently',
  );
  console.log('  fail-closed: missing subagents service surfaces CONFIG-TOOLS-UNAVAILABLE');
  assert.ok(h.names !== undefined);
}

// ── A settings write must not destroy the run bookkeeping ──────────────────
// The regression this covers: `applyTo()` used to start with a FULL release,
// which deleted the tracker entry and the `subagent/start` + `subagent/end`
// listeners with it. A volatile write that changes the effect signature (the
// prompt, the allow list, `includeRuntimeContext`) therefore turned every known
// child into `unknown` and re-registered a SECOND pair of listeners.
{
  const subagents = fakeSubagents();
  const { config, refs } = liveConfig();
  const h = await mount({ config, subagents });
  // `ctx.on()` on any scoped context lands in the ONE event bus of the root, so
  // this counts the gate's own listeners exactly.
  const hooks = (name) => (h.root.events._hooks[name] ?? []).length;
  assert.equal(hooks('subagent/start'), 1, 'one start listener per governed agent');
  assert.equal(hooks('subagent/end'), 1, 'one end listener per governed agent');

  const created = await h.call('subagent', { prompt: 'probe the tracker', description: 'probe child' });
  const childId = created.value.agent_id;
  subagents.state.catalog = [{ id: childId, createdAt: 1, mode: 'continuable', label: 'probe child' }];
  const settle = (id, text) => {
    const runId = subagents.state.epochs.get(id);
    h.emitLifecycle('subagent/end', {
      runId, provider: 'spawn', id, local: true, stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text }],
    }, h.orchestrator);
  };

  settle(childId, 'RESULT-1');
  const a1 = await h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 60 });
  assert.equal(a1.value.results[0].status, 'settled');
  assert.equal(a1.value.results[0].output, 'RESULT-1');

  // Control: a write OUTSIDE the effect signature must not re-apply at all.
  refs.subagentModel[WRITE]('fixture/model-2');
  h.root.emit('loader/volatile-update', [['subagentModel']]);
  const a2 = await h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 60 });
  assert.equal(a2.value.results[0].status, 'settled');
  assert.equal(a2.value.results[0].output, 'RESULT-1');

  // The suspect case: a SIGNATURE-changing write re-installs the effect set.
  refs.includeRuntimeContext[WRITE](true);
  h.root.emit('loader/volatile-update', [['includeRuntimeContext']]);
  assert.deepEqual(await h.names(h.orchestrator), ORCHESTRATOR_TOOLS, 'the write re-installed the same three tools');
  const a3 = await h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 60 });
  assert.equal(a3.value.results[0].status, 'settled', 'a signature write must not drop a settled child');
  assert.equal(a3.value.results[0].output, 'RESULT-1');

  // A RUNNING child across the same write: still running, never `unknown`.
  const created2 = await h.call('subagent', { prompt: 'second probe', description: 'probe child 2' });
  const childId2 = created2.value.agent_id;
  subagents.state.catalog.push({ id: childId2, createdAt: 2, mode: 'continuable', label: 'probe child 2' });
  const b1 = await h.call('wait_subagent', { agent_ids: [childId2], timeout_ms: 30 });
  assert.equal(b1.value.results[0].status, 'running');
  refs.orchestratorSystemPrompt[WRITE]('a custom prompt that changes the signature');
  h.root.emit('loader/volatile-update', [['orchestratorSystemPrompt']]);
  const b2 = await h.call('wait_subagent', { agent_ids: [childId2], timeout_ms: 30 });
  assert.equal(b2.value.results[0].status, 'running', 'a settings write never turns a live child into unknown');
  assert.equal(b2.value.timed_out, true);
  settle(childId2, 'RESULT-2');
  const b3 = await h.call('wait_subagent', { agent_ids: [childId2], timeout_ms: 60 });
  assert.equal(b3.value.results[0].status, 'settled');
  assert.equal(b3.value.results[0].output, 'RESULT-2');

  assert.equal(hooks('subagent/start'), 1, 'three re-installs added no second start listener');
  assert.equal(hooks('subagent/end'), 1, 'three re-installs added no second end listener');

  // Teardown: the agent is gone, so the durable listeners go with it.
  h.root.emit('agent/disposed', { agent: h.orchestrator });
  assert.equal(hooks('subagent/start'), 0);
  assert.equal(hooks('subagent/end'), 0);
  console.log('  lifecycle: the tracker survives a signature write, listeners are installed once');
}

// ── A temporary un-govern keeps the children it can no longer serve ────────
// Switching the preset away releases the gate's EFFECTS (its three tools), but
// the children of that agent keep running; a switch back has to be able to wait
// for what happened in between.
{
  const subagents = fakeSubagents();
  const mountOptions = { config: liveConfig().config, subagents };
  const h = await mount(mountOptions);
  const hooks = (name) => (h.root.events._hooks[name] ?? []).length;

  const created = await h.call('subagent', { prompt: 'probe through an un-govern', description: 'probe child' });
  const childId = created.value.agent_id;
  subagents.state.catalog = [{ id: childId, createdAt: 1, mode: 'continuable', label: 'probe child' }];
  assert.equal((await h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 30 })).value.results[0].status, 'running');

  mountOptions.preset = 'some-other-preset';
  h.root.emit('loader/volatile-update', [['presetId']]);
  assert.ok(!(await h.names(h.orchestrator)).includes('wait_subagent'), 'an un-governed agent loses the gate tools');

  // The child settles while the gate does not govern: the durable listeners must
  // still record it (they are not part of the released effect set).
  const runId = subagents.state.epochs.get(childId);
  h.emitLifecycle('subagent/end', {
    runId, provider: 'spawn', id: childId, local: true, stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'RESULT-ACROSS' }],
  }, h.orchestrator);

  mountOptions.preset = 'frugal';
  h.root.emit('loader/volatile-update', [['presetId']]);
  assert.deepEqual(await h.names(h.orchestrator), ORCHESTRATOR_TOOLS, 'switching back re-installs the three tools');
  const back = await h.call('wait_subagent', { agent_ids: [childId], timeout_ms: 60 });
  assert.equal(back.value.results[0].status, 'settled', 'the settlement recorded while un-governed is still there');
  assert.equal(back.value.results[0].output, 'RESULT-ACROSS');
  assert.equal(hooks('subagent/start'), 1, 'the un-govern/back cycle added no second start listener');
  assert.equal(hooks('subagent/end'), 1, 'the un-govern/back cycle added no second end listener');

  h.root.emit('agent/disposed', { agent: h.orchestrator });
  assert.equal(hooks('subagent/start'), 0);
  assert.equal(hooks('subagent/end'), 0);
  console.log('  un-govern: effects go, bookkeeping stays, switching back can still wait');
}

console.log(`frugal-orchestrator delegation harness: all assertions passed (profile: ${profileDir})`);
