// Offline harness for client.js, plus the cross-half check.
//
// The browser half is hand-written (no build step), so this runs a minimal
// element renderer over the real component tree: it reaches real onChange /
// onBlur handlers and asserts the exact mutate() ops a control produces.
//
//   node client.test.mjs
import assert from 'node:assert/strict';
import { Config } from './index.js';

// ── The two React APIs this half uses, plus a tree renderer. ─────────────────
const hookSlots = [];
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
};

const switches = [];
const Switch = (props) => {
  switches.push(props);
  return React.createElement('button', { type: 'button', 'data-switch': props.checked === true ? 'on' : 'off' }, props.label);
};

function render(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return null;
  if (typeof element === 'string' || typeof element === 'number') return String(element);
  const { type, props } = element;
  if (typeof type === 'function') {
    if (renderDepth === 0) hookCursor = 0;
    renderDepth += 1;
    try {
      return render(type({ ...props }));
    } finally {
      renderDepth -= 1;
    }
  }
  assert.equal(typeof type, 'string', `a host element tag is expected, saw ${String(type)}`);
  const children = (Array.isArray(props.children) ? props.children : [props.children]).map(render).filter((child) => child !== null);
  return { tag: type, props, children };
}

const nodes = (node) => (node === null || typeof node === 'string' ? [] : [node, ...node.children.flatMap(nodes)]);
const one = (tree, predicate, what) => {
  const found = nodes(tree).filter(predicate);
  assert.equal(found.length, 1, `exactly one ${what}`);
  return found[0];
};

// ── Load the half the way the browser module system would. ───────────────────
let registration;
globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value; } } };
await import('./client.js');
assert.equal(registration?.id, '@nu11dev/dsh-compaction-policy', 'the registration id is the package name');

const moduleExports = registration.factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Switch };
  throw new Error(`client.js required an unexpected module: ${specifier}`);
});
assert.deepEqual(moduleExports.inject, ['slots', 'configForms']);

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
assert.deepEqual(watched, ['compaction-policy'], 'the page follows the row id as its settings namespace');
assert.equal(page.options.name, 'plugins.row.config');
assert.equal(page.options.key, '@nu11dev/dsh-compaction-policy#compaction-policy');

const VALUES = {
  reserveRatio: 0.15,
  reserveFloorTokens: 16384,
  thresholdPercent: '',
  thresholdTokens: 0,
  desiredOutputCap: 0,
  workerOutputCap: 0,
  fitHeadroomTokens: 64,
  minFittedOutputTokens: 1024,
  estimateMarginDivisor: 10,
  keepRecentTokens: 20000,
  compactionRetries: 2,
  maxOverflowRetries: 1,
  agentThresholdOverrides: 'abc123=90000, def456=80%',
  skipFitTargets: 'provider/model',
  diagnostics: true,
};
const writes = [];
const form = {
  state: { status: 'ready', writable: true, revision: 3, value: { ...VALUES } },
  mutate: (ops) => {
    writes.push(ops);
    return Promise.resolve(true);
  },
};
const pageTree = (overrides = {}) => {
  hookSlots.length = 0;
  return render(React.createElement(page.component, { view: 'page', form, ...overrides }));
};
const rerender = (overrides = {}) => render(React.createElement(page.component, { view: 'page', form, ...overrides }));

// ── Summary and the full page ────────────────────────────────────────────────
assert.match(render(React.createElement(page.component, { view: 'summary', form })), /上下文阈值/);
switches.length = 0;
const tree = pageTree();
const text = JSON.stringify(tree);
for (const copy of ['压缩阈值', '输出上限（fit）', '压缩行为', '诊断']) {
  assert.ok(text.includes(copy), `the page renders the 「${copy}」 section`);
}
assert.equal(switches.length, 1, 'one switch renders');
assert.deepEqual([switches[0].label, switches[0].checked, switches[0].disabled], ['写诊断日志', true, false]);
assert.ok(text.includes('217600'), 'the copy shows the concrete absolute-override example');
assert.ok(text.includes('80%'), 'and the percent spelling');
assert.ok(text.includes('0 = 跟随模型声明的能力'), 'the fit field explains decision A');

// ── Controls carry the Host\'s values and write the exact op shape ────────────
const number = (value) => one(tree, (node) => node.tag === 'input' && node.props.type === 'number' && node.props.value === value, `number input ${value}`);
const field = (value) => one(tree, (node) => node.tag === 'input' && node.props.type === 'text' && node.props.value === value, `text input "${value}"`);
assert.equal(nodes(tree).filter((node) => node.tag === 'input').length, 14, 'eleven numeric and three text fields render');
assert.equal(field('abc123=90000, def456=80%').props.disabled, false, 'the per-agent override string renders verbatim');
assert.equal(field('provider/model').props.placeholder, 'someprovider/some-model', 'the route-skip field keeps its example placeholder');
number(0.15).props.onChange({ target: { value: '0.2' } });
assert.deepEqual(writes.at(-1), [{ op: 'set', path: ['reserveRatio'], value: 0.2 }]);
number(16384).props.onChange({ target: { value: '9000' } });
assert.deepEqual(writes.at(-1), [{ op: 'set', path: ['reserveFloorTokens'], value: 9000 }]);
number(20000).props.onChange({ target: { value: 'abc' } });
assert.equal(writes.length, 2, 'an unparsable number writes nothing');
field('').props.onChange({ target: { value: '80%' } });
assert.equal(writes.length, 2, 'typing alone writes nothing');
field('').props.onBlur();
assert.equal(writes.length, 2, 'a blur that changed nothing writes nothing');
const staged = one(rerender(), (node) => node.tag === 'input' && node.props.type === 'text' && node.props.value === '80%', 'the staged percent edit');
staged.props.onKeyDown({ key: 'Enter', preventDefault: () => {} });
assert.deepEqual(writes.at(-1), [{ op: 'set', path: ['thresholdPercent'], value: '80%' }]);
switches.find((entry) => entry.label === '写诊断日志').onChange(false);
assert.deepEqual(writes.at(-1), [{ op: 'set', path: ['diagnostics'], value: false }]);

// ── A read-only deployment disables every control ────────────────────────────
switches.length = 0;
const locked = pageTree({ form: { ...form, state: { ...form.state, writable: false } } });
assert.ok(nodes(locked).filter((node) => node.tag === 'input').every((node) => node.props.disabled === true));
assert.equal(switches[0].disabled, true);

// ── Cross-half: the client's defaults and the Host schema agree exactly ──────
const schemaKeys = Object.keys(Config.dict ?? {});
assert.ok(schemaKeys.length > 0, 'the Host Config exposes its field map');
assert.deepEqual(Object.keys(moduleExports.DEFAULTS).sort(), schemaKeys.sort(), 'every Config field has a client default and vice versa');
for (const [key, value] of Object.entries(moduleExports.DEFAULTS)) {
  assert.equal(typeof value, typeof VALUES[key], `${key} has the same primitive type on both halves`);
}

console.log(JSON.stringify({
  check: 'client', namespace: page.options.key, fields: schemaKeys.length,
  sections: ['压缩阈值', '输出上限（fit）', '压缩行为', '诊断'], defaultsAgree: true,
}));
console.log('client: row config page renders, writes exact ops, and agrees with the Host schema');
