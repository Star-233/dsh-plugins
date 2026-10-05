/**
 * Frugal-orchestrator gate — host half.
 *
 * WHY THIS ROW IS TOP-LEVEL (not a row inside the `frugal` preset):
 *   - A delegated child JOINS its parent's preset (`applyChildComposition` ->
 *     `agentPresets.composeFrom`), so the preset must carry the FULL working
 *     toolset; the top-level agent's minimal view has to be produced at
 *     runtime.
 *   - The Web GUI only configures rows the profile can address. The settings
 *     document is built from `configEditor.entries()`, which keeps only direct
 *     children of an `include` entry — a row nested inside a preset tree is not
 *     addressable, so it can never get a configure page. A top-level row with
 *     `.volatile()` Config fields does.
 *
 * WHAT IT DOES, per agent, live (a volatile config write commits into the
 * running fiber's references — `loader/volatile-update` — so nothing restarts):
 *
 *   depth 0 (the orchestrator, only while its preset id matches `presetId`):
 *     1. `tools.restrict({ allow })`      — which INHERITED tools exist. A
 *        restriction filters what a scope inherits and never what its OWN layer
 *        registers (`ToolRuntime.view()`), so this alone cannot produce a
 *        three-tool orchestrator. It also decides whether `dsh-tool-skill` emits
 *        its "available skills" catalogue: that catalogue is rendered only for
 *        a scope that can resolve `skill`.
 *     1b. `system-prompt/assemble` filter + `tools.guard()` — the authoritative
 *        MODEL-FACING CATALOG. The Agent Teams tools and the schedule tools are
 *        registered through `agent.ctx.tools.register()`, i.e. into the agent's
 *        OWN layer, which no restriction can reach; the assembly waterfall is
 *        the one public seam that sees the final tool table. It keeps EXACTLY
 *        the effective allow list — no exceptions (the reserved `run_code`
 *        transport is a DETECTOR of an unsupported, non-native presentation,
 *        not something to keep), and under such a presentation it REFUSES the
 *        assembly by throwing `CONFIG-UNSUPPORTED`, so the request is never
 *        sent (fail-closed) and the guard stays strict.
 *        See {@link installCatalogFilter}.
 *     1c. A non-blank `orchestratorTools` that reconciles to no tool name (e.g.
 *        `"skill"` while the skills switch is off), or that names a tool NO
 *        layer has (a typo — `knownNames` is the registry's answer for "does
 *        this exist", `restrictableNames` only for "may `restrict()` name it"),
 *        falls back to the built-in trio and is reported (`CONFIG-FALLBACK`, and
 *        `CONFIG-UNKNOWN` for the typo). A blank field is the only "no
 *        restriction" spelling; anything else must end up narrow — and must not
 *        SILENTLY lose a tool the prompt still promises. A name that exists only
 *        in the agent's own layer is not a typo: it stays in the catalog, is
 *        left out of `restrict()`, and is reported as `CONFIG-OWN-LAYER`.
 *     1d. The DELEGATION SURFACE, registered into the agent's own layer by
 *        `./lib/delegation.js`: `subagent` (create a continuable child, or
 *        continue one by `agent_id`) and `wait_subagent` (wait for the children
 *        this agent dispatched). Both SHADOW the preset's inherited names —
 *        `subagent` because the upstream tool has neither an `agent_id` nor any
 *        wait seam — and both are required: if the tool factory, the registry, or
 *        the `subagents` service cannot deliver them, the governed agent fails
 *        its setup with `CONFIG-TOOLS-UNAVAILABLE` instead of silently running
 *        on a different (or absent) delegation surface. Note that
 *        `restrict()` cannot name these own-layer tools: the restriction is
 *        built from the allow list MINUS the names that only exist in the
 *        agent's own layer.
 *     2. `systemPrompt.suppressRuntimeContext()` — the dynamic runtime-context
 *        section (time / environment snapshot).
 *     3. `systemPrompt.section({ name: 'deployment:persona-prefix', ... })` —
 *        the orchestrator's system prompt. Registering the SAME section name in
 *        the agent's own scope shadows the preset's `persona` row for this one
 *        agent (and only this one: a child has its own scope), which is what
 *        makes the prompt editable from the GUI without touching the preset.
 *        The registered TEXT is the user's prompt with
 *        {@link TOOL_CAPABILITY_SUFFIX} appended, because an effective
 *        `complete` section is restored by `SystemPrompt.assemble()` as the SOLE
 *        prompt section: a second section would be dropped, so the fixed tool
 *        contract has to travel inside this one. A custom prompt therefore
 *        cannot remove the three tools' real contract, and the DEFAULT prompt
 *        does not repeat it (the suffix is appended once, and a text that
 *        already carries it verbatim is not doubled).
 *     4. `agent/pre-step` rewrite of the `dsh-agent-instructions` baseline —
 *        the single injected block that carries the user-global
 *        (`$DSH_HOME/AGENTS.md`) and the project (`AGENTS.md` / `CLAUDE.md`)
 *        instruction files. Each switch removes its sections by the
 *        `Instructions from: <path>` block marker. Fail-safe: when the marker
 *        is absent the message is passed through untouched.
 *
 *   every depth (the workers):
 *     5. `agent/request` — provider / model / reasoning effort for the child
 *        agents (and, optionally, an override for the orchestrator itself).
 *
 * WHEN IT DECIDES, and why one hook is not enough:
 *   `agent/created` fires once, when the agent is announced. The preset an agent
 *   runs under is NOT necessarily final at that moment: DSH creates the session
 *   on the profile's `selectedDefault` and the user may switch preset on the
 *   still-blank session, which `agentPresets.recompose()` performs later and
 *   which announces itself as `agent-preset/selected`. A gate that only read the
 *   preset at creation time therefore governs nothing in the common
 *   "create session, then pick 省钱编排" flow. So the gate reconciles on:
 *     - `agent/created`              (preset already final)
 *     - `agent-preset/selected`      (the switch, looked up through `agents`)
 *     - `loader/volatile-update`     (the GUI wrote a switch; swept over every
 *       agent `agents.list()`/`roots()` exposes, plus the ones this gate
 *       remembers, because a `presetId` edit can UN-govern an agent and the
 *       write that governs it again must still reach that live session)
 *     - `agent/pre-step` / `agent/request` (a cheap idempotent safety net that
 *       also makes the gate self-healing if any of the above is ever missed)
 *
 * The module imports only `node:` builtins and its own relative modules, and
 * resolves every runtime package at load time through `./lib/resolve.js`: an
 * installed bundle may be linked into the profile from another drive, so a bare
 * specifier would not resolve from the file's own realpath. `node:` builtins
 * always do, and the profile directory names a directory whose `node_modules`
 * holds `@deepseek-ai/schemastery`.
 *
 * @module @nu11dev/dsh-frugal-orchestrator
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  GATE_TOOL_NAMES,
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_TOOL_NAME,
  WAIT_TOOL_NAME,
  createChildRuns,
  installChildRunObservers,
  installDelegationTools,
  loadToolModule,
  prewarmToolModule,
  resolveWaitBudget,
  toolModuleFailure,
} from './lib/delegation.js';
import { resolutionBases } from './lib/resolve.js';
import { Coordination } from './lib/coordination.js';
import { installHostUi } from './lib/host-ui.js';
import { DELIVER_TOOL_NAME, READ_TOOL_NAME, createFileStore, installImageBridge } from './lib/images.js';
import { TEAM_TOOLS, TEAM_PROMPT, TEAM_CONTRACT, DELEGATION_DENY, workerPersona, teamMembership, installAdmission, teamWaitContract, waitAgentGuardReason } from './lib/team.js';

/** Cordis plugin name. */
export const name = 'frugal-gate';

/** Services that must exist before this row can take effect. */
export const inject = ['tools', 'systemPrompt'];

/** Tools the orchestrator keeps when `orchestratorTools` is left at its default. */
const DEFAULT_ORCHESTRATOR_TOOLS = [SUBAGENT_TOOL_NAME, 'ask_user_question', WAIT_TOOL_NAME, READ_TOOL_NAME];

/**
 * The Team Lead's default surface: the host's own Team tools plus the READ
 * half of the image bridge, which THIS plugin registers into the Lead's scope.
 * `TEAM_TOOLS` stays the native list (what the host must provide); the reader
 * is added here so a deployment without it is a degraded image bridge rather
 * than a missing Team tool.
 */
const DEFAULT_TEAM_TOOLS = [...TEAM_TOOLS, READ_TOOL_NAME];

/**
 * The FIXED tool-capability paragraph appended to whatever prompt is installed.
 *
 * WHY IT IS APPENDED AND NOT A SECOND SECTION: the orchestrator's prompt is a
 * `complete: true` section, and `SystemPrompt.assemble()` ends with
 * `sections: [completeSection]` — every other section, including the
 * `deployment:persona-suffix` one `dsh-persona` registers, is dropped. So the
 * ONE section the gate registers has to carry both the user's text and this
 * contract, which is exactly what makes the contract non-overridable: a custom
 * `orchestratorSystemPrompt` changes the policy text, never the tool schema.
 *
 * It describes `./lib/delegation.js` as implemented, and it is the reason the
 * default prompt does NOT repeat these lines (no duplication), while a prompt
 * the user pasted from a previous default still does not double them
 * ({@link orchestratorSectionText}).
 *
 * It is exported so the offline harness can assert the client half and the
 * bundled patch agree with it, and that no shipped copy silently loses it.
 */
export const TOOL_CAPABILITY_SUFFIX = `固定的工具能力说明（由插件追加在末尾，不会被上面的提示词覆盖）：
- subagent({ description, prompt })：创建一个 child，立刻返回 agent_id；任务始终在后台运行，不接受前台阻塞。description 是 3-5 个词的标签，可省略（省略时取 prompt 第一行）。
- subagent({ agent_id, prompt })：继续同一个 direct continuable child（同一个 agent_id 冷恢复，进程重启后仍然可用）。prompt 是它自己那条会话里的下一条消息，只需要写新增要求；它看不到这次主对话。
- subagent 的 run_in_background: false 明确不支持：会在产生任何副作用之前报错（BACKGROUND_REFUSED）。此时改用 wait_subagent 等结果，不要轮询，也不要改成前台调用。
- wait_subagent({ agent_ids: [ID, ...], timeout_ms }): 等你派出去的那些 child 的当前这轮工作 settle 或超时。超时是**截止时间**，不是强制睡满：child 一 settle 就立刻返回。timeout_ms 省略时的默认值 = max(30000, minWaitTimeoutMs)；minWaitTimeoutMs 留空/0 表示插件不设下限，配置了正数时**显式传更小的值会被明确拒绝**（不会被偷偷放大）；上限 3600000 ms（更大被拒绝）。超时只结束这次等待，不会取消 child，它仍在后台运行，可以再 wait 一次。返回每个 ID 的状态与输出；对无法判定的 child 明确返回 unknown（表示这个进程没有它的生命周期记录，不等于已完成），这时用 subagent({ agent_id, prompt }) 派新工作开一轮新的 epoch，再 wait。只能等你自己派出去的 child。
- ask_user_question：只用于用户专属的决定，或确实缺失且无法自行查证的关键信息；不要用它做频繁确认。
- send_message / wait_agent 是 Agent Teams 的队友工具，够不到你派出去的 child，不要混用。旧的一次性（one-shot）child 没有可续聊的会话，也没有可等待的 epoch；本插件不承诺把它恢复成可续聊，直接新建一个 continuable child。`;

/**
 * The section text the gate registers for one prompt.
 *
 * Blank falls back to {@link DEFAULT_ORCHESTRATOR_PROMPT} (the Config doc's
 * contract), the fixed contract is appended, and a text that ALREADY carries it
 * verbatim is returned unchanged — so neither the default nor a user whose
 * prompt was seeded from the default ever shows the contract twice.
 * @param prompt - the configured `orchestratorSystemPrompt`, already trimmed.
 * @returns the text to register as the `deployment:persona-prefix` section.
 */
export function orchestratorSectionText(prompt) {
  const text = typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : DEFAULT_ORCHESTRATOR_PROMPT;
  return text.includes(TOOL_CAPABILITY_SUFFIX) ? text : `${text}\n\n${TOOL_CAPABILITY_SUFFIX}`;
}

/**
 * Reserved name of the PTC presentation transport.
 *
 * `dsh-tools` keeps it outside the filterable layers: `ToolRuntime.view()`
 * appends it to a scope's view ONLY when that scope presents `ptc`/`both`, and
 * `register()` rejects the name, so its presence is proof of a non-native
 * presentation — and its absence means a native catalogue IS the whole model
 * surface. It is therefore a DETECTOR here, never an exception: under
 * `ptc`/`both` the model's real surface is `run_code` plus the SDK bindings
 * generated from `sdkSchemas(scope)`, a table `system-prompt/assemble` does not
 * carry, so this gate cannot promise "exactly the allow list" there. The
 * `frugal` preset composes no `tool-presentation` row, so its agents present
 * natively; a deployment whose governed agents present `ptc`/`both` gets its
 * model requests REFUSED — a `CONFIG-UNSUPPORTED` error thrown out of the
 * assembly waterfall — instead of a silent empty catalogue or a third tool, and
 * its guard stays strict. See {@link installCatalogFilter} and the README's
 * known trade-offs.
 */
const RUN_CODE_NAME = 'run_code';

/** The one presentation mode in which the assembled catalogue is the model surface. */
const NATIVE_PRESENTATION = 'native';

/**
 * The orchestrator's system prompt when `orchestratorSystemPrompt` is blank.
 *
 * Kept identical to the `persona` row inside the preset on purpose: the preset
 * is the fallback for any agent this gate does not govern, so the two must not
 * disagree about what 「省钱编排」 means. (`catalog.test.mjs` asserts the
 * equality against the bundled patch, so a stale YAML copy fails the suite.)
 *
 * It carries the ORCHESTRATION POLICY — understand the goal, design, split,
 * judge, accept — and deliberately NOT the tool schemas: those live in
 * {@link TOOL_CAPABILITY_SUFFIX}, which is appended to every installed prompt,
 * so the default cannot show them twice and a custom prompt cannot lose them.
 *
 * It states the tool contract exactly as `./lib/delegation.js` implements it:
 * `subagent` creates a continuable child (returning its id) or continues one by
 * `agent_id`, `wait_subagent` waits for dispatched children, and neither is an
 * Agent Teams tool.
 */
export const DEFAULT_ORCHESTRATOR_PROMPT = `你是「省钱编排」主 agent：这次任务里推理最强的一环。你负责理解用户的真实目标、收集缺失的事实、自主设计方案与取舍、拆分任务、制定验收标准，并亲自验收后向用户交付结论。子 agent 用便宜模型，只负责提供上下文和按明确要求执行；不要把最终设计、关键判断或验收结论整体外包给它们。

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

/** Section name `dsh-persona` and `dsh-subagent` use for the persona prefix. */
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix';

/** Fallback placement of that section, from `dsh-system-prompt`'s order table. */
const PERSONA_PREFIX_ORDER = 0;

/** Block marker every rendered instruction file starts with. */
const SECTION_MARKER = 'Instructions from: ';

/** Model-facing spellings of the single user-global instruction file. */
const GLOBAL_INSTRUCTION_PATHS = new Set(['~/.dsh/AGENTS.md', '$DSH_HOME/AGENTS.md']);

/** Cap on the diagnostic log before it is restarted from scratch. */
const LOG_MAX_BYTES = 512 * 1024;

/**
 * Resolve the schemastery factory the Config schema is built from.
 *
 * `@deepseek-ai/schemastery` is a peer of every host plugin, but this package
 * may be linked into the profile (`link:`) and therefore evaluated from a
 * directory outside the profile's resolution root. {@link resolutionBases}
 * names the bases that are guaranteed to hold it, nearest authority first.
 * @returns The schemastery factory (`z`).
 * @throws When no candidate base resolves the package.
 */
function loadSchemaFactory() {
  for (const base of resolutionBases()) {
    try {
      const loaded = createRequire(base)('@deepseek-ai/schemastery');
      const z = loaded?.default ?? loaded;
      if (typeof z === 'function' && typeof z.object === 'function') return z;
    } catch {
      // Try the next base.
    }
  }
  throw new Error(
    'frugal-gate: cannot resolve @deepseek-ai/schemastery. The row needs it to declare the volatile '
    + 'Config the Web GUI edits; install the plugin inside the profile instead of linking it, or make '
    + 'DSH_PROFILE_DIR name a profile whose node_modules holds @deepseek-ai/schemastery.',
  );
}

const z = loadSchemaFactory();

/**
 * The switches the Web GUI edits.
 *
 * Every field is `.volatile()`: a write is committed into this already-running
 * fiber's references, which is what makes a toggle take effect on live agents
 * without a remount.
 */
export const Config = z.object({
  /** Preset id whose agents this gate governs. */
  presetId: z.string().default('frugal').volatile(),
  /**
   * Comma/space separated allow list; empty keeps the whole toolset.
   *
   * The default is the three-tool orchestration surface: `subagent` (create or
   * continue a child), `ask_user_question`, `wait_subagent`. A gate-owned name
   * that the user drops from the list disappears from the model's catalog (the
   * assembly filter and the guard both use this list), so `wait_subagent`
   * missing here means the orchestrator cannot wait for anything.
   */
  orchestratorTools: z.string().default(DEFAULT_ORCHESTRATOR_TOOLS.join(', ')).volatile(),
  /**
   * The orchestrator's policy prompt; blank restores the built-in one.
   *
   * This is the whole `complete` persona section MINUS the fixed tool contract,
   * which `apply()` appends on top of whatever this field holds (see
   * {@link TOOL_CAPABILITY_SUFFIX}) — so a custom prompt can change the policy
   * but can never remove the accurate `subagent` / `wait_subagent` contract.
   */
  orchestratorSystemPrompt: z.string().default(DEFAULT_ORCHESTRATOR_PROMPT).volatile(),
  /** Keep the user-global `$DSH_HOME/AGENTS.md` block. */
  includeGlobalAgentsMd: z.boolean().default(false).volatile(),
  /** Keep the project `AGENTS.md` / `CLAUDE.md` blocks. */
  includeProjectAgentsMd: z.boolean().default(true).volatile(),
  /** Keep the `skill` tool (and with it the "available skills" catalogue). */
  includeSkills: z.boolean().default(false).volatile(),
  /** Keep the dynamic runtime-context section. */
  includeRuntimeContext: z.boolean().default(false).volatile(),
  // The child route ships EMPTY on purpose: naming a provider/model here would
  // bake the author's private route into every install. Empty means "inherit the
  // parent's route" (a partial route is completed by the delegation service, and
  // an all-empty route is passed as no override at all).
  /** Child agents' provider override; empty (the shipped default) inherits the parent's route. */
  subagentProvider: z.string().default('').volatile(),
  /** Child agents' model override; empty (the shipped default) inherits the parent's route. */
  subagentModel: z.string().default('').volatile(),
  /** Child agents' thinking-level override; empty leaves the choice to the service. */
  subagentReasoningEffort: z.string().default('').volatile(),
  /** Orchestrator provider override; empty follows the session's selection. */
  orchestratorProvider: z.string().default('').volatile(),
  /** Orchestrator model override; empty follows the session's selection. */
  orchestratorModel: z.string().default('').volatile(),
  /** Orchestrator thinking-level override; empty follows the session's selection. */
  orchestratorReasoningEffort: z.string().default('').volatile(),
  /** Append every governance decision to `$DSH_HOME/frugal-gate.log`. */
  diagnostics: z.boolean().default(true).volatile(),
  defaultCoordinationMode: z.string().default('subagent').volatile(),
  teamOrchestratorTools: z.string().default(DEFAULT_TEAM_TOOLS.join(', ')).volatile(),
  maxMembers: z.number().step(1).min(1).default(3).volatile(),
  maxConcurrent: z.number().step(1).min(1).default(2).volatile(),
  checkpointSteps: z.number().step(1).min(1).default(40).volatile(),
  checkpointMinutes: z.number().min(1).default(8).volatile(),
  /**
   * Minimum wait the orchestrator's wait tools accept, in milliseconds.
   *
   * Blank (the default) and `0` both mean "no plugin lower bound": the wait
   * tools then accept anything from `0` up to their cap. A positive value must
   * be a safe integer no greater than `3600000`; anything else is reported as
   * `CONFIG-INVALID` and treated as blank rather than as a bogus lower bound.
   *
   * It is a STRING so that blank stays distinguishable from `0` in the GUI's
   * text field. The effective default of `wait_subagent` is
   * `max(30000, this)`, and an explicit `timeout_ms` below it is REJECTED with
   * an actionable message — never silently raised. In Team mode the same value
   * is enforced on the host's `wait_agent` by a guard (a guard can only deny:
   * the host tool's arguments are frozen, so its schema keeps saying 10000).
   */
  minWaitTimeoutMs: z.string().default('').volatile(),
});

/**
 * Read the live value behind a config field.
 *
 * A volatile field's resolved value is a `createVolatile()` reference, not the
 * value itself; the reference is the one object a settings write commits into.
 * @param value - whatever the field currently holds.
 * @returns the plain value.
 */
function unwrap(value) {
  let current = value;
  for (let step = 0; step < 4; step += 1) {
    if (current === null || typeof current !== 'object') break;
    if (typeof current.get !== 'function' || Object.getOwnPropertySymbols(current).length === 0) break;
    current = current.get();
  }
  return current;
}

/**
 * Read an agent's delegation depth.
 *
 * Mirrors `@deepseek-ai/dsh-subagent`'s `delegationDepthOf`: the persisted
 * session header is authoritative and monotone, and the runtime option may
 * only deepen it.
 * @param agent - the agent whose depth is read.
 * @returns its non-negative depth (0 for a top-level session agent).
 */
function depthOf(agent) {
  const header = agent?.session?.header?.delegationDepth;
  const runtime = agent?.options?.subagentDepth;
  return Math.max(
    typeof header === 'number' && Number.isSafeInteger(header) ? header : 0,
    typeof runtime === 'number' && Number.isSafeInteger(runtime) ? runtime : 0,
  );
}

/**
 * Ownership facts for the image bridge, decided HERE and never inside the
 * bridge module: who may deliver (a delegated child or a Team teammate), who may
 * read (only a Lead), and which durable ids the parent/child pair is keyed by.
 *
 * `resolveTarget` is ASYNC on purpose. The authoritative "is this my direct
 * child" answer comes from the host's durable catalog (`subagents.listChildren`,
 * served from the `subagentCatalog` session projection) or the Team roster. An
 * in-process tracker would answer `undefined` after a restart and permanently
 * strand images that a child delivered in an earlier process.
 * @param ctx - the plugin context, carrying the Team roster and the subagents service.
 * @param role - `'lead'` installs the read half, `'worker'` the delivery half.
 * @returns the identity record the bridge requires (fail-closed on a missing method).
 */
function imageIdentity(ctx, role) {
  const sessionIdOf = (caller) => caller?.session?.id;
  const teammateOf = (caller) => teamMembership(ctx, caller);
  /** The Lead's session id as seen from one of its children. */
  const leadIdOf = (caller) => {
    const membership = teammateOf(caller);
    if (membership?.role === 'teammate') return membership.root?.session?.id ?? membership.root?.id;
    const recorded = caller?.session?.header?.parentSession;
    if (recorded === undefined || recorded === null) return undefined;
    // Resolve through the live roster when possible: the durable header records
    // an agent id, and the store is keyed by the Lead's SESSION id.
    const parent = ctx.get('agents')?.get?.(recorded);
    return parent?.session?.id ?? recorded;
  };
  if (role === 'worker') {
    return {
      mayDeliver: (caller) => depthOf(caller) > 0 || teammateOf(caller)?.role === 'teammate',
      idOf: (caller) => sessionIdOf(caller),
      parentIdOf: (caller) => leadIdOf(caller),
    };
  }
  return {
    // A teammate is never a Lead, whatever its depth.
    mayRead: (caller) => depthOf(caller) === 0 && teammateOf(caller)?.role !== 'teammate',
    idOf: (caller) => sessionIdOf(caller),
    resolveTarget: async (caller, target) => {
      const membership = teammateOf(caller);
      if (membership !== undefined) {
        const teams = ctx.get('agentTeams');
        const members = typeof teams?.listMembers === 'function' ? teams.listMembers(caller) : [];
        const match = (members ?? []).find((member) => member.name === target || member.id === target);
        if (match === undefined || match.role === 'lead') return undefined;
        return { childId: String(match.id), parentId: sessionIdOf(caller) };
      }
      const subagents = ctx.get('subagents');
      if (typeof subagents?.listChildren !== 'function') return undefined;
      const children = await subagents.listChildren(sessionIdOf(caller));
      const match = (children ?? []).find((child) => child.id === target || child.label === target);
      if (match === undefined) return undefined;
      // `listChildren` rows carry the durable CHILD SESSION id, which is what the
      // worker side records as its own `idOf`.
      return { childId: String(match.id), parentId: sessionIdOf(caller), sessionId: String(match.id) };
    },
  };
}

/** A short, safe rendering of one value for a log line. */
function describe(value) {
  try {
    return String(value);
  } catch {
    return '<unprintable>';
  }
}

/**
 * Resolve the tool registry from an agent's scoped context.
 *
 * `agentCtx.tools` is the accessor every scoped registration uses, but Cordis'
 * proxy throws `cannot get property "tools" without inject` when no fiber on
 * the accessor's chain injects the service; `agentCtx.get('tools')` is the
 * inject-free form and still binds the returned service to the calling scope.
 * The gate must survive either resolution: losing the registry silently
 * restores the whole toolset for the orchestrator.
 * @param agentCtx - the agent's scoped context.
 * @returns the scope-bound tool registry, or undefined when neither form works.
 */
function toolsOf(agentCtx) {
  try {
    const direct = agentCtx?.tools;
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    // Fall through to the inject-free lookup.
  }
  try {
    return agentCtx?.get?.('tools');
  } catch {
    return undefined;
  }
}

/**
 * Resolve the prompt registry from an agent's scoped context.
 *
 * Same two resolutions as {@link toolsOf}: a throwing accessor must degrade to
 * "no prompt override" instead of tearing down the `agent/created` listener.
 * @param agentCtx - the agent's scoped context.
 * @returns the scope-bound prompt registry, or undefined when neither form works.
 */
function promptOf(agentCtx) {
  try {
    const direct = agentCtx?.systemPrompt;
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    // Fall through to the inject-free lookup.
  }
  try {
    return agentCtx?.get?.('systemPrompt');
  } catch {
    return undefined;
  }
}

/** The first 8 characters of an agent id, or a placeholder. */
function shortId(agent) {
  const id = agent?.id ?? agent?.session?.id;
  return typeof id === 'string' ? id.slice(0, 8) : '<no-id>';
}

/**
 * Project the live config into the shape the gate applies.
 * @param config - the row's resolved config (volatile references included).
 * @returns plain, already-defaulted settings.
 */
function settingsOf(config) {
  const read = (key, fallback) => {
    const value = unwrap(config?.[key]);
    return value === undefined || value === null ? fallback : value;
  };

  const text = String(read('orchestratorTools', DEFAULT_ORCHESTRATOR_TOOLS.join(', '))).trim();
  const listed = text.length === 0 ? [] : text.split(/[,\s]+/).filter((entry) => entry.length > 0);
  const includeSkills = read('includeSkills', false) === true;
  // `skill` is the one tool a dedicated switch owns, so a stale entry in the
  // list can never disagree with the switch the user just flipped.
  const cleaned = listed.filter((entry) => entry !== 'skill');
  if (includeSkills && listed.length > 0) cleaned.push('skill');

  // A BLANK field is the documented "keep every tool" spelling (see the
  // README). Any OTHER spelling has to end up narrow, so an explicit list that
  // reconciles down to nothing — `"skill"` with the skills switch off is the
  // one way to write that — must not reach the `allow.length === 0` branch and
  // silently restore the whole toolset. Fall back to the built-in trio and let
  // the caller report the fallback; `allowRequested`/`allowFallback` carry it.
  const allowFallback = text.length > 0 && cleaned.length === 0;
  const allow = allowFallback ? [...DEFAULT_ORCHESTRATOR_TOOLS] : cleaned;

  const prompt = String(read('orchestratorSystemPrompt', DEFAULT_ORCHESTRATOR_PROMPT)).trim();

  return {
    defaultCoordinationMode: String(read('defaultCoordinationMode', 'subagent')),
    teamOrchestratorTools: String(read('teamOrchestratorTools', DEFAULT_TEAM_TOOLS.join(', '))),
    maxMembers: Number(read('maxMembers', 3)),
    maxConcurrent: Number(read('maxConcurrent', 2)),
    checkpointSteps: Number(read('checkpointSteps', 40)),
    checkpointMinutes: Number(read('checkpointMinutes', 8)),
    presetId: String(read('presetId', 'frugal')).trim(),
    allow,
    allowRequested: text,
    allowFallback,
    systemPrompt: prompt.length === 0 ? DEFAULT_ORCHESTRATOR_PROMPT : prompt,
    includeGlobalAgentsMd: read('includeGlobalAgentsMd', false) === true,
    includeProjectAgentsMd: read('includeProjectAgentsMd', true) === true,
    includeRuntimeContext: read('includeRuntimeContext', false) === true,
    diagnostics: read('diagnostics', true) === true,
    subagent: {
      provider: String(read('subagentProvider', '')).trim(),
      model: String(read('subagentModel', '')).trim(),
      reasoningEffort: String(read('subagentReasoningEffort', '')).trim(),
    },
    orchestrator: {
      provider: String(read('orchestratorProvider', '')).trim(),
      model: String(read('orchestratorModel', '')).trim(),
      reasoningEffort: String(read('orchestratorReasoningEffort', '')).trim(),
    },
    // The wait budget both modes read: `wait_subagent` builds its schema and its
    // runtime check from it, and the Team guard enforces `minMs` on the host's
    // frozen `wait_agent` arguments. `invalid` is reported (never a silent
    // lower bound) and is part of the effect signature, so a typo re-logs once.
    wait: resolveWaitBudget(read('minWaitTimeoutMs', '')),
  };
}

/**
 * The per-agent effects a settings revision determines.
 *
 * Used to skip redundant work: `agent/pre-step` reconciles on every step, and
 * re-registering the same restriction would churn the tool layers (and emit
 * `tools/change`) for nothing.
 * @param settings - plain settings from {@link settingsOf}.
 * @returns a stable string identifying the applied effect set.
 */
function effectSignature(settings) {
  return JSON.stringify([
    settings.allow,
    // Part of the signature so that moving INTO or OUT of the
    // "explicit list reconciled to nothing" fallback re-applies (and therefore
    // re-logs) even when the resulting allow list happens to be the built-in
    // trio either way. A list with an unknown name (a typo) goes down the same
    // path, and its own `allow` array already differs, so it re-applies too.
    settings.allowFallback,
    settings.systemPrompt,
    settings.includeRuntimeContext,
    settings.mode,
    settings.teamOrchestratorTools,
    settings.maxMembers, settings.maxConcurrent,
    settings.checkpointSteps, settings.checkpointMinutes,
    // The wait minimum (and its "invalid" report) has to re-apply the surface:
    // `wait_subagent`'s schema text and the Team guard are built from it.
    settings.wait.minMs, settings.wait.invalid,
  ]);
}

/** Whether a rendered instruction path names the user-global file. */
function isGlobalInstructionPath(displayPath) {
  if (GLOBAL_INSTRUCTION_PATHS.has(displayPath)) return true;
  if (displayPath.startsWith('~') || displayPath.startsWith('$')) return true;
  return /^[A-Za-z]:[\\/]/.test(displayPath) || displayPath.startsWith('/');
}

/** Where the `<system-reminder>` frame carrying the baseline closes. */
function frameEnd(text) {
  const at = text.lastIndexOf('</system-reminder>');
  return at === -1 ? text.length : at;
}

/**
 * Remove whole `Instructions from: <path>` sections from one rendered block.
 *
 * The renderer joins the sections with a blank line inside a single
 * `<system-reminder>` frame, so a section runs from its marker to the next
 * marker (or to the closing tag). Only the baseline rendering uses the
 * capitalised `Instructions from: ` marker; the reconciliation renderings use
 * "Additional"/"Updated instructions from:" and "Instructions removed:", which
 * this never matches.
 *
 * The frame itself is kept, even once every section is gone: the block stays
 * in the session's durable surface, so `dsh-agent-instructions` keeps treating
 * its baseline as supplied instead of re-rendering and re-injecting it on
 * every step.
 * @param text - one rendered text block.
 * @param drop - predicate deciding whether a section's display path is removed.
 * @returns the rewritten block, or the original text when nothing was dropped
 *   (the fail-safe path: no marker, no edit).
 */
function dropSections(text, drop) {
  const starts = [];
  let at = text.indexOf(SECTION_MARKER);
  while (at !== -1) {
    starts.push(at);
    at = text.indexOf(SECTION_MARKER, at + SECTION_MARKER.length);
  }
  if (starts.length === 0) return text;

  const end = frameEnd(text);
  const cuts = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (start >= end) break;
    const lineEnd = text.indexOf('\n', start);
    const raw = lineEnd === -1 ? text.slice(start + SECTION_MARKER.length) : text.slice(start + SECTION_MARKER.length, lineEnd);
    if (!drop(raw.trim())) continue;
    const next = index + 1 < starts.length ? starts[index + 1] : end;
    cuts.push([start, Math.min(next, end)]);
  }
  if (cuts.length === 0) return text;

  let out = '';
  let cursor = 0;
  for (const [start, stop] of cuts) {
    out += text.slice(cursor, start);
    cursor = stop;
  }
  out += text.slice(cursor);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Install the gate.
 * @param ctx - the host scope this row is mounted in.
 * @param config - the row's resolved config (see {@link Config}).
 */
export function apply(ctx, config) {
  /** Depth-0 agents of this preset: agent -> disposer releasing this gate's effects on it. */
  const owned = new Map();
  /** Depth-0 agents of this preset: the orchestrators the tool/context switches own. */
  const orchestrators = new Set();
  /** Every agent this gate decided it governs, at any depth: the model-override subject. */
  const governed = new Set();
  /**
   * Every agent this gate has EVER governed, until it is disposed.
   *
   * Distinct from {@link governed} on purpose: un-governing (a preset switch, a
   * `presetId` edit) removes an agent from `governed`, and a later write has to
   * be able to find it again even on a host whose `agents` service exposes
   * neither `list()` nor `roots()`. Nothing here is a strong reference the
   * session does not already hold, and disposal prunes it.
   */
  const remembered = new Set();
  /** Governed depth-0 agents: the effect signature currently installed on them. */
  const applied = new Map();
  /**
   * Governed depth-0 agents: the delegation bookkeeping (`./lib/delegation.js`).
   *
   * Separate from {@link owned} because the lifecycle events of a child are
   * push-only: re-installing the effect set after a settings write must not
   * forget which children are still running, nor release the listeners that
   * record them (`entry.observers`).
   */
  const delegations = new Map();
  /** Rewritten baseline messages, keyed by the message the loop handed us. */
  const rewrites = new WeakMap();

  // Resolve the official tool factory while the host finishes booting: the row
  // is mounted long before the first agent exists, and a Node whose `require()`
  // cannot reach the ES-module package needs the asynchronous fallback.
  prewarmToolModule();

  const logPath = (() => {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh');
    return join(home, 'frugal-gate.log');
  })();

  /**
   * Where delivered-image records live: `<DSH_HOME>/frugal-orchestrator/image-deliveries`.
   *
   * The store keeps metadata only (references, ids, timestamps) — never bytes,
   * never base64 — and one JSON file per (parent, child) pair, written
   * atomically. It needs an ABSOLUTE path, which is why it is derived from
   * `DSH_HOME` here rather than left to the bridge's default.
   */
  const imageStore = (() => {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh');
    try {
      return createFileStore({ dir: join(home, 'frugal-orchestrator', 'image-deliveries') });
    } catch (error) {
      ctx.logger?.error?.(`frugal-gate: could not open the image-delivery store; the image bridge stays off — ${describe(error)}`);
      return undefined;
    }
  })();

  /**
   * Install one half of the image bridge into one agent's own scope.
   *
   * `role: 'lead'` registers `read_delivered_images` (the Lead only reads: a Lead
   * able to deliver its own images could manufacture a child's evidence),
   * `role: 'worker'` registers `deliver_images`.
   * @param options - `{ agent, agentCtx, registry, role, settings }`.
   * @returns `{ disposers, names }`.
   * @throws when the store or the official tool factory is unavailable.
   */
  const installImageTools = ({ agent, agentCtx, registry, role, settings }) => {
    // `loadToolModule()` hands back the module NAMESPACE (that is what shrinking
    // `require()`/`import()` calls can share), so the factory has to be taken off
    // it: passing the namespace itself fails `typeof … !== 'function'` and would
    // silently keep the whole bridge off.
    const toolsModule = loadToolModule();
    const defineTool = toolsModule?.defineTool;
    if (imageStore === undefined || typeof defineTool !== 'function') {
      throw new Error(`IMAGE-TOOLS-UNAVAILABLE: ${
        imageStore === undefined ? 'the image-delivery store could not be opened' : ''
      }${
        typeof defineTool !== 'function' ? `${imageStore === undefined ? ' and ' : ''}the official dsh-tools defineTool factory is not resolvable (${toolModuleFailure()?.message ?? 'no diagnosis'})` : ''
      }`);
    }
    const bridge = installImageBridge({
      agent,
      // The scope the tools live in: the bridge resolves the live attachment
      // service through it (`ctx.get('attachments')`), because a property read
      // needs `inject` and this row must not require an attachment deployment.
      agentCtx,
      role,
      registry,
      defineTool,
      store: imageStore,
      identity: imageIdentity(agentCtx ?? ctx, role),
      note: (line) => note(settings, line),
    });
    return { disposers: bridge.disposers, names: [role === 'lead' ? READ_TOOL_NAME : DELIVER_TOOL_NAME] };
  };

  /**
   * Append one line to the diagnostic log.
   *
   * The gate has no other observable surface: whether it governs an agent, and
   * whether a `restrict()` was rejected, is otherwise invisible until the model
   * behaves wrongly. Never throws.
   * @param settings - the live settings (the `diagnostics` switch gates this).
   * @param line - the already-formatted message.
   */
  const note = (settings, line) => {
    if (settings.diagnostics !== true) return;
    const text = `${new Date().toISOString()} ${line}\n`;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      try {
        if (statSync(logPath).size > LOG_MAX_BYTES) writeFileSync(logPath, '');
      } catch {
        // No log yet: the append below creates it.
      }
      appendFileSync(logPath, text);
    } catch {
      // Diagnostics must never break session creation.
    }
  };

  const presetOf = (agent) => {
    try {
      const registry = ctx.get('agentPresets');
      const composed = registry?.composedPreset;
      if (typeof composed !== 'function') return undefined;
      return composed.call(registry, agent?.ctx);
    } catch {
      return undefined;
    }
  };

  const governs = (agent, settings) => {
    const wanted = settings.presetId;
    if (wanted.length === 0) return true;
    const actual = presetOf(agent);
    return actual !== undefined && actual === wanted;
  };

  /**
   * Release the EFFECTS of one application — everything a re-application may
   * legitimately replace.
   *
   * That is the tool restriction, the catalog filter, the guard, the prompt
   * section, the runtime-context suppression and the two own-layer tool
   * registrations. The run bookkeeping and its lifecycle listeners are NOT
   * here: they are durable state ({@link releaseDelegation}), because a settings
   * write re-applies this effect set while the children of this agent keep
   * running, and `subagent/end` is never replayed.
   * @param agent - the governed agent.
   */
  const releaseEffects = (agent) => {
    const dispose = owned.get(agent);
    owned.delete(agent);
    applied.delete(agent);
    if (dispose === undefined) return;
    try {
      dispose();
    } catch {
      // The agent's own scope already unwound it.
    }
  };

  /**
   * Release EVERYTHING this gate owns on one agent, bookkeeping included.
   *
   * Reserved for the two edges where the agent is really gone (`agent/disposed`,
   * the agent's own scope unwinding) and for the plugin unmount. Releasing the
   * lifecycle listeners of an agent that still exists would drop the settlement
   * evidence of its running children.
   * @param agent - the agent.
   */
  const release = (agent) => {
    releaseEffects(agent);
    releaseDelegation(agent);
  };

  const restrictTo = (registry, allow) => registry.restrict({ allow: [...allow] });

  /**
   * The inherited tool names a restriction MAY name.
   *
   * `tools.restrict()` validates every name against `view(scope)`'s
   * `restrictableNames`, which is the GLOBAL layer plus the scope's ANCESTORS —
   * a scope's own registrations are exempt (they are the child's structured
   * output and, here, this gate's own two tools). The allow list a user writes
   * therefore routinely names tools that exist only in the agent's own layer
   * (`wait_subagent`), and passing those to `restrict()` would throw, trip the
   * typo fallback, and report a healthy configuration as a rejected one.
   *
   * When the host does NOT expose the set, no name can be checked, so every
   * name stays in the list and a bad one fails loudly at `restrict()` (the
   * fallback path). When it DOES, an unresolvable name is dropped from the
   * RESTRICTION (never from the effective allow list the catalog filter and the
   * guard enforce) and reported as `CONFIG-UNKNOWN` — see `applyTo`.
   * @param registry - the scope-bound tool registry.
   * @param agent - the scope key to resolve the restriction names for.
   * @returns the restrictable names, or undefined when the host does not expose them.
   */
  const restrictableNamesOf = (registry, agent) => {
    const view = registry?.view;
    if (typeof view !== 'function') return undefined;
    try {
      const resolved = view.call(registry, agent)?.restrictableNames;
      return typeof resolved?.has === 'function' ? resolved : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Every tool name one agent's scope can resolve, INCLUDING its own layer.
   *
   * `restrictableNames` deliberately leaves the scope's own layer out (see
   * {@link restrictableNamesOf}), so it cannot answer "does this name exist at
   * all?": the Agent Teams / schedule tools and this gate's own two tools are
   * own-layer registrations that the CATALOG filter can still allow. Existence
   * and restrictability are therefore two different questions, and a name that
   * is in neither `restrictableNames` nor `knownNames` is a typo — which has to
   * fail loudly instead of silently shrinking the surface.
   * @param registry - the scope-bound tool registry.
   * @param agent - the scope key to resolve the names for.
   * @returns the known names, or undefined when the host does not expose them.
   */
  const knownNamesOf = (registry, agent) => {
    const view = registry?.view;
    if (typeof view !== 'function') return undefined;
    try {
      const resolved = view.call(registry, agent)?.knownNames;
      return typeof resolved?.has === 'function' ? resolved : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Narrow one allow list to the names `restrict()` can actually accept.
   * @param allow - the effective allow list.
   * @param restrictable - the restrictable names, when known.
   * @returns the list for `restrict()` (possibly empty).
   */
  const restrictAllowFor = (allow, restrictable) => allow.filter((name) => {
    // A gate-owned tool lives in the agent's own layer: exempt from restrict()
    // by construction. Every other name must be restrictable or it is a typo.
    if (GATE_TOOL_NAMES.includes(name)) return restrictable === undefined ? false : restrictable.has(name);
    return restrictable === undefined ? true : restrictable.has(name);
  });

  /**
   * The run bookkeeping of one governed agent.
   *
   * Kept OUTSIDE the per-application disposers on purpose: a settings write
   * re-installs the effect set, and a re-install must not forget which children
   * are still running (the lifecycle events are push-only, so a lost record is
   * a settlement this process can never reconstruct). `observers` holds the
   * `subagent/start` + `subagent/end` listeners on the SAME lifetime: installed
   * once per agent, handed back to every re-install, disposed only when the
   * agent (or the plugin) goes away.
   * @param agent - the governed agent.
   * @returns its entry, created on first use.
   */
  const delegationOf = (agent) => {
    let entry = delegations.get(agent);
    if (entry === undefined) {
      entry = { tracker: createChildRuns(), observers: undefined };
      delegations.set(agent, entry);
    }
    return entry;
  };

  /**
   * Release the durable bookkeeping of one agent and the listeners feeding it.
   *
   * The listeners go FIRST, so a late edge cannot repopulate a tracker that no
   * longer has an owner. Never call this while the agent still exists (see
   * {@link releaseEffects}).
   * @param agent - the agent.
   */
  const releaseDelegation = (agent) => {
    const entry = delegations.get(agent);
    if (entry === undefined) return;
    delegations.delete(agent);
    for (const dispose of entry.observers ?? []) {
      try {
        dispose();
      } catch {
        // The agent's own scope already unwound it.
      }
    }
    entry.observers = undefined;
    entry.tracker.reset();
  };

  /**
   * Resolve one service without letting a throwing accessor escape.
   * @param service - the service name.
   * @returns the service, or undefined.
   */
  const serviceOf = (service) => {
    try {
      return ctx.get(service);
    } catch {
      return undefined;
    }
  };

  const coordination = new Coordination({
    ctx,
    settings: () => settingsOf(config),
    governs: (agent) => governs(agent, settingsOf(config)),
    reconcile: (agent) => reconcile(agent, settingsOf(config), 'mode-switch'),
  });
  const workerEffects = new Map();
  const workerSignatures = new Map();
  const modeSettings = (agent, settings) => {
    const mode = coordination.mode(agent);
    if (mode !== 'team') return { ...settings, mode, builtinTools: DEFAULT_ORCHESTRATOR_TOOLS };
    const requested = settings.teamOrchestratorTools.trim();
    const tools = requested.split(/[,\s]+/).filter(Boolean);
    return {
      ...settings, mode, builtinTools: DEFAULT_TEAM_TOOLS,
      allow: tools.length ? tools : DEFAULT_TEAM_TOOLS,
      allowRequested: requested, allowFallback: !tools.length,
      systemPrompt: settings.systemPrompt === DEFAULT_ORCHESTRATOR_PROMPT ? TEAM_PROMPT : settings.systemPrompt,
    };
  };
  installAdmission(ctx, coordination, (agent) => governs(agent, settingsOf(config)), (agent) => delegationOf(agent).tracker);
  installHostUi(ctx, coordination, (agent) => governs(agent, settingsOf(config)));

  /**
   * The child agents' LLM route from the live settings.
   * @param settings - the live settings.
   * @returns the options to merge over the child's inherited route, or
   *   undefined when every field is blank (inherit the parent's own route).
   */
  const childAgentOptions = (settings) => {
    const { provider, model, reasoningEffort } = settings.subagent;
    if (provider.length === 0 && model.length === 0 && reasoningEffort.length === 0) return undefined;
    return {
      ...provider.length === 0 ? {} : { provider },
      ...model.length === 0 ? {} : { model },
      ...reasoningEffort.length === 0 ? {} : { reasoningEffort },
    };
  };

  /**
   * Install the delegation surface (the two own-layer tools + their lifecycle
   * bookkeeping) on one governed agent.
   *
   * Two lifetimes: the `subagent/start` + `subagent/end` listeners are installed
   * exactly once per agent (`installChildRunObservers`) and reused by every
   * re-install, while the two tool registrations are replaced with each
   * application of the effect set (`observeLifecycle: false`).
   *
   * FAIL-CLOSED by design: a governed agent must get exactly the delegation
   * surface the model's prompt describes. If the tools package, the registry,
   * or the `subagents` service cannot deliver it, this throws
   * `CONFIG-TOOLS-UNAVAILABLE` instead of leaving the agent with the upstream
   * tool (no `agent_id`, no wait) or with no delegation at all.
   * @param agent - the governed depth-0 agent.
   * @param agentCtx - its own scoped context.
   * @param registry - the scope-bound tool registry.
   * @param settings - the live settings.
   * @param reason - the hook that triggered this application, for the log.
   * @returns the disposers plus a status word for the diagnostic log.
   */
  const installDelegation = (agent, agentCtx, registry, settings, reason) => {
    const entry = delegationOf(agent);
    const options = childAgentOptions(settings);
    // The listeners are installed ONCE per governed agent and then handed back
    // to every re-install: they are the only channel through which a settlement
    // ever reaches this process, so they must outlive a settings write (which
    // releases and re-registers the two tools below). FAIL-CLOSED: if they
    // cannot be registered, this throws and the agent is never announced.
    let installedObservers = false;
    if (entry.observers === undefined) {
      entry.observers = installChildRunObservers({
        agentCtx,
        tracker: entry.tracker,
        note: (line) => note(settings, line),
      });
      installedObservers = true;
    }
    let installed;
    try {
      installed = installDelegationTools({
        agentCtx,
        agent,
        registry,
        waitBudget: settings.wait,
        subagents: serviceOf('subagents'),
        agents: serviceOf('agents'),
        tracker: entry.tracker,
        childAgentOptions: options,
        maxDepth: MAX_SUBAGENT_DEPTH,
        note: (line) => note(settings, line),
        logError: (line) => ctx.logger?.error?.(line),
        observeLifecycle: false,
        observerDisposers: entry.observers,
      });
    } catch (error) {
      // Nothing of this surface survives (`applyTo` releases every effect it
      // installed), so a listener installed by THIS call would feed a tracker
      // nothing owns any more. A listener that was already there is kept: the
      // agent still exists and the next application has to reuse it.
      if (installedObservers) {
        for (const dispose of entry.observers) {
          try {
            dispose();
          } catch {
            // Already released.
          }
        }
        entry.observers = undefined;
      }
      throw error;
    }
    note(
      settings,
      `delegation id=${shortId(agent)} reason=${reason} tools=[${GATE_TOOL_NAMES.join(' ')}] `
      + `agentOptions=${options === undefined ? 'inherit' : `[${Object.entries(options).map(([key, value]) => `${key}=${value}`).join(' ')}]`} `
      + `maxDepth=${MAX_SUBAGENT_DEPTH}`,
    );
    return installed;
  };

  /**
   * The presentation mode one scope's agent sees (`native` / `ptc` / `both`).
   *
   * `ToolRuntime.modeFor(scope)` is the registry's own resolver — the one
   * `wireSchemas()` and the PTC collapse both read — and the assembly context
   * passes the agent itself as the scope (`assembleContextFor` returns
   * `{ agent, scope: agent }`). It is declared private, so an unknown or
   * throwing resolver yields `undefined` ("unknown") and the assembly backstop
   * inside {@link installCatalogFilter} decides from authoritative data.
   * @param registry - the scope-bound tool registry, when it resolved.
   * @param agent - the scope key to resolve for.
   * @returns the mode, or undefined when it cannot be read.
   */
  const presentationOf = (registry, agent) => {
    const modeFor = registry?.modeFor;
    if (typeof modeFor !== 'function') return undefined;
    try {
      const mode = modeFor.call(registry, agent);
      return typeof mode === 'string' ? mode : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * The one message that names a configuration this gate cannot enforce.
   *
   * Shared verbatim by the diagnostic log line and by the error thrown out of
   * the assembly waterfall, so a blocked request and its recorded cause carry
   * the same `CONFIG-UNSUPPORTED` text.
   * @param settings - the live settings (the allow list it cannot guarantee).
   * @param agent - the agent whose scope presents the unsupported mode.
   * @param mode - the presentation mode that was resolved.
   * @param source - where the mode was resolved (`presentation` | `assembly`).
   * @returns the message.
   */
  const unsupportedMessage = (settings, agent, mode, source) =>
    `CONFIG-UNSUPPORTED id=${shortId(agent)} presentation=${mode} source=${source}: this agent does not present tools natively, `
    + `so the "${settings.allow.join(', ')}" catalog cannot be guaranteed (run_code's SDK surface is built from view(scope), not from the assembly). `
    + 'FAIL-CLOSED: the gate refuses to assemble a model request for this agent and denies every tool outside the allow list. '
    + 'Run the preset with the native tool presentation — the `frugal` preset composes no `tool-presentation` row, so its agents present natively.';

  /**
   * Record a configuration this gate cannot enforce correctly.
   *
   * The gate has no UI surface: the logger and `$DSH_HOME/frugal-gate.log` are
   * its two observable channels, and a silent degradation here would look
   * exactly like a working deployment until someone counted the tools.
   * @param settings - the live settings (the `diagnostics` switch gates the file).
   * @param agent - the agent whose scope presents the unsupported mode.
   * @param mode - the presentation mode that was resolved.
   * @param source - where the mode was resolved (`presentation` | `assembly`).
   */
  const declareUnsupported = (settings, agent, mode, source) => {
    const line = unsupportedMessage(settings, agent, mode, source);
    note(settings, line);
    ctx.logger?.error?.(`frugal-gate: ${line}`);
  };

  /**
   * The FAIL-CLOSED half of {@link declareUnsupported}.
   *
   * Thrown from the `system-prompt/assemble` listener, where it aborts the step:
   * `ReactLoopAgent.preStep()` awaits that waterfall BEFORE it builds the
   * request header, so the model request is never sent. A plain `Error` with a
   * `CONFIG-UNSUPPORTED` code is enough — nothing in the loop has to know the
   * class, only the operator reading `agent/error` does.
   * @param settings - the live settings.
   * @param agent - the agent whose scope presents the unsupported mode.
   * @param mode - the presentation mode that was resolved.
   * @param source - where the mode was resolved (`presentation` | `assembly`).
   * @returns the error to throw.
   */
  const unsupportedError = (settings, agent, mode, source) => {
    const error = new Error(unsupportedMessage(settings, agent, mode, source));
    error.name = 'FrugalConfigUnsupportedError';
    error.code = 'CONFIG-UNSUPPORTED';
    return error;
  };

  /**
   * Install the authoritative model-facing catalog filter and its execution guard.
   *
   * WHY THIS EXISTS, and why `restrict()` alone can never do it: a restriction
   * filters what a scope INHERITS and never what its OWN layer registers
   * (`ToolRuntime.view()`), while the Agent Teams tools
   * (`dsh-experimental-tool-agent-team`) and the schedule tools
   * (`dsh-schedule`) register through `agent.ctx.tools.register()` — the
   * agent's own layer. They therefore survive every `restrict()` and stay in
   * the model's catalog for a depth-0 agent.
   *
   * The seam is `system-prompt/assemble`: `dsh-tools` contributes the tool
   * table to every assembly (`ctx.systemPrompt.tools((context) =>
   * wireSchemas(context.scope))`), the agent loop is its only consumer and
   * hands `assembly.tools` straight to the request header, and the event is
   * documented as an expert waterfall whose return value is authoritative over
   * "the assembled sections, contexts, tools, and variables". It is a
   * scope-filtered dispatch, so a listener registered on the agent's OWN scope
   * receives exactly that agent's assemblies — one scope closer than the
   * preset, and never a child's (a child's scope chain joins the preset mount,
   * not its parent agent's scope key).
   *
   * Consequences that make this the right seam:
   *   - it runs on EVERY assembly, so a tool registered or injected after this
   *     installation is filtered on the next step (no install-order race);
   *   - it removes every scope-own registration the allow list does not name,
   *     whichever bundle installed it (Team, schedule, MCP, a future tool);
   *   - the identity check (`context.agent === agent`) keeps a mismatched or
   *     foreign assembly untouched (fail-safe: never filter someone else's
   *     request).
   *
   * The catalog alone would be cosmetic: a scope-own registration stays
   * EXECUTABLE (`resolveExecution` reads the same `view(scope)`), so a model
   * that names a hidden tool would still run it. The same allow list is
   * therefore enforced as a `tools.guard()`, which applies to that agent only.
   *
   * NATIVE PRESENTATION IS REQUIRED, and the requirement is ENFORCED rather
   * than merely recorded: under `ptc`/`both` the model's surface is `run_code`
   * plus the SDK bindings generated from `sdkSchemas(scope)` = `view(scope)`,
   * which no `system-prompt/assemble` listener can rewrite. The two dishonest
   * options are "keep a third tool and pretend" and "silently empty the
   * catalogue" (a strict filter over a `ptc` assembly, which contains only
   * `run_code`, would leave the model with ZERO tools). The gate takes neither,
   * and it does not hand the table over untouched either: under a non-native
   * presentation the assembly listener THROWS a CONFIG-UNSUPPORTED
   * configuration error. `ReactLoopAgent.preStep()` awaits the waterfall before
   * it builds the request header, so the request is never sent — fail-closed,
   * not "logged and ignored". The guard below stays strict in that state too,
   * so nothing outside the allow list can execute even if it is somehow
   * reached. The error is recorded to the logger and the diagnostic log.
   *
   * @param agentCtx - the orchestrator's scoped context.
   * @param agent - the orchestrator, for the assembly identity check.
   * @param settings - the live settings (the `diagnostics` switch gates the log).
   * @param allow - the EFFECTIVE allow list (already reconciled with a
   *   rejected `restrict()`, so the catalog can never disagree with it).
   * @param presentation - the scope's presentation mode when the host exposes
   *   it, else undefined ("unknown": decided at assembly time instead).
   * @returns the disposers to release with the rest of the gate, plus a status
   *   word for the diagnostic log.
   */
  const installCatalogFilter = (agentCtx, agent, settings, allow, presentation) => {
    const allowed = new Set(allow);
    /** Strictly the effective allow list: `run_code` is a DETECTOR below, never an exception. */
    const keep = (name) => allowed.has(name);
    const disposers = [];
    let detail = 'catalog=unavailable';
    /**
     * The non-native presentation this scope was proven to have, and where the
     * proof came from. `undefined` means "nothing non-native seen yet": the
     * assembly backstop below fills it in when the host exposes no resolver.
     * Once set, this scope's model requests are BLOCKED (the listener throws)
     * and the guard stays strict — see the doc comment above.
     */
    const state = {
      unsupported: presentation === undefined || presentation === NATIVE_PRESENTATION ? undefined : presentation,
      source: 'presentation',
    };

    if (typeof agentCtx?.on !== 'function') {
      ctx.logger?.error?.('frugal-gate: agent ctx has no event API; the orchestrator keeps every scope-own tool in its catalog');
      return { disposers, detail };
    }

    // Known before the first assembly because the registry's own resolver said
    // so: say it once here; the listener installed below then blocks every
    // attempt, so nothing depends on an assembly ever being observed.
    if (state.unsupported !== undefined) declareUnsupported(settings, agent, state.unsupported, state.source);

    try {
      // What the model actually receives, recorded once per DISTINCT catalog:
      // the log is the only surface that shows the filtered result without
      // exporting a session, and a per-step line would drown it.
      let logged = undefined;
      disposers.push(agentCtx.on('system-prompt/assemble', async (assembly, context, next) => {
        const result = await next();
        if (context?.agent !== agent) return result;
        const tools = result?.tools;
        if (state.unsupported === undefined && Array.isArray(tools) && tools.some((tool) => tool?.name === RUN_CODE_NAME)) {
          // Backstop for a host that does not expose the presentation mode up
          // front: `view()` appends the reserved transport exactly when a scope
          // presents `ptc`/`both`, and the name cannot be registered, so seeing
          // it here PROVES a non-native presentation. Filtering this table
          // would leave the model an empty catalog under `ptc`; keeping the
          // transport would be a third tool. So the assembly is REFUSED below.
          state.unsupported = 'ptc/both';
          state.source = 'assembly';
          declareUnsupported(settings, agent, state.unsupported, state.source);
        }
        if (state.unsupported !== undefined) {
          // FAIL-CLOSED: no model request may leave with a catalog this gate
          // cannot guarantee. The agent loop awaits this waterfall before it
          // builds the request header, so throwing here cancels the step.
          throw unsupportedError(settings, agent, state.unsupported, state.source);
        }
        if (!Array.isArray(tools)) return result;
        const kept = tools.filter((tool) => keep(tool?.name));
        const signature = kept.map((tool) => tool?.name).join(' ');
        if (signature !== logged) {
          logged = signature;
          note(settings, `catalog id=${shortId(agent)} tools=[${signature}] dropped=${tools.length - kept.length}`);
        }
        if (kept.length === tools.length) return result;
        return { ...result, tools: kept };
      }));
      detail = state.unsupported === undefined
        ? `catalog=[${allow.join(' ')}]`
        : `catalog=unsupported-presentation(${state.unsupported})+blocked`;
    } catch (error) {
      detail = `catalog=failed(${describe(error)})`;
      ctx.logger?.error?.(`frugal-gate: could not install the catalog filter; the orchestrator keeps every scope-own tool — ${describe(error)}`);
    }

    const registry = toolsOf(agentCtx);
    const guard = registry?.guard;
    if (typeof guard !== 'function') {
      detail += '+guard-unavailable';
      return { disposers, detail };
    }
    try {
      // Strict in every state, INCLUDING a non-native presentation: blocking the
      // request is the primary defence, and a denied tool is the second one. The
      // guard never widens to "unsupported, so let it through".
      disposers.push(guard.call(registry, (exec) => {
        if (keep(exec?.name)) return undefined;
        return `frugal-gate: tool "${describe(exec?.name)}" is not available to this orchestrator (available: ${allow.join(', ')})`;
      }));
      detail += '+guard';
    } catch (error) {
      detail += `+guard-failed(${describe(error)})`;
      ctx.logger?.error?.(`frugal-gate: could not install the tool guard; a hidden scope-own tool would still execute — ${describe(error)}`);
    }
    return { disposers, detail };
  };

  /**
   * Install the orchestrator's system prompt in the agent's own scope.
   *
   * The preset's `persona` row registers `deployment:persona-prefix` (with
   * `complete: true`) in the preset's scope; a section is shadowed by name, so
   * registering the same name one scope closer replaces it for this agent and
   * leaves children — which have their own scopes and their own shadowing
   * `persona` from `tool-subagent` — untouched.
   *
   * The text is `orchestratorSectionText(prompt)`: the user's policy prompt plus
   * the fixed tool contract. `assemble()` restores a `complete` section as the
   * ONLY prompt section, so this one section is the only place the contract can
   * live.
   * @param prompt - the orchestrator's scoped prompt registry.
   * @param text - the prompt to install (already carrying the fixed contract).
   * @returns the disposer (when installed) plus a status word for the log.
   */
  const installPrompt = (prompt, text) => {
    if (prompt === undefined || typeof prompt.section !== 'function') {
      return { detail: 'unavailable' };
    }
    let order = PERSONA_PREFIX_ORDER;
    if (typeof prompt.getSectionOrder === 'function') {
      const resolved = prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX');
      if (Number.isFinite(resolved)) order = resolved;
    }
    try {
      const disposer = prompt.section({ name: PERSONA_PREFIX_SECTION, order, text, complete: true });
      return { disposer, detail: `ok@${order}` };
    } catch (error) {
      return { detail: `failed(${describe(error)})` };
    }
  };

  /** Re-derive every per-agent effect for one depth-0 agent from the live settings. */
  const applyTo = (agent, settings, reason) => {
    const agentCtx = agent?.ctx;
    if (agentCtx === undefined) {
      ctx.logger?.error?.('frugal-gate: agent/created payload carried no agent context');
      note(settings, `apply id=${shortId(agent)} reason=${reason} FAILED no-agent-ctx`);
      return;
    }
    // Effects only: re-applying the switches must never forget the children
    // this agent already created (their settlement edges are never replayed).
    releaseEffects(agent);

    const disposers = [];
    let toolOutcome = 'tools=unrestricted';
    // The list the CATALOG filter and the guard enforce. Kept in step with what
    // `restrict()` actually accepted, so a typo in the GUI list can never leave
    // the orchestrator with an empty catalog while the restriction fell back to
    // the built-in trio.
    let effectiveAllow = settings.allow;
    const builtinTools = settings.builtinTools ?? DEFAULT_ORCHESTRATOR_TOOLS;
    if (settings.mode === 'team') {
      const teams = serviceOf('agentTeams');
      const unavailable = (message) => {
        const entry = coordination.entry(agent);
        entry.state.warning = { code: 'TEAM-UNAVAILABLE', message };
        coordination.publish(entry);
        throw Object.assign(new Error(`TEAM-UNAVAILABLE: ${message}`), { code: 'TEAM-UNAVAILABLE' });
      };
      if (typeof teams?.spawnTeammate !== 'function') unavailable('native Agent Teams service is required');
      const actual = knownNamesOf(toolsOf(agentCtx), agent);
      // `TEAM_TOOLS` is the NATIVE surface only: the image reader this plugin
      // registers itself is deliberately not part of the check, so a deployment
      // without an attachment service degrades the bridge (logged) instead of
      // looking like a Team service that cannot work.
      const missing = actual === undefined ? TEAM_TOOLS : TEAM_TOOLS.filter((name) => !actual.has(name));
      if (missing.length) unavailable(`missing native tool registrations: ${missing.join(', ')}`);
    }
    let allowFallback = settings.allowFallback;
    const registry = toolsOf(agentCtx);
    // The READ half of the image bridge, in both modes. AFTER `registry` is bound
    // (the install needs it), and independent of the native-tool checks above,
    // which only cover the host's own Team surface. Deliberately NOT fail-closed:
    // losing the bridge degrades image delivery to the child's text report.
    try {
      const images = installImageTools({ agent, agentCtx, registry, role: 'lead', settings });
      for (const dispose of images.disposers) disposers.push(dispose);
      toolOutcome += ` images=[${images.names.join(' ')}]`;
    } catch (error) {
      note(settings, `IMAGE-BRIDGE lead id=${shortId(agent)} FAILED ${describe(error)}`);
      ctx.logger?.warn?.(`frugal-gate: no Lead image bridge (image delivery degrades to text); ${describe(error)}`);
    }
    const presentation = presentationOf(registry, agent);
    const restrictable = restrictableNamesOf(registry, agent);
    const known = knownNamesOf(registry, agent);

    /**
     * Release everything installed so far. Only the fail-closed paths below use
     * it: a partially applied orchestrator must not survive as "the switches
     * worked but the tools are someone else's".
     */
    const abandon = () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // Already released.
        }
      }
      applied.delete(agent);
    };

    try {
      if (settings.allowFallback) {
        // An explicit, non-blank list that reconciles to nothing must never mean
        // "unrestricted": that is the fail-open this branch exists to prevent.
        ctx.logger?.error?.(
          `frugal-gate: orchestratorTools=${JSON.stringify(settings.allowRequested)} reconciles to no tool `
          + '(the skills switch owns "skill"); enforcing the built-in '
          + `${DEFAULT_ORCHESTRATOR_TOOLS.join(', ')} instead of leaving the orchestrator unrestricted`,
        );
        note(settings, `CONFIG-FALLBACK id=${shortId(agent)} reason=${reason} requested=${describe(settings.allowRequested)} allow=[${settings.allow.join(' ')}]`);
      } else if (settings.allow.length > 0) {
        // A name the scope cannot resolve AT ALL is a typo, and a typo must not
        // silently shrink the orchestration surface (the prompt still promises
        // all three tools). `knownNames` is the registry's own answer for every
        // layer INCLUDING the agent's own — the gate's own two tools are known
        // by construction even though the delegation surface is registered a
        // moment later — while `restrictableNames` deliberately leaves the own
        // layer out. So "unknown" here means "names nothing anywhere", and the
        // list fails loudly into the built-in trio, exactly like a list that
        // reconciles to nothing. A name that IS known but not restrictable is a
        // legitimate own-layer tool: it keeps its place in the effective list
        // (the catalog filter and the guard can allow it) and is merely left out
        // of `restrict()`, which could never name it.
        const knownAll = known === undefined ? undefined : new Set([...known, ...GATE_TOOL_NAMES]);
        const unknownNames = knownAll === undefined ? [] : settings.allow.filter((name) => !knownAll.has(name));
        const ownLayerNames = restrictable === undefined || knownAll === undefined
          ? []
          : settings.allow.filter((name) => knownAll.has(name) && !restrictable.has(name) && !GATE_TOOL_NAMES.includes(name));
        if (unknownNames.length > 0) {
          allowFallback = true;
          effectiveAllow = builtinTools;
          const message = `frugal-gate: orchestratorTools names ${unknownNames.map((name) => JSON.stringify(name)).join(', ')}, `
            + 'which no tool layer (global, ancestors, or the agent\'s own) provides; enforcing the built-in '
            + `${DEFAULT_ORCHESTRATOR_TOOLS.join(', ')} instead of a list that silently loses tools`;
          ctx.logger?.error?.(message);
          note(settings, `CONFIG-UNKNOWN id=${shortId(agent)} reason=${reason} requested=${describe(settings.allowRequested)} names=[${unknownNames.join(' ')}]`);
          note(settings, `CONFIG-FALLBACK id=${shortId(agent)} reason=${reason} requested=${describe(settings.allowRequested)} allow=[${effectiveAllow.join(' ')}]`);
        } else if (ownLayerNames.length > 0) {
          // Allowed, documented, and reported: the model-facing list still names
          // them, so they survive the catalog filter, but `restrict()` cannot
          // name them and they are dropped from the restriction on purpose.
          note(settings, `CONFIG-OWN-LAYER id=${shortId(agent)} reason=${reason} names=[${ownLayerNames.join(' ')}]`);
        }
      }

      if (effectiveAllow.length > 0) {
        const restrict = registry?.restrict;
        // `restrict()` never reaches the agent's own layer, so the names this
        // gate registers there are dropped from the restriction (see
        // {@link restrictAllowFor}); the assembly filter and the guard still
        // enforce the FULL list.
        const restrictAllow = restrictAllowFor(effectiveAllow, restrictable);
        const builtinAllow = restrictAllowFor(builtinTools, restrictable);
        if (typeof restrict !== 'function') {
          toolOutcome = 'tools=restrict-unavailable';
          ctx.logger?.error?.('frugal-gate: the tool registry is unavailable; the orchestrator keeps every inherited tool');
        } else if (restrictAllow.length === 0) {
          toolOutcome = 'tools=own-layer-only';
        } else {
          try {
            disposers.push(restrictTo(registry, restrictAllow));
            toolOutcome = allowFallback
              ? `tools=fallback(${describe(settings.allowRequested)}->[${effectiveAllow.join(' ')}])`
              : `tools=[${effectiveAllow.join(' ')}]`;
          } catch (error) {
            // A typo in the GUI text field must not brick session creation. Fall
            // back to the built-in trio, and say so loudly.
            effectiveAllow = builtinTools;
            toolOutcome = `tools=rejected(${describe(error)})`;
            ctx.logger?.error?.(`frugal-gate: tools.restrict(${restrictAllow.join(', ')}) was rejected; retrying with ${builtinAllow.join(', ')} — ${describe(error)}`);
            try {
              disposers.push(restrictTo(registry, builtinAllow));
              toolOutcome += `->[${builtinAllow.join(' ')}]`;
            } catch (fallbackError) {
              toolOutcome += `->unrestricted(${describe(fallbackError)})`;
              ctx.logger?.error?.(`frugal-gate: the orchestrator keeps every inherited tool; ${describe(fallbackError)}`);
            }
          }
        }

        // The restriction above only reaches INHERITED layers. This is what
        // actually produces the three-tool catalog for a depth-0 agent.
        const catalog = installCatalogFilter(agentCtx, agent, settings, effectiveAllow, presentation);
        for (const dispose of catalog.disposers) disposers.push(dispose);
        toolOutcome += ` ${catalog.detail}`;
      }

      let contextOutcome = `runtimeContext=${settings.includeRuntimeContext}`;
      // Resolved once, tolerating an accessor that throws (see {@link promptOf}).
      const prompt = promptOf(agentCtx);
      if (!settings.includeRuntimeContext) {
        const suppress = prompt?.suppressRuntimeContext;
        if (typeof suppress === 'function') {
          try {
            disposers.push(suppress.call(prompt));
            contextOutcome = 'runtimeContext=suppressed';
          } catch (error) {
            contextOutcome = `runtimeContext=suppress-failed(${describe(error)})`;
            ctx.logger?.error?.(`frugal-gate: suppressRuntimeContext() failed; ${describe(error)}`);
          }
        } else {
          contextOutcome = 'runtimeContext=suppress-unavailable';
        }
      }

      const sectionText = settings.mode === 'team'
        ? `${settings.systemPrompt}\n\n${TEAM_CONTRACT}${teamWaitContract(settings.wait)}`
        : orchestratorSectionText(settings.systemPrompt);
      const promptOutcome = installPrompt(prompt, sectionText);
      if (promptOutcome.disposer !== undefined) disposers.push(promptOutcome.disposer);
      else if (promptOutcome.detail !== 'unavailable') {
        // A thrown `section()` is a hard failure: the orchestrator would silently
        // run on the preset's persona.
        ctx.logger?.error?.(`frugal-gate: could not install the orchestrator system prompt; ${promptOutcome.detail}`);
      }

      // The two own-layer tools. Installed last so that a failure here can
      // release everything above it, and FAIL-CLOSED: the agent must not run
      // with a delegation surface other than the one its prompt describes.
      if (settings.mode !== 'team') {
        const delegation = installDelegation(agent, agentCtx, registry, settings, reason);
        for (const dispose of delegation.disposers) disposers.push(dispose);
        toolOutcome += ` delegation=[${GATE_TOOL_NAMES.join(' ')}]`;
      } else {
        const entry = delegationOf(agent);
        entry.observers ??= installChildRunObservers({ agentCtx, tracker: entry.tracker, note: (line) => note(settings, line) });
        // The host's `wait_agent` lives in this agent's OWN layer and its
        // arguments are deep-frozen: a guard can only DENY a call, so the
        // configured minimum is enforced by refusing too-short waits with an
        // actionable reason, while the contract paragraph above tells the model
        // the number to pass. Nothing about the host tool definition changes.
        if (settings.wait.minMs > 0) {
          try {
            disposers.push(registry.guard((exec) => waitAgentGuardReason(exec, settings.wait)));
            toolOutcome += ` wait_agent>=${settings.wait.minMs}ms`;
          } catch (error) {
            ctx.logger?.error?.(`frugal-gate: could not install the wait_agent minimum guard; ${describe(error)}`);
          }
        }
      }
      if (settings.wait.invalid !== undefined) {
        // A typo must never become a silent lower bound (or a silent "no
        // minimum"): report it wherever diagnostics are looked at.
        note(settings, settings.wait.invalid);
        ctx.logger?.error?.(`frugal-gate: ${settings.wait.invalid}`);
      }
      const lifecycle = delegationOf(agent);
      if (!lifecycle.budgetObserver) {
        lifecycle.budgetObserver = lifecycle.tracker.onChange(() => {
          const entry = coordination.entry(agent);
          for (const member of entry.state.budget.members) {
            const observed = lifecycle.tracker.describe(member.id);
            if (observed.status === 'settled' && member.status !== 'settled' && !(member.receipts ?? []).some((receipt) => receipt.status === 'queued')) entry.budget.settle(member.mode, member.id, observed.stopReason);
          }
        });
      }

      owned.set(agent, () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // Already released.
          }
        }
      });
      applied.set(agent, effectSignature(settings));

      note(
        settings,
        `apply id=${shortId(agent)} reason=${reason} preset=${describe(presetOf(agent))} `
        + `${toolOutcome} ${contextOutcome} prompt=${settings.systemPrompt.length}chars`
        + `+contract=${TOOL_CAPABILITY_SUFFIX.length}chars/${promptOutcome.detail}`,
      );
      ctx.logger?.debug?.(`frugal-gate: orchestrator ${shortId(agent)} -> ${toolOutcome}, ${contextOutcome}`);
    } catch (error) {
      abandon();
      note(
        settings,
        `apply id=${shortId(agent)} reason=${reason} FAILED ${describe(error)}`,
      );
      // The failure is rethrown (the agent must not be announced with a
      // delegation surface this gate could not install), so it is also named on
      // the logger: that is the only channel besides `$DSH_HOME/frugal-gate.log`.
      ctx.logger?.error?.(
        `frugal-gate: could not apply the orchestrator configuration to agent ${shortId(agent)} (${reason}); `
        + `everything already installed for it was released — ${describe(error)}`,
      );
      throw error;
    }
  };

  /**
   * Bring one agent's gate state in line with the live settings.
   *
   * Idempotent and cheap when nothing changed, so it can run from every hook.
   * @param agent - the agent to reconcile.
   * @param settings - the live settings.
   * @param reason - the hook that triggered this, for the diagnostic log.
   * @returns whether the gate currently governs the agent.
   */
  const reconcile = (agent, settings, reason) => {
    if (agent === undefined || agent === null) return false;

    if (!governs(agent, settings)) {
      for (const dispose of workerEffects.get(agent) ?? []) dispose();
      workerEffects.delete(agent);
      workerSignatures.delete(agent);
      const entry = coordination.entries.get(agent.id ?? agent.session.id);
      if (entry?.loaded && entry.state.enabled !== false) { entry.state.enabled = false; coordination.publish(entry); }
      if (governed.has(agent) || owned.has(agent)) {
        orchestrators.delete(agent);
        governed.delete(agent);
        // A preset switch may be temporary (the user switches away and back), so
        // the tool/context effects go but the run bookkeeping — and the
        // listeners feeding it — stay: the children keep running either way, and
        // switching back has to be able to wait for them again.
        releaseEffects(agent);
        note(settings, `ungovern id=${shortId(agent)} reason=${reason} preset=${describe(presetOf(agent))}`);
      }
      return false;
    }

    governed.add(agent);
    remembered.add(agent);
    // A child of a `frugal` orchestrator joined the same preset revision, but
    // its tools and its prompt are the preset's own; only depth 0 is gated.
    const membership = teamMembership(ctx, agent);
    if (depthOf(agent) !== 0 || membership?.role === 'teammate') {
      const text = workerPersona(membership);
      const signature = `${membership?.role ?? 'child'}/${membership?.name ?? ''}/${text}`;
      if (workerSignatures.get(agent) !== signature) {
        for (const dispose of workerEffects.get(agent) ?? []) dispose();
        const disposers = [];
        const prompt = promptOf(agent.ctx);
        if (typeof prompt?.section !== 'function') throw new Error('WORKER-PERSONA: no scoped prompt capability');
        disposers.push(prompt.section({ name: PERSONA_PREFIX_SECTION, order: PERSONA_PREFIX_ORDER, text }));
        const denied = new Set(DELEGATION_DENY);
        if (membership?.role !== 'teammate') for (const tool of TEAM_TOOLS) if (tool !== 'ask_user_question') denied.add(tool);
        disposers.push(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
          const result = await next();
          if (context.agent !== agent) return result;
          if (result.tools.some((tool) => tool.name === RUN_CODE_NAME)) throw new Error('CONFIG-UNSUPPORTED: workers require native tools');
          return { ...result, tools: result.tools.filter((tool) => !denied.has(tool.name)) };
        }));
        disposers.push(toolsOf(agent.ctx).guard((exec) => denied.has(exec.name) ? 'NESTED-DELEGATION: workers cannot create lower agents or use another coordination mode' : undefined));
        // The DELIVERY half of the image bridge: this is the agent that does the
        // work, so this is the agent that can hand an image back. Not
        // fail-closed — a worker without the bridge still reports in text.
        try {
          const images = installImageTools({ agent, agentCtx: agent.ctx, registry: toolsOf(agent.ctx), role: 'worker', settings });
          for (const dispose of images.disposers) disposers.push(dispose);
          note(settings, `IMAGE-BRIDGE worker id=${shortId(agent)} role=${membership?.role ?? 'child'} [${images.names.join(' ')}]`);
        } catch (error) {
          note(settings, `IMAGE-BRIDGE worker id=${shortId(agent)} FAILED ${describe(error)}`);
          ctx.logger?.warn?.(`frugal-gate: no worker image bridge (image delivery degrades to text); ${describe(error)}`);
        }
        workerEffects.set(agent, disposers);
        workerSignatures.set(agent, signature);
      }
      return true;
    }

    settings = modeSettings(agent, settings);
    const stateEntry = coordination.entry(agent);
    if (stateEntry.loaded) {
      const personaWarning = /只有两个工具|只剩两个工具|不能续聊|无法续聊/.test(settings.systemPrompt) ? '自定义正文仍含旧工具或续聊说明；固定契约已追加，请在配置页修正文案。' : null;
      if (stateEntry.state.enabled !== true || stateEntry.state.personaWarning !== personaWarning) {
        stateEntry.state.enabled = true;
        stateEntry.state.personaWarning = personaWarning;
        coordination.publish(stateEntry);
      }
    }
    orchestrators.add(agent);
    if (owned.has(agent) && applied.get(agent) === effectSignature(settings)) return true;
    applyTo(agent, settings, reason);
    return true;
  };

  ctx.effect(() => () => {
    for (const dispose of [...owned.values()]) {
      try {
        dispose();
      } catch {
        // The agent's own scope already unwound it.
      }
    }
    for (const disposers of workerEffects.values()) for (const dispose of disposers) dispose();
    workerEffects.clear();
    workerSignatures.clear();
    owned.clear();
    applied.clear();
    orchestrators.clear();
    governed.clear();
    remembered.clear();
    // Unmount: the listeners go with the bookkeeping.
    for (const agent of [...delegations.keys()]) releaseDelegation(agent);
    delegations.clear();
  }, 'frugal-gate.cleanup');

  ctx.on('agent/created', async ({ agent, source }) => {
    const settings = settingsOf(config);
    const preset = presetOf(agent);
    const depth = depthOf(agent);
    if (depth === 0 && governs(agent, settings) && teamMembership(ctx, agent)?.role !== 'teammate') await coordination.run(agent, async () => {});
    const didGovern = reconcile(agent, settings, `created:${describe(source)}`);
    note(
      settings,
      `created id=${shortId(agent)} depth=${depth} preset=${describe(preset)} `
      + `wanted=${settings.presetId} governed=${didGovern}`,
    );

    if (!didGovern || depth !== 0) return;
    agent?.ctx?.effect(() => () => {
      orchestrators.delete(agent);
      release(agent);
    }, 'frugal-gate.agent');
  });

  ctx.on('agent/disposed', ({ agent }) => {
    for (const dispose of workerEffects.get(agent) ?? []) dispose();
    workerEffects.delete(agent);
    workerSignatures.delete(agent);
    orchestrators.delete(agent);
    governed.delete(agent);
    remembered.delete(agent);
    release(agent);
  });

  // The preset is not always final when `agent/created` fires: a blank session
  // created on the profile default and switched afterwards reaches the gate
  // only through this edge. Without it the gate governs nothing at all in the
  // ordinary "create, then pick 省钱编排" flow.
  ctx.on('agent-preset/selected', async (sessionId, agentPreset) => {
    const settings = settingsOf(config);
    const registry = ctx.get('agents');
    const agent = typeof registry?.get === 'function' ? registry.get(sessionId) : undefined;
    if (agent && depthOf(agent) === 0 && governs(agent, settings)) await coordination.run(agent, async () => {});
    const didGovern = reconcile(agent, settings, 'preset-selected');
    note(
      settings,
      `selected id=${describe(sessionId).slice(0, 8)} preset=${describe(agentPreset)} `
      + `live=${agent === undefined ? 'no' : 'yes'} governed=${didGovern}`,
    );
  });

  /**
   * Every live agent the `agents` service exposes.
   *
   * `list()` is the complete set (roots plus delegated children) and `roots()`
   * the top-level subset; both are read when present because either alone
   * under-covers on some hosts. A service that exposes neither — or one that
   * throws — degrades to an empty list and the caller falls back to the agents
   * this gate has already decided about, so a missing API costs coverage, never
   * correctness.
   * @returns the distinct live agents, in service order.
   */
  const liveAgents = () => {
    let registry;
    try {
      registry = ctx.get('agents');
    } catch {
      // An accessor that throws costs coverage, never the config write itself.
      return [];
    }
    const found = [];
    const seen = new Set();
    for (const method of ['list', 'roots']) {
      if (typeof registry?.[method] !== 'function') continue;
      try {
        const value = registry[method]();
        if (!Array.isArray(value)) continue;
        for (const agent of value) {
          if (agent === undefined || agent === null || seen.has(agent)) continue;
          seen.add(agent);
          found.push(agent);
        }
      } catch {
        // Try the next accessor; the caller still has its own record.
      }
    }
    return found;
  };

  /** A config write commits into the live references; re-derive what already exists. */
  ctx.on('loader/volatile-update', () => {
    const settings = settingsOf(config);
    // A write can change WHICH agents this gate governs, in both directions: a
    // `presetId` edit away from an agent ungoverns it (and drops it from
    // `governed`), so a later edit back would never reach that live session if
    // this swept `governed` alone — and the session's first assembly after the
    // write can even precede the next `agent/pre-step`. Sweep three sources:
    //   - `agents.list()` / `roots()`: the authoritative live set, which also
    //     covers a session this gate never decided about;
    //   - `remembered`: agents it governed before, for a host whose service
    //     exposes neither accessor;
    //   - `governed`: what it currently owns.
    const targets = new Set([...remembered, ...governed]);
    for (const agent of liveAgents()) targets.add(agent);
    note(
      settings,
      `config allow=[${settings.allow.join(' ')}] fallback=${settings.allowFallback} `
      + `global=${settings.includeGlobalAgentsMd} `
      + `project=${settings.includeProjectAgentsMd} runtime=${settings.includeRuntimeContext} `
      + `prompt=${settings.systemPrompt.length}chars diagnostics=${settings.diagnostics} `
      + `sweep=${targets.size}(remembered=${remembered.size} governed=${governed.size})`,
    );
    for (const agent of targets) reconcile(agent, settings, 'volatile-update');
  });

  /**
   * Rewrite one message's instruction blocks, memoised on the message object.
   * @param message - one message entering the step.
   * @param settings - the live settings.
   * @param signature - the two switches the rewrite depends on.
   * @returns the same message, or a copy with the dropped sections removed.
   */
  const rewriteBaseline = (message, settings, signature) => {
    if (message?.source?.kind !== 'agent-instructions') return message;
    const content = message.content;
    if (!Array.isArray(content)) return message;

    const cached = rewrites.get(message);
    if (cached !== undefined && cached.signature === signature) return cached.out;

    const drop = (displayPath) => (isGlobalInstructionPath(displayPath)
      ? !settings.includeGlobalAgentsMd
      : !settings.includeProjectAgentsMd);

    let changed = false;
    const next = [];
    for (const item of content) {
      if (item?.type !== 'text' || typeof item.text !== 'string' || !item.text.includes(SECTION_MARKER)) {
        next.push(item);
        continue;
      }
      const text = dropSections(item.text, drop);
      if (text === item.text) {
        next.push(item);
        continue;
      }
      changed = true;
      next.push({ ...item, text });
    }

    const out = changed ? { ...message, content: next } : message;
    rewrites.set(message, { signature, out });
    return out;
  };

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (context?.agent && governs(context.agent, settingsOf(config))) {
      const before = applied.get(context.agent);
      if (depthOf(context.agent) === 0) await coordination.run(context.agent, async () => {});
      reconcile(context.agent, settingsOf(config), 'assemble');
      if (depthOf(context.agent) === 0 && before !== applied.get(context.agent)) {
        // SystemPrompt captured its complete section before this waterfall.
        // The awaited pre-step normally prevents this; direct/racing callers must retry.
        throw Object.assign(new Error('MODE-NOT-READY: persona changed during assembly; retry after mode restoration'), { code: 'MODE-NOT-READY' });
      }
    }
    const result = await next();
    return result;
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    const settings = settingsOf(config);
    const agent = payload?.agent;
    if (agent && governs(agent, settings) && depthOf(agent) === 0) {
      await coordination.run(agent, async () => {});
    }
    // Safety net: this runs for every agent on every step, so a governance
    // decision missed by the three announce-style hooks is repaired here,
    // before the request is assembled.
    reconcile(payload?.agent, settings, 'pre-step');

    let decision = await next();
    if (decision.kind !== 'enter') return decision;
    if (agent && governs(agent, settings)) {
      const membership = teamMembership(ctx, agent);
      const root = membership?.root ?? serviceOf('agents')?.get?.(agent.session.header.parentSession);
      if (root && root !== agent) {
        const entry = coordination.entry(root);
        if (entry.budget.checkpoint(agent.id, settings)) {
          const reminder = {
            id: randomUUID(), role: 'user', source: { kind: 'frugal-checkpoint' },
            content: [{ type: 'text', text: '软预算检查点：请提交已完成项、证据（文件/命令/结果）、未完成项和下一步，结束本轮，让 Lead 决定是否继续。不要新建接手者，不要中断正在执行的工具。' }],
          };
          root.steer?.({ ...reminder, id: randomUUID(), content: [{ type: 'text', text: `执行者 ${agent.id} 达到软预算，已提醒其提交短检查点；收到证据后由你决定是否续聊，勿新建替代成员。` }] });
          decision = { ...decision, messages: [...decision.messages, reminder] };
        }
      }
    }
    if (agent === undefined || !orchestrators.has(agent)) return decision;
    if (settings.includeGlobalAgentsMd && settings.includeProjectAgentsMd) return decision;

    const signature = `${settings.includeGlobalAgentsMd ? 1 : 0}${settings.includeProjectAgentsMd ? 1 : 0}`;
    let changed = false;
    const messages = decision.messages.map((message) => {
      const rewritten = rewriteBaseline(message, settings, signature);
      if (rewritten !== message) changed = true;
      return rewritten;
    });
    if (!changed) return decision;
    return { ...decision, messages };
  });

  ctx.on('agent/request', async (payload, next) => {
    const agent = payload?.agent;
    if (agent === undefined) return next();

    const settings = settingsOf(config);
    reconcile(agent, settings, 'request');

    const worker = depthOf(agent) !== 0 || teamMembership(ctx, agent)?.role === 'teammate';
    const override = worker ? settings.subagent : settings.orchestrator;
    const base = await next();
    if (!governed.has(agent) && !governs(agent, settings)) return base;
    // The output cap is no longer forced here: it is a policy of the
    // `@nu11dev/dsh-compaction-policy` row (memory: fit + reserve live there).
    return {
      ...base,
      ...(override.provider.length > 0 ? { provider: override.provider } : {}),
      ...(override.model.length > 0 ? { model: override.model } : {}),
      ...(override.reasoningEffort.length > 0 ? { reasoningEffort: override.reasoningEffort } : {}),
    };
  });

  const bootSettings = settingsOf(config);
  note(
    bootSettings,
    `boot log=${logPath} profile=${describe(process.env.DSH_PROFILE_DIR)} `
    + `allow=[${bootSettings.allow.join(' ')}] fallback=${bootSettings.allowFallback}`,
  );
}
