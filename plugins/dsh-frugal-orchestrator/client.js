/**
 * Frugal-orchestrator gate — browser half.
 *
 * Registers the `frugal-gate` row's configuration page into the Plugins page's
 * `plugins.row.config` slot, keyed by `<package name>#<row id>`. The owner
 * (ui-plugin-manager) resolves the row's settings namespace by row id — which
 * is why the host row and this key must agree — and hands the page a
 * `ConfigPageForm` (`{ state, mutate }`) plus the `view` it wants.
 *
 * Every control writes straight through `form.mutate()` with no revision
 * fence: the Host's controller falls back to the revision it currently holds,
 * so a burst of clicks cannot 409 against itself. A volatile write commits into
 * the running fiber's references, so a flip takes effect on live agents.
 *
 * Hand-written in the `window.__ModuleLoader__.load({ id, factory })` form the
 * module system serves: this package is not built by tsdown, so there is no
 * bundle step and no source map.
 *
 * One host-side requirement is only SURFACED here, never configured from here:
 * the catalog filter narrows `system-prompt/assemble`, which is the model's
 * whole tool surface only under the host's NATIVE tool presentation. Under
 * `ptc`/`both` the host half refuses the assembly with CONFIG-UNSUPPORTED (the
 * request is never sent) instead of handing the model a third tool, so the copy
 * below says "native" out loud — see `toolsHint`.
 *
 * Labels are Simplified Chinese by design — the copy belongs to this plugin,
 * not to the deployment's locale.
 */
window.__ModuleLoader__.load({
  id: '@nu11dev/dsh-frugal-orchestrator',
  factory: (require) => {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    /** Settings namespace of the host row = the row id. */
    const NS = 'frugal-gate';
    /** `plugins.row.config` cell key = `<bundle package name>#<row id>`. */
    const ROW_KEY = '@nu11dev/dsh-frugal-orchestrator#frugal-gate';

    /** Tool names this preset actually registers, for the allow-list hint. */
    const KNOWN_TOOLS = [
      'subagent', 'wait_subagent', 'ask_user_question', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent',
      'bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep',
      'job_list', 'job_output', 'job_kill', 'skill', 'workflow', 'present',
      'todo_write', 'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode',
      'web_search', 'web_fetch',
    ];

    /** The schema's own defaults, repeated so the form renders before the Host answers. */
    const DEFAULT_PROMPT = `你是「省钱编排」主 agent：这次任务里推理最强的一环。你负责理解用户的真实目标、收集缺失的事实、自主设计方案与取舍、拆分任务、制定验收标准，并亲自验收后向用户交付结论。子 agent 用便宜模型，只负责提供上下文和按明确要求执行；不要把最终设计、关键判断或验收结论整体外包给它们。

你没有直接读写文件、运行命令、检索资料的能力，也不要假装有：不凭猜测陈述事实，不虚构文件内容、命令输出或测试结果。需要事实时，派子 agent 去读相关原文（源码、日志、diff）或执行操作，拿到证据之后再下结论。

派发一次性任务时，prompt 要让执行者几乎不用再自己判断就能动手，按这个顺序写全：
1) 背景与目标：为什么做、要产出或回答什么。子 agent 看不到这段主对话，也看不到你和用户的历史消息，首派必须自带完整背景包（短而全，不要指望它去猜）。
2) 精确输入：工作区/仓库的绝对路径，要读的文件与行号区间，日志、数据、复现脚本的路径，可以用的命令。路径或事实不确定，就先派一次只读取证，不要让它自己满仓找。
3) 操作序列：按顺序列出要做的事；独立任务在同一条回复里并行派发，有依赖的按顺序派发，并明确各自负责的文件或区域，避免多个 child 同时修改同一个文件。
4) 范围与禁区：允许改的文件/目录，明确不许碰的文件和不许做的事（提交、重启服务、改配置、删数据、扩大范围）。执行者不得自行扩大范围；在范围外发现的问题只报告，不顺手改。
5) 验收与验证：给出可运行的验证命令或判据（测试、构建、检查），以及失败时怎么取证；说清「怎样算完成」。
6) 交付格式：结论 + 可复核证据（文件路径、关键行号、命令原文、关键输出片段）+ 未完成项与风险，不要只回「已完成」。
7) 阻塞策略：确实缺关键信息且无法自行查证才问（一次问清、给出选项）；其余情况做合理假设继续，并在交付里显式标注「假设」。不要为等待结果另建观察者。
分工固定：设计、取舍、验收标准与最终判断由你（Lead）负责，执行者只按上面的指令取证和操作。一句话就能说清的小任务不必套满模板，但范围、验收判据和交付格式仍要写。

派发后保留工具返回的 agent_id。续聊会保留 child 自己已经积累的上下文（包括它读过的代码和得到的结论），所以后续指令只写新增要求，不必重复背景；但用户新给的信息、新的范围与禁区、变更后的验收判据和交付格式必须转发过去，不要指望它自己知道。证据不足或结论有误时，优先用同一个 agent_id 续聊补充证据或修正；不要把重派当成续聊，重派会让它丢掉已经积累的上下文。

等待 child 期间你可以继续自己推理、设计方案、准备验收；必须等证据才能决策时用 wait_subagent 明确等待，不要靠反复查状态或猜测进度。

验收是你的责任：拿到 child 的结果后，亲自对照用户目标检查关键源码、真实差异和测试证据，必要时再派定向检查补证。child 说通过不等于完成，最终是否达标由你判断。向用户报告已核实的事实、结论，以及还没解决的限制。

只有必须由用户本人决定的问题才用 ask_user_question；其余情况自主推进，不要频繁找用户确认。

（身份提示词、工具清单、上下文注入、子 agent 模型都在侧栏「插件」面板 → 组合包 @nu11dev/dsh-frugal-orchestrator → 行 frugal-gate → 配置里改，改完立即生效；末尾那段固定的工具能力说明由插件追加，不受这段提示词影响。）`;

    const DEFAULTS = {
      presetId: 'frugal',
      orchestratorTools: 'subagent, ask_user_question, wait_subagent, read_delivered_images',
      orchestratorSystemPrompt: DEFAULT_PROMPT,
      includeGlobalAgentsMd: false,
      includeProjectAgentsMd: true,
      includeSkills: false,
      includeRuntimeContext: false,
      // Empty on purpose: the shipped row must not name the author's private
      // route. Empty = inherit, so these two placeholders say what blank means.
      subagentProvider: '',
      subagentModel: '',
      subagentReasoningEffort: '',
      orchestratorProvider: '',
      orchestratorModel: '',
      orchestratorReasoningEffort: '',
      diagnostics: true,
      defaultCoordinationMode: 'subagent',
      teamOrchestratorTools: 'spawn_teammate, send_message, list_agents, wait_agent, interrupt_agent, team_task_create, team_task_get, team_task_list, team_task_update, ask_user_question, read_delivered_images',
      maxMembers: 3,
      maxConcurrent: 2,
      checkpointSteps: 40,
      checkpointMinutes: 8,
      minWaitTimeoutMs: '',
    };

    const COPY = {
      summary: '「省钱编排」主 agent 的系统提示词、工具、上下文注入与子 agent 模型。',
      loading: '正在读取配置…',
      unavailable: '这一行当前没有可写的配置：它启用了 volatile 字段吗？插件是否已加载？',
      intro: '主 agent 按当前模式使用编排工具。执行者保留文件、命令和 skill 能力，但禁止嵌套派发；Team 队友另有原生通信与任务板。配置写入后应用于下一步，模式切换需会话空闲。',
      sectionPrompt: '主 agent 的系统提示词',
      promptLabel: '身份提示词',
      promptHint: '这就是主 agent 全部的系统提示词（complete 段落）。留空 = 用内置默认文案。失焦提交，Ctrl/Cmd+Enter 立即提交。末尾那段「固定的工具能力说明」（三个工具的准确 schema、续聊与等待语义）由插件追加，不在这里、也不会被这里覆盖，所以默认文案里不会重复出现它。',
      promptPlaceholder: '留空 = 用内置默认文案',
      sectionScope: '生效范围',
      presetId: 'preset id',
      presetIdHint: '只对这个 id 的 preset 的主 agent 生效；留空表示对所有 preset 生效（不建议）。',
      sectionTools: '主 agent 的工具',
      tools: '允许的工具',
      toolsHint: '逗号或空格分隔。真正留空 = 不限制（保留全套工具）；非空但清洗后一个有效工具名都不剩（例如只写 skill 而下面的 skills 开关关着）会退回内置的三个工具 subagent, ask_user_question, wait_subagent，并在日志里记一条 CONFIG-FALLBACK。wait_subagent 是插件注册在主 agent 自己那一层的等待工具，写在这里才会出现在模型工具表里。这一行要求这个 agent 以 native 方式呈现工具（frugal preset 默认如此）：若部署把呈现模式改成 ptc/both，闸门会拒绝装配该步并记 CONFIG-UNSUPPORTED，这次模型请求不会发出，allow 之外的工具也一律被拒。',
      toolsKnown: `本 preset 会注册的工具名：${KNOWN_TOOLS.join(' ')}`,
      sectionContext: '主 agent 的上下文注入',
      contextHint: '关掉即从模型输入里剔除；剥离方式是按 `Instructions from: <路径>` 分块删除，标记不在时原样放行（不会误删）。',
      globalAgents: '用户全局 AGENTS.md',
      globalAgentsHint: '~/.dsh/AGENTS.md（$DSH_HOME/AGENTS.md）。',
      projectAgents: '项目级 AGENTS.md',
      projectAgentsHint: '从项目根到 cwd 的 AGENTS.md / CLAUDE.md / *.local.md 链。',
      skills: '技能目录（skills）',
      skillsHint: '打开 = 把 skill 工具放回列表；dsh-tool-skill 只在 skill 可用时才发「可用 skills」目录。',
      runtimeContext: '运行时上下文',
      runtimeContextHint: '时间与环境快照那一段动态 section。',
      sectionSubagent: '子 agent 的模型（干活的那些）',
      provider: 'provider',
      model: 'model',
      effort: '思考级别',
      inheritPlaceholder: '继承主 agent',
      subagentHint: '留空 = 沿用父 agent（会话）当前的路由；只填 provider 或只填 model 时，另一半仍按继承补齐。',
      sectionOrchestrator: '主 agent 的模型覆盖（可选）',
      orchestratorHint: '留空 = 跟随会话里选的模型与思考级别。填了就强制覆盖，选择器只影响显示。',
      effortPlaceholder: 'low / medium / high 或留空',
      sectionDiagnostics: '诊断',
      diagnostics: '写诊断日志',
      diagnosticsHint: '$DSH_HOME/frugal-gate.log：每个 agent 有没有被闸门接管、工具限制是否被拒绝，都记一行。排障用，平时可以关掉。',
    };

    const STYLES = {
      form: { display: 'flex', flexDirection: 'column', fontFamily: 'var(--dsw-font-family)' },
      intro: { margin: '0 0 4px', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      section: { margin: '18px 0 0', fontSize: 12, fontWeight: 600, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)', textTransform: 'none' },
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
      promptBlock: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0' },
      textarea: {
        width: '100%', minHeight: 220, boxSizing: 'border-box', padding: '8px 10px',
        border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit', fontSize: 13, lineHeight: 1.6,
        color: 'var(--dsw-alias-label-primary)', resize: 'vertical',
      },
    };

    /** One labelled row with a control on the right. */
    function Row(props) {
      const label = h('div', { key: 'label', style: STYLES.label }, [
        h('div', { key: 'text' }, props.label),
        props.hint === undefined ? null : h('p', { key: 'hint', style: STYLES.hint }, props.hint),
      ]);
      return h('div', { style: props.first === true ? { ...STYLES.row, ...STYLES.rowFirst } : STYLES.row }, [label, props.children]);
    }

    /**
     * Derive local state from an incoming prop, so a click shows immediately
     * even if the owner has not re-rendered yet.
     * @returns the editable value and its setter.
     */
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
        onChange: (event) => {
          setText(event.target.value);
        },
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        },
      }));
    }

    /**
     * Multi-line text block: stages locally, writes on blur or Ctrl/Cmd+Enter.
     *
     * Plain Enter must insert a newline here — a prompt is edited as prose, not
     * as a form field — so the keyboard commit needs the modifier.
     */
    function TextArea(props) {
      const [text, setText] = useSynced(props.value);
      const commit = () => {
        if (text === props.value) return;
        props.onCommit(text);
      };
      return h('div', { style: STYLES.promptBlock }, [
        h('div', { key: 'head', style: STYLES.label }, [
          h('div', { key: 'text' }, props.label),
          props.hint === undefined ? null : h('p', { key: 'hint', style: STYLES.hint }, props.hint),
        ]),
        h('textarea', {
          key: 'control',
          value: text,
          rows: props.rows ?? 12,
          placeholder: props.placeholder,
          disabled: props.disabled,
          spellCheck: false,
          style: { ...STYLES.textarea, ...(props.disabled ? STYLES.controlDisabled : {}) },
          onChange: (event) => {
            setText(event.target.value);
          },
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              commit();
            }
          },
        }),
      ]);
    }

    /** The row's configuration page. */
    function GateForm(props) {
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
      const set = (key, value) => {
        void form.mutate([{ op: 'set', path: [key], value }]);
      };
      const bool = (key) => read(key) === true;
      const text = (key) => String(read(key) ?? '');

      return h('div', { style: STYLES.form }, [
        h('p', { key: 'intro', style: STYLES.intro }, COPY.intro),

        h('p', { key: 'h-prompt', style: { ...STYLES.section, margin: '4px 0 0' } }, COPY.sectionPrompt),
        h(TextArea, {
          key: 'orchestratorSystemPrompt',
          label: COPY.promptLabel,
          hint: COPY.promptHint,
          value: text('orchestratorSystemPrompt'),
          placeholder: COPY.promptPlaceholder,
          disabled,
          onCommit: (value) => set('orchestratorSystemPrompt', value),
        }),

        h('p', { key: 'h-coordination', style: STYLES.section }, '协作模式与软预算'),
        h(Row, { key: 'mode', label: '新会话默认模式', hint: '只影响尚未固定模式的新会话；当前会话从头部控件切换。' }, h('select', {
          value: text('defaultCoordinationMode'), disabled, style: STYLES.control,
          onChange: (event) => set('defaultCoordinationMode', event.target.value),
        }, [h('option', { key: 'subagent', value: 'subagent' }, 'Subagent'), h('option', { key: 'team', value: 'team' }, 'Agent Teams')])),
        h(TextField, { key: 'teamOrchestratorTools', label: 'Team Lead 的工具', hint: '独立于 Subagent 的工具列表；缺少原生 Team 能力时明确拒绝启用。', value: text('teamOrchestratorTools'), disabled, wide: true, onCommit: (value) => set('teamOrchestratorTools', value) }),
        ...[
          ['maxMembers', '每模式成员上限', '不含 Lead；已存在的成员不会被删除。'],
          ['maxConcurrent', '同时执行上限', '新建和唤醒共用限制；未知未结算工作占用额度。'],
          ['checkpointSteps', '软预算（模型步骤）', '提醒提交检查点，不能保证强制停止。'],
          ['checkpointMinutes', '软预算（分钟）', '在下一模型步骤提醒；不打断执行中的工具。'],
        ].map(([key, label, hint]) => h(Row, { key, label, hint }, h('input', {
          type: 'number', min: 1, step: 1, value: read(key), disabled, style: STYLES.control,
          onChange: (event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value > 0) set(key, value); },
        }))),
        h(TextField, {
          key: 'minWaitTimeoutMs',
          wide: true,
          label: '最低等待时长（毫秒）',
          hint: '同时约束 Subagent 的 wait_subagent 与 Team 的 wait_agent。留空（或 0）= 插件不设下限；正整数（最大 3600000）= 比它更短的显式等待会被明确拒绝，不会替你放大。省略 timeout_ms 时默认 = max(30000, 本值)。下限只是这次等待的截止时间，不会强制睡满，没有活跃队友时仍立即返回。',
          value: text('minWaitTimeoutMs'),
          placeholder: '留空 = 不设下限（如 300000 = 5 分钟）',
          disabled,
          onCommit: (value) => set('minWaitTimeoutMs', value),
        }),

        h('p', { key: 'h-scope', style: STYLES.section }, COPY.sectionScope),
        h(TextField, {
          key: 'presetId',
          first: true,
          label: COPY.presetId,
          hint: COPY.presetIdHint,
          value: text('presetId'),
          placeholder: DEFAULTS.presetId,
          disabled,
          onCommit: (value) => set('presetId', value),
        }),

        h('p', { key: 'h-tools', style: STYLES.section }, COPY.sectionTools),
        h(TextField, {
          key: 'orchestratorTools',
          first: true,
          wide: true,
          label: COPY.tools,
          hint: h('span', null, [COPY.toolsHint, h('br', { key: 'br' }), COPY.toolsKnown]),
          value: text('orchestratorTools'),
          placeholder: DEFAULTS.orchestratorTools,
          disabled,
          onCommit: (value) => set('orchestratorTools', value),
        }),

        h('p', { key: 'h-context', style: STYLES.section }, COPY.sectionContext),
        h('p', { key: 'context-hint', style: STYLES.hint }, COPY.contextHint),
        h(Toggle, {
          key: 'projectAgents',
          first: true,
          label: COPY.projectAgents,
          hint: COPY.projectAgentsHint,
          checked: bool('includeProjectAgentsMd'),
          disabled,
          onCommit: (value) => set('includeProjectAgentsMd', value),
        }),
        h(Toggle, {
          key: 'globalAgents',
          label: COPY.globalAgents,
          hint: COPY.globalAgentsHint,
          checked: bool('includeGlobalAgentsMd'),
          disabled,
          onCommit: (value) => set('includeGlobalAgentsMd', value),
        }),
        h(Toggle, {
          key: 'skills',
          label: COPY.skills,
          hint: COPY.skillsHint,
          checked: bool('includeSkills'),
          disabled,
          onCommit: (value) => set('includeSkills', value),
        }),
        h(Toggle, {
          key: 'runtimeContext',
          label: COPY.runtimeContext,
          hint: COPY.runtimeContextHint,
          checked: bool('includeRuntimeContext'),
          disabled,
          onCommit: (value) => set('includeRuntimeContext', value),
        }),

        h('p', { key: 'h-sub', style: STYLES.section }, COPY.sectionSubagent),
        h('p', { key: 'sub-hint', style: STYLES.hint }, COPY.subagentHint),
        h(TextField, {
          key: 'subagentProvider',
          first: true,
          label: COPY.provider,
          value: text('subagentProvider'),
          placeholder: DEFAULTS.subagentProvider === '' ? COPY.inheritPlaceholder : DEFAULTS.subagentProvider,
          disabled,
          onCommit: (value) => set('subagentProvider', value),
        }),
        h(TextField, {
          key: 'subagentModel',
          wide: true,
          label: COPY.model,
          value: text('subagentModel'),
          placeholder: DEFAULTS.subagentModel === '' ? COPY.inheritPlaceholder : DEFAULTS.subagentModel,
          disabled,
          onCommit: (value) => set('subagentModel', value),
        }),
        h(TextField, {
          key: 'subagentReasoningEffort',
          label: COPY.effort,
          value: text('subagentReasoningEffort'),
          placeholder: COPY.effortPlaceholder,
          disabled,
          onCommit: (value) => set('subagentReasoningEffort', value),
        }),

        h('p', { key: 'h-orch', style: STYLES.section }, COPY.sectionOrchestrator),
        h('p', { key: 'orch-hint', style: STYLES.hint }, COPY.orchestratorHint),
        h(TextField, {
          key: 'orchestratorProvider',
          first: true,
          label: COPY.provider,
          value: text('orchestratorProvider'),
          disabled,
          onCommit: (value) => set('orchestratorProvider', value),
        }),
        h(TextField, {
          key: 'orchestratorModel',
          wide: true,
          label: COPY.model,
          value: text('orchestratorModel'),
          disabled,
          onCommit: (value) => set('orchestratorModel', value),
        }),
        h(TextField, {
          key: 'orchestratorReasoningEffort',
          label: COPY.effort,
          value: text('orchestratorReasoningEffort'),
          placeholder: COPY.effortPlaceholder,
          disabled,
          onCommit: (value) => set('orchestratorReasoningEffort', value),
        }),

        h('p', { key: 'h-diag', style: STYLES.section }, COPY.sectionDiagnostics),
        h(Toggle, {
          key: 'diagnostics',
          first: true,
          label: COPY.diagnostics,
          hint: COPY.diagnosticsHint,
          checked: bool('diagnostics'),
          disabled,
          onCommit: (value) => set('diagnostics', value),
        }),
      ]);
    }

    /** Unclamped width of the session-header popover. */
    const HEADER_PANEL_WIDTH = 360;
    /** Gap between the header control and its panel. */
    const HEADER_PANEL_GAP = 6;
    /** Distance the panel keeps from every viewport edge. */
    const HEADER_PANEL_MARGIN = 8;
    /**
     * Height the panel PREFERS. It is never a floor: on a short viewport the
     * panel shrinks to the real remaining room instead of overflowing the
     * viewport or covering the control it belongs to.
     */
    const HEADER_PANEL_PREFERRED_HEIGHT = 120;
    /** Above every host overlay in the conversation column (which tops out at 1100). */
    const HEADER_PANEL_Z = 1200;

    /**
     * Place the header popover against its trigger, clamped to the viewport.
     *
     * WHY A PLACEMENT FUNCTION AND NOT `position:absolute; right:0`: the header
     * control sits in a row the sidebar overlaps, so a panel anchored to the
     * control's right edge extends LEFT past the conversation column and its
     * left-hand text is cut off at the sidebar seam. The panel is therefore
     * rendered through a portal into `document.body` (escaping every ancestor
     * clip and stacking context) and positioned here, inside the viewport and
     * with the height it actually has room for.
     *
     * The panel keeps the control's RIGHT edge when it fits, flips above the
     * control when there is more room there than below, and never leaves the
     * viewport. Every clamp is derived from the space that exists — an
     * unconditional minimum would push the panel back out of the viewport
     * exactly on the small viewports it is supposed to protect.
     * @param rect - the trigger's `getBoundingClientRect()`.
     * @param viewport - `{ width, height }` of the viewport.
     * @param panelWidth - the unclamped panel width.
     * @returns `{ left, top, width, maxHeight, placement }`, for `position: fixed`.
     */
    function placeHeaderPanel(rect, viewport, panelWidth = HEADER_PANEL_WIDTH) {
      const vw = Number.isFinite(viewport?.width) && viewport.width > 0 ? viewport.width : 0;
      const vh = Number.isFinite(viewport?.height) && viewport.height > 0 ? viewport.height : 0;
      const width = vw === 0
        ? panelWidth
        : Math.max(0, Math.min(panelWidth, vw - 2 * HEADER_PANEL_MARGIN));
      const left = vw === 0
        ? HEADER_PANEL_MARGIN
        : Math.min(
          Math.max(rect.right - width, HEADER_PANEL_MARGIN),
          Math.max(HEADER_PANEL_MARGIN, vw - width - HEADER_PANEL_MARGIN),
        );
      const below = vh === 0 ? Number.POSITIVE_INFINITY : vh - rect.bottom - HEADER_PANEL_GAP - HEADER_PANEL_MARGIN;
      const above = vh === 0 ? Number.POSITIVE_INFINITY : rect.top - HEADER_PANEL_GAP - HEADER_PANEL_MARGIN;
      const flip = vh > 0 && below < HEADER_PANEL_PREFERRED_HEIGHT * 2 && above > below;
      const room = Math.max(0, flip ? above : below);
      // Prefer the preferred height, but never exceed the room that exists:
      // shrinking is always better than covering the trigger or the viewport.
      const maxHeight = vh === 0
        ? '70vh'
        : room >= HEADER_PANEL_PREFERRED_HEIGHT
          ? Math.min(room, vh * 0.7)
          : room;
      const top = flip
        ? Math.max(HEADER_PANEL_MARGIN, rect.top - HEADER_PANEL_GAP - maxHeight)
        : Math.max(HEADER_PANEL_MARGIN, Math.min(rect.bottom + HEADER_PANEL_GAP, vh === 0 ? Number.POSITIVE_INFINITY : vh - HEADER_PANEL_MARGIN - maxHeight));
      return { left, top, width, maxHeight, placement: flip ? 'top' : 'bottom' };
    }

    /** Two placements are the same when every rendered field matches. */
    function samePlacement(a, b) {
      return a === b || (a !== null && b !== null
        && a.left === b.left && a.top === b.top && a.width === b.width
        && a.maxHeight === b.maxHeight && a.placement === b.placement);
    }

    function FrugalAction({ sessionId, useSession, useSessions, useSessionStatus, sessions }) {
      const parentId = useSession((snapshot) => snapshot.subagent?.address?.parentSessionId);
      const leadId = parentId ?? sessionId;
      const projections = useSessions((state) => state.projectionsBySession);
      const projection = projections[leadId]?.values.frugal;
      const running = useSessionStatus((state) => state.get(leadId)?.running) === true;
      const [pending, setPending] = React.useState(false);
      const [error, setError] = React.useState(null);
      // Every hook runs BEFORE the early return below: a session whose `frugal`
      // projection arrives one render later would otherwise render more hooks
      // than the previous pass, which React rejects outright.
      const [open, setOpen] = React.useState(false);
      const [placement, setPlacement] = React.useState(null);
      const triggerRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const state = projection?.data;
      const unavailable = !state || state.enabled === false;
      const close = () => { setOpen(false); setPlacement(null); };

      // A projection that disappears (disabled mode, or a session that is not
      // governed right now) must not leave `open` latched: when the projection
      // comes back, the panel would otherwise re-open by itself, on a stale
      // placement, without any click.
      React.useEffect(() => {
        if (!unavailable) return;
        setOpen(false);
        setPlacement(null);
      }, [unavailable]);

      // While the panel is open it follows its trigger, closes on an outside
      // click or Escape, and removes every listener on close/unmount. The
      // panel is INSIDE its own click guard, so its controls keep working.
      React.useEffect(() => {
        if (!open) return undefined;
        const measure = () => {
          const trigger = triggerRef.current;
          if (trigger === null || typeof trigger?.getBoundingClientRect !== 'function') return;
          const next = placeHeaderPanel(trigger.getBoundingClientRect(), {
            width: window.innerWidth,
            height: window.innerHeight,
          });
          // Re-measuring on every scroll frame would re-render for nothing, and
          // scrolling INSIDE the panel does not move the panel at all.
          setPlacement((previous) => samePlacement(previous, next) ? previous : next);
        };
        // `contains()` throws for a non-Node target (`window`, a plain object),
        // and a scroll/click on the page itself must never be mistaken for one
        // inside the panel. Fail closed to "not inside".
        const within = (node, target) => {
          if (typeof node?.contains !== 'function' || target === null || target === undefined) return false;
          try { return node.contains(target) === true; } catch { return false; }
        };
        const onPointerDown = (event) => {
          if (within(panelRef.current, event?.target) || within(triggerRef.current, event?.target)) return;
          close();
        };
        const onKeyDown = (event) => {
          if (event?.key === 'Escape') close();
        };
        const onScroll = (event) => {
          if (event?.target !== document && within(panelRef.current, event?.target)) return;
          measure();
        };
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', onScroll, true);
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          window.removeEventListener('resize', measure);
          window.removeEventListener('scroll', onScroll, true);
          document.removeEventListener('mousedown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      if (unavailable) return null;
      const members = state.budget?.members ?? [];
      const unknown = members.filter((member) => ['running', 'pending', 'unknown'].includes(member.status));
      const reservations = state.budget?.reservations?.length ?? 0;
      const disabled = Boolean(parentId) || pending || running || unknown.length > 0 || reservations > 0;
      const telemetry = parentId ? projections[sessionId]?.values.frugal?.telemetry : projection.telemetry;
      const time = (ms) => ms === null || ms === undefined ? '无记录' : `${(ms / 60000).toFixed(1)} 分钟`;
      const submit = async (command) => {
        setPending(true); setError(null);
        try {
          const session = sessions.binding(leadId)?.session;
          if (!session?.command) throw new Error('命令通道尚未就绪');
          const result = await session.command(command);
          if (result?.ok === false) throw new Error(result.error?.message ?? '命令提交失败');
        } catch (reason) { setError(String(reason.message ?? reason)); }
        finally { setPending(false); }
      };
      const switchMode = (mode) => submit(`/frugal mode ${mode}`);

      const panel = h('div', { key: 'panel', ref: panelRef, style: {
        position: 'fixed',
        zIndex: HEADER_PANEL_Z,
        width: placement?.width ?? HEADER_PANEL_WIDTH,
        maxHeight: placement?.maxHeight ?? '70vh',
        overflow: 'auto',
        padding: 14,
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        boxShadow: 'var(--dsw-elevation-prominent)',
        color: 'var(--dsw-alias-label-primary)',
        ...(placement === null ? { top: 48, right: HEADER_PANEL_MARGIN } : { top: placement.top, left: placement.left }),
      } }, [
          h('p', { key: 'mode' }, parentId ? `执行者；Lead 会话：${leadId.slice(0, 8)}` : '仅修改本会话；新会话默认在插件配置页设置。'),
          h('select', { key: 'select', value: state.mode ?? 'subagent', disabled, onChange: (event) => void switchMode(event.target.value) }, [
            h('option', { key: 'subagent', value: 'subagent' }, 'Subagent'), h('option', { key: 'team', value: 'team' }, 'Agent Teams'),
          ]),
          disabled && !parentId ? h('p', { key: 'busy' }, `暂不可切换：${pending ? '命令正在提交' : running ? 'Lead 正在执行' : reservations ? '派发预留尚未对账' : '成员有未结算或未知工作'}。未完成任务和待处理消息还会由宿主检查。`) : null,
          h('button', { key: 'refresh', type: 'button', disabled: pending, onClick: () => void submit('/frugal status') }, '刷新状态 / 对账'),
          state.blockers?.length ? h('p', { key: 'blockers' }, `宿主阻塞项：${state.blockers.join('；')}`) : null,
          state.personaWarning ? h('p', { key: 'persona', role: 'alert' }, String(state.personaWarning.message ?? state.personaWarning)) : null,
          h('p', { key: 'counts' }, `新建 ${state.budget?.counters?.created ?? 0}；续聊 ${state.budget?.counters?.continued ?? 0}；拒绝 ${state.budget?.counters?.rejected ?? 0}`),
          h('ul', { key: 'members' }, members.map((member) => h('li', { key: `${member.mode}/${member.id}` }, `${member.label} · ${member.mode} · ${member.status} · ${member.id.slice(0, 8)}${member.alerted ? ' · 已提醒软预算检查点' : ''}${member.stopReason ? ` · 结束 ${member.stopReason}` : ''}${member.recovery ? ` · 恢复待核对 ${member.recovery.code}` : ''}`))),
          h('p', { key: 'route' }, telemetry?.route ? `实际路由：${telemetry.route.provider}/${telemetry.route.model}；思考 ${telemetry.route.reasoningEffort ?? '适配器默认'}；输出 cap ${telemetry.route.maxTokens ?? '未记录'}` : '实际路由：等待首个请求记录'),
          h('p', { key: 'times' }, `模型累计 ${time(telemetry?.modelMs)}；工具区间合并 ${time(telemetry?.toolMs)}；等待 ${time(telemetry?.waitMs)}；墙钟 ${time(telemetry?.wallMs)}。等待包含在工具时间内。`),
          h('p', { key: 'policy' }, '上下文阈值、输出上限与压缩由侧栏「插件」→ 组合包 @nu11dev/dsh-compaction-policy → 行 compaction-policy 的配置页负责；诊断日志在 $DSH_HOME/compaction-policy.log。'),
          state.warning ? h('p', { key: 'warning', role: 'alert' }, state.warning.message) : null,
          state.commandOutcome ? h('p', { key: 'outcome', role: state.commandOutcome.success ? undefined : 'alert' }, state.commandOutcome.message) : null,
          error ? h('p', { key: 'error', role: 'alert' }, error) : null,
        ]);

      return [
        h('button', {
          key: 'trigger',
          type: 'button',
          ref: triggerRef,
          'aria-expanded': open,
          onClick: () => {
            if (open) { close(); return; }
            // Measure BEFORE opening, in the same batch as `setOpen`: waiting
            // for the effect would paint one frame at the fallback position and
            // then jump across the header to the real one.
            const trigger = triggerRef.current;
            if (trigger !== null && typeof trigger?.getBoundingClientRect === 'function') {
              setPlacement(placeHeaderPanel(trigger.getBoundingClientRect(), {
                width: window.innerWidth,
                height: window.innerHeight,
              }));
            }
            setOpen(true);
          },
          style: {
            cursor: 'pointer', whiteSpace: 'nowrap', font: 'inherit', fontSize: 12,
            color: 'inherit', background: 'none', border: 'none', padding: 0,
          },
        }, `${open ? '▴' : '▾'} 省钱编排 · ${state.mode ?? '加载中'}`),
        open && typeof document !== 'undefined' && document.body !== undefined
          ? ReactDOM.createPortal(panel, document.body, 'panel')
          : null,
      ];
    }

    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'configForms'];

    /**
     * Mount the row's configuration page while the Host serves its namespace.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_KEY,
      }, GateForm))), '@nu11dev/dsh-frugal-orchestrator: row configuration page');
      if (typeof ctx.inject === 'function') ctx.inject(['sessions'], (scoped) => scoped.slots.inject('conversation.session.header.actions', () => scoped.slots.register({
        name: 'conversation.session.header.actions', id: 'frugal', order: -30,
        inject: () => ({ sessions: scoped.get('sessions') }),
      }, FrugalAction)));
    }

    const exports = { apply, inject, NS, ROW_KEY, FrugalAction, placeHeaderPanel, samePlacement };
    return exports;
  },
});
