/**
 * Compaction policy — browser half.
 *
 * Registers the `compaction-policy` row's configuration page into the Plugins
 * page's `plugins.row.config` slot, keyed by `<package name>#<row id>`. Every
 * control writes straight through `form.mutate()` with no revision fence; the
 * fields are volatile, so a write commits into the running fiber and applies to
 * the next request without a restart.
 *
 * Hand-written in the `window.__ModuleLoader__.load({ id, factory })` form the
 * module system serves (no build step). Labels are Simplified Chinese by design.
 *
 * @module @nu11dev/dsh-compaction-policy/client
 */
window.__ModuleLoader__.load({
  id: '@nu11dev/dsh-compaction-policy',
  factory: (require) => {
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    /** Settings namespace of the host row = the row id. */
    const NS = 'compaction-policy';
    /** `plugins.row.config` cell key = `<bundle package name>#<row id>`. */
    const ROW_KEY = '@nu11dev/dsh-compaction-policy#compaction-policy';

    /** The schema's own defaults, repeated so the form renders before the Host answers. */
    const DEFAULTS = {
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
      agentThresholdOverrides: '',
      skipFitTargets: '',
      diagnostics: true,
    };

    const COPY = {
      summary: '上下文阈值、输出上限与压缩行为。默认值来自 pi / oh-my-pi：阈值 = 窗口 − max(15%×窗口, 16384)。',
      loading: '正在读取配置…',
      unavailable: '这一行当前没有可写的配置：它启用了 volatile 字段吗？插件是否已加载？',
      intro: '压缩只在「对话真的快占满窗口」时发生。输出上限默认跟随模型能力，发送前按剩余空间收窄，不预先从窗口里扣掉。只有装了 bridge 的 preset 会被接管，其余 preset 继续用宿主内置压缩。',
      sectionThreshold: '压缩阈值',
      reserveRatio: '预留比例',
      reserveRatioHint: '窗口的百分之多少留给摘要与输出。0.15 = 15%（ompi 默认）。',
      reserveFloorTokens: '预留下限（token）',
      reserveFloorTokensHint: '比例算出来小于它时用这个下限；ompi/pi 都是 16384。',
      thresholdPercent: '百分比覆盖',
      thresholdPercentHint: '填了就覆盖上面的公式，例如 80% 或 80；留空或 -1 = 用公式。与「绝对覆盖」二选一，绝对优先。',
      thresholdTokens: '绝对覆盖（token）',
      thresholdTokensHint: '例如 217600；0 = 不覆盖。',
      agentThresholdOverrides: '按 agent 覆盖',
      agentThresholdOverridesHint: '逗号分隔的 id=值，例如 abc123=90000, def456=80%（值带 % 按百分比，否则按绝对 token）。',
      sectionFit: '输出上限（fit）',
      fitIntro: '每次请求先按模型能力要输出，只有「窗口 − 当前输入 − 余量」装不下时才收窄。',
      desiredOutputCap: '输出上限（token）',
      desiredOutputCapHint: '0 = 跟随模型声明的能力（推荐，模型不会被提前截断）。填了就统一用这个值。',
      workerOutputCap: '执行者输出上限',
      workerOutputCapHint: '0 = 与上面一致（决策 A）。填了只对子 agent 生效，用于省钱。',
      fitHeadroomTokens: '安全余量（token）',
      fitHeadroomTokensHint: '抵 tokenizer 抖动；ompi 用 64。',
      minFittedOutputTokens: '收窄下限（token）',
      minFittedOutputTokensHint: '再挤也不低于它；ompi 用 1024。',
      estimateMarginDivisor: '估算放大分母',
      estimateMarginDivisorHint: '没有真实 usage 锚点时，本地估算 ×(1+1/分母)；10 就是 +10%。',
      skipFitTargets: '跳过 fit 的路由',
      skipFitTargetsHint: '逗号分隔的 provider/model 或 model；用于「宿主自己会在窗口处停下」的模型。',
      sectionCompaction: '压缩行为',
      keepRecentTokens: '保留近期尾部（token）',
      keepRecentTokensHint: '一次压缩保留的最新内容预算；pi/ompi 用 20000。',
      compactionRetries: '摘要重试次数',
      compactionRetriesHint: '一次压力事件里最多压几轮。',
      maxOverflowRetries: '溢出恢复次数',
      maxOverflowRetriesHint: 'provider 报「上下文超限」后压缩并重试几次；用满后保留原错误。',
      sectionDiagnostics: '诊断',
      diagnostics: '写诊断日志',
      diagnosticsHint: '$DSH_HOME/compaction-policy.log：每个 agent 的阈值、压力、fit 结果与压缩结果都记一行。排障用。',
    };

    const STYLES = {
      form: { display: 'flex', flexDirection: 'column', fontFamily: 'var(--dsw-font-family)' },
      intro: { margin: '0 0 4px', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      section: { margin: '18px 0 0', fontSize: 12, fontWeight: 600, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      row: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
      rowFirst: { borderTop: 'none' },
      label: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' },
      hint: { margin: '2px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      control: {
        height: 32, padding: '0 10px', border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-bg-layer-3)',
        font: 'inherit', fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)',
        width: 260, flex: '0 0 auto',
      },
      controlWide: { width: 320 },
      controlDisabled: { color: 'var(--dsw-alias-label-tertiary)', cursor: 'default' },
    };

    /** One labelled row with a control on the right. */
    function Row(props) {
      const label = h('div', { key: 'label', style: STYLES.label }, [
        h('div', { key: 'text' }, props.label),
        props.hint === undefined ? null : h('p', { key: 'hint', style: STYLES.hint }, props.hint),
      ]);
      return h('div', { style: props.first === true ? { ...STYLES.row, ...STYLES.rowFirst } : STYLES.row }, [label, props.children]);
    }

    /** Derive local state from an incoming prop, so a click shows immediately. */
    function useSynced(remote) {
      const [value, setValue] = React.useState(remote);
      const [seen, setSeen] = React.useState(remote);
      if (remote !== seen) {
        setSeen(remote);
        setValue(remote);
      }
      return [value, setValue];
    }

    /** Boolean row: writes on every flip. */
    function Toggle(props) {
      const [checked, setChecked] = useSynced(props.checked);
      return h(Row, { label: props.label, hint: props.hint, first: props.first }, h(primitives.Switch, {
        key: 'control',
        checked,
        label: props.label,
        disabled: props.disabled,
        onChange: (next) => {
          setChecked(next);
          props.onCommit(next);
        },
      }));
    }

    /** Text row: stages locally, writes on blur or Enter. */
    function TextField(props) {
      const [text, setText] = useSynced(props.value);
      const commit = () => {
        if (text === props.value) return;
        props.onCommit(text);
      };
      return h(Row, { label: props.label, hint: props.hint, first: props.first }, h('input', {
        key: 'control',
        type: 'text',
        value: text,
        placeholder: props.placeholder,
        disabled: props.disabled,
        spellCheck: false,
        style: {
          ...STYLES.control,
          ...(props.wide === true ? STYLES.controlWide : {}),
          ...(props.disabled ? STYLES.controlDisabled : {}),
        },
        onChange: (event) => { setText(event.target.value); },
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        },
      }));
    }

    /** Numeric row: writes a validated positive integer on change. */
    function NumberField(props) {
      return h(Row, { label: props.label, hint: props.hint, first: props.first }, h('input', {
        key: 'control',
        type: 'number',
        min: props.min ?? 0,
        step: props.step ?? 1,
        value: props.value,
        disabled: props.disabled,
        style: { ...STYLES.control, ...(props.disabled ? STYLES.controlDisabled : {}) },
        onChange: (event) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value) && value >= (props.min ?? 0)) props.onCommit(value);
        },
      }));
    }

    /** The row's configuration page. */
    function PolicyForm(props) {
      if (props.view === 'summary') return COPY.summary;
      const form = props.form;
      if (form === undefined || form.state === undefined || form.state.status !== 'ready') {
        return h('p', { style: STYLES.intro }, form === undefined ? COPY.unavailable : COPY.loading);
      }
      const state = form.state;
      const read = (key) => {
        const value = state.value?.[key];
        return value === undefined ? DEFAULTS[key] : value;
      };
      const disabled = state.writable === false;
      const set = (key, value) => { void form.mutate([{ op: 'set', path: [key], value }]); };
      const text = (key) => String(read(key) ?? '');
      const num = (key) => Number(read(key) ?? 0);

      return h('div', { style: STYLES.form }, [
        h('p', { key: 'intro', style: STYLES.intro }, COPY.intro),

        h('p', { key: 'h-threshold', style: { ...STYLES.section, margin: '4px 0 0' } }, COPY.sectionThreshold),
        h(NumberField, {
          key: 'reserveRatio', first: true, min: 0.01, step: 0.01,
          label: COPY.reserveRatio, hint: COPY.reserveRatioHint,
          value: num('reserveRatio'), disabled, onCommit: (value) => set('reserveRatio', value),
        }),
        h(NumberField, {
          key: 'reserveFloorTokens', label: COPY.reserveFloorTokens, hint: COPY.reserveFloorTokensHint,
          value: num('reserveFloorTokens'), disabled, onCommit: (value) => set('reserveFloorTokens', value),
        }),
        h(TextField, {
          key: 'thresholdPercent', label: COPY.thresholdPercent, hint: COPY.thresholdPercentHint,
          value: text('thresholdPercent'), placeholder: '80%', disabled, onCommit: (value) => set('thresholdPercent', value),
        }),
        h(NumberField, {
          key: 'thresholdTokens', label: COPY.thresholdTokens, hint: COPY.thresholdTokensHint,
          value: num('thresholdTokens'), disabled, onCommit: (value) => set('thresholdTokens', value),
        }),
        h(TextField, {
          key: 'agentThresholdOverrides', wide: true, label: COPY.agentThresholdOverrides, hint: COPY.agentThresholdOverridesHint,
          value: text('agentThresholdOverrides'), placeholder: 'abc123=90000, def456=80%', disabled,
          onCommit: (value) => set('agentThresholdOverrides', value),
        }),

        h('p', { key: 'h-fit', style: STYLES.section }, COPY.sectionFit),
        h('p', { key: 'fit-intro', style: STYLES.hint }, COPY.fitIntro),
        h(NumberField, {
          key: 'desiredOutputCap', first: true, label: COPY.desiredOutputCap, hint: COPY.desiredOutputCapHint,
          value: num('desiredOutputCap'), disabled, onCommit: (value) => set('desiredOutputCap', value),
        }),
        h(NumberField, {
          key: 'workerOutputCap', label: COPY.workerOutputCap, hint: COPY.workerOutputCapHint,
          value: num('workerOutputCap'), disabled, onCommit: (value) => set('workerOutputCap', value),
        }),
        h(NumberField, {
          key: 'fitHeadroomTokens', label: COPY.fitHeadroomTokens, hint: COPY.fitHeadroomTokensHint,
          value: num('fitHeadroomTokens'), disabled, onCommit: (value) => set('fitHeadroomTokens', value),
        }),
        h(NumberField, {
          key: 'minFittedOutputTokens', min: 1, label: COPY.minFittedOutputTokens, hint: COPY.minFittedOutputTokensHint,
          value: num('minFittedOutputTokens'), disabled, onCommit: (value) => set('minFittedOutputTokens', value),
        }),
        h(NumberField, {
          key: 'estimateMarginDivisor', min: 1, label: COPY.estimateMarginDivisor, hint: COPY.estimateMarginDivisorHint,
          value: num('estimateMarginDivisor'), disabled, onCommit: (value) => set('estimateMarginDivisor', value),
        }),
        h(TextField, {
          key: 'skipFitTargets', wide: true, label: COPY.skipFitTargets, hint: COPY.skipFitTargetsHint,
          value: text('skipFitTargets'), placeholder: 'someprovider/some-model', disabled,
          onCommit: (value) => set('skipFitTargets', value),
        }),

        h('p', { key: 'h-compaction', style: STYLES.section }, COPY.sectionCompaction),
        h(NumberField, {
          key: 'keepRecentTokens', first: true, label: COPY.keepRecentTokens, hint: COPY.keepRecentTokensHint,
          value: num('keepRecentTokens'), disabled, onCommit: (value) => set('keepRecentTokens', value),
        }),
        h(NumberField, {
          key: 'compactionRetries', label: COPY.compactionRetries, hint: COPY.compactionRetriesHint,
          value: num('compactionRetries'), disabled, onCommit: (value) => set('compactionRetries', value),
        }),
        h(NumberField, {
          key: 'maxOverflowRetries', label: COPY.maxOverflowRetries, hint: COPY.maxOverflowRetriesHint,
          value: num('maxOverflowRetries'), disabled, onCommit: (value) => set('maxOverflowRetries', value),
        }),

        h('p', { key: 'h-diag', style: STYLES.section }, COPY.sectionDiagnostics),
        h(Toggle, {
          key: 'diagnostics', first: true, label: COPY.diagnostics, hint: COPY.diagnosticsHint,
          checked: read('diagnostics') === true, disabled, onCommit: (value) => set('diagnostics', value),
        }),
      ]);
    }

    const inject = ['slots', 'configForms'];

    /** Mount the row's configuration page while the Host serves its namespace. */
    function apply(ctx) {
      ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_KEY,
      }, PolicyForm))), '@nu11dev/dsh-compaction-policy: row configuration page');
    }

    return { apply, inject, NS, ROW_KEY, DEFAULTS, PolicyForm };
  },
});
