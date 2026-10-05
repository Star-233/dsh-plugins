import { requireFromBases } from './resolve.js';
import { FRUGAL_EVENT, STATE_VERSION } from './telemetry.js';

/** Optional carriers register when available; missing command/projection is visible. */
export function installHostUi(ctx, controller, governs) {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['commands'], (scoped) => {
    const loaded = requireFromBases('@deepseek-ai/dsh-commands/brand');
    if (!loaded.ok) throw new Error('COMMAND-UNAVAILABLE: CommandDefinitionId cannot be resolved');
    scoped.get('commands').register({
      definitionId: loaded.module.CommandDefinitionId('@nu11dev/dsh-frugal-orchestrator/frugal'),
      name: 'frugal', description: '省钱编排：本会话模式与健康状态',
      async handler(invocation) {
        const { agent, signal, rawInput } = invocation;
        if (!governs(agent) || (agent.session.header.delegationDepth ?? 0) !== 0) return { kind: 'error', text: '该命令只用于省钱编排的主会话。' };
        const args = rawInput.trim().split(/\s+/);
        try {
          if (args[0] === 'status') return { kind: 'success', text: JSON.stringify(await controller.status(agent, signal), null, 2) };
          if (args[0] !== 'mode' || args.length !== 2) return { kind: 'error', text: 'Usage: /frugal mode subagent|team 或 /frugal status' };
          const result = await controller.switchMode(agent, args[1], signal);
          const entry = controller.entry(agent);
          entry.state.warning = null;
          entry.state.commandOutcome = { requested: args[1], success: true, message: `本会话模式：${result.mode}`, at: Date.now() };
          await controller.persist(entry);
          return { kind: 'success', text: `本会话模式：${result.mode}` };
        } catch (error) {
          const entry = controller.entry(agent);
          entry.state.warning = { code: error.code ?? 'MODE-ERROR', message: error.message };
          entry.state.commandOutcome = { requested: args[1] ?? null, success: false, message: error.message, at: Date.now() };
          controller.publish(entry);
          return { kind: 'error', text: error.message };
        }
      },
    });
  });
  ctx.inject(['sessionProjections'], (scoped) => {
    const loaded = requireFromBases('zod');
    if (!loaded.ok) throw new Error('PROJECTION-UNAVAILABLE: zod cannot be resolved');
    const z = loaded.module.z;
    const schema = z.object({ inheritedEventCount: z.number(), data: z.unknown().nullable(), telemetry: z.record(z.string(), z.unknown()) });
    scoped.get('sessionProjections').register({
      key: 'frugal', stateVersion: STATE_VERSION, stateSchema: schema,
      init: (_header, inheritedEventCount) => ({ inheritedEventCount, data: null, telemetry: { modelMs: null, toolMs: null, waitMs: null, wallMs: null, firstAt: null, stepAt: null, calls: {}, toolOpenAt: null, waitOpenAt: null, lastCompaction: null, lastPrune: null, route: null } }),
      apply(state, event) {
        if (event.seq < state.inheritedEventCount) return state;
        if (event.type === FRUGAL_EVENT) {
          if (event.data.version !== STATE_VERSION) return { ...state, data: { warning: { code: 'STATE-VERSION', message: '升级插件后才能读取此状态。' } } };
          return { ...state, data: event.data.state };
        }
        if (!['step/start', 'assistant/message', 'tool/call', 'tool/result', 'turn/end', 'request/header', 'compaction/end', 'compaction/prune'].includes(event.type)) return state;
        const t = structuredClone(state.telemetry);
        t.firstAt ??= event.time;
        t.wallMs = event.time - t.firstAt;
        if (event.type === 'step/start') t.stepAt = event.time;
        if (event.type === 'assistant/message' && t.stepAt !== null) { t.modelMs += event.time - t.stepAt; t.stepAt = null; }
        if (event.type === 'request/header') t.route = event.data.header.config;
        if (event.type === 'tool/call') {
          if (!Object.keys(t.calls).length) t.toolOpenAt = event.time;
          t.calls[event.data.callId] = event.data.name;
          if (['wait_subagent', 'wait_agent', 'job_output'].includes(event.data.name)) t.waitOpenAt ??= event.time;
        }
        if (event.type === 'tool/result') {
          delete t.calls[event.data.message.toolCallId];
          if (!Object.keys(t.calls).length && t.toolOpenAt !== null) { t.toolMs += event.time - t.toolOpenAt; t.toolOpenAt = null; }
          if (!Object.values(t.calls).some((name) => ['wait_subagent', 'wait_agent', 'job_output'].includes(name)) && t.waitOpenAt !== null) { t.waitMs += event.time - t.waitOpenAt; t.waitOpenAt = null; }
        }
        if (event.type === 'compaction/end') t.lastCompaction = { at: event.time, error: event.data.error ?? null };
        if (event.type === 'compaction/prune') t.lastPrune = { at: event.time };
        if (event.type === 'turn/end') t.stopReason = event.data.reason?.kind ?? 'unknown';
        return { ...state, telemetry: t };
      },
      wire: { viewSchema: schema, view: (state) => state },
    });
  });
}
