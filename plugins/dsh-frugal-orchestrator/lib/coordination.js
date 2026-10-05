import { FRUGAL_EVENT, STATE_VERSION, observeEvents, replayTelemetry } from './telemetry.js';
import { MemberBudgets, emptyBudgetState } from './budgets.js';
import { terminalReceipt } from './recovery.js';

export function emptyCoordinationState() {
  return { version: STATE_VERSION, mode: null, enabled: true, budget: emptyBudgetState(), health: null, warning: null };
}

export function foldCoordination(events, inheritedEventCount = 0) {
  let state = emptyCoordinationState();
  for (const event of events.slice(inheritedEventCount)) {
    if (event.type !== FRUGAL_EVENT) continue;
    if (event.data.version !== STATE_VERSION) throw Object.assign(new Error('STATE-VERSION: unsupported frugal state'), { code: 'STATE-VERSION' });
    if (event.data.state) {
      const candidate = event.data.state;
      const b = candidate.budget;
      const invalid = candidate.version !== STATE_VERSION || ![null, 'subagent', 'team'].includes(candidate.mode)
        || !Array.isArray(b?.members) || !Array.isArray(b?.reservations)
        || !['created', 'continued', 'rejected'].every((k) => Number.isSafeInteger(b.counters?.[k]) && b.counters[k] >= 0)
        || b.members.some((m) => !m || !['subagent', 'team'].includes(m.mode) || typeof m.id !== 'string' || !m.id
          || !['running', 'pending', 'unknown', 'settled'].includes(m.status))
        || b.reservations.some((r) => !r || !['subagent', 'team'].includes(r.mode) || typeof r.token !== 'string'
          || typeof r.create !== 'boolean' || typeof r.slot !== 'boolean');
      if (invalid) throw Object.assign(new Error('STATE-SHAPE: invalid frugal mode/admission ledger'), { code: 'STATE-SHAPE' });
      const identities = b.members.map((m) => `${m.mode}/${m.id}`);
      if (new Set(identities).size !== identities.length) throw Object.assign(new Error('STATE-SHAPE: duplicate member identities'), { code: 'STATE-SHAPE' });
      state = structuredClone(candidate);
    }
  }
  return state;
}

/** One mutex owns mode changes and admission; runtime settlements remain evidence-driven. */
export class Coordination {
  constructor({ ctx, settings, governs, reconcile }) {
    this.ctx = ctx;
    this.settings = settings;
    this.governs = governs;
    this.reconcile = reconcile;
    this.entries = new Map();
  }
  entry(agent) {
    const id = agent.id ?? agent.session.id;
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { agent, state: emptyCoordinationState(), loaded: false, tail: Promise.resolve() };
      entry.budget = new MemberBudgets({
        state: entry.state.budget,
        limits: () => this.settings(),
        persist: () => this.persist(entry),
        changed: (warning) => {
          if (warning) entry.state.warning = warning;
          this.publish(entry);
        },
      });
      this.entries.set(id, entry);
    }
    entry.agent = agent;
    return entry;
  }
  run(agent, operation) {
    const entry = this.entry(agent);
    const pending = entry.tail.then(async () => { await this.load(entry); return operation(entry); });
    entry.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }
  mode(agent) { return this.entry(agent).state.mode ?? 'subagent'; }
  async load(entry) {
    if (entry.loaded) return;
    const { events, inheritedEventCount } = await observeEvents(this.ctx.get('sessionQuery'), entry.agent.session);
    entry.state = foldCoordination(events, inheritedEventCount);
    entry.budget.state = entry.state.budget;
    for (const member of entry.state.budget.members) if (['running', 'pending'].includes(member.status)) member.status = 'unknown';
    const own = events.slice(inheritedEventCount);
    const legacy = own.some((e) => ['step/start', 'user/message', 'subagent/catalog', 'team/member'].includes(e.type));
    entry.state.mode ??= legacy ? 'subagent' : this.settings().defaultCoordinationMode;
    entry.loaded = true;
    try { await this.persist(entry); }
    catch (error) { entry.loaded = false; throw error; }
  }
  publish(entry) {
    if (!entry.loaded || typeof entry.agent.session.append !== 'function') return;
    entry.agent.session.append(FRUGAL_EVENT, { version: STATE_VERSION, state: structuredClone(entry.state) });
  }
  async persist(entry) {
    this.publish(entry);
    const sessions = this.ctx.get('sessions');
    if (typeof sessions?.flush !== 'function') throw Object.assign(new Error('PERSISTENCE-UNAVAILABLE: session flush is required'), { code: 'PERSISTENCE-UNAVAILABLE' });
    if (await sessions.flush(entry.agent.session) === false) throw Object.assign(new Error('PERSISTENCE-UNAVAILABLE: no durability participant'), { code: 'PERSISTENCE-UNAVAILABLE' });
  }
  async syncMembers(entry, signal) {
    const root = entry.agent;
    const teams = this.ctx.get('agentTeams');
    const membership = teams?.tryMembership?.(root);
    const teamMembers = typeof teams?.listMembers === 'function' && (!teams.tryMembership || membership)
      ? teams.listMembers(root).filter((m) => m.role === 'teammate') : [];
    const teamIds = new Set(teamMembers.map((m) => m.id));
    const children = await this.ctx.get('subagents').listChildren(root.id, signal);
    entry.children = children;
    const before = JSON.stringify(entry.state.budget);
    entry.budget.recoverMembers('subagent', children.filter((m) => m.mode === 'continuable' && !teamIds.has(m.id)));
    entry.budget.recoverMembers('team', teamMembers);
    const source = await observeEvents(this.ctx.get('sessionQuery'), root.session, signal);
    const delivered = new Set(source.events.slice(source.inheritedEventCount).filter((e) => e.type === 'team/message/delivered').map((e) => e.data.messageId));
    for (const member of entry.state.budget.members) {
      for (const receipt of member.receipts ?? []) if (receipt.status === 'queued' && delivered.has(receipt.id)) receipt.status = 'accepted';
      if (!entry.budget.occupied(member)) continue;
      const live = this.ctx.get('agents')?.get?.(member.id);
      if (live && (live.status !== 'idle' || live.inbox?.hasPending)) continue;
      try {
        const observation = await observeEvents(this.ctx.get('sessionQuery'), { id: member.id }, signal);
        const terminal = terminalReceipt(observation.events, observation.inheritedEventCount, member.receipts);
        if (terminal) entry.budget.settle(member.mode, member.id, terminal.stopReason);
      } catch (error) {
        signal?.throwIfAborted();
        member.recovery = { code: error.code ?? 'RECOVERY-UNAVAILABLE', message: error.message };
      }
    }
    if (JSON.stringify(entry.state.budget) !== before) await this.persist(entry);
  }
  async blockers(entry, signal) {
    const agent = entry.agent;
    const blockers = [];
    if (agent.status !== 'idle') blockers.push('主 agent 正在执行');
    if (agent.inbox?.hasPending) blockers.push('主 agent 有待处理输入');
    await this.syncMembers(entry, signal);
    if (entry.state.budget.reservations.length) blockers.push('存在尚未对账的派发预留');
    for (const m of entry.state.budget.members) if (entry.budget.occupied(m)) blockers.push(`${m.label}: ${m.status}`);
    const inbox = this.ctx.get('sessionProjections')?.snapshot(agent.session)?.values?.inbox;
    if ((inbox?.['next-turn']?.length ?? 0) + (inbox?.['next-step']?.length ?? 0)) blockers.push('主 agent 有待处理消息');
    const teams = this.ctx.get('agentTeams');
    if (typeof teams?.listTasks === 'function' && (!teams.tryMembership || teams.tryMembership(agent)) && teams.listTasks(agent).some((task) => !['completed', 'deleted'].includes(task.status))) blockers.push('Team 有未完成任务');
    const observation = await observeEvents(this.ctx.get('sessionQuery'), agent.session, signal);
    const queued = new Set();
    for (const event of observation.events.slice(observation.inheritedEventCount)) {
      if (event.type === 'team/message/queued') queued.add(event.data.message?.id ?? event.data.id);
      if (event.type === 'team/message/delivered') queued.delete(event.data.messageId);
    }
    if (queued.size) blockers.push('Team 有待投递消息');
    if (typeof agent.runMaintenance !== 'function') blockers.push('宿主缺少空闲维护隔离能力');
    return blockers;
  }
  async switchMode(agent, mode, signal) {
    if (!['subagent', 'team'].includes(mode)) throw new Error('Usage: /frugal mode subagent|team');
    return this.run(agent, async (entry) => {
      if (entry.state.mode === mode) return { mode };
      const blockers = await this.blockers(entry, signal);
      if (blockers.length) throw Object.assign(new Error(`MODE-BUSY: ${blockers.join('；')}`), { code: 'MODE-BUSY' });
      if (mode === 'team' && typeof this.ctx.get('agentTeams')?.spawnTeammate !== 'function') throw new Error('TEAM-UNAVAILABLE: host Agent Teams service absent');
      return agent.runMaintenance(async (maintenanceSignal) => {
        signal?.throwIfAborted();
        maintenanceSignal.throwIfAborted();
        if (agent.inbox?.hasPending) throw new Error('MODE-BUSY: new input arrived before switch');
        const previous = entry.state.mode;
        try {
          entry.state.mode = mode;
          this.reconcile(agent); // capability check before committing the candidate
          await this.persist(entry);
        } catch (error) {
          entry.state.mode = previous;
          this.reconcile(agent);
          // A compensating snapshot supersedes a candidate append whose flush failed.
          this.publish(entry);
          throw error;
        }
        return { mode };
      });
    });
  }
  async status(agent, signal) {
    return this.run(agent, async (entry) => {
      const blockers = await this.blockers(entry, signal);
      entry.state.blockers = blockers;
      this.publish(entry);
      const { events, inheritedEventCount } = await observeEvents(this.ctx.get('sessionQuery'), agent.session, signal);
      return { ...structuredClone(entry.state), telemetry: replayTelemetry(events, inheritedEventCount) };
    });
  }
}
