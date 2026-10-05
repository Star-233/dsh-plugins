// Unit harness for plugins/dsh-frugal-orchestrator/index.js.
//
// The gate resolves `@deepseek-ai/schemastery` from the active profile at load
// time (a `link:`ed package cannot resolve it from its own realpath), so the
// harness runs the import dynamically after pointing DSH_PROFILE_DIR at a real
// profile. It never talks to a live dsh process.
//
//   node gate.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Point DSH_PROFILE_DIR at a profile whose node_modules holds schemastery.
 * @returns the profile directory the harness will use.
 */
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

const profileDir = ensureProfileDir();
const {
  apply, inject, name, Config,
  DEFAULT_ORCHESTRATOR_PROMPT, TOOL_CAPABILITY_SUFFIX, orchestratorSectionText,
} = await import('./index.js');

assert.equal(name, 'frugal-gate');
assert.deepEqual(inject, ['tools', 'systemPrompt']);
assert.equal(Object.keys(Config.dict).length, 21, 'the GUI schema declares every switch');

// The schema's own defaults, resolved the way the Loader resolves them: a
// `.volatile()` field materialises as a reference, not as the plain value.
const SCHEMA = Config({});
/** @returns the plain default behind a possibly-volatile schema field. */
function schemaDefault(key) {
  let value = SCHEMA[key];
  for (let step = 0; step < 4 && value !== null && typeof value === 'object' && typeof value.get === 'function'; step += 1) value = value.get();
  return value;
}

const DEFAULT_PROMPT = schemaDefault('orchestratorSystemPrompt');
// The orchestration surface: the delegation pair, the question tool, and the
// READ half of the image bridge (the delivery half belongs to the workers).
const DEFAULT_TOOLS = 'subagent, ask_user_question, wait_subagent, read_delivered_images';
assert.equal(schemaDefault('presetId'), 'frugal');
assert.equal(schemaDefault('diagnostics'), true, 'diagnostics default to on');
// The shipped child route is EMPTY: a provider/model here would force the
// author's private route on every install. Empty means inherit.
assert.equal(schemaDefault('subagentProvider'), '', 'the child provider default inherits');
assert.equal(schemaDefault('subagentModel'), '', 'the child model default inherits');
assert.equal(schemaDefault('subagentReasoningEffort'), '', 'the child effort default inherits');
assert.ok(DEFAULT_PROMPT.includes('省钱编排'), 'the default prompt ships with the row');

// ── The default tool list is the three-tool orchestration surface. ───────────
// Every copy of it (schema default, client half, bundled patch) has to agree;
// the client half and the patch are asserted at the end of this file and in
// `catalog.test.mjs`.
assert.equal(schemaDefault('orchestratorTools'), DEFAULT_TOOLS, 'the schema default names the whole orchestration surface');
assert.equal(DEFAULT_ORCHESTRATOR_PROMPT, DEFAULT_PROMPT, 'the exported default is the schema default');

// ── The default prompt states the whole working agreement. ──────────────────
// Each entry is a requirement that used to be lost when the prompt was edited:
// the orchestrator designs and accepts, the child executes and returns evidence,
// a child never sees this conversation, the returned id is kept, independent work
// runs in parallel while dependent work is ordered, the orchestrator reads the
// real diff/test evidence before believing a child, it never invents facts or
// tools it does not have, and it waits for evidence with `wait_subagent` instead
// of asking the user to confirm.
for (const requirement of [
  '理解用户的真实目标',
  '自主设计方案与取舍',
  '制定验收标准',
  '不要把最终设计、关键判断或验收结论整体外包',
  '也不要假装有',
  '不虚构文件内容、命令输出或测试结果',
  '去读相关原文',
  '看不到这段主对话',
  '关键行号',
  '怎样算完成',
  '独立任务在同一条回复里并行派发',
  '有依赖的按顺序派发',
  '避免多个 child 同时修改同一个文件',
  // The dispatch brief is a numbered checklist, because the point of it is that
  // a cheap child can act without making its own design decisions.
  '1) 背景与目标',
  '2) 精确输入',
  '3) 操作序列',
  '4) 范围与禁区',
  '5) 验收与验证',
  '6) 交付格式',
  '7) 阻塞策略',
  '执行者不得自行扩大范围',
  '显式标注「假设」',
  '分工固定',
  '一句话就能说清的小任务不必套满模板',
  '保留工具返回的 agent_id',
  '不必重复背景',
  '必须转发过去',
  '用同一个 agent_id 续聊',
  '不要把重派当成续聊',
  '必须等证据才能决策时用 wait_subagent',
  '亲自对照用户目标检查关键源码、真实差异和测试证据',
  'child 说通过不等于完成',
  '只有必须由用户本人决定的问题才用 ask_user_question',
  '不要频繁找用户确认',
]) {
  assert.ok(DEFAULT_PROMPT.includes(requirement), `the default prompt keeps the requirement 「${requirement}」`);
}

// ── The FIXED tool contract is appended, exactly once, to any prompt. ────────
// `SystemPrompt.assemble()` restores an effective `complete` section as the ONLY
// prompt section, so a second section would be dropped: the contract has to be
// part of this one. A custom prompt can therefore never remove it, and the
// default (which does not carry it) is never doubled.
{
  const viaDefault = orchestratorSectionText(DEFAULT_PROMPT);
  assert.equal(viaDefault, `${DEFAULT_PROMPT}\n\n${TOOL_CAPABILITY_SUFFIX}`);
  assert.equal(viaDefault.split(TOOL_CAPABILITY_SUFFIX).length - 1, 1, 'the contract appears once for the default prompt');
  assert.equal(orchestratorSectionText(''), viaDefault, 'a blank field means the built-in prompt');
  assert.equal(orchestratorSectionText('   '), viaDefault, 'whitespace is blank too');
  const custom = orchestratorSectionText('只回一句话。');
  assert.ok(custom.startsWith('只回一句话。'), 'a custom prompt is kept verbatim');
  assert.equal(custom.split(TOOL_CAPABILITY_SUFFIX).length - 1, 1, 'a custom prompt gets the contract exactly once');
  assert.equal(orchestratorSectionText(custom), custom, 'a prompt that already carries the contract is not doubled');
  // The contract names the real schema, continuation semantics, the refused
  // foreground flag and the wait budget — the four things a model gets wrong.
  for (const fact of [
    'subagent({ description, prompt })',
    'subagent({ agent_id, prompt })',
    'run_in_background: false 明确不支持',
    'wait_subagent({ agent_ids: [ID, ...], timeout_ms })',
    'max(30000, minWaitTimeoutMs)',
    '上限 3600000 ms',
    '不会被偷偷放大',
    '不会取消 child',
    'unknown',
    'one-shot',
    'send_message / wait_agent',
  ]) {
    assert.ok(TOOL_CAPABILITY_SUFFIX.includes(fact), `the fixed contract states 「${fact}」`);
  }
}

// ── A live reference, shaped exactly like cosmokit's createVolatile(). ────────
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
    orchestratorTools: DEFAULT_TOOLS,
    orchestratorSystemPrompt: DEFAULT_PROMPT,
    includeGlobalAgentsMd: false,
    includeProjectAgentsMd: true,
    includeSkills: false,
    includeRuntimeContext: false,
    // A PROFILE-level child route (not the shipped default — the bundle ships
    // empty = inherit). Every test that wants a concrete route sets it here.
    subagentProvider: 'fixture-provider',
    subagentModel: 'fixture/model-1',
    subagentReasoningEffort: 'low',
    orchestratorProvider: '',
    orchestratorModel: '',
    orchestratorReasoningEffort: '',
    // Off unless a test asks for it, so no harness run writes into $DSH_HOME.
    diagnostics: false,
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

/**
 * The tools a `frugal` preset registers in the scope ABOVE the agent — the set
 * `tools.restrict()` may name. The gate registers `subagent` + `wait_subagent`
 * into the agent's OWN layer (so `subagent` is in both, shadowing the preset's,
 * and `wait_subagent` is only in the own layer), which is exactly why the real
 * `ToolRuntime.view(scope).restrictableNames` is the set the harness models here
 * and not "every allowed name". The Agent Teams / schedule tools are absent on
 * purpose: other bundles register those into the agent's own layer.
 */
const RESTRICTABLE = [
  'subagent', 'subagent_fork', 'list_agents', 'ask_user_question',
  'bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep',
  'job_list', 'job_output', 'job_kill', 'skill', 'workflow', 'present',
  'todo_write', 'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode',
  'web_search', 'web_fetch',
];

/**
 * Registrations that live ONLY in the agent's own layer: the Agent Teams /
 * schedule bundles' plus the gate's wait tool. `knownNames` covers them (so a
 * user MAY allow one by name and the catalog filter keeps it) while
 * `restrictableNames` does not (so `restrict()` can never name them).
 */
const OWN_LAYER_KNOWN = [
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
  'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update',
  'wait_subagent',
];

/** One recorded `subagents` service: the shape `installDelegationTools` requires. */
function fakeSubagents() {
  const created = [];
  const sent = [];
  const provider = {
    name: 'spawn',
    prepareContinuable: () => ({}),
  };
  const service = {
    getProvider: (name) => (name === 'spawn' ? provider : undefined),
    list: () => ['spawn', 'fork'],
    async startContinuable({ label, request }) {
      const childId = `child-${created.length + 1}`;
      created.push({ childId, label, request });
      return { childId, messageId: `accept-${created.length}` };
    },
    async sendMessage(parent, childId, blocks) {
      sent.push({ parent, childId, blocks });
      return `accept-continue-${sent.length}`;
    },
    async listChildren() {
      return created.map((entry) => ({ id: entry.childId, mode: 'continuable', label: entry.label }));
    },
  };
  return { service, provider, created, sent };
}

const fakeSessions = new Map();
/** Build a fake ctx that records effects and lets the harness dispatch events. */
function fakeCtx(presetOfAgent = () => 'frugal', options = {}) {
  const listeners = new Map();
  const logs = [];
  const effects = [];
  /** Live agents by session id, as the `agents` service holds them. */
  const registry = new Map();
  const subagents = fakeSubagents();
  const ctx = {
    logger: {
      debug: (message) => logs.push({ level: 'debug', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
    get: (service) => {
      if (service === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 256000 }, defaultMaxTokens: 256000 }) };
      if (service === 'tokenMeter') return { measure: () => ({ totalTokens: 0, nodes: [], baseline: { kind: 'estimated' } }), estimateMessage: (message) => Math.ceil(JSON.stringify(message.content).length / 4) };
      if (service === 'sessions') return { flush: async () => true };
      if (service === 'sessionQuery') return { observeSession: async (id) => ({ events: fakeSessions.get(id)?.events ?? [], inheritedEventCount: 0, [Symbol.dispose]() {} }) };
      if (service === 'agentPresets') return { composedPreset: (agentCtx) => presetOfAgent(agentCtx) };
      if (service === 'subagents') return options.subagents === null ? undefined : subagents.service;
      if (service === 'agents') {
        return {
          get: (id) => registry.get(id),
          // The real service exposes both: `list()` is every live agent and
          // `roots()` the top-level ones (a child is created under an owner).
          list: () => [...registry.values()],
          roots: () => [...registry.values()].filter((agent) => (agent.session?.header?.delegationDepth ?? 0) === 0),
        };
      }
      return undefined;
    },
    on(event, handler) {
      listeners.set(event, handler);
    },
    effect(callback, label) {
      const dispose = callback();
      const entry = { label, dispose };
      effects.push(entry);
      return () => {
        try {
          dispose?.();
        } catch {
          // Ignore.
        }
      };
    },
    dispatch(event, payload, next) {
      const handler = listeners.get(event);
      if (handler === undefined) throw new Error(`no listener for ${event}`);
      return handler(payload, next);
    },
  };
  return { ctx, logs, effects, registry, subagents };
}

/** Build a fake agent; depth>0 means a delegated child. */
function fakeAgent(depth, preset = 'frugal') {
  const restricted = [];
  const suppressed = [];
  const sections = [];
  const sectionCalls = [];
  const agentEffects = [];
  const calls = [];
  /** The agent's OWN scope listeners, recorded the way the Cordis proxy would. */
  const agentListeners = new Map();
  /** Guards installed through this agent's registry view. */
  const guards = [];
  /** Definitions registered into this agent's OWN layer (the gate's two tools). */
  const registered = [];
  const agent = {
    session: { id: `session-depth-${depth}`, header: depth === 0 ? {} : { delegationDepth: depth }, requestHeader: () => undefined },
    options: {},
    ctx: {
      __preset: preset,
      on: (event, handler) => {
        const list = agentListeners.get(event) ?? [];
        list.push(handler);
        agentListeners.set(event, list);
        calls.push(['on', event]);
        return () => {
          const index = list.indexOf(handler);
          if (index !== -1) list.splice(index, 1);
          calls.push(['off', event]);
        };
      },
      tools: {
        // The real `ToolRuntime.view(scope)`: `restrictableNames` covers the
        // INHERITED layers only, so a name that exists solely in the agent's own
        // layer (the gate's `wait_subagent`) is not a legal restriction name —
        // and `restrict()` throws for it. Modelling this is what makes the
        // harness exercise the gate's own-layer handling for real.
        view: () => ({
          restrictableNames: new Set(RESTRICTABLE),
          knownNames: new Set([...RESTRICTABLE, ...OWN_LAYER_KNOWN]),
          visible: new Map(),
        }),
        // The registry's own presentation resolver; a native deployment (the
        // `frugal` preset composes no `tool-presentation` row) reports this.
        modeFor: () => 'native',
        restrict: (filter) => {
          calls.push(['restrict', filter]);
          restricted.push(filter);
          return () => restricted.push('disposed');
        },
        guard: (guard) => {
          calls.push(['guard']);
          guards.push(guard);
          return () => guards.push('disposed');
        },
        register: (definition) => {
          calls.push(['register', definition?.name]);
          registered.push(definition);
          return () => registered.push('disposed');
        },
      },
      systemPrompt: {
        suppressRuntimeContext: () => {
          suppressed.push(true);
          return () => suppressed.push('disposed');
        },
        getSectionOrder: (sectionName) => (sectionName === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : undefined),
        section: (section) => {
          sectionCalls.push(section);
          sections.push(section);
          return () => sections.push('disposed');
        },
      },
      effect: (callback, label) => {
        const dispose = callback();
        agentEffects.push({ label, dispose });
        return dispose;
      },
    },
    _observed: { restricted, suppressed, sections, sectionCalls, agentEffects, calls, agentListeners, guards, registered },
  };
  agent.session.events = [];
  agent.session.append = (type, data) => {
    const event = { type, data: structuredClone(data), seq: agent.session.events.length, time: Date.now() };
    agent.session.events.push(event);
    return event;
  };
  fakeSessions.set(agent.session.id, agent.session);
  return agent;
}

const INTRO = 'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.';

/** Build the baseline message dsh-agent-instructions injects. */
function baselineMessage(paths = ['~/.dsh/AGENTS.md', 'AGENTS.md']) {
  const sections = paths.map((path) => `Instructions from: ${path}\n\nBODY of ${path}`);
  const text = `<system-reminder>\n\n${[INTRO, ...sections].join('\n\n')}\n</system-reminder>`;
  return {
    id: 'baseline-1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'agent-instructions', form: 'instructions', baseline: true, baselineIdentity: 'x', changes: [] },
  };
}

/** Run one pre-step through the gate's listener. */
async function preStep(ctx, agent, messages) {
  return ctx.dispatch('agent/pre-step', { agent, messages, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }));
}

/** Run one request through the gate's waterfall. */
async function request(ctx, agent, base) {
  return ctx.dispatch('agent/request', { agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => base);
}

/**
 * Run one tool assembly through the listeners registered on ONE agent's scope.
 *
 * Mirrors `EventsService.waterfall`: every listener receives the same payload
 * plus `next`, and the outermost return value is authoritative. Only the
 * listeners of the agent under test run — a real scoped dispatch admits exactly
 * those (verified against the live registry in `catalog.test.mjs`).
 * @param agent - the agent whose own-scope listeners are dispatched.
 * @param tools - the assembly's tool table, as bare names or schema objects.
 * @param contextAgent - the `context.agent` the loop would pass; defaults to the agent.
 * @returns the resulting tool NAMES, sorted (a tool table is a set here).
 */
async function assembleTools(agent, tools, contextAgent = agent) {
  const listeners = [...(agent._observed.agentListeners.get('system-prompt/assemble') ?? [])];
  const table = tools.map((tool) => (typeof tool === 'string' ? { name: tool, description: tool, parameters: {} } : tool));
  const payload = { sections: [], contexts: [], tools: table, variables: {} };
  const next = (index) => () => (index >= listeners.length
    ? Promise.resolve(payload)
    : listeners[index](payload, { agent: contextAgent, scope: contextAgent }, next(index + 1)));
  return (await next(0)()).tools.map((tool) => tool.name).sort();
}

/** The catalog a depth-0 `frugal` orchestrator really sees on the user's profile. */
const OBSERVED_CATALOG = [
  // Registered through the agent's OWN scope by the Team / schedule bundles:
  // unreachable by `restrict()`.
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
  'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update',
  // Registered into the agent's OWN scope by the GATE: the wait seam `restrict()`
  // cannot name either (it does not exist in any inherited layer).
  'wait_subagent',
  // Inherited from the preset scope: removed by `restrict()`.
  'subagent', 'ask_user_question',
];

/** The three names the gate's catalog filter and guard enforce by default. */
const ALLOWED = ['subagent', 'ask_user_question', 'wait_subagent'];
/** The two of them `restrict()` may name (the preset's layer holds no `wait_subagent`). */
const RESTRICT_ALLOWED = ['subagent', 'ask_user_question'];
/** The same three names, in the order a sorted assembly table reports them. */
const ALLOWED_SORTED = [...ALLOWED].sort();
/** The whole observed table, sorted the same way. */
const CATALOG_SORTED = [...OBSERVED_CATALOG].sort();

// ── Defaults: the depth-0 orchestrator is cut down, children are untouched. ───
{
  const { config } = liveConfig();
  const { ctx, logs } = fakeCtx();
  apply(ctx, config);

  const orchestrator = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent: orchestrator });
  assert.deepEqual(orchestrator._observed.restricted, [{ allow: RESTRICT_ALLOWED }],
    'restrict() gets the restrictable subset: wait_subagent lives in the agent own layer');
  assert.deepEqual(orchestrator._observed.suppressed, [true]);
  assert.deepEqual(
    orchestrator._observed.registered.map((entry) => (typeof entry === 'string' ? entry : entry.name)),
    ['subagent', 'wait_subagent'],
    'the gate registers its own delegation surface into the agent own layer',
  );

  const child = fakeAgent(1);
  await ctx.dispatch('agent/created', { agent: child });
  assert.deepEqual(child._observed.restricted, [], 'a depth-1 child keeps the full preset');
  assert.deepEqual(child._observed.suppressed, []);
  assert.deepEqual(child._observed.registered, [], 'a child gets no gate tools of its own');

  const deepened = fakeAgent(0);
  deepened.options.subagentDepth = 2;
  await ctx.dispatch('agent/created', { agent: deepened });
  assert.deepEqual(deepened._observed.restricted, [], 'the runtime option can only deepen');

  assert.ok(logs.some((entry) => entry.level === 'debug'), 'the gate narrates its decision');
}

// ── Preset filter: another preset's agents are never governed. ────────────────
{
  const { config } = liveConfig();
  const { ctx } = fakeCtx(() => 'standard');
  apply(ctx, config);
  const foreign = fakeAgent(0, 'standard');
  await ctx.dispatch('agent/created', { agent: foreign });
  assert.deepEqual(foreign._observed.restricted, []);
  assert.deepEqual(foreign._observed.suppressed, []);
}

// ── The preset is not final at creation: `agent-preset/selected` governs. ─────
// This is the regression that made every switch look dead: DSH opens a session
// on the profile's `selectedDefault` and the user switches preset afterwards,
// so a gate reading the preset only at `agent/created` governs nothing.
{
  let preset = 'code-gitbash';
  const { config } = liveConfig();
  const { ctx, registry } = fakeCtx(() => preset);
  apply(ctx, config);

  const agent = fakeAgent(0, 'code-gitbash');
  registry.set(agent.session.id, agent);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.restricted, [], 'the profile default is not governed');
  assert.deepEqual(agent._observed.sections, []);

  preset = 'frugal';
  await ctx.dispatch('agent-preset/selected', agent.session.id, 'frugal');
  assert.deepEqual(agent._observed.restricted, [{ allow: RESTRICT_ALLOWED }], 'the switch is picked up');
  assert.deepEqual(agent._observed.suppressed, [true]);
  assert.equal(agent._observed.sections.length, 1, 'the switch installs the orchestrator prompt');

  // Switching away releases everything again.
  preset = 'standard';
  await ctx.dispatch('agent-preset/selected', agent.session.id, 'standard');
  assert.equal(agent._observed.restricted.filter((entry) => entry === 'disposed').length, 1);
  assert.equal(agent._observed.suppressed.filter((entry) => entry === 'disposed').length, 1);
  assert.equal(agent._observed.sections.filter((entry) => entry === 'disposed').length, 1);

  // An unknown session id (or one with no live agent) is a no-op, not a throw.
  await ctx.dispatch('agent-preset/selected', 'session-not-live', 'frugal');
}

// ── The step and request hooks are a self-healing safety net. ────────────────
{
  let preset = 'code-gitbash';
  const { config } = liveConfig();
  const { ctx } = fakeCtx(() => preset);
  apply(ctx, config);
  const agent = fakeAgent(0, 'code-gitbash');

  // No announce-style hook ever saw this agent as frugal; the next step does.
  preset = 'frugal';
  await preStep(ctx, agent, []);
  assert.deepEqual(agent._observed.restricted, [{ allow: RESTRICT_ALLOWED }], 'pre-step repairs a missed decision');
  assert.equal(agent._observed.sections.length, 1);
}

// ── The orchestrator prompt is a scoped shadow of the preset's persona. ──────
{
  const { config } = liveConfig();
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  const [section] = agent._observed.sectionCalls;
  assert.equal(section.name, 'deployment:persona-prefix', 'the same name shadows the preset persona');
  assert.equal(section.order, 0);
  assert.equal(section.complete, true, 'a complete section keeps the whole prompt replaced');
  assert.equal(section.text, orchestratorSectionText(DEFAULT_PROMPT), 'the section carries the policy prompt plus the fixed contract');

  const child = fakeAgent(1);
  await ctx.dispatch('agent/created', { agent: child });
  assert.ok(child._observed.sections.at(-1).text.includes('子 agent'), 'a child receives its execution persona');
  assert.equal(child._observed.sections.at(-1).complete, undefined, 'worker persona does not inherit complete');
}
{
  const { config } = liveConfig({ orchestratorSystemPrompt: '只回一句话。' });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  const custom = agent._observed.sectionCalls[0].text;
  assert.equal(custom, orchestratorSectionText('只回一句话。'), 'a custom prompt still gets the fixed tool contract');
  assert.ok(custom.startsWith('只回一句话。'), 'and its own text survives verbatim');
  assert.ok(custom.includes(TOOL_CAPABILITY_SUFFIX), 'and it carries the fixed contract');
  assert.ok(custom.includes('run_in_background: false 明确不支持'), 'including the refused foreground flag');
}
{
  const { config } = liveConfig({ orchestratorSystemPrompt: '   \n  ' });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  assert.equal(agent._observed.sectionCalls[0].text, orchestratorSectionText(DEFAULT_PROMPT), 'blank restores the built-in prompt');
}
{
  // A prompt rewrite on a live agent replaces the section instead of stacking.
  const { config, refs } = liveConfig();
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  refs.orchestratorSystemPrompt[WRITE]('新身份');
  ctx.dispatch('loader/volatile-update', [['orchestratorSystemPrompt']]);
  assert.equal(agent._observed.sections.filter((entry) => entry === 'disposed').length, 1, 'the previous section was lifted');
  assert.equal(agent._observed.sectionCalls.at(-1).text, orchestratorSectionText('新身份'), 'a rewrite replaces the section and keeps the contract');
}
{
  // A plain pre-step (unchanged settings) must not churn the layers.
  const { config } = liveConfig();
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  await preStep(ctx, agent, []);
  await preStep(ctx, agent, []);
  assert.equal(agent._observed.restricted.length, 1, 'the reconciliation is idempotent');
  assert.equal(agent._observed.sectionCalls.length, 1);
}

// ── The diagnostic log records the decisions (the only observable surface). ──
{
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const home = mkdtempSync(join(tmpdir(), 'frugal-gate-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { config } = liveConfig({ diagnostics: true });
    const { ctx } = fakeCtx();
    apply(ctx, config);
    const agent = fakeAgent(0);
    await ctx.dispatch('agent/created', { agent });
    const lines = readFileSync(join(home, 'frugal-gate.log'), 'utf8').trim().split('\n');
    assert.ok(lines.some((line) => line.includes('boot log=')), 'the boot line names the log');
    assert.ok(lines.some((line) => line.includes('created id=session-') && line.includes('governed=true')));
    // The harness provides no attachment service, so the image reader cannot be
    // registered and the unknown name resolves through the built-in fallback; the
    // applied set is still the built-in quartet, and it is still recorded.
    assert.ok(lines.some((line) => line.includes('tools=fallback(')
      && line.includes('[subagent ask_user_question wait_subagent read_delivered_images]')),
      'the applied tool set is recorded');
    assert.ok(lines.some((line) => line.includes('/ok@0')), 'the prompt install is recorded');

    // The catalog line names what the MODEL receives — the scope-own tools that
    // `restrict()` cannot reach are counted as dropped. The order is the
    // assembly's own order (the gate only filters), so it is compared sorted.
    const catalogLine = () => readFileSync(join(home, 'frugal-gate.log'), 'utf8').split('\n').filter((line) => line.includes('catalog id='));
    const catalogTools = (line) => [.../tools=\[([^\]]*)\]/.exec(line)[1].split(' ')].sort();
    assert.deepEqual(catalogLine(), [], 'no catalog line before an assembly');
    await assembleTools(agent, OBSERVED_CATALOG);
    assert.equal(catalogLine().length, 1);
    assert.deepEqual(catalogTools(catalogLine()[0]), [...ALLOWED].sort(), 'the catalog line lists the surviving tools');
    assert.ok(catalogLine()[0].includes(`dropped=${OBSERVED_CATALOG.length - ALLOWED.length}`),
      'the scope-own tools are counted as dropped');
    await assembleTools(agent, OBSERVED_CATALOG);
    assert.equal(catalogLine().length, 1, 'an unchanged catalog is not re-logged every step');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

// ── Tools: an empty list means "no restriction"; skill is switch-owned. ───────
{
  const { config } = liveConfig({ orchestratorTools: '' });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.restricted, [], 'blank tool list keeps every tool');
  assert.deepEqual(agent._observed.suppressed, [true], 'runtime context is still a separate switch');
}
{
  const { config } = liveConfig({ orchestratorTools: 'subagent, skill, todo_write', includeSkills: false });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.restricted, [{ allow: ['subagent', 'todo_write'] }], 'the skills switch owns `skill`');
}
{
  const { config } = liveConfig({ orchestratorTools: 'subagent', includeSkills: true });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.restricted, [{ allow: ['subagent', 'skill'] }], 'the skills switch adds `skill` back');
}
{
  // An EXPLICIT list that reconciles down to nothing is the fail-open this case
  // exists for: `"skill"` with the skills switch off cleans to an empty array,
  // and an empty allow list is the documented spelling of "keep every tool" —
  // so the orchestrator silently kept all 15 tools while the text field said
  // `skill`. Blank input keeps its meaning; every other input has to end narrow.
  const { config, refs } = liveConfig({ orchestratorTools: 'skill', includeSkills: false });
  const { ctx, logs } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });

  assert.deepEqual(agent._observed.restricted, [{ allow: RESTRICT_ALLOWED }],
    'the reconciled-to-empty list falls back to the built-in trio');
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG), ALLOWED_SORTED,
    'and the model-facing catalog is the pair, not the whole toolset');
  assert.match(agent._observed.guards[0]({ name: 'bash' }), /not available to this orchestrator/,
    'the guard enforces the pair too');
  assert.ok(
    logs.some((entry) => entry.level === 'error' && entry.message.includes('reconciles to no tool')),
    'the fallback is logged loudly rather than applied silently',
  );

  // Blanking the field restores the documented "no restriction" meaning: the
  // filter and the guard are released instead of being kept at the fallback.
  refs.orchestratorTools[WRITE]('');
  ctx.dispatch('loader/volatile-update', [['orchestratorTools']]);
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG), CATALOG_SORTED, 'a blank field is still "keep everything"');
  assert.ok(agent._observed.guards.includes('disposed'), 'the fallback guard is released with the rest');
}
{
  // The boundary is "blank" vs "anything else", and it is deliberately narrow:
  // only a truly empty (or whitespace-only) field means "no restriction". A
  // field holding nothing but separators is a non-empty list that reconciles to
  // nothing, so it fails CLOSED with the same warning instead of silently
  // keeping every tool.
  const { config } = liveConfig({ orchestratorTools: ' ,  , ', includeSkills: false });
  const { ctx, logs } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.restricted, [{ allow: RESTRICT_ALLOWED }],
    'separators only = an explicit list with no names = the fail-closed fallback');
  assert.ok(logs.some((entry) => entry.level === 'error' && entry.message.includes('reconciles to no tool')));

  const spaces = liveConfig({ orchestratorTools: '   ', includeSkills: false });
  const blank = fakeCtx();
  apply(blank.ctx, spaces.config);
  const blankAgent = fakeAgent(0);
  await blank.ctx.dispatch('agent/created', { agent: blankAgent });
  assert.deepEqual(blankAgent._observed.restricted, [], 'whitespace only is still the documented "no restriction"');

  const skills = liveConfig({ orchestratorTools: 'skill', includeSkills: true });
  const second = fakeCtx();
  apply(second.ctx, skills.config);
  const skillOnly = fakeAgent(0);
  await second.ctx.dispatch('agent/created', { agent: skillOnly });
  assert.deepEqual(skillOnly._observed.restricted, [{ allow: ['skill'] }], 'with the switch on, `skill` alone is a real one-tool list');
}

// ── The model-facing catalog: scope-own tools are filtered out. ──────────────
// This is the mechanism the whole preset depends on. A restriction filters what
// a scope INHERITS, so the Agent Teams tools and the schedule tools — all
// registered through `agent.ctx.tools.register()`, i.e. into the agent's OWN
// layer — survived every `restrict()`. The catalog is filtered at
// `system-prompt/assemble`, whose return value is authoritative and whose
// dispatch a listener on the agent's own scope receives; `catalog.test.mjs`
// proves both facts against the real ToolRuntime/SystemPrompt/scope stack.
{
  const { config } = liveConfig();
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });

  const listeners = agent._observed.agentListeners.get('system-prompt/assemble') ?? [];
  assert.equal(listeners.length, 1, 'the filter is registered on the agent OWN scope, not the preset or the row');
  assert.ok(agent._observed.agentListeners.size >= 1);

  const kept = await assembleTools(agent, OBSERVED_CATALOG);
  assert.deepEqual(kept, ALLOWED_SORTED, 'the observed 19-tool catalog collapses to the allow list');
  assert.ok(!kept.includes('spawn_teammate'), 'the Team tools are gone even though no restriction reaches them');
  assert.ok(!kept.includes('schedule_create'), 'the schedule tools are gone');

  // The catalog alone is cosmetic: a scope-own registration stays EXECUTABLE.
  // The guard makes the same list true at execution time.
  const [guard] = agent._observed.guards;
  assert.equal(typeof guard, 'function', 'a tool guard enforces the same list');
  assert.equal(guard({ name: 'subagent' }), undefined, 'an allowed tool passes the guard');
  assert.equal(guard({ name: 'ask_user_question' }), undefined);
  // `run_code` is NOT an exception: a natively presenting scope can never carry
  // it (`ToolRuntime.view()` appends the reserved transport only for ptc/both,
  // and `register()` rejects the name), so the guard staying strict on it costs
  // nothing and keeps "exactly the allow list" literally true.
  assert.match(guard({ name: 'run_code' }), /not available to this orchestrator/);
  assert.match(guard({ name: 'spawn_teammate' }), /not available to this orchestrator/);

  // A tool injected AFTER the filter was installed is filtered on the next step.
  const injected = [...OBSERVED_CATALOG, 'mcp__late__tool'];
  assert.deepEqual(await assembleTools(agent, injected), ALLOWED_SORTED);

  // Fail-safe: an assembly for another agent is never touched.
  const foreign = await assembleTools(agent, OBSERVED_CATALOG, fakeAgent(0));
  assert.deepEqual(foreign, CATALOG_SORTED, 'a mismatched context.agent is left alone');
}
{
  // Workers keep execution tools while nested delegation is denied.
  const { config } = liveConfig();
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  const child = fakeAgent(1);
  await ctx.dispatch('agent/created', { agent });
  await ctx.dispatch('agent/created', { agent: child });

  assert.equal(child._observed.agentListeners.has('system-prompt/assemble'), true, 'a worker gets a nested-delegation filter');
  assert.equal(child._observed.guards.length, 1, 'workers have a nested-delegation guard');
  assert.deepEqual(await assembleTools(child, OBSERVED_CATALOG),
    ['ask_user_question', 'schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update', 'wait_subagent'],
    'workers retain non-delegation tools and lose Lead-only Team controls');
}
{
  // A GUI edit re-applies the filter with the new list (and releases the old).
  const { config, refs } = liveConfig();
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });

  refs.orchestratorTools[WRITE]('subagent, todo_write');
  ctx.dispatch('loader/volatile-update', [['orchestratorTools']]);
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG.concat('todo_write')), ['subagent', 'todo_write']);
  assert.deepEqual(
    agent._observed.agentListeners.get('system-prompt/assemble').length,
    1,
    'the previous listener was released instead of stacking',
  );
  assert.ok(agent._observed.guards.includes('disposed'), 'the previous guard was released');
}
{
  // A blank list still means "no restriction" — no catalog filter, no guard.
  // The delegation surface IS still installed: it is not an allow-list entry,
  // it is what the orchestrator's prompt is written against.
  const { config } = liveConfig({ orchestratorTools: '' });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  assert.equal(agent._observed.agentListeners.has('system-prompt/assemble'), false);
  assert.deepEqual([...agent._observed.agentListeners.keys()], ['subagent/start', 'subagent/end']);
  assert.deepEqual(agent._observed.guards, []);
  assert.deepEqual(agent._observed.registered.map((entry) => entry.name), ['subagent', 'wait_subagent']);
}
{
  // A name that NO layer provides (not the inherited ones, not the agent's own)
  // is a typo, and a typo must never silently shrink the orchestration surface:
  // the list fails loudly into the built-in trio, exactly like a list that
  // reconciles to nothing — the prompt still promises all three tools.
  const { config } = liveConfig({ orchestratorTools: 'subagent, not_a_tool' });
  const { ctx, logs } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.restricted, [{ allow: RESTRICT_ALLOWED }],
    'the fallback restriction is the built-in trio (minus the own-layer name)');
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG), ALLOWED_SORTED,
    'and the model gets the trio, not a silently reduced list');
  assert.equal(agent._observed.guards[0]({ name: 'wait_subagent' }), undefined);
  assert.match(agent._observed.guards[0]({ name: 'bash' }), /not available to this orchestrator/);
  assert.ok(logs.some((entry) => entry.level === 'error' && entry.message.includes('"not_a_tool"')),
    'the name that resolves to no tool is reported');
}
{
  // Same for a list of nothing but typos: the trio, never an empty catalog.
  const { config } = liveConfig({ orchestratorTools: 'not_a_tool' });
  const { ctx, logs } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.restricted, [{ allow: RESTRICT_ALLOWED }]);
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG), ALLOWED_SORTED,
    'the model gets the three tools, not zero and not everything');
  assert.ok(logs.some((entry) => entry.level === 'error' && entry.message.includes('"not_a_tool"')));
}
{
  // A name that exists ONLY in the agent's own layer is not a typo: the Agent
  // Teams / schedule tools are own-layer registrations the CATALOG filter is the
  // only thing that can remove, so naming one is how a user keeps it. It is left
  // out of `restrict()` (which can never name it) and reported, but the catalog
  // filter and the guard honour it.
  const { config } = liveConfig({ orchestratorTools: 'subagent, spawn_teammate' });
  const { ctx, logs } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.restricted, [{ allow: ['subagent'] }],
    'the own-layer name is dropped from the restriction instead of failing the list');
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG), ['spawn_teammate', 'subagent'],
    'but the model-facing catalog keeps it');
  assert.equal(agent._observed.guards[0]({ name: 'spawn_teammate' }), undefined);
  assert.match(agent._observed.guards[0]({ name: 'send_message' }), /not available to this orchestrator/);
  assert.ok(!logs.some((entry) => entry.level === 'error'), 'a legitimate own-layer name is not an error');
}
{
  // The catalog must follow the list `restrict()` ACCEPTED, never a rejected
  // list: otherwise the orchestrator would be left with an empty catalog while
  // the restriction had already fallen back to the built-in trio. `restrict()`
  // is stubbed to reject here because the real one cannot reject a list the gate
  // has already narrowed — this is the defensive path.
  const { config } = liveConfig({ orchestratorTools: 'subagent, not_a_tool' });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  let calls = 0;
  agent.ctx.tools.restrict = (filter) => {
    calls += 1;
    if (calls === 1) throw new Error('tools.restrict() names unknown global tool "not_a_tool"');
    agent._observed.restricted.push(filter);
    return () => agent._observed.restricted.push('disposed');
  };
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG), ALLOWED_SORTED);
  assert.equal(agent._observed.guards[0]({ name: 'ask_user_question' }), undefined);
}
{
  // A PTC-presenting scope is an UNSUPPORTED configuration, and the gate is
  // FAIL-CLOSED about it. `run_code` can only be in an assembly when the scope
  // presents ptc/both, and in those modes the model's real surface is `run_code`
  // plus the SDK bindings generated from `sdkSchemas(scope)` — which the
  // assembly waterfall does not carry. The two dishonest options are "filter
  // anyway" (under `ptc` the assembly holds only `run_code`, so the model would
  // be left with ZERO tools) and "keep the third tool and call it two". The
  // gate takes neither: the assembly listener throws a CONFIG-UNSUPPORTED error,
  // which aborts the agent loop's pre-step BEFORE the request header is built,
  // so the model request is never sent. The guard stays strict as well.
  const { config } = liveConfig();
  const { ctx, logs } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });

  await assert.rejects(
    assembleTools(agent, ['run_code', ...OBSERVED_CATALOG]),
    (error) => error?.code === 'CONFIG-UNSUPPORTED' && /CONFIG-UNSUPPORTED/.test(error.message),
    'a PTC-presenting assembly is REFUSED, not handed back untouched',
  );
  assert.ok(
    logs.some((entry) => entry.level === 'error' && entry.message.includes('CONFIG-UNSUPPORTED')),
    'the unsupported configuration is reported loudly',
  );
  const [guard] = agent._observed.guards;
  assert.equal(typeof guard, 'function', 'the guard is still installed in the unsupported state');
  assert.equal(guard({ name: 'subagent' }), undefined, 'an allow-listed tool still passes the guard');
  assert.equal(guard({ name: 'ask_user_question' }), undefined);
  assert.match(guard({ name: 'run_code' }), /not available to this orchestrator/, 'never fail-open: the transport is denied like any other outsider');
  assert.match(guard({ name: 'spawn_teammate' }), /not available to this orchestrator/, 'and so is every scope-own tool');
}
{
  // The same configuration, detected up front from the registry's own resolver
  // (the shape a `ptc` deployment really has): the collector is installed and
  // REJECTS, and the guard is installed strict. Nothing is ever silently
  // handed over, and the inherited-layer restriction still applies.
  const { config } = liveConfig();
  const { ctx, logs } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  agent.ctx.tools.modeFor = () => 'ptc';
  await ctx.dispatch('agent/created', { agent });
  await assert.rejects(
    assembleTools(agent, ['run_code']),
    (error) => error?.code === 'CONFIG-UNSUPPORTED' && /presentation=ptc/.test(error.message) && /source=presentation/.test(error.message),
    'a resolver-reported PTC presentation blocks the assembly instead of passing it through',
  );
  assert.deepEqual(agent._observed.restricted, [{ allow: RESTRICT_ALLOWED }], 'the inherited-layer restriction still applies');
  const [guard] = agent._observed.guards;
  assert.equal(typeof guard, 'function', 'the guard is installed under a resolver-reported PTC presentation');
  assert.equal(guard({ name: 'subagent' }), undefined);
  assert.match(guard({ name: 'run_code' }), /not available to this orchestrator/, 'no half-enforcement: the transport is denied');
  assert.match(guard({ name: 'spawn_teammate' }), /not available to this orchestrator/);
  assert.ok(
    logs.some((entry) => entry.level === 'error' && entry.message.includes('presentation=ptc')),
    'the mode is named in the error, and nothing claims a three-tool catalog',
  );
}
{
  // An agent ctx without the event API cannot carry the delegation surface, and
  // the surface is what the prompt is written against — so this is FAIL-CLOSED,
  // not "skip the filter and keep going": the agent's setup throws
  // CONFIG-TOOLS-UNAVAILABLE and everything already installed for it is released
  // again (a half-applied orchestrator must not survive).
  const { config } = liveConfig();
  const { ctx, logs } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  delete agent.ctx.on;
  await assert.rejects(
    async () => ctx.dispatch('agent/created', { agent }),
    (error) => error?.code === 'CONFIG-TOOLS-UNAVAILABLE' && /no event API/.test(error.message),
    'a ctx that cannot host the delegation surface fails the agent closed',
  );
  assert.deepEqual(agent._observed.restricted, [{ allow: RESTRICT_ALLOWED }, 'disposed'],
    'the restriction is released with the rest of the abandoned effect set');
  assert.deepEqual(agent._observed.suppressed, [true, 'disposed']);
  assert.ok(logs.some((entry) => entry.level === 'error' && entry.message.includes('no event API')));
}

{
  // Fail-safe resolution: Cordis' proxy throws for an accessor no fiber on the
  // chain injects. The gate must fall back to the inject-free lookup for BOTH
  // services instead of tearing down the listener.
  const { config } = liveConfig();
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  const registry = agent.ctx.tools;
  Object.defineProperty(agent.ctx, 'tools', {
    configurable: true,
    get() { throw new Error('cannot get property "tools" without inject'); },
  });
  Object.defineProperty(agent.ctx, 'systemPrompt', {
    configurable: true,
    get() { throw new Error('cannot get property "systemPrompt" without inject'); },
  });
  // `tools` resolves inject-free; `systemPrompt` deliberately does not (the
  // gate has to degrade to "no prompt override" for that one).
  agent.ctx.get = (service) => (service === 'tools' ? registry : undefined);

  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.restricted, [{ allow: RESTRICT_ALLOWED }], 'the restriction still applies');
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG), ALLOWED_SORTED, 'the catalog is still filtered');
  assert.deepEqual(agent._observed.suppressed, [], 'a prompt registry that cannot be resolved degrades to no override');
  assert.deepEqual(agent._observed.registered.map((entry) => entry.name), ['subagent', 'wait_subagent'],
    'the delegation surface is installed through the inject-free registry too');

  // With NEITHER resolution the registry is gone, so the delegation surface
  // cannot be installed: that is the same fail-closed path, and nothing of the
  // effect set survives.
  const second = fakeAgent(0);
  delete second.ctx.tools;
  delete second.ctx.systemPrompt;
  await assert.rejects(
    async () => ctx.dispatch('agent/created', { agent: second }),
    (error) => error?.code === 'CONFIG-TOOLS-UNAVAILABLE',
  );
  assert.deepEqual(second._observed.guards, []);
  assert.equal(second._observed.agentListeners.get('system-prompt/assemble')?.length ?? 0, 0,
    'the catalog filter that had already been installed was released again');
  assert.deepEqual(second._observed.registered, [], 'no tool of the abandoned surface is left registered');
  assert.deepEqual(second._observed.sectionCalls, [], 'and no prompt section survives either');
}

// ── Runtime context can be kept. ─────────────────────────────────────────────
{
  const { config } = liveConfig({ includeRuntimeContext: true });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.suppressed, [], 'runtime context can be kept');
}

// ── A rejected restrict() falls back instead of bricking the session. ─────────
{
  const { config } = liveConfig({ orchestratorTools: 'subagent, not_a_tool' });
  const { ctx, logs } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  let calls = 0;
  agent.ctx.tools.restrict = (filter) => {
    calls += 1;
    if (calls === 1) throw new Error('tools.restrict() names unknown global tool "not_a_tool"');
    agent._observed.restricted.push(filter);
    return () => agent._observed.restricted.push('disposed');
  };
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.restricted, [{ allow: RESTRICT_ALLOWED }]);
  assert.ok(logs.some((entry) => entry.level === 'error'), 'the fallback is logged loudly');
}

// ── Context switches rewrite the injected baseline. ──────────────────────────
{
  const { config } = liveConfig({ includeGlobalAgentsMd: false, includeProjectAgentsMd: true });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });

  const message = baselineMessage();
  const decision = await preStep(ctx, agent, [message]);
  assert.equal(decision.messages.length, 1);
  const rewritten = decision.messages[0];
  assert.notEqual(rewritten, message, 'the baseline was rewritten');
  const text = rewritten.content[0].text;
  assert.ok(!text.includes('~/.dsh/AGENTS.md'), 'the user-global block is gone');
  assert.ok(text.includes('Instructions from: AGENTS.md'), 'the project block survives');
  assert.ok(text.includes('</system-reminder>'), 'the frame is intact');
  assert.equal(rewritten.source, message.source, 'the source keeps its identity for reconciliation');
}
{
  const { config } = liveConfig({ includeGlobalAgentsMd: true, includeProjectAgentsMd: false });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  const decision = await preStep(ctx, agent, [baselineMessage()]);
  const text = decision.messages[0].content[0].text;
  assert.ok(text.includes('Instructions from: ~/.dsh/AGENTS.md'), 'the global block survives');
  assert.ok(!text.includes('Instructions from: AGENTS.md'), 'the project block is gone');
}
{
  const { config } = liveConfig({ includeGlobalAgentsMd: false, includeProjectAgentsMd: false });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  const decision = await preStep(ctx, agent, [baselineMessage()]);
  const text = decision.messages[0].content[0].text;
  assert.ok(!text.includes('Instructions from: '), 'every instruction section is gone');
  assert.ok(text.includes('</system-reminder>'), 'the frame survives, so reconciliation never re-injects');
}
{
  const { config } = liveConfig({ includeGlobalAgentsMd: false, includeProjectAgentsMd: false });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });

  // Fail-safe: an unrelated user message is never touched, and a block with no
  // `Instructions from: ` marker passes through byte for byte.
  const plain = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } };
  const decision = await preStep(ctx, agent, [plain]);
  assert.equal(decision.messages[0], plain);

  const broken = { id: 'b1', role: 'user', content: [{ type: 'text', text: 'no marker here' }], source: { kind: 'agent-instructions', form: 'instructions', changes: [] } };
  const kept = await preStep(ctx, agent, [broken]);
  assert.equal(kept.messages[0], broken, 'a marker-less block is passed through');

  // A child is not governed, so its baseline is untouched even with both off.
  const child = fakeAgent(1);
  await ctx.dispatch('agent/created', { agent: child });
  const childDecision = await preStep(ctx, child, [baselineMessage()]);
  assert.equal(childDecision.messages[0].source.kind, 'agent-instructions');
  assert.ok(childDecision.messages[0].content[0].text.includes('~/.dsh/AGENTS.md'), 'the child keeps the full baseline');
}
{
  const { config } = liveConfig({ includeGlobalAgentsMd: false, includeProjectAgentsMd: false });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  const message = baselineMessage();
  const first = await preStep(ctx, agent, [message]);
  const second = await preStep(ctx, agent, [message]);
  assert.equal(first.messages[0], second.messages[0], 'the rewrite is memoised per message');
}

// ── Model override: children by default, the orchestrator only when set. ─────
{
  const { config } = liveConfig();
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const orchestrator = fakeAgent(0);
  const child = fakeAgent(1);
  await ctx.dispatch('agent/created', { agent: orchestrator });
  await ctx.dispatch('agent/created', { agent: child });

  const base = { provider: 'session-provider', model: 'session-model' };
  assert.deepEqual(await request(ctx, child, base), {
    provider: 'fixture-provider',
    model: 'fixture/model-1',
    reasoningEffort: 'low',
  }, 'the child is routed; the output cap is @nu11dev/dsh-compaction-policy\'s decision now');
  assert.deepEqual(await request(ctx, orchestrator, base), base, 'the orchestrator keeps the session route untouched');
}
// ── An EMPTY child route is an inherit, not an override. ─────────────────────
// This is the shipped default, so it is the path every fresh install takes.
{
  const { config } = liveConfig({ subagentProvider: '', subagentModel: '', subagentReasoningEffort: '' });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const orchestrator = fakeAgent(0);
  const child = fakeAgent(1);
  await ctx.dispatch('agent/created', { agent: orchestrator });
  await ctx.dispatch('agent/created', { agent: child });

  const base = { provider: 'session-provider', model: 'session-model', temperature: 0.3 };
  assert.deepEqual(await request(ctx, child, base), base,
    'an all-empty child route leaves the session route (and its extra keys) untouched');
}
// A PARTIAL route only overrides the half it names.
{
  const { config } = liveConfig({ subagentProvider: '', subagentModel: 'fixture/model-2', subagentReasoningEffort: '' });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const orchestrator = fakeAgent(0);
  const child = fakeAgent(1);
  await ctx.dispatch('agent/created', { agent: orchestrator });
  await ctx.dispatch('agent/created', { agent: child });

  const base = { provider: 'session-provider', model: 'session-model' };
  assert.deepEqual(await request(ctx, child, base), { provider: 'session-provider', model: 'fixture/model-2' },
    'only the configured half is overridden');
}
{
  const { config } = liveConfig({ orchestratorProvider: 'hubway', orchestratorModel: 'claude-opus-5-5' });
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const orchestrator = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent: orchestrator });
  const overridden = await request(ctx, orchestrator, { provider: 'x', model: 'y', temperature: 0.3 });
  assert.deepEqual(overridden, { provider: 'hubway', model: 'claude-opus-5-5', temperature: 0.3 });
}
{
  const { config } = liveConfig();
  const { ctx } = fakeCtx(() => 'standard');
  apply(ctx, config);
  const foreign = fakeAgent(1, 'standard');
  await ctx.dispatch('agent/created', { agent: foreign });
  const base = { provider: 'p', model: 'm' };
  assert.equal(await request(ctx, foreign, base), base, 'another preset keeps its own model');
}

// ── A volatile write re-applies to live agents without a remount. ────────────
{
  const { config, refs } = liveConfig();
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.restricted, [{ allow: RESTRICT_ALLOWED }]);

  refs.orchestratorTools[WRITE]('subagent, todo_write, present');
  refs.includeRuntimeContext[WRITE](true);
  ctx.dispatch('loader/volatile-update', [['orchestratorTools'], ['includeRuntimeContext']]);
  assert.deepEqual(agent._observed.restricted.at(-1), { allow: ['subagent', 'todo_write', 'present'] });
  assert.equal(agent._observed.restricted.filter((entry) => entry === 'disposed').length, 1, 'the previous restriction was lifted');

  // A live write also reaches the context switches on the next step.
  refs.includeProjectAgentsMd[WRITE](false);
  const decision = await preStep(ctx, agent, [baselineMessage()]);
  assert.ok(!decision.messages[0].content[0].text.includes('Instructions from: '), 'turning both off on the fly empties the baseline');

  // Changing the preset id stops governing an existing agent.
  refs.presetId[WRITE]('other');
  ctx.dispatch('loader/volatile-update', [['presetId']]);
  assert.equal(agent._observed.restricted.filter((entry) => entry === 'disposed').length, 2);
}

// ── A live `presetId` flip must re-tighten what it un-governed. ──────────────
// Switching `presetId` away RELEASES the agent and drops it from `governed`, so
// a sweep over that set alone can never bring it back: the live session would
// keep the full catalog forever while the GUI said `frugal` again. The sweep
// therefore asks the `agents` service for every live agent, and the write is
// synchronous, so even a session whose next assembly precedes its next
// `agent/pre-step` is already narrowed.
{
  /** The live session stays on the `frugal` preset; only the GUI's `presetId` moves. */
  const { config, refs } = liveConfig();
  const { ctx, registry } = fakeCtx(() => 'frugal');
  apply(ctx, config);

  const agent = fakeAgent(0, 'frugal');
  registry.set(agent.session.id, agent);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG), ALLOWED_SORTED);

  refs.presetId[WRITE]('standard');
  ctx.dispatch('loader/volatile-update', [['presetId']]);
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG), CATALOG_SORTED,
    'a `presetId` that no longer matches the session releases it');
  assert.ok(agent._observed.guards.includes('disposed'), 'and its guard is lifted');

  refs.presetId[WRITE]('frugal');
  ctx.dispatch('loader/volatile-update', [['presetId']]);
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG), ALLOWED_SORTED,
    'editing `presetId` back re-tightens the SAME live session, which `governed` no longer remembered');
  assert.match(agent._observed.guards.at(-1)({ name: 'spawn_teammate' }), /not available to this orchestrator/,
    'the guard is restored with it');
}
{
  // The same sweep picks up a live agent the gate has never decided about (a
  // session opened before this row mounted, or while `presetId` pointed
  // elsewhere), while a delegated child — which is live too, and is IN `list()`
  // — must not be touched.
  const { config, refs } = liveConfig();
  const { ctx, registry } = fakeCtx();
  apply(ctx, config);

  const late = fakeAgent(0, 'frugal');
  const child = fakeAgent(1, 'frugal');
  registry.set(late.session.id, late);
  registry.set(child.session.id, child);

  refs.orchestratorTools[WRITE]('subagent, todo_write');
  ctx.dispatch('loader/volatile-update', [['orchestratorTools']]);
  assert.deepEqual(late._observed.restricted, [{ allow: ['subagent', 'todo_write'] }],
    'a live orchestrator the gate had never seen is governed on the next write');
  // The handler is synchronous, so the narrowing is already installed when the
  // dispatch returns — an assembly that precedes the session's next
  // `agent/pre-step` still sees the new catalog.
  assert.equal(late._observed.agentListeners.get('system-prompt/assemble').length, 1);
  assert.deepEqual(child._observed.restricted, [], 'a delegated child in `list()` is never gated by the sweep');
  assert.deepEqual(child._observed.suppressed, []);
  assert.equal(child._observed.agentListeners.has('system-prompt/assemble'), true, 'worker filter remains installed on sweep');
}
{
  // Compatibility fallback: a host whose `agents` service exposes neither
  // `list()` nor `roots()` still re-applies the agents this gate decided about —
  // including ones it had to release earlier — so a missing accessor costs
  // coverage, never correctness.
  const { config, refs } = liveConfig();
  const { ctx } = fakeCtx();
  const originalGet = ctx.get;
  ctx.get = (service) => (service === 'agents' ? { get: () => undefined } : originalGet(service));
  apply(ctx, config);

  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG), ALLOWED_SORTED);

  refs.presetId[WRITE]('standard');
  ctx.dispatch('loader/volatile-update', [['presetId']]);
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG), CATALOG_SORTED, 'released while the field names another preset');

  refs.presetId[WRITE]('frugal');
  ctx.dispatch('loader/volatile-update', [['presetId']]);
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG), ALLOWED_SORTED,
    'the connector-less host is re-tightened too, from the agents this gate remembers');

  refs.orchestratorTools[WRITE]('subagent, todo_write');
  ctx.dispatch('loader/volatile-update', [['orchestratorTools']]);
  assert.deepEqual(agent._observed.restricted.at(-1), { allow: ['subagent', 'todo_write'] },
    'the previously governed agent is still re-applied');
  assert.deepEqual(await assembleTools(agent, OBSERVED_CATALOG.concat('todo_write')), ['subagent', 'todo_write']);

  // Disposal prunes the memory, so a long-lived process does not accumulate
  // released sessions.
  ctx.dispatch('agent/disposed', { agent });
  refs.orchestratorTools[WRITE]('subagent');
  ctx.dispatch('loader/volatile-update', [['orchestratorTools']]);
  assert.equal(agent._observed.restricted.at(-1), 'disposed', 'a disposed agent is never re-gated');
}

// ── The delegation surface the prompt is written against, end to end. ────────
// The prompt promises `subagent` (create → `agent_id`, or continue by
// `agent_id`), `wait_subagent` (wait for dispatched children) and a hard refusal
// of `run_in_background: false`. Those are the definitions the GATE registers
// into the agent's own layer, shadowing the preset's upstream `subagent`, so
// this block drives the registered definitions themselves through the fake
// `subagents` service: the surface is real, not just a name in the allow list.
{
  const { config } = liveConfig();
  const { ctx, subagents } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });

  const definitions = Object.fromEntries(agent._observed.registered.map((entry) => [entry.name, entry]));
  assert.deepEqual(Object.keys(definitions), ['subagent', 'wait_subagent']);
  assert.ok(definitions.subagent.description.includes('agent_id'), 'the shadowing definition is the gate\'s, not the preset\'s');
  assert.equal(definitions.wait_subagent.name, 'wait_subagent');
  assert.equal(definitions.wait_subagent.parameters.properties.agent_ids.type, 'array');
  assert.deepEqual(definitions.wait_subagent.parameters.required, ['agent_ids']);
  assert.deepEqual(definitions.subagent.parameters.required, ['prompt']);

  const exec = { agent, signal: new AbortController().signal };
  // A foreground call is refused BEFORE any side effect: nothing is created.
  await assert.rejects(
    definitions.subagent.execute({ prompt: 'do the thing', run_in_background: false }, exec),
    (error) => error?.code === 'BACKGROUND_REFUSED' && /wait_subagent/.test(error.message),
    'run_in_background: false is refused with a pointer at the wait tool',
  );
  assert.deepEqual(subagents.created, [], 'and it created nothing before refusing');

  const started = await definitions.subagent.execute({ prompt: 'read the file', description: 'read file' }, exec);
  assert.equal(started.kind, 'continuable');
  assert.equal(started.agent_id, 'child-1');
  assert.equal(started.continued, false);
  assert.equal(subagents.created.length, 1);
  assert.equal(subagents.created[0].label, 'read file', 'the description becomes the label');
  assert.equal(subagents.created[0].request.maxDepth, 1, 'children cannot delegate further');
  assert.equal(subagents.created[0].request.persona.includes('子 agent'), true, 'the child brings its own persona');
  assert.deepEqual(subagents.created[0].request.agentOptions, {
    provider: 'fixture-provider',
    model: 'fixture/model-1',
    reasoningEffort: 'low',
  });

  // Continuing uses the same id and the child's own conversation.
  const again = await definitions.subagent.execute({ agent_id: started.agent_id, prompt: 'now the second half' }, exec);
  assert.equal(again.continued, true);
  assert.equal(again.agent_id, 'child-1');
  assert.equal(subagents.created.length, 1, 'continuing never creates a second child');
  assert.equal(subagents.sent.length, 1);

  // The wait tool reports the child's state through the same service.
  const waited = await definitions.wait_subagent.execute({ agent_ids: [started.agent_id], timeout_ms: 1 }, exec);
  assert.equal(waited.timed_out, true);
  assert.deepEqual(waited.results.map((entry) => entry.agent_id), ['child-1']);
  assert.equal(typeof waited.results[0].status, 'string');

  // An id that is not this agent's own session cannot be waited for.
  const self = await definitions.wait_subagent.execute({ agent_ids: [agent.session.id] }, exec);
  assert.equal(self.results[0].status, 'invalid');
}

// ── An EMPTY child route is passed as NO agentOptions (the child inherits). ──
{
  const { config } = liveConfig({ subagentProvider: '', subagentModel: '', subagentReasoningEffort: '' });
  const { ctx, subagents } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  const definitions = Object.fromEntries(agent._observed.registered.map((entry) => [entry.name, entry]));
  const exec = { agent, signal: new AbortController().signal };

  const started = await definitions.subagent.execute({ prompt: 'read the file', description: 'read file' }, exec);
  assert.equal(started.kind, 'continuable', 'an empty route still creates the child');
  assert.equal('agentOptions' in subagents.created[0].request, false,
    'no route is merged into the request, so the child keeps its own preset / parent route');
  assert.equal(subagents.created[0].request.persona.includes('子 agent'), true, 'the persona is unaffected by the route');
}

// ── The whole row is FAIL-CLOSED without the services the surface needs. ─────
// A governed agent must never run on a delegation surface other than the one its
// prompt describes: no `subagents` service (or a registry that refuses the
// names) means the agent's setup throws CONFIG-TOOLS-UNAVAILABLE, releasing
// everything it had already installed. Fail-closed is the contract — it is NOT
// "keep the preset's upstream tool and hope".
{
  const { config } = liveConfig();
  const { ctx, logs } = fakeCtx(() => 'frugal', { subagents: null });
  apply(ctx, config);
  const agent = fakeAgent(0);
  await assert.rejects(
    async () => ctx.dispatch('agent/created', { agent }),
    (error) => error?.code === 'CONFIG-TOOLS-UNAVAILABLE' && /subagents service is not available/.test(error.message),
    'a deployment without the subagents service fails the governed agent closed',
  );
  assert.deepEqual(agent._observed.restricted, [{ allow: RESTRICT_ALLOWED }, 'disposed'], 'the restriction was released again');
  assert.equal(agent._observed.agentListeners.get('system-prompt/assemble')?.length ?? 0, 0, 'and so was the catalog filter');
  assert.equal(agent._observed.agentListeners.get('subagent/start')?.length ?? 0, 0,
    'the lifecycle listeners installed for the abandoned surface were released too');
  assert.equal(agent._observed.agentListeners.get('subagent/end')?.length ?? 0, 0);
  assert.deepEqual(agent._observed.registered, [], 'nothing of the delegation surface is left behind');
  assert.ok(logs.some((entry) => entry.level === 'error'),
    'and the failure is reported on the observable surface');
}
{
  // The registry refusing the names is the other half of the same contract (a
  // same-layer duplicate, or a definition the registry rejects).
  const { config } = liveConfig();
  const { ctx } = fakeCtx();
  apply(ctx, config);
  const agent = fakeAgent(0);
  agent.ctx.tools.register = (definition) => {
    if (definition.name === 'wait_subagent') throw new Error('same-layer registration already exists');
    agent._observed.registered.push(definition);
    return () => agent._observed.registered.push('disposed');
  };
  await assert.rejects(
    async () => ctx.dispatch('agent/created', { agent }),
    (error) => error?.code === 'CONFIG-TOOLS-UNAVAILABLE' && /refused subagent, wait_subagent/.test(error.message),
  );
  assert.deepEqual(agent._observed.registered.map((entry) => (typeof entry === 'string' ? entry : entry.name)),
    ['subagent', 'disposed'],
    'the registration that HAD succeeded is unwound before the failure is reported');
}

// ── Unloading releases what it still owns. ──────────────────────────────────
{
  const { config } = liveConfig();
  const { ctx, effects } = fakeCtx();
  const listeners = [];
  const realOn = ctx.on;
  ctx.on = (event, handler) => {
    listeners.push(event);
    realOn(event, handler);
  };
  apply(ctx, config);
  assert.deepEqual(listeners, ['tools/execute', 'agent/created', 'agent/disposed', 'agent-preset/selected', 'loader/volatile-update', 'system-prompt/assemble', 'agent/pre-step', 'agent/request']);
  assert.deepEqual(effects.map((entry) => entry.label), ['frugal-gate.cleanup']);

  const agent = fakeAgent(0);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.agentEffects.map((entry) => entry.label), ['frugal-gate.agent']);
  agent._observed.agentEffects[0].dispose();
  assert.equal(agent._observed.restricted.at(-1), 'disposed', 'the agent effect releases its restriction');
  assert.equal(agent._observed.registered.at(-1), 'disposed', 'and its own-layer tool registrations');
  effects[0].dispose();
  assert.equal(agent._observed.suppressed.at(-1), 'disposed', 'unloading releases what the agent effect did not');
}

// ── Switching preset away releases the whole surface, including the tools. ───
{
  let preset = 'frugal';
  const { config } = liveConfig();
  const { ctx, registry } = fakeCtx(() => preset);
  apply(ctx, config);
  const agent = fakeAgent(0, 'frugal');
  registry.set(agent.session.id, agent);
  await ctx.dispatch('agent/created', { agent });
  assert.deepEqual(agent._observed.registered.map((entry) => entry.name), ['subagent', 'wait_subagent']);

  preset = 'standard';
  await ctx.dispatch('agent-preset/selected', agent.session.id, 'standard');
  assert.deepEqual(agent._observed.registered.slice(2), ['disposed', 'disposed'],
    'both gate tools are unregistered when the agent leaves the preset');
  assert.equal(agent._observed.agentListeners.get('system-prompt/assemble')?.length ?? 0, 0,
    'and the catalog filter goes with them');
  // The run bookkeeping is NOT an effect: a preset switch may be temporary, the
  // children of this agent keep running either way, and `subagent/end` is never
  // replayed — so the lifecycle listeners stay until the agent really goes.
  const remaining = [...agent._observed.agentListeners]
    .filter(([, list]) => list.length > 0)
    .map(([event]) => event)
    .sort();
  assert.deepEqual(remaining, ['subagent/end', 'subagent/start'],
    'the durable lifecycle listeners survive an un-govern');
  await ctx.dispatch('agent/disposed', { agent });
  assert.equal(agent._observed.agentListeners.get('subagent/start')?.length ?? 0, 0,
    'disposal releases the lifecycle listeners');
  assert.equal(agent._observed.agentListeners.get('subagent/end')?.length ?? 0, 0);
}

// ── The two halves agree on the schema's field names and the cell key. ───────
{
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  /** The file is checked out with CRLF; template literals normalise to LF. */
  const lf = (text) => text.replace(/\r\n/g, '\n');
  for (const key of Object.keys(Config.dict)) assert.ok(source.includes(`${key}:`), `client.js renders ${key}`);
  assert.ok(source.includes("'@nu11dev/dsh-frugal-orchestrator#frugal-gate'"), 'the row cell key names the bundle and the row');

  // The form must show the same default the Host would apply, or a user who
  // never touches the textarea would still see a different prompt on screen.
  const shipped = /const DEFAULT_PROMPT = `([\s\S]*?)`;/.exec(source);
  assert.ok(shipped !== null, 'client.js declares the default prompt');
  assert.equal(lf(shipped[1]), lf(DEFAULT_PROMPT), 'the client half ships the same default prompt as the host half');
  const mirrored = /orchestratorSystemPrompt: DEFAULT_PROMPT,/.test(source);
  assert.ok(mirrored, 'DEFAULTS points at the shared prompt constant');
  assert.ok(source.includes(`orchestratorTools: '${DEFAULT_TOOLS}'`), 'the client half ships the same default tool list');

  // The child route ships empty in BOTH halves (= inherit). A client copy that
  // still named the author's provider/model would be the default a user sees.
  for (const key of ['subagentProvider', 'subagentModel', 'subagentReasoningEffort']) {
    assert.equal(schemaDefault(key), '', `the schema default for ${key} is empty`);
    assert.ok(source.includes(`      ${key}: '',`), `client.js DEFAULTS ships ${key} empty like the schema`);
  }
  assert.ok(!/commandcode|deepseek-v4\.1-flash/.test(source), 'the client half names no private route');

  // The client half's own copy of the tool names has to name the wait tool: it
  // is the only hint the user gets about which name to keep in the allow list.
  const known = /const KNOWN_TOOLS = \[([\s\S]*?)\];/.exec(source);
  assert.ok(known !== null, 'client.js lists the preset tool names');
  for (const name of ['subagent', 'wait_subagent', 'ask_user_question', 'present', 'workflow']) {
    assert.ok(known[1].includes(`'${name}'`), `the tool hint names ${name}`);
  }
  // And the copy must not still claim the old two-tool surface.
  assert.ok(!/只剩两个|只有两个工具|内置对 subagent, ask_user_question(?!,)/.test(source),
    'no shipped copy still describes the two-tool surface');
}

console.log(`frugal-gate unit harness: all assertions passed (profile: ${profileDir})`);
