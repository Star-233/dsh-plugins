// Unit harness for plugins/dsh-frugal-orchestrator/client.js.
//
// The browser half is hand-written (no build step), so this exercises it two
// ways:
//
//   1. A minimal element renderer that invokes every function component with
//      the two React APIs this half actually uses (`createElement`, `useState`).
//      That is what lets the harness reach real `onChange` handlers and assert
//      the exact `mutate()` ops a click produces.
//   2. When a real React + react-dom/server install is discoverable on this
//      machine, the same tree is rendered through it as a crash smoke test.
//      The browser half targets React 18; any 18/19 install is close enough for
//      `createElement` + `useState` + a static render.
//
// Neither path talks to a live dsh process.
//
//   node client.test.mjs
import assert from 'node:assert/strict';
import { existsSync, globSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Point DSH_PROFILE_DIR at a profile directory (used only to name the profile).
 * @returns the profile directory the harness will use.
 */
function ensureProfileDir() {
  const configured = process.env.DSH_PROFILE_DIR;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  const root = join(homedir(), '.dsh', 'profiles');
  if (!existsSync(root)) throw new Error(`no dsh profiles under ${root}; set DSH_PROFILE_DIR`);
  const first = readdirSync(root)[0];
  if (first === undefined) throw new Error(`no profiles under ${root}; set DSH_PROFILE_DIR`);
  process.env.DSH_PROFILE_DIR = join(root, first);
  return process.env.DSH_PROFILE_DIR;
}

const profileDir = ensureProfileDir();

// ── The two React APIs this half uses, plus a renderer that walks the tree. ──
// `useState` keeps its slot between renders so a handler's setter has an
// observable effect: without that, a staged edit could never be committed by a
// later event and the textarea's commit path would be untestable here.
const hookSlots = [];
const refSlots = [];
let hookCursor = 0;
let renderDepth = 0;
const React = {
  createElement(type, props, ...children) {
    const next = { ...(props ?? {}) };
    if (children.length === 1) next.children = children[0];
    else if (children.length > 1) next.children = children;
    return { type, props: next };
  },
  useState(initial) {
    const index = hookCursor;
    hookCursor += 1;
    if (hookSlots[index] === undefined) hookSlots[index] = typeof initial === 'function' ? initial() : initial;
    return [hookSlots[index], (next) => {
      hookSlots[index] = typeof next === 'function' ? next(hookSlots[index]) : next;
    }];
  },
  useRef(initial) {
    const index = hookCursor;
    hookCursor += 1;
    if (refSlots[index] === undefined) refSlots[index] = { current: initial };
    return refSlots[index];
  },
  // Effects run inline: the assertions below need the listeners the open panel
  // installs to exist right after the render that opened it.
  useEffect(effect) {
    const index = hookCursor;
    hookCursor += 1;
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups[index] = cleanup;
  },
};
/** Cleanups of the effects the current mount installed, by hook slot. */
const cleanups = [];

/** Portals the half created: `{ children, container, key }` in creation order. */
const portals = [];
const ReactDOM = {
  createPortal(children, container, key) {
    portals.push({ children, container, key });
    return { type: '__portal__', props: { children, container } };
  },
};

// The header geometry measured from the real page: the control's right edge
// sits at 650 CSS px, i.e. 186 px to the right of the sidebar seam (349), which
// is why an unclamped 360 px panel lost its left-hand text behind the sidebar.
// Mutable, so a test can move the control the way a window resize would.
let measuredRect = { top: 25, bottom: 47, right: 650, left: 528 };
/** How often the half measured its trigger: proves a scroll was skipped. */
let measuredCalls = 0;

/** Records every listener the half installs, so a test can fire one. */
function makeEventTarget(name) {
  const listeners = [];
  return {
    listeners,
    target: {
      name,
      listeners,
      addEventListener(type, handler, options) {
        listeners.push({ type, handler, capture: options === true });
      },
      removeEventListener(type, handler) {
        const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
  };
}

/** Every `Switch` the render reached, in order. */
const switches = [];
const Switch = (props) => {
  switches.push(props);
  return React.createElement('button', { type: 'button', 'data-switch': props.checked === true ? 'on' : 'off' }, props.label);
};

/**
 * Render one element tree into plain nodes.
 * @param element - a createElement result, a string, or nothing.
 * @returns a `{tag, props, children}` node, a string, or null.
 */
function render(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return null;
  if (Array.isArray(element)) return element.map(render).filter((child) => child !== null);
  if (typeof element === 'string' || typeof element === 'number') return String(element);
  const { type, props } = element;
  if (type === '__portal__') return render(props.children);
  if (typeof type === 'function') {
    // A hook cursor is per render pass, exactly like React's: only the
    // outermost call starts a new pass.
    if (renderDepth === 0) hookCursor = 0;
    renderDepth += 1;
    try {
      return render(type({ ...props }));
    } finally {
      renderDepth -= 1;
    }
  }
  assert.equal(typeof type, 'string', `a host element tag is expected, saw ${String(type)}`);
  const children = (Array.isArray(props.children) ? props.children : [props.children])
    .map(render)
    .flat()
    .filter((child) => child !== null);
  const node = { tag: type, props, children };
  // Attach refs the way a real renderer would, so the popover's
  // inside-the-panel click guard is reachable from here. A real DOM element
  // has `contains()`; this renders into plain nodes, so the method is added
  // here — on the NODE, exactly where the component looks for it. Both
  // properties stay NON-enumerable: the existing assertions JSON.stringify
  // whole trees, and an enumerable cyclic property would throw.
  const attach = (target, name, value) => Object.defineProperty(target, name, {
    value, writable: true, configurable: true, enumerable: false,
  });
  if (props.ref !== undefined && props.ref !== null && typeof props.ref === 'object') {
    attach(node, 'contains', (target) => target === node || nodes(node).includes(target));
    attach(node, 'getBoundingClientRect', () => { measuredCalls += 1; return measuredRect; });
    attach(props.ref, 'current', node);
  }
  return node;
}

/** Collect every node in a rendered tree. */
function nodes(node) {
  if (node === null || typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...node.children.flatMap(nodes)];
}

/** The single node matching a predicate, asserting it is unique. */
function one(tree, predicate, what) {
  const found = nodes(tree).filter(predicate);
  assert.equal(found.length, 1, `exactly one ${what}`);
  return found[0];
}

// ── Load the half the way the browser module system would. ───────────────────
let registration;
const windowTarget = makeEventTarget('window');
const documentTarget = makeEventTarget('document');
const body = { tag: 'body' };
globalThis.window = {
  innerWidth: 1851,
  innerHeight: 916,
  addEventListener: windowTarget.target.addEventListener,
  removeEventListener: windowTarget.target.removeEventListener,
  __ModuleLoader__: {
    load: (value) => {
      registration = value;
    },
  },
};
globalThis.document = {
  body,
  addEventListener: documentTarget.target.addEventListener,
  removeEventListener: documentTarget.target.removeEventListener,
};

await import('./client.js');
assert.equal(registration?.id, '@nu11dev/dsh-frugal-orchestrator', 'the registration id is the package name');

const moduleExports = registration.factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react-dom') return ReactDOM;
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Switch };
  throw new Error(`client.js required an unexpected module: ${specifier}`);
});
assert.deepEqual(moduleExports.inject, ['slots', 'configForms']);

// ── Mounting: the row cell is keyed by <bundle>#<row id>. ───────────────────
let page;
let watched;
const ctx = {
  effect: (callback) => callback(),
  configForms: {
    whileServed: (namespaces, register) => {
      watched = namespaces;
      return register(new Set(namespaces));
    },
  },
  slots: {
    inject: (_name, register) => register(),
    register: (options, component) => {
      page = { options, component };
      return () => {};
    },
  },
};
moduleExports.apply(ctx);
assert.deepEqual(watched, ['frugal-gate'], 'the page follows the row id as its settings namespace');
assert.equal(page.options.name, 'plugins.row.config');
assert.equal(page.options.key, '@nu11dev/dsh-frugal-orchestrator#frugal-gate');

const VALUES = {
  presetId: 'frugal',
  orchestratorTools: 'subagent, ask_user_question, wait_subagent',
  orchestratorSystemPrompt: '你是测试用的主 agent。',
  includeGlobalAgentsMd: false,
  includeProjectAgentsMd: true,
  includeSkills: false,
  includeRuntimeContext: false,
  // Form values, as the Host would hand them over (NOT the shipped defaults: the
  // bundle ships these empty = inherit, which the placeholder test covers below).
  subagentProvider: 'profile-provider',
  subagentModel: 'profile/model-x',
  subagentReasoningEffort: 'low',
  orchestratorProvider: '',
  orchestratorModel: '',
  orchestratorReasoningEffort: '',
  diagnostics: true,
  minWaitTimeoutMs: '300000',
};
const writes = [];
/** The form face ui-plugin-manager passes as `props.form`. */
const form = {
  state: { status: 'ready', writable: true, revision: 7, value: { ...VALUES } },
  mutate: (ops) => {
    writes.push(ops);
    return Promise.resolve(true);
  },
};

/** Render the page with a form override, as a FRESH mount (hooks start empty). */
const pageTree = (overrides = {}) => {
  hookSlots.length = 0;
  return render(React.createElement(page.component, { view: 'page', form, ...overrides }));
};

/** Re-render the page as the SAME mount, so staged edits are still in their slots. */
const rerender = (overrides = {}) => render(React.createElement(page.component, { view: 'page', form, ...overrides }));

// ── Summary view: plain text, no controls. ─────────────────────────────────
assert.match(render(React.createElement(page.component, { view: 'summary', form })), /省钱编排/);

// ── Page view: every control renders with the Host's values. ───────────────
switches.length = 0;
const tree = pageTree();
const text = JSON.stringify(tree);
for (const copy of ['主 agent 的系统提示词', '生效范围', '主 agent 的工具', '主 agent 的上下文注入', '子 agent 的模型', '主 agent 的模型覆盖', '诊断']) {
  assert.ok(text.includes(copy), `the page renders the 「${copy}」 section`);
}
for (const copy of ['项目级 AGENTS.md', '用户全局 AGENTS.md', '技能目录（skills）', '运行时上下文', '写诊断日志']) {
  assert.ok(text.includes(copy), `the page renders the 「${copy}」 switch`);
}
assert.equal(switches.length, 5, 'five switches render');
assert.deepEqual(switches.map((entry) => [entry.label, entry.checked]), [
  ['项目级 AGENTS.md', true],
  ['用户全局 AGENTS.md', false],
  ['技能目录（skills）', false],
  ['运行时上下文', false],
  ['写诊断日志', true],
]);
assert.ok(switches.every((entry) => entry.disabled === false));

const input = (value) => one(tree, (node) => node.tag === 'input' && node.props.value === value, `input valued ${value}`);
input('frugal');
input('subagent, ask_user_question, wait_subagent');
input('profile/model-x');
input('profile-provider');
input('low');
assert.equal(nodes(tree).filter((node) => node.tag === 'input').length, 14, 'ten text and four numeric fields render');
// The new field is the wait minimum: it has to render as a TEXT input, because
// blank is a meaningful value ("no plugin lower bound") that `type=number` and
// a numeric commit path would erase.
const waitField = one(tree, (node) => node.tag === 'input' && node.props.value === '300000', 'the wait minimum input');
assert.equal(waitField.props.type, 'text', 'the wait minimum is a text field so blank stays blank');
assert.ok(text.includes('最低等待时长'), 'the wait field is labelled');
assert.ok(text.includes('3600000'), 'the label states the ceiling');
assert.ok(text.includes('subagent_fork'), 'the known-tool hint lists the preset tool names');
assert.ok(text.includes('wait_subagent'), 'including the gate-owned wait tool the allow list needs');
// The prompt hint has to say where the fixed tool contract lives: the box only
// edits the policy text, and a user who thinks the box is the whole prompt
// would look for the three tools' contract there.
assert.ok(text.includes('固定的工具能力说明'), 'the prompt hint names the appended fixed contract');
assert.ok(!text.includes('只剩两个') && !text.includes('只有两个工具'), 'no client copy still claims a two-tool surface');

// ── Blank (the shipped default) has to explain itself. ─────────────────────
// The child route ships empty = inherit, so an empty box must say so instead of
// looking like a missing value.
{
  const blankForm = {
    state: { status: 'ready', writable: true, revision: 8, value: { ...VALUES, subagentProvider: '', subagentModel: '', subagentReasoningEffort: '' } },
    mutate: () => Promise.resolve(true),
  };
  hookSlots.length = 0;
  const blankText = JSON.stringify(render(React.createElement(page.component, { view: 'page', form: blankForm })));
  assert.ok(blankText.includes('继承主 agent'), 'an empty route field shows the inherit placeholder');
  assert.ok(blankText.includes('留空 = 沿用父 agent'), 'and the section hint explains what blank means');
}
assert.equal(one(tree, (node) => node.tag === 'input' && node.props.value === 'low' && node.props.disabled === false, 'child effort input').props.placeholder, 'low / medium / high 或留空');

// ── The system prompt is a textarea: Enter is a newline, blur commits. ─────
const promptBox = one(tree, (node) => node.tag === 'textarea', 'the prompt textarea');
assert.equal(promptBox.props.value, '你是测试用的主 agent。');
assert.equal(promptBox.props.rows, 12);
assert.equal(promptBox.props.disabled, false);

// ── Flipping a switch writes one path op with no revision fence. ───────────
switches.find((entry) => entry.label === '技能目录（skills）').onChange(true);
assert.deepEqual(writes.at(-1), [{ op: 'set', path: ['includeSkills'], value: true }]);
switches.find((entry) => entry.label === '用户全局 AGENTS.md').onChange(true);
assert.deepEqual(writes.at(-1), [{ op: 'set', path: ['includeGlobalAgentsMd'], value: true }]);

// ── A text field commits on blur and on Enter, and stays quiet otherwise. ──
const toolInput = input('subagent, ask_user_question, wait_subagent');
toolInput.props.onChange({ target: { value: 'subagent, todo_write' } });
assert.equal(writes.length, 2, 'typing alone writes nothing');
const before = writes.length;
toolInput.props.onBlur();
assert.equal(writes.length, before, 'a blur that changed nothing writes nothing');
// The staged edit lives in the box: a re-render of the same mount shows it.
const stagedTools = rerender();
assert.ok(nodes(stagedTools).some((node) => node.tag === 'input' && node.props.value === 'subagent, todo_write'), 'the edit is staged');

// ── The prompt textarea stages locally, then writes the whole text. ────────
const beforePrompt = writes.length;
promptBox.props.onChange({ target: { value: '只派活，只回一句话。' } });
assert.equal(writes.length, beforePrompt, 'typing a prompt writes nothing');
promptBox.props.onKeyDown({ key: 'Enter', preventDefault: () => {} });
assert.equal(writes.length, beforePrompt, 'a bare Enter must insert a newline, not commit');
const staged = one(rerender(), (node) => node.tag === 'textarea', 'the prompt textarea');
assert.equal(staged.props.value, '只派活，只回一句话。', 'the edit is staged in the box');
let prevented = false;
staged.props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault: () => { prevented = true; } });
assert.equal(prevented, true, 'Ctrl+Enter commits');
assert.deepEqual(writes.at(-1), [{ op: 'set', path: ['orchestratorSystemPrompt'], value: '只派活，只回一句话。' }]);
switches.find((entry) => entry.label === '写诊断日志').onChange(false);
assert.deepEqual(writes.at(-1), [{ op: 'set', path: ['diagnostics'], value: false }]);

// ── A read-only deployment disables every control. ────────────────────────
switches.length = 0;
const locked = pageTree({ form: { ...form, state: { ...form.state, writable: false } } });
assert.ok(switches.every((entry) => entry.disabled === true), 'a read-only deployment locks the switches');
assert.ok(nodes(locked).filter((node) => node.tag === 'input').every((node) => node.props.disabled === true), 'and every text field');
assert.equal(nodes(locked).find((node) => node.tag === 'textarea').props.disabled, true, 'and the prompt box');

// ── Unavailable and loading states say so instead of rendering controls. ───
switches.length = 0;
assert.ok(JSON.stringify(render(React.createElement(page.component, { view: 'page' }))).includes('没有可写的配置'), 'a missing namespace is explained');
const loading = pageTree({ form: { ...form, state: { ...form.state, status: 'loading', value: undefined } } });
assert.ok(JSON.stringify(loading).includes('正在读取配置'), 'a pending read is explained');
assert.equal(switches.length, 0, 'no control renders before the Host answers');

// ── A partial projection still renders: missing keys fall back to defaults. ─
switches.length = 0;
const partial = pageTree({ form: { ...form, state: { ...form.state, value: {} } } });
assert.deepEqual(switches.map((entry) => entry.checked), [true, false, false, false, true], 'the schema defaults stand in');
assert.ok(JSON.stringify(partial).includes("subagent, ask_user_question, wait_subagent"), 'the default tool list stands in');
assert.ok(nodes(partial).find((node) => node.tag === 'textarea').props.value.includes('省钱编排'), 'the default prompt stands in');

// Cross-half defaults for all eight v0.3 fields.
const { Config } = await import('./index.js');
const defaults = Object.fromEntries(Object.entries(Config({})).map(([key, value]) => [key, typeof value?.get === 'function' ? value.get() : value]));
const numericKeys = ['maxMembers', 'maxConcurrent', 'checkpointSteps', 'checkpointMinutes'];
assert.deepEqual(nodes(partial).filter((n) => n.tag === 'input' && n.props.type === 'number').map((n) => n.props.value), numericKeys.map((k) => defaults[k]));
assert.equal(one(partial, (n) => n.tag === 'select', 'default mode').props.value, defaults.defaultCoordinationMode);
assert.ok(nodes(partial).some((n) => n.tag === 'input' && n.props.value === defaults.teamOrchestratorTools));
let headerSlot;
moduleExports.apply({ ...ctx, inject: (names, mount) => {
  assert.deepEqual(names, ['sessions']);
  mount({ get: () => ({}), slots: { inject: (_name, callback) => callback(), register: (options, component) => { headerSlot = { options, component }; return () => {}; } } });
} });
assert.equal(headerSlot.options.name, 'conversation.session.header.actions');
assert.equal(headerSlot.component, moduleExports.FrugalAction);
let parentId;
let running = false;
let response = { ok: true, value: { matched: true } };
const commands = [];
const responses = [];
const status = { data: { enabled: true, mode: 'subagent', budget: { members: [], reservations: [], counters: {} }, health: { routeSource: { provider: '继承', model: '继承', reasoningEffort: '插件配置覆盖' } }, personaWarning: '旧正文工具描述过时' }, telemetry: { modelMs: null } };
const headerProps = {
  sessionId: 'lead', useSession: (select) => select({ subagent: parentId ? { address: { parentSessionId: parentId } } : undefined }),
  useSessions: (select) => select({ projectionsBySession: { lead: { values: { frugal: status } } } }),
  useSessionStatus: (select) => select({ get: () => ({ running }) }),
  sessions: { binding: (id) => { assert.equal(id, 'lead'); return { session: { command: (line) => { commands.push(line); const promise = Promise.resolve(response); responses.push(promise); return promise; } } }; } },
};
const header = (fresh = true) => { if (fresh) hookSlots.length = 0; return render(React.createElement(headerSlot.component, headerProps)); };
const headerControl = (tree) => one(tree, (n) => n.tag === 'button' && typeof n.props.children === 'string' && n.props.children.includes('省钱编排'), 'header control');
/** Click the control, then re-render the SAME mount, as React would. */
const openHeader = () => { headerControl(header()).props.onClick(); return header(false); };

let headerTree = header();
assert.equal(nodes(headerTree).some((n) => n.tag === 'select'), false, 'the panel stays closed until the control is clicked');
assert.equal(portals.length, 0, 'a closed panel creates no portal');
headerTree = openHeader();
assert.equal(portals.at(-1).container, body, 'the open panel is portaled into document.body, so no ancestor can clip it');
assert.equal(portals.at(-1).key, 'panel', 'the portal carries a key: it sits in an array of children');
// F1: the FIRST painted frame is already placed. The click measures the
// trigger and stores the placement in the same batch as `open`, so there is no
// frame at the fallback corner and no 1193px jump to left 290.
const firstFrame = one(headerTree, (n) => n.tag === 'div' && n.props.style?.position === 'fixed', 'fixed panel');
assert.equal(firstFrame.props.style.left, 290, 'the panel is placed in the frame that opens it');
assert.equal(firstFrame.props.style.right, undefined, 'the fallback corner is never painted');
assert.equal(firstFrame.props.style.width, 360);
// F5: scrolling INSIDE the panel must not re-measure it (and therefore must
// not re-render). The harness re-runs effects on every render, so this counts
// measurements rather than renders: a real React only re-runs the effect when
// `open` flips, so the count it can add on its own is exactly one per render.
const scrollTree = header(false);
const scrollPanel = one(scrollTree, (n) => n.tag === 'div' && n.props.style?.position === 'fixed', 'fixed panel');
const scrollListener = windowTarget.listeners.filter((entry) => entry.type === 'scroll' && entry.capture === true).at(-1);
const measuredAfterRender = measuredCalls;
scrollListener.handler({ target: scrollPanel });
assert.equal(measuredCalls, measuredAfterRender, 'F5: an internal scroll does not re-measure the panel');
scrollListener.handler({ target: globalThis.document });
assert.equal(measuredCalls, measuredAfterRender + 1, 'a page scroll does re-measure it');
// The panel follows a control that really moved (resize/scroll), and comes
// back. A state write lands in the hook slots of the NEXT render, exactly as
// React schedules it, so the measuring render and the asserted one differ.
measuredRect = { top: 25, bottom: 47, right: 1200, left: 1078 };
header(false);
assert.equal(one(header(false), (n) => n.tag === 'div' && n.props.style?.position === 'fixed', 'fixed panel').props.style.left,
  840, 'a moved control drags the panel with it');
measuredRect = { top: 25, bottom: 47, right: 650, left: 528 };
header(false);
assert.equal(one(header(false), (n) => n.tag === 'div' && n.props.style?.position === 'fixed', 'fixed panel').props.style.left,
  290, 'and back to the header');
// F6: the equality used by the state update, so an unchanged re-measure is a
// no-op instead of a fresh object on every scroll frame.
{
  const { samePlacement } = moduleExports;
  const a = { left: 290, top: 53, width: 360, maxHeight: 210, placement: 'bottom' };
  assert.ok(samePlacement(a, { ...a }), 'identical placements compare equal');
  assert.ok(!samePlacement(a, { ...a, left: 291 }), 'a different left is a real change');
  assert.ok(!samePlacement(a, { ...a, placement: 'top' }), 'a flip is a real change');
  assert.ok(!samePlacement(null, a) && !samePlacement(a, null), 'null is never equal to a placement');
  assert.ok(samePlacement(null, null), 'null equals itself');
}
assert.ok(JSON.stringify(headerTree).includes('无记录'));
assert.ok(JSON.stringify(headerTree).includes('旧正文工具描述过时'));
assert.equal(one(headerTree, (n) => n.tag === 'select', 'mode selector').props.disabled, false);
one(headerTree, (n) => n.tag === 'select', 'mode selector').props.onChange({ target: { value: 'team' } });
await responses.at(-1);
assert.equal(commands.at(-1), '/frugal mode team');
assert.equal(status.data.mode, 'subagent', 'UI waits for authoritative projection instead of claiming a switch');
response = { ok: false, error: { message: 'injected transport failure' } };
one(header(false), (n) => n.tag === 'button' && n.props.children === '刷新状态 / 对账', 'refresh').props.onClick();
await responses.at(-1);
assert.equal(commands.at(-1), '/frugal status');
assert.ok(JSON.stringify(header(false)).includes('injected transport failure'));
// The panel and the listener must come from the SAME render: a later render
// rebinds panelRef to a fresh panel node.
const insideTree = header(false);
const panelNode = one(insideTree, (n) => n.tag === 'div' && n.props.style?.position === 'fixed', 'fixed panel');
const mousedown = documentTarget.listeners.filter((entry) => entry.type === 'mousedown').at(-1);
assert.ok(mousedown !== undefined, 'an open panel listens for outside clicks');
mousedown.handler({ target: panelNode });
assert.ok(nodes(header(false)).some((n) => n.tag === 'select'), 'a click inside the panel does not close it');
documentTarget.listeners.filter((entry) => entry.type === 'keydown').at(-1).handler({ key: 'Escape' });
assert.equal(nodes(header(false)).some((n) => n.tag === 'select'), false, 'Escape closes the panel');
openHeader();
documentTarget.listeners.filter((entry) => entry.type === 'mousedown').at(-1).handler({ target: { name: 'elsewhere' } });
assert.equal(nodes(header(false)).some((n) => n.tag === 'select'), false, 'a click outside closes the panel');
running = true;
assert.equal(one(openHeader(), (n) => n.tag === 'select', 'busy selector').props.disabled, true);
running = false;
status.data.budget.reservations.push({ token: 'unknown' });
assert.equal(one(openHeader(), (n) => n.tag === 'select', 'unreceipted selector').props.disabled, true);
status.data.budget.reservations.length = 0;
parentId = 'lead';
assert.equal(one(openHeader(), (n) => n.tag === 'select', 'worker selector').props.disabled, true);
parentId = undefined;
status.data.enabled = false;
assert.equal(header(), null);
assert.equal(nodes(header(false)).some((n) => n.tag === 'select'), false, 'a projection that goes away closes the panel');
status.data.enabled = true;
assert.equal(nodes(header(false)).some((n) => n.tag === 'select'), false,
  'F7: a restored projection does not re-open the panel by itself, and keeps no stale placement');

// ── Placement is a pure function: clamp it directly, no DOM needed. ────────
{
  const place = moduleExports.placeHeaderPanel;
  const rect = { top: 25, bottom: 47, right: 650, left: 528 };
  const wide = place(rect, { width: 1851, height: 916 });
  assert.deepEqual([wide.left, wide.width, wide.placement], [290, 360, 'bottom'],
    'the panel keeps the control\'s right edge when the viewport has room');
  const narrow = place({ ...rect, right: 300, left: 178 }, { width: 320, height: 916 });
  assert.equal(narrow.width, 304, 'the panel is clamped to the viewport width');
  assert.ok(narrow.left >= 8 && narrow.left + narrow.width <= 312, 'and stays inside the viewport margins');
  const tall = place({ top: 860, bottom: 882, right: 650, left: 528 }, { width: 1851, height: 916 });
  assert.equal(tall.placement, 'top', 'a control near the bottom flips the panel above itself');
  assert.ok(tall.top >= 8 && tall.top + tall.maxHeight <= 916 - 8, 'the flipped panel stays in the viewport');
  const short = place(rect, { width: 1851, height: 300 });
  assert.ok(short.maxHeight >= 120 && short.top + short.maxHeight <= 300, 'the height follows the real viewport');
  // F2: a 120px floor used to overflow a 160px-tall viewport by 13px (real room
  // below the control: 160 - 47 - 6 - 8 = 99px).
  const tiny = place(rect, { width: 1851, height: 160 });
  assert.equal(tiny.maxHeight, 99, 'a short viewport shrinks the panel to the room that exists');
  assert.ok(tiny.top + tiny.maxHeight <= 160 - 8, 'and does not overflow it');
  // F2 again: flipping up with less than the preferred height of room must not
  // cover the control it belongs to (that would swallow its own click).
  const flippedTight = place({ top: 100, bottom: 112, right: 650, left: 528 }, { width: 1851, height: 200 });
  assert.equal(flippedTight.placement, 'top', 'there is more room above than below');
  assert.equal(flippedTight.maxHeight, 86, 'the flipped panel takes the room above');
  assert.ok(flippedTight.top >= 8 && flippedTight.top + flippedTight.maxHeight <= 100, 'and stays clear of the control');
  // F3: the width is clamped against the viewport, never against a height constant.
  const vw120 = place({ top: 25, bottom: 47, right: 120, left: 0 }, { width: 120, height: 916 });
  assert.equal(vw120.width, 104, 'a 120px viewport gets 104px of panel');
  assert.ok(vw120.left >= 8 && vw120.left + vw120.width <= 120 - 8, 'with the right margin intact');
  const vw130 = place({ top: 25, bottom: 47, right: 130, left: 8 }, { width: 130, height: 916 });
  assert.ok(vw130.left + vw130.width <= 130 - 8, 'a 130px viewport keeps its 8px right margin');
}

// ── Real-React smoke render, when one is discoverable on this machine. ─────
const reactRoot = findRealReact();
if (reactRoot === undefined) {
  console.log('frugal-orchestrator client harness: real-React smoke render SKIPPED (no react-dom/server on this machine)');
} else {
  const realRequire = createRequire(join(reactRoot, 'noop.js'));
  const RealReact = realRequire('react');
  const { renderToStaticMarkup } = realRequire('react-dom/server');
  // A second factory call: the half binds whichever React its own `require`
  // returns, so this builds a real-React instance of the very same module.
  const realExports = registration.factory((specifier) => {
    if (specifier === 'react') return RealReact;
    if (specifier === 'react-dom') return realRequire('react-dom');
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Switch: (props) => RealReact.createElement('button', { type: 'button' }, props.label) };
    }
    throw new Error(`client.js required an unexpected module: ${specifier}`);
  });
  const realPage = { component: undefined };
  realExports.apply({
    effect: (callback) => callback(),
    configForms: { whileServed: (_namespaces, register) => register(new Set(['frugal-gate'])) },
    slots: {
      inject: (_name, register) => register(),
      register: (_options, component) => {
        realPage.component = component;
        return () => {};
      },
    },
  });
  const html = renderToStaticMarkup(RealReact.createElement(realPage.component, { view: 'page', form }));
  for (const copy of ['项目级 AGENTS.md', '用户全局 AGENTS.md', '技能目录（skills）', "subagent, ask_user_question, wait_subagent"]) {
    assert.ok(html.includes(copy), `real React rendered 「${copy}」`);
  }
  const summary = renderToStaticMarkup(RealReact.createElement(realPage.component, { view: 'summary', form }));
  assert.match(summary, /省钱编排/);
  assert.ok(!summary.includes('<'), 'the summary view is a bare string');
  console.log(`frugal-orchestrator client harness: real React ${realRequire('react/package.json').version} smoke render passed (${reactRoot})`);
}

/**
 * Find one real `react-dom/server` install on this machine.
 * @returns the `node_modules` directory holding it, or undefined.
 */
function findRealReact() {
  const roots = [
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'),
    join(homedir(), '.dsh', 'profiles'),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const hits = globSync('**/node_modules/react-dom/package.json', { cwd: root, withFileTypes: false }).slice(0, 4);
      for (const hit of hits) {
        const candidate = join(root, hit, '..', '..');
        if (existsSync(join(candidate, 'react', 'package.json'))) return candidate;
      }
    } catch {
      // An unreadable root is simply not a candidate.
    }
  }
  return undefined;
}

console.log(`frugal-orchestrator client harness: all assertions passed (profile: ${profileDir})`);
