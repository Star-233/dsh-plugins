// Integration harness for plugins/dsh-frugal-orchestrator/index.js.
//
// `gate.test.mjs` drives the gate against fakes. This harness drives it against
// the REAL stack that decides what the model sees:
//
//   @deepseek-ai/cordis            — the actual scope-tagged event dispatch
//   @deepseek-ai/dsh-scope         — createScope/bindScopeParent (the same calls
//                                    `ReactLoopAgent` and `applyChildComposition`
//                                    use: an agent scope keyed by the agent
//                                    object, a child scope joined to the preset)
//   @deepseek-ai/dsh-tools         — the real ToolRuntime (register/restrict/
//                                    guard/view) and its assembly provider
//   @deepseek-ai/dsh-system-prompt — the real SystemPrompt.assemble() waterfall
//
// It reproduces the observed production catalog (Agent Teams + schedule tools
// registered into the agent's OWN scope), then asserts what the model would
// receive — `assembly.tools`, the array the agent loop hands to the request
// header — plus what may execute. No model call, no dsh process, no user
// profile or installed package is touched.
//
//   node catalog.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Point DSH_PROFILE_DIR at a profile whose node_modules holds schemastery: the
 * gate resolves that package from the active profile at load time.
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

/**
 * Locate the `@deepseek-ai` directory that ships the dsh runtime packages.
 *
 * A profile's node_modules holds only the peer packages, so the runtime is
 * found the way the CLI's own resolver finds it: next to the `dsh` executable,
 * or beside it in the global npm root.
 * @returns the absolute `@deepseek-ai` package directory.
 */
function findDshPackages() {
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
const packages = process.env.DSH_TOOLS_DIR ?? findDshPackages();
/** Import one runtime module by path inside the install. */
const load = (relative) => import(pathToFileURL(join(packages, relative)).href);

// The gate's diagnostic log is its documented observable surface, so the
// harness points `$DSH_HOME` at a throwaway directory and asserts on the file
// instead of on the user's real `~/.dsh/frugal-gate.log`.
const logHome = mkdtempSync(join(tmpdir(), 'frugal-gate-catalog-'));
process.env.DSH_HOME = logHome;
const logFile = join(logHome, 'frugal-gate.log');
/** @returns the diagnostic log written so far ('' before the first line). */
function logText() {
  try {
    return readFileSync(logFile, 'utf8');
  } catch {
    return '';
  }
}

const { Context } = await load('cordis/lib/index.js');
const { ToolRuntime, defineTool } = await load('dsh-tools/lib/index.js');
const { SystemPrompt } = await load('dsh-system-prompt/lib/index.js');
const { createScope } = await load('dsh-scope/lib/index.js');
const { apply: applyGate, Config, TOOL_CAPABILITY_SUFFIX } = await import('./index.js');

// ── The gate's live config, shaped exactly like a settings document ──────────
const WRITE = Symbol('cosmokit.volatile.write');
/** @returns a frozen reference whose value only its writer changes. */
function volatileRef(value) {
  let current = value;
  return Object.freeze({ get: () => current, [WRITE]: (next) => { current = next; } });
}
const SCHEMA = Config({});
/** @returns the plain default behind a possibly-volatile schema field. */
function schemaDefault(key) {
  let value = SCHEMA[key];
  for (let step = 0; step < 4 && value !== null && typeof value === 'object' && typeof value.get === 'function'; step += 1) value = value.get();
  return value;
}
function liveConfig(overrides = {}) {
  const plain = {
    presetId: 'frugal',
    orchestratorTools: schemaDefault('orchestratorTools'),
    orchestratorSystemPrompt: schemaDefault('orchestratorSystemPrompt'),
    includeGlobalAgentsMd: false,
    includeProjectAgentsMd: true,
    includeSkills: false,
    includeRuntimeContext: false,
    subagentProvider: '',
    subagentModel: '',
    subagentReasoningEffort: '',
    orchestratorProvider: '',
    orchestratorModel: '',
    orchestratorReasoningEffort: '',
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

/** One registered tool, minimal but valid for the real ToolRuntime. */
const tool = (name) => defineTool({
  name,
  description: `tool ${name}`,
  parameters: {},
  output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: name }] },
  execute: async () => name,
});

/**
 * Register tools in a context's OWN layer, the way a tool plugin does.
 * @param ctx - the scope whose layer receives the registrations.
 * @param names - tool names to register.
 */
async function register(ctx, ...names) {
  await ctx.plugin({
    name: `register-${names.join('-')}`,
    inject: ['tools'],
    apply(toolCtx) {
      for (const name of names) toolCtx.tools.register(tool(name));
    },
  });
}

// ── The production composition, reproduced ───────────────────────────────────
const INHERITED = ['subagent', 'ask_user_question', 'bash', 'todo_write', 'skill'];
/** Registered through `agent.ctx` by the Agent Teams and schedule bundles. */
const OWN_LAYER = [
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
  'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update',
];
const OBSERVED_CATALOG = [...INHERITED, ...OWN_LAYER];

const root = new Context();
root.logger.level = 4;
await root.plugin(SystemPrompt, {});
await root.plugin(ToolRuntime, {});
const { SessionStore } = await load('dsh-session/lib/index.js');
const { SessionQueryEngine } = await load('dsh-session-query/lib/index.js');
await root.plugin(SessionStore);
await root.plugin(SessionQueryEngine);
root.on('session/flush', () => {}); // isolated in-memory durability sink
const session = (id, header = {}) => root.sessions.create(id, { meta: header });
// The preset is a standing scope; the orchestrator is a scope keyed by the
// agent object itself (exactly `createScope(loopCtx, this)` in ReactLoopAgent),
// and a delegated child joins the PRESET's mount, not its parent's scope.
// The scopes are minted from a ctx that owns the registry and the prompt (the
// agent runtime's context in production), which is what makes `agent.ctx.tools`
// and `agent.ctx.systemPrompt` resolve through Cordis' dependency walk.
const presetKey = { kind: 'preset', id: 'frugal' };
const orchestrator = { id: 'orchestrator', session: session('s-root'), options: {} };
const child = { id: 'child', session: session('s-child', { delegationDepth: 1 }), options: {} };
let preset;
let agentScope;
let childScope;
await root.plugin({
  name: 'agent-runtime',
  inject: ['tools', 'systemPrompt'],
  apply(runtimeCtx) {
    preset = createScope(runtimeCtx, presetKey);
    agentScope = createScope(runtimeCtx, orchestrator, { parent: presetKey });
    childScope = createScope(runtimeCtx, child, { parent: presetKey });
  },
});
orchestrator.ctx = agentScope.ctx;
child.ctx = childScope.ctx;
assert.equal(typeof agentScope.ctx.tools.restrict, 'function', 'the agent scope resolves the registry the way production does');

await register(preset.ctx, ...INHERITED);
await register(agentScope.ctx, ...OWN_LAYER);
// A child's own-layer tool (the delegation runtime registers its
// structured-output tool there): it must survive untouched.
await register(childScope.ctx, 'structured_output');

/** Assemble exactly the way the agent loop does (`assembleContextFor`). */
const assemble = (agent) => root.systemPrompt.assemble({ agent, scope: agent });
const names = (assembly) => assembly.tools.map((entry) => entry.name).sort();
/** One tool invocation as the agent loop submits it (a caller-owned signal included). */
const call = (name, callId, agent, args = {}) => ({ name, callId, arguments: args, agent, signal: new AbortController().signal });

// ── Control: the registry view keeps scope-own tools whatever restrict() says ─
{
  const registry = root.get('tools');
  assert.deepEqual(registry.schemas(orchestrator).map((entry) => entry.name).sort(), [...OBSERVED_CATALOG].sort(),
    'every preset tool plus every scope-own tool is visible to the registry');
  const dispose = agentScope.ctx.get('tools').restrict({ allow: ['subagent', 'ask_user_question'] });
  const afterRestrict = registry.schemas(orchestrator).map((s) => s.name);
  for (const name of OWN_LAYER) {
    assert.ok(afterRestrict.includes(name), `restrict() cannot remove the scope-own tool ${name}`);
  }
  assert.ok(!afterRestrict.includes('bash'), 'restrict() removes an inherited tool');
  const childNames = registry.schemas(child).map((s) => s.name);
  assert.ok(childNames.includes('bash'), 'a child scope keeps its inherited tools');
  dispose();

  const before = await assemble(orchestrator);
  assert.deepEqual(names(before), [...OBSERVED_CATALOG].sort(), 'the model-facing catalog before the gate');
  console.log(`  before the gate: ${before.tools.length} tools (${INHERITED.length} inherited + ${OWN_LAYER.length} in the agent's own layer)`);
  // The own-layer tools really execute: this is why hiding them in the catalog
  // alone would be cosmetic.
  const ran = await registry.execute(call('spawn_teammate', 'pre-1', orchestrator));
  assert.equal(ran.isError, false, `an own-layer tool executes before the gate: ${JSON.stringify(ran).slice(0, 120)}`);
}

// ── Install the gate as the top-level row it ships as ───────────────────────
const gate = liveConfig({
  diagnostics: true,
  // A PROFILE-level child route — deliberately NOT the shipped default: the
  // bundle ships `''` (= inherit), so this exercises the override path, and the
  // tool call below can assert the agentOptions the gate merges into the request.
  subagentProvider: 'profile-provider',
  subagentModel: 'profile/model-x',
  subagentReasoningEffort: 'high',
});
root.reflect.provide('agentPresets', { composedPreset: () => 'frugal' });
// The real `agents` service (dsh-agent): `list()` is every live agent, `roots()`
// the top-level ones. The gate sweeps it on a volatile write, which is the only
// way a `presetId` edit can re-tighten a session it just released.
const living = new Set();
root.reflect.provide('agents', {
  get: (id) => [...living].find((agent) => agent.session.id === id),
  list: () => [...living],
  roots: () => [...living].filter((agent) => (agent.session?.header?.delegationDepth ?? 0) === 0),
});
// The gate's delegation surface needs the real `subagents` service shape:
// `getProvider('spawn')` with `prepareContinuable`, `startContinuable`,
// `sendMessage` and `listChildren`. `@deepseek-ai/dsh-subagents` is that shape;
// loading the real one would need a session-persistence backend, so the harness
// supplies the same interface and records what the tools did with it.
const delegations = { created: [], sent: [] };
root.reflect.provide('subagents', {
  getProvider: (name) => (name === 'spawn'
    ? { name: 'spawn', prepareContinuable: () => ({}) }
    : undefined),
  list: () => ['spawn', 'fork'],
  async startContinuable({ label, request }) {
    const childId = `child-${delegations.created.length + 1}`;
    delegations.created.push({ childId, label, request });
    return { childId, messageId: `accept-${delegations.created.length}` };
  },
  async sendMessage(parent, childId, blocks) {
    delegations.sent.push({ parent, childId, blocks });
    return `accept-continue-${delegations.sent.length}`;
  },
  async listChildren() {
    return delegations.created.map((entry) => ({ id: entry.childId, mode: 'continuable', label: entry.label }));
  },
});
await root.plugin({
  name: 'frugal-gate',
  inject: ['tools', 'systemPrompt'],
  apply: (ctx) => applyGate(ctx, gate.config),
});
living.add(orchestrator);
living.add(child);
await root.serial('agent/created', { agent: orchestrator });
await root.serial('agent/created', { agent: child });

/** The three-tool surface, in the sorted order the harness reports names. */
// What this harness actually registers and can therefore SEE: the delegation pair
// and the question tool. The default allow list also names the READ half of the
// image bridge, but this harness provides no attachment service, so that tool is
// not registered here (see DEFAULT_NAMES below and images.test.mjs).
const ALLOWED = ['ask_user_question', 'subagent', 'wait_subagent'];
/** The default allow list itself, which includes the plugin's own image reader. */
const DEFAULT_NAMES = [...ALLOWED, 'read_delivered_images'].sort();

// ── What the model receives ─────────────────────────────────────────────────
{
  const registry = root.get('tools');
  const assembly = await assemble(orchestrator);
  assert.deepEqual(names(assembly), ALLOWED, 'the orchestrator sees exactly the tools that exist in its scope');
  console.log(`  after the gate:  ${assembly.tools.length} tools (${names(assembly).join(', ')})`);
  assert.ok(assembly.tools.every((entry) => typeof entry.description === 'string' && entry.parameters !== undefined),
    'the surviving schemas are complete projections, not stripped stubs');

  // The `subagent` in the model's catalogue is the GATE's definition (own-layer
  // registration shadowing the preset's), and the wait seam is only reachable
  // through it.
  const subagentDefinition = registry.get('subagent', orchestrator);
  assert.ok(subagentDefinition.description.includes('WITHOUT `agent_id` this CREATES a child'),
    'the model sees the gate definition of subagent, not the preset one');
  assert.ok(subagentDefinition.parameters.properties.agent_id !== undefined, 'the gate definition takes agent_id');
  assert.ok(registry.get('wait_subagent', orchestrator) !== undefined);
  assert.equal(registry.guardReason({ name: 'wait_subagent', callId: 'g0', arguments: {}, agent: orchestrator }), undefined,
    'the own-layer wait tool passes the same guard');

  // The registry view is untouched — that is the whole point: the removal lives
  // in the model-facing catalog plus the guard, never in the layers.
  const view = registry.schemas(orchestrator).map((s) => s.name);
  for (const name of OWN_LAYER) assert.ok(view.includes(name), `${name} is still registered (own layer)`);

  // Execution: hidden scope-own tools are denied, the allow list runs.
  assert.equal(registry.guardReason({ name: 'spawn_teammate', callId: 'g1', arguments: {}, agent: orchestrator }),
    'frugal-gate: tool "spawn_teammate" is not available to this orchestrator (available: subagent, ask_user_question, wait_subagent, read_delivered_images)',
    'the guard denies a scope-own Team tool');
  assert.equal(registry.guardReason({ name: 'subagent', callId: 'g2', arguments: {}, agent: orchestrator }), undefined);
  const denied = await registry.execute(call('spawn_teammate', 'post-1', orchestrator));
  assert.equal(denied.isError, true, 'the denied tool does not run');
  assert.ok(JSON.stringify(denied.content).includes('not available to this orchestrator'),
    `the denial names the gate: ${JSON.stringify(denied.content).slice(0, 200)}`);
  const allowed = await registry.execute(call('subagent', 'post-2', orchestrator, { prompt: 'list the entry points' }));
  assert.equal(allowed.isError, false, 'an allowed tool still runs — through the gate definition, against the real service');
  assert.equal(delegations.created.length, 1, 'and it really created a continuable child');
  assert.deepEqual(delegations.created[0].request.agentOptions, {
    provider: 'profile-provider',
    model: 'profile/model-x',
    reasoningEffort: 'high',
  });

  // A tool injected AFTER the filter is installed is filtered on the next step.
  await register(agentScope.ctx, 'mcp__late__tool');
  assert.deepEqual(names(await assemble(orchestrator)), ALLOWED, 'late injection is filtered too');
  assert.equal(registry.guardReason({ name: 'mcp__late__tool', callId: 'g3', arguments: {}, agent: orchestrator })?.startsWith('frugal-gate:'), true);

  // The child is untouched: same assembly waterfall, different scope.
  const childAssembly = await assemble(child);
  console.log(`  a depth-1 child: ${childAssembly.tools.length} tools (${names(childAssembly).join(', ')})`);
  assert.ok(names(childAssembly).includes('bash'), 'a child keeps every preset tool');
  assert.ok(names(childAssembly).includes('structured_output'), 'a child keeps its own structured-output tool');
  assert.equal(registry.guardReason({ name: 'bash', callId: 'g4', arguments: {}, agent: child }), undefined, 'the guard never covers a child');
  const childRuns = await registry.execute(call('bash', 'child-1', child));
  assert.equal(childRuns.isError, false, 'a child still runs preset tools');

  // Fail-safe identity check: an assembly FOR another root agent that is
  // dispatched under THIS agent's scope key (the shape a too-broad listener
  // would filter) is left alone.
  const other = { id: 'other-root', session: session('s-other'), options: {} };
  let otherScope;
  await root.plugin({
    name: 'other-runtime',
    inject: ['tools'],
    apply(runtimeCtx) { otherScope = createScope(runtimeCtx, other, { parent: presetKey }); },
  });
  other.ctx = otherScope.ctx;
  living.add(other);
  await root.serial('agent/created', { agent: other });
  assert.deepEqual(names(await assemble(other)), ALLOWED, 'the other root agent is governed too');
  const crossed = await root.systemPrompt.assemble({ agent: other, scope: orchestrator });
  assert.ok(crossed.tools.length > 2, 'an assembly whose context.agent is not this agent is never rewritten');
  assert.ok(names(crossed).includes('spawn_teammate'), 'the crossed assembly keeps its scope-own tools');
}

// ── A live `presetId` edit must re-tighten what it just released ─────────────
// Against the REAL stack: the volatile write releases every agent whose composed
// preset no longer matches (and drops it from the gate's own `governed` set), so
// editing the field back can only reach that live session through the `agents`
// service. Both directions are asserted on `assembly.tools` and on the real
// `guardReason`, and the delegated child stays outside it all.
{
  // Everything the orchestrator would see with no gate at all: the observed
  // catalog plus the tool injected into its own scope by the earlier block.
  const fullCatalog = [...OBSERVED_CATALOG, 'mcp__late__tool'].sort();
  const registry = root.get('tools');

  gate.refs.presetId[WRITE]('standard');
  root.emit('loader/volatile-update', [['presetId']]);
  assert.deepEqual(names(await assemble(orchestrator)), fullCatalog,
    'a `presetId` that no longer matches releases the live session');
  assert.equal(registry.get('wait_subagent', orchestrator), undefined,
    'releasing the agent also unregisters the gate own-layer tools');
  assert.equal(registry.guardReason({ name: 'spawn_teammate', callId: 'v1', arguments: {}, agent: orchestrator }), undefined,
    'and lifts its guard');

  gate.refs.presetId[WRITE]('frugal');
  root.emit('loader/volatile-update', [['presetId']]);
  assert.deepEqual(names(await assemble(orchestrator)), ALLOWED,
    'editing `presetId` back re-tightens the SAME live session (the sweep reads `agents.list()`)');
  for (const peer of [...living].filter((candidate) => candidate !== orchestrator && candidate !== child)) {
    assert.deepEqual(names(await assemble(peer)), ALLOWED,
      `every live root agent is covered by the sweep, not just the one that was governed (${peer.id})`);
  }
  assert.match(
    registry.guardReason({ name: 'spawn_teammate', callId: 'v2', arguments: {}, agent: orchestrator }),
    /not available to this orchestrator/,
    'the guard is restored with the catalog',
  );
  const childAgain = await assemble(child);
  assert.ok(names(childAgain).includes('bash'), 'the child is untouched by the sweep');
  assert.ok(names(childAgain).includes('structured_output'), 'including its own structured-output tool');
  assert.equal(registry.guardReason({ name: 'bash', callId: 'v3', arguments: {}, agent: child }), undefined);
}

// ── An explicit tool list that reconciles to nothing fails CLOSED ────────────
// `orchestratorTools: "skill"` with the skills switch off cleans down to an
// empty allow list, which is the documented spelling of "keep every tool": the
// orchestrator used to keep the whole observed catalog while the field said
// `skill`. Blank input keeps that meaning; anything else ends up narrow.
{
  gate.refs.orchestratorTools[WRITE]('skill');
  root.emit('loader/volatile-update', [['orchestratorTools']]);
  const registry = root.get('tools');
  assert.deepEqual(names(await assemble(orchestrator)), ALLOWED,
    'the reconciled-to-empty list falls back to the built-in trio on the REAL stack');
  assert.match(
    registry.guardReason({ name: 'bash', callId: 'e1', arguments: {}, agent: orchestrator }),
    /not available to this orchestrator/,
  );
  assert.match(logText(), /CONFIG-FALLBACK .*requested=skill/, 'the fallback is recorded on the documented surface');

  // And the documented "no restriction" spelling still works: the catalog filter
  // and the guard are released, while the delegation surface STAYS installed —
  // it is not an allow-list entry, it is the seam the prompt is written against.
  gate.refs.orchestratorTools[WRITE]('');
  root.emit('loader/volatile-update', [['orchestratorTools']]);
  assert.deepEqual(names(await assemble(orchestrator)), [...OBSERVED_CATALOG, 'mcp__late__tool', 'wait_subagent'].sort(),
    'a blank field keeps every tool, on purpose');
  assert.equal(registry.guardReason({ name: 'spawn_teammate', callId: 'e2', arguments: {}, agent: orchestrator }), undefined,
    'and the guard is gone with it');
  assert.ok(registry.get('wait_subagent', orchestrator) !== undefined, 'the gate wait tool is still there');

  gate.refs.orchestratorTools[WRITE](schemaDefault('orchestratorTools'));
  root.emit('loader/volatile-update', [['orchestratorTools']]);
  assert.deepEqual(names(await assemble(orchestrator)), ALLOWED);
}

// ── A typo falls back loudly; an own-layer name is a legitimate entry ────────
// The two questions are different, and the real registry answers both:
// `knownNames` (global + ancestors + the agent's OWN layer) says whether a name
// EXISTS, `restrictableNames` (global + ancestors only) says whether
// `restrict()` may name it.
{
  const registry = root.get('tools');
  // 1. A name no layer holds is a typo. Silently dropping it would turn
  //    `subagent, wait_subagentt` into a ONE-tool orchestrator while the prompt
  //    still promises three, so the list fails into the built-in trio instead.
  gate.refs.orchestratorTools[WRITE]('subagent, wait_subagentt');
  root.emit('loader/volatile-update', [['orchestratorTools']]);
  assert.deepEqual(names(await assemble(orchestrator)), ALLOWED, 'a typo falls back to the built-in trio');
  assert.match(logText(), /CONFIG-UNKNOWN [^\n]*names=\[wait_subagentt\]/, 'the typo is named in the diagnostic log');
  assert.match(logText(), /CONFIG-FALLBACK [^\n]*allow=\[subagent ask_user_question wait_subagent read_delivered_images\]/);
  assert.match(registry.guardReason({ name: 'wait_subagent', callId: 't1', arguments: {}, agent: orchestrator }) ?? '', /^$/,
    'the wait tool is inside the fallback allow list, so it passes the guard');

  // 2. `spawn_teammate` exists — in the agent's OWN layer. Naming it is how a
  //    user keeps a Team tool for this one agent, so it must NOT be treated as a
  //    typo: it stays in the catalog and the guard allows it, even though
  //    `restrict()` can never name it.
  gate.refs.orchestratorTools[WRITE]('subagent, spawn_teammate');
  root.emit('loader/volatile-update', [['orchestratorTools']]);
  assert.deepEqual(names(await assemble(orchestrator)), ['spawn_teammate', 'subagent'],
    'an own-layer name is honoured by the catalog filter');
  assert.equal(registry.guardReason({ name: 'spawn_teammate', callId: 't2', arguments: {}, agent: orchestrator }), undefined,
    'and by the guard');
  assert.match(registry.guardReason({ name: 'send_message', callId: 't3', arguments: {}, agent: orchestrator }),
    /not available to this orchestrator/, 'the names it did not list stay denied');
  assert.match(logText(), /CONFIG-OWN-LAYER [^\n]*names=\[spawn_teammate\]/, 'and it is reported as an own-layer entry, not an error');

  gate.refs.orchestratorTools[WRITE](schemaDefault('orchestratorTools'));
  root.emit('loader/volatile-update', [['orchestratorTools']]);
  assert.deepEqual(names(await assemble(orchestrator)), ALLOWED);
  assert.equal(registry.guardReason({ name: 'spawn_teammate', callId: 't4', arguments: {}, agent: orchestrator }),
    'frugal-gate: tool "spawn_teammate" is not available to this orchestrator (available: subagent, ask_user_question, wait_subagent, read_delivered_images)');
}

// ── A non-native presentation is REFUSED, never silently emptied ─────────────
// Built with the REAL registry: `presentAs('ptc')` on a scope makes `view()`
// append the reserved `run_code` transport, and `wireSchemas()` collapse the
// catalog to it. A strict allow-list filter over that assembly would leave the
// model with ZERO tools, and keeping `run_code` would be a third tool. The gate
// does neither: the assembly waterfall THROWS a CONFIG-UNSUPPORTED error, which
// is exactly what aborts `ReactLoopAgent.preStep()` before it builds the request
// header — the request is never sent. The execution guard stays strict there.
{
  const registry = root.get('tools');
  assert.equal(registry.get('run_code', orchestrator), undefined,
    'a natively presenting scope can never resolve the reserved transport');
  assert.match(registry.guardReason({ name: 'run_code', callId: 'p0', arguments: {}, agent: orchestrator }),
    /not available to this orchestrator/,
    'and the guard treats it like any other non-allow-listed name — no exception');

  // A PTC runtime backend is what a `ptc` deployment loads; the harness supplies
  // the same shape (`requirePtcRuntime` reads `language`).
  root.reflect.provide('ptcRuntime', { language: 'typescript' });
  const ptc = { id: 'ptc-root', session: session('s-ptc'), options: {} };
  let ptcScope;
  await root.plugin({
    name: 'ptc-runtime',
    inject: ['tools', 'systemPrompt'],
    apply(runtimeCtx) { ptcScope = createScope(runtimeCtx, ptc, { parent: presetKey }); },
  });
  ptc.ctx = ptcScope.ctx;
  ptcScope.ctx.tools.presentAs('ptc');

  living.add(ptc);
  await root.serial('agent/created', { agent: ptc });
  // The scope's own resolver reports `ptc` before any assembly, so the gate
  // knows up front and refuses every assembly: no tool table — not the host's
  // untouched one, not an emptied one — ever reaches a model.
  await assert.rejects(assemble(ptc), (error) => error?.code === 'CONFIG-UNSUPPORTED' && /presentation=ptc/.test(error.message),
    'a `ptc` scope gets no assembled tool table: the request is refused');
  assert.match(registry.guardReason({ name: 'run_code', callId: 'p1', arguments: {}, agent: ptc }),
    /not available to this orchestrator/,
    'and the guard stays strict: the transport is denied like any other outsider');
  assert.match(logText(), /CONFIG-UNSUPPORTED id=\S+ presentation=ptc source=presentation/,
    'the unsupported configuration is detected from the registry\'s own resolver and named in the diagnostic log');
  // The rest of the gate still applies to that agent: the inherited surface is
  // restricted, and the orchestrator prompt is installed.
  assert.deepEqual(names(await assemble(orchestrator)), ALLOWED, 'other agents are unaffected');

  // `both` is the same unsupported configuration (native schemas PLUS the
  // transport, whose SDK section still enumerates the scope's whole view): the
  // gate refuses there too, names the mode it found, and keeps the guard strict
  // even for the scope-own tool the filter alone could never have reached.
  const both = { id: 'both-root', session: session('s-both'), options: {} };
  let bothScope;
  await root.plugin({
    name: 'both-runtime',
    inject: ['tools', 'systemPrompt'],
    apply(runtimeCtx) { bothScope = createScope(runtimeCtx, both, { parent: presetKey }); },
  });
  both.ctx = bothScope.ctx;
  // A tool in that scope's OWN layer, the shape the Agent Teams bundle really
  // registers: it is unreachable by `restrict()`, so only the catalog filter or
  // the guard can stop it — and the gate refuses to assemble instead.
  await register(bothScope.ctx, 'spawn_teammate');
  bothScope.ctx.tools.presentAs('both');
  living.add(both);
  await root.serial('agent/created', { agent: both });
  await assert.rejects(assemble(both), (error) => error?.code === 'CONFIG-UNSUPPORTED' && /presentation=both/.test(error.message),
    'a `both` assembly is refused as well, transport and scope-own tool included');
  assert.match(registry.guardReason({ name: 'spawn_teammate', callId: 'p2', arguments: {}, agent: both }),
    /not available to this orchestrator/,
    'the scope-own tool is denied at execution time, not left executable behind a log line');
  assert.match(logText(), /CONFIG-UNSUPPORTED id=\S+ presentation=both source=presentation/);
}

// ── The assembled prompt really carries the fixed contract. ─────────────────
// Requirement B, proven against the real `SystemPrompt`: the `frugal` preset
// mounts `dsh-persona` with `complete: true`, and `assemble()` ends with
// `sections: [completeSection]` — every OTHER section is dropped. So the gate
// could not add the tool contract as a second section; it appends it to the one
// section it shadows, which is why the assembled prompt (the text the model
// really gets) contains it no matter what the user typed into the GUI.
{
  const dshPersona = await load('dsh-persona/lib/index.js');
  await preset.ctx.plugin(dshPersona, { prefix: 'preset persona（兜底）', complete: true });
  const assembled = await assemble(orchestrator);
  assert.equal(assembled.sections.length, 1, 'a complete section is restored as the ONLY prompt section');
  assert.equal(assembled.sections[0].name, 'deployment:persona-prefix', 'the gate shadows the preset persona by name');
  const text = assembled.sections[0].text;
  assert.ok(text.startsWith(schemaDefault('orchestratorSystemPrompt')), 'the assembled prompt is the configured policy text');
  assert.equal(text.split(TOOL_CAPABILITY_SUFFIX).length - 1, 1, 'and it carries the fixed contract exactly once');
  assert.ok(!text.includes('preset persona（兜底）'), 'the preset fallback is fully shadowed, not merged');
  // `dsh-persona` also registers a (non-complete) suffix section: it is a second
  // section, so the complete restore drops it — the reason the contract cannot
  // live in one either.
  assert.ok(!assembled.sections.some((section) => section.name === 'deployment:persona-suffix'));
  console.log(`  assembled prompt: ${text.length} chars, contract appended (${TOOL_CAPABILITY_SUFFIX.length} chars)`);
}

// ── Offline copy consistency: no shipped or deployed YAML may go stale. ──────
// The same three-tool surface is written down in four places (the host schema
// defaults, `client.js`, the bundle patch, and the preset's persona/persona
// fallback), and the ACTIVE profile may override the row again. A copy that
// still describes the old two-tool surface is invisible at runtime until the
// orchestrator cannot wait for anything, so it is checked here: these are source
// assertions on the real files, no dsh process and no model involved.
{
  const { existsSync, readFileSync } = await import('node:fs');
  /** The file is checked out with CRLF; YAML and template literals normalise to LF. */
  const lf = (text) => String(text).replace(/\r\n/g, '\n');
  const yamlEntry = join(dirname(packages), 'yaml', 'dist', 'index.js');
  assert.ok(existsSync(yamlEntry), `the dsh install ships a YAML parser (${yamlEntry})`);
  const yaml = await import(pathToFileURL(yamlEntry).href);
  /**
   * Parse one patch file. `!!js` expressions are host-evaluated (`dshHomePath`,
   * `process.env`), so the tag is stripped: only literal values are asserted.
   * @param path - the patch file.
   * @returns its parsed document.
   */
  const parsePatch = (path) => yaml.parse(lf(readFileSync(path, 'utf8')).replace(/!!js\s+/g, ''));
  /** Find a row by `id`, wherever a patch nests it (top level, `insert`, group). */
  const rowById = (node, id) => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = rowById(child, id);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    if (node === null || typeof node !== 'object') return undefined;
    if (node.id === id) return node;
    for (const value of Object.values(node)) {
      const hit = rowById(value, id);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const bundled = parsePatch(new URL('./cordis.patch.yml', import.meta.url));
  /** The schema's default tool list, as names — the one list every copy must match. */
  const defaultNames = String(schemaDefault('orchestratorTools')).split(/[,\s]+/).filter((name) => name.length > 0);
  assert.deepEqual([...defaultNames].sort(), DEFAULT_NAMES, 'the schema default is the orchestration surface');
  const gateRow = rowById(bundled, 'frugal-gate');
  const presetRow = rowById(bundled, 'preset-frugal');
  assert.ok(gateRow !== undefined && presetRow !== undefined, 'the bundle patch declares both rows');
  assert.equal(gateRow.config.orchestratorTools, schemaDefault('orchestratorTools'),
    'the bundled gate row ships the schema default tool list');
  // Left out on purpose (the comment in the patch says so): one source of truth
  // for the long prompt is the schema default, so it cannot drift.
  assert.equal(gateRow.config.orchestratorSystemPrompt, undefined,
    'the bundled gate row does not restate the prompt (the schema default is authoritative)');
  for (const name of defaultNames) {
    assert.ok(presetRow.config.description.includes(name), `the preset description names ${name}`);
  }
  assert.ok(!/只剩 subagent 与 ask_user_question/.test(presetRow.config.description),
    'the preset description no longer describes the two-tool surface');

  const personaRow = rowById(presetRow.config.plugins, 'persona');
  assert.ok(personaRow !== undefined, 'the preset still ships a persona fallback');
  assert.equal(lf(personaRow.config.prefix), lf(schemaDefault('orchestratorSystemPrompt')),
    'the preset persona fallback is byte-identical to the schema default prompt');
  assert.ok(!personaRow.config.prefix.includes(TOOL_CAPABILITY_SUFFIX),
    'the fallback does not repeat the fixed contract (the gate appends it)');

  const CHILD_PERSONA = (await import('./lib/delegation.js')).CHILD_PERSONA;
  const subagentRow = rowById(presetRow.config.plugins, 'tool-subagent');
  assert.equal(lf(subagentRow.config.persona), lf(CHILD_PERSONA),
    'the preset child persona is byte-identical to the one the gate installs');
  assert.equal(lf(subagentRow.config.persona).split('\n').length, lf(CHILD_PERSONA).split('\n').length);

  // ── The SHIPPED child route names no private provider. ────────────────────
  // Empty gate fields plus no preset fallback = "inherit", which is what a user
  // who never opens the row gets. Any value here would be the AUTHOR's own route.
  for (const key of ['subagentProvider', 'subagentModel', 'subagentReasoningEffort']) {
    assert.equal(gateRow.config[key], '', `the bundled gate row ships ${key} empty (= inherit)`);
  }
  assert.equal(subagentRow.config.agentOptions, undefined,
    'the bundled preset keeps no route fallback: an empty route inherits the parent');

  // The ACTIVE profile is the authority at runtime: an explicit row beats the
  // bundle's value, so an override written for the two-tool surface has to be
  // updated by hand (that is exactly what the deployment in this workspace did).
  //
  // Only THAT ONE ROW is looked at: the slice below stops at the next top-level
  // `- id:`, so no other (possibly credential-bearing) section of the user's
  // profile is ever parsed, let alone asserted on.
  const profilePatch = join(profileDir, 'cordis.patch.yml');
  const profileText = existsSync(profilePatch) ? lf(readFileSync(profilePatch, 'utf8')) : '';
  const rowStart = profileText.indexOf('- id: frugal-gate');
  if (rowStart === -1) {
    console.log(`  no frugal-gate override in ${profilePatch} (the bundle default applies)`);
  } else {
    const nextRow = profileText.indexOf('\n- id: ', rowStart + 1);
    const fragment = profileText.slice(rowStart, nextRow === -1 ? undefined : nextRow);
    const parsed = yaml.parse(fragment.replace(/!!js\s+/g, ''));
    // A slice that starts at a `- id:` line is a one-item sequence.
    const override = Array.isArray(parsed) ? parsed[0] : parsed;
    assert.equal(override?.id, 'frugal-gate', 'the profile override slice is exactly the gate row');
    const listed = override.config?.orchestratorTools;
    if (typeof listed === 'string' && listed.trim().length > 0) {
      for (const name of defaultNames) {
        assert.ok(listed.split(/[,\s]+/).includes(name),
          `the active profile's frugal-gate override must list ${name} (it has ${JSON.stringify(listed)}); `
          + 'an override that still names the old two-tool surface leaves the orchestrator unable to wait for its children');
      }
    }
    console.log(`  profile override checked: ${profilePatch} -> orchestratorTools=${JSON.stringify(listed ?? '<unset>')}`);
  }
}

console.log(`frugal-gate catalog integration: all assertions passed (packages: ${packages})`);
