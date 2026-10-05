import { CHILD_PERSONA } from './delegation.js';
import { requireFromBases } from './resolve.js';

export const TEAM_TOOLS = [
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update', 'ask_user_question',
];
export const DELEGATION_DENY = new Set(['subagent', 'subagent_fork', 'workflow', 'spawn_teammate', 'interrupt_agent']);
export const TEAM_CONTRACT = `固定的 Team 能力说明（当前会话已经由用户启用 Team 模式）：
- 你是 Team Lead，设计、取舍和最终验收仍由你负责。默认按需要创建 executor；仅风险或证据需要独立审查时创建 reviewer。不要为了查看进度创建观察队友。
- spawn_teammate 默认 fresh，需短而完整的背景包；fork 只继承已完成的 Lead 历史，不含当前未完成 turn。同职责后续工作用原 target 的 send_message，不反复新建。
- 成员数量与并行限制由插件执行。达到限制时复用或等待；accepted/queued 都是已持久化投递，不能重发。
- inactive 只是没有 turn 在执行，不是完成。先 list_agents 确认必要队友 running/provisioning，再 wait_agent；醒来重新查看消息、任务和证据。wait_agent 不唤醒成员，也不读取缓存结果。
- 任务板先 list/get，再按最新 revision claim/update，实际完成后 complete。ready 不会唤醒 owner；无完整证据不能把任务标记完成。
- 共享工作区；并行写入必须分配互不重叠的 write_scopes，依赖工作用 blocked_by。最终由 Lead 审查真实差异与必要测试。
- 子执行者不能继续创建下级 agent。等待后台 job 用 job_output，不用 wait_agent。`;
export const TEAM_PROMPT = `你是「省钱编排」Team Lead。理解用户目标，自主设计方案与验收标准，把取证与执行交给少量固定队友；关键设计和最终验收由你承担。
你没有直接操作文件或 shell 的能力，不虚构证据。派发必须写清背景、范围、限制、交付格式和完成条件。不要为每件小事新建队友；复用他们已经积累的上下文。向用户交付核实过的结论和仍存在的限制。仅用户专属决定或无法查证的关键信息才提问。`;

export function teamMembership(ctx, agent) {
  return ctx.get('agentTeams')?.tryMembership?.(agent);
}

/**
 * The LIVE minimum-wait paragraph appended to the Team contract.
 *
 * The host's `wait_agent` schema cannot carry a `minimum` (its annotation keys
 * are description/title/default/examples only) and its arguments arrive deep
 * frozen, so the configured minimum is enforced by a GUARD — which can only
 * deny, never rewrite the call. The contract therefore has to state the number
 * the model must pass, otherwise the guard would reject correct-looking calls.
 *
 * With no minimum configured the paragraph is empty: the host's own 10000..3600000
 * bound and its 30000 default stay the whole story, and nothing is appended.
 * @param wait - the resolved budget from `resolveWaitBudget()`.
 * @returns the paragraph, or an empty string when no minimum is configured.
 */
export function teamWaitContract(wait) {
  const min = Number.isSafeInteger(wait?.minMs) ? wait.minMs : 0;
  if (min <= 0) return '';
  const hostDefaultMs = 30_000;
  const recommended = Math.max(min, hostDefaultMs);
  const omitted = min > hostDefaultMs
    ? `宿主 schema 与默认值仍是 10000..3600000 / ${hostDefaultMs} ms，省略 timeout_ms 会落到宿主默认 ${hostDefaultMs} ms、低于本下限并被拒绝：每次都显式写 timeout_ms: ${recommended}。`
    : `宿主默认 ${hostDefaultMs} ms 已经不低于本下限，省略 timeout_ms 也可以；显式传小于 ${min} 的值会被拒绝。`;
  return `\n\n本会话的 wait_agent 最低等待：${min} ms（由插件配置 minWaitTimeoutMs 强制；更短的显式调用会被拒绝，`
    + '宿主工具的参数是冻结的，插件只能拒绝、不会替你放大）。'
    + `${omitted}`
    + '这个下限只是**请求的等待上限**，不是强制睡满：没有活跃队友时 noProgress 会立即返回，队友有变化时也会提前醒来。';
}

/**
 * The guard reason for one `wait_agent` call, or undefined to allow it.
 *
 * Reads — never rewrites — the (frozen) arguments. A MISSING `timeout_ms` waits
 * the HOST's own default (30000 ms), so it is compared as 30000 rather than as
 * "too short": with a minimum at or below the host default, omitting the field
 * is a legitimate call and rejecting it would be a lie about the host contract.
 * Above it, the caller has to name a value that satisfies the minimum.
 * @param exec - the tool execution the guard is evaluating.
 * @param wait - the resolved budget from `resolveWaitBudget()`.
 * @returns the denial reason, or undefined.
 */
export function waitAgentGuardReason(exec, wait) {
  const min = Number.isSafeInteger(wait?.minMs) ? wait.minMs : 0;
  if (min <= 0 || exec?.name !== 'wait_agent') return undefined;
  const hostDefaultMs = 30_000;
  const passed = exec?.arguments?.timeout_ms;
  if (passed === undefined || passed === null) {
    if (hostDefaultMs >= min) return undefined;
    return `FRUGAL-WAIT-MIN: this session requires wait_agent timeout_ms of at least ${min} ms, and the host default `
      + `(${hostDefaultMs} ms) is below it. Retry with wait_agent({ timeout_ms: ${Math.max(min, hostDefaultMs)} }); `
      + 'this limit only caps the wait — wait_agent still returns immediately when no teammate is active (noProgress).';
  }
  if (!Number.isSafeInteger(passed) || passed < min) {
    return `FRUGAL-WAIT-MIN: wait_agent timeout_ms must be a whole number of milliseconds >= ${min} in this session `
      + `(received ${JSON.stringify(passed)}). The host still accepts 10000..3600000; this plugin additionally rejects `
      + `anything below ${min}. Retry with wait_agent({ timeout_ms: ${Math.max(min, hostDefaultMs)} }).`;
  }
  return undefined;
}
export function workerPersona(membership) {
  if (!membership || membership.role !== 'teammate') return CHILD_PERSONA;
  return `${CHILD_PERSONA}\n你是 Team 队友 ${membership.name}，Lead 是 lead。${membership.name === 'reviewer' ? '职责是定向独立审查并返回证据，不擅自扩展实现。' : '职责是按明确范围执行。'}\n使用 send_message 给 Lead 汇报；任务先 get/claim，再按最新 revision 更新。不创建下级 agent；收到软预算提醒时提交检查点结束本轮。`;
}

const PRE_ADMISSION_CODES = new Set([
  'BACKGROUND_REFUSED', 'NOT_RESUMABLE', 'UNAUTHORIZED', 'UNKNOWN_MODEL', 'NO_ADAPTER',
  'UNSUPPORTED_REASONING_EFFORT', 'TEAM_MEMBER_NAME_TAKEN', 'TEAM_MEMBER_LIMIT',
  'TEAM_SELF_MESSAGE', 'TEAM_MESSAGE_TOO_LARGE', 'TEAM_MAILBOX_FULL', 'TOOL_ABORTED_BEFORE_DISPATCH',
]);

/** Public around-dispatch seam: keep native roster, mailbox, task CAS and receipts. */
export function installAdmission(ctx, controller, governs, trackerOf) {
  return ctx.on('tools/execute', async (exec, next) => {
    const caller = exec.agent;
    if (!caller || !governs(caller)) return next();
    if (['subagent_fork', 'workflow'].includes(exec.name)) {
      const HarnessError = requireFromBases('@deepseek-ai/dsh-llm').module?.HarnessError ?? Error;
      throw new HarnessError('DELEGATION-PATH: use the current mode admission tools; alternate delegation bypasses the member budget', 'DELEGATION-PATH');
    }
    if (!['subagent', 'spawn_teammate', 'send_message'].includes(exec.name)) return next();
    try {
      const membership = teamMembership(ctx, caller);
      const root = membership?.root ?? caller;
      const teamCall = exec.name !== 'subagent';
      if (teamCall && !membership) throw new Error('TEAM-UNAVAILABLE: caller is not a Team member');
      if (exec.name === 'subagent' && ((caller.session.header.delegationDepth ?? 0) !== 0 || membership?.role === 'teammate')) throw new Error('NESTED-DELEGATION: workers cannot create children');
      const args = exec.arguments;
      if (exec.name === 'subagent' && (args.run_in_background === false || !args.prompt?.trim())) return next();
      return await controller.run(root, async (entry) => {
        const mode = teamCall ? 'team' : 'subagent';
        if (entry.state.mode !== mode) throw new Error(`MODE-MISMATCH: ${exec.name} unavailable in ${entry.state.mode}`);
        await controller.syncMembers(entry, exec.signal);
        const teams = ctx.get('agentTeams');
        let id = args.agent_id;
        let label = args.description ?? 'executor';
        if (exec.name === 'spawn_teammate') {
          label = args.name.trim();
          if (teams.listMembers(root).some((m) => m.name === label)) throw new Error('MEMBER-EXISTS: use send_message with the existing target');
        }
        if (exec.name === 'send_message') {
          const target = teams.listMembers(caller).find((m) => m.name === args.target);
          if (!target) throw new Error('TEAM-TARGET: unknown teammate');
          if (target.role === 'lead') return next();
          id = target.id;
          label = target.name;
        }
        // Let the native tool classify non-resumable/unauthorized IDs before any new side effect.
        if (exec.name === 'subagent' && id && !entry.state.budget.members.some((m) => m.mode === mode && m.id === id)) {
          if (entry.children.some((child) => child.id === id && child.mode === 'one-shot')) return next();
          throw entry.budget.failure('MEMBER-UNKNOWN', mode);
        }
        const token = await entry.budget.reserve(mode, id, label, exec.signal);
        const tracker = trackerOf(root);
        const generation = teamCall && id ? tracker.beginDelivery(id) : null;
        let result;
        try { result = await next(); }
        catch (error) { await entry.budget.rejected(token, false); throw error; }
        if (result.isError) {
          const safe = PRE_ADMISSION_CODES.has(result.error?.info?.code);
          if (safe && generation !== null) tracker.failDelivery(id, generation, result.error.message);
          await entry.budget.rejected(token, safe);
          return result;
        }
        if (exec.name === 'spawn_teammate') id = teams.listMembers(root).find((m) => m.name === label)?.id;
        else if (exec.name === 'subagent') id = result.value?.agent_id;
        if (!id) { await entry.budget.rejected(token, false); throw new Error('ADMISSION-RECEIPT: missing accepted member identity'); }
        if (teamCall) {
          if (exec.name === 'spawn_teammate') tracker.attachCreate(id);
          else if (result.value?.status === 'accepted') tracker.acceptDelivery(id, generation);
        }
        const evidence = tracker.describe(id);
        await entry.budget.accepted(token, id, evidence.status === 'settled' ? 'settled' : result.value?.status === 'queued' ? 'pending' : 'running', {
          id: result.value?.messageId ?? result.value?.message_id ?? null,
          status: result.value?.status === 'queued' ? 'queued' : 'accepted',
        });
        const counts = entry.budget.counts(mode);
        return { ...result, content: [...(result.content ?? []), { type: 'text', text: `${token.create ? '新建' : '续聊'}；${mode} 成员 ${counts.members}/${controller.settings().maxMembers}，执行 ${counts.active}/${controller.settings().maxConcurrent}；同职责后续工作复用 ${mode === 'team' ? label : id}。` }] };
      });
    } catch (error) {
      const HarnessError = requireFromBases('@deepseek-ai/dsh-llm').module?.HarnessError;
      if (!HarnessError || error instanceof HarnessError) throw error;
      const code = error.code ?? error.message.split(':')[0];
      throw new HarnessError(`${error.message}${error.members ? `; reusable=${JSON.stringify(error.members)}` : ''}`, code, { cause: error });
    }
  });
}
