/** Durable admission ledger. Limits count possibly-running work, not idle agents. */
import { randomUUID } from 'node:crypto';

export function emptyBudgetState() {
  return { members: [], reservations: [], counters: { created: 0, continued: 0, rejected: 0 } };
}

export class MemberBudgets {
  constructor({ state, limits, persist, changed = () => {} }) {
    this.state = state;
    this.limits = limits;
    this.persist = persist;
    this.changed = changed;
  }

  snapshot() { return structuredClone(this.state); }
  occupied(member) { return ['running', 'pending', 'unknown'].includes(member.status); }
  counts(mode) {
    const members = this.state.members.filter((m) => m.mode === mode);
    const reservations = this.state.reservations.filter((r) => r.mode === mode);
    return {
      members: members.length + reservations.filter((r) => r.create).length,
      active: members.filter((m) => this.occupied(m)).length + reservations.filter((r) => r.slot).length,
    };
  }
  failure(code, mode) {
    this.state.counters.rejected += 1;
    this.changed();
    return Object.assign(new Error(`${code}: ${mode} admission refused; reuse an existing member or wait for settlement`), {
      code, members: this.state.members.filter((m) => m.mode === mode).map((m) => ({ id: m.id, label: m.label, status: m.status })),
    });
  }

  /** Caller holds the session controller lock. Flush intent BEFORE dispatch. */
  async reserve(mode, id, label, signal) {
    signal?.throwIfAborted();
    const limits = this.limits();
    const member = this.state.members.find((m) => m.mode === mode && m.id === id);
    const create = !id;
    if (!create && !member) throw this.failure('MEMBER-UNKNOWN', mode);
    const slot = create || !this.occupied(member);
    const counts = this.counts(mode);
    if (create && counts.members >= limits.maxMembers) throw this.failure('MEMBER-LIMIT', mode);
    if (slot && counts.active >= limits.maxConcurrent) throw this.failure('CONCURRENCY-LIMIT', mode);
    const token = { token: randomUUID(), mode, id: id ?? null, label, create, slot, at: Date.now() };
    this.state.reservations.push(token);
    try { await this.persist(); }
    catch (error) {
      this.state.reservations = this.state.reservations.filter((r) => r.token !== token.token);
      this.changed(); // compensate any candidate snapshot appended before a failed flush
      throw error;
    }
    try { signal?.throwIfAborted(); }
    catch (error) { await this.rejected(token, true); throw error; }
    return token;
  }

  /** A receipt is authoritative even if a later UI or flush fails. */
  async accepted(token, id, status = 'running', receipt = null) {
    const existing = this.state.members.find((m) => m.mode === token.mode && m.id === id);
    if (existing) {
      if (token.slot) {
        existing.status = status;
        existing.round += 1;
        existing.startedAt = token.at;
        existing.steps = 0;
        existing.alerted = false;
      }
    } else {
      this.state.members.push({ mode: token.mode, id, label: token.label, status, round: 1, startedAt: token.at, steps: 0, alerted: false });
    }
    const member = this.state.members.find((m) => m.mode === token.mode && m.id === id);
    if (token.slot) member.receipts = [];
    if (receipt) (member.receipts ??= []).push(receipt);
    if (status === 'pending') member.status = 'pending';
    this.state.reservations = this.state.reservations.filter((r) => r.token !== token.token);
    this.state.counters[token.create ? 'created' : 'continued'] += 1;
    // If persistence fails, the accepted operation must never be retried as new.
    try { await this.persist(); } catch (error) { this.changed({ code: 'RECEIPT-PERSISTENCE', message: error.message }); }
  }

  async rejected(token, definitelyNotAccepted = false) {
    if (definitelyNotAccepted) this.state.reservations = this.state.reservations.filter((r) => r.token !== token.token);
    // Otherwise preserve the intent: a lost receipt is possibly accepted work.
    await this.persist();
  }

  settle(mode, id, stopReason) {
    const member = this.state.members.find((m) => m.mode === mode && m.id === id);
    if (!member) return;
    member.status = 'settled';
    member.stopReason = stopReason ?? 'unknown';
    this.changed();
  }

  recoverMembers(mode, entries) {
    for (const entry of entries) {
      if (this.state.members.some((m) => m.mode === mode && m.id === entry.id)) continue;
      this.state.members.push({ mode, id: entry.id, label: entry.label ?? entry.name ?? entry.id, status: 'unknown', round: 0, startedAt: 0, steps: 0, alerted: false });
    }
  }

  checkpoint(id, settings, now = Date.now()) {
    const member = this.state.members.find((m) => m.id === id);
    if (!member || !this.occupied(member)) return false;
    member.steps += 1;
    this.changed();
    if (member.alerted || (member.steps < settings.checkpointSteps && now - member.startedAt < settings.checkpointMinutes * 60000)) return false;
    member.alerted = true;
    this.changed();
    return true;
  }
}
