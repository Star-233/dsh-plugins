/**
 * Overflow recovery bookkeeping.
 *
 * The retry budget is per agent and is released as soon as the agent produces a
 * real assistant message or goes idle, mirroring dsh-compaction-basic: one
 * provider-confirmed overflow earns one compaction + retry, and a second
 * overflow in the same request series keeps the original error.
 *
 * @module @nu11dev/dsh-compaction-policy/lib/overflow
 */

/** Bind one agent to its overflow budget. */
export class OverflowGuard {
  /** @type {WeakMap<object, { attempts: number }>} */
  budgets = new WeakMap();

  /**
   * Attempts already spent by this agent.
   * @param agent - the agent.
   * @returns a non-negative attempt count.
   */
  attempts(agent) {
    return this.budgets.get(agent)?.attempts ?? 0;
  }

  /** Record one successful compaction + retry. */
  spend(agent) {
    const current = this.budgets.get(agent) ?? { attempts: 0 };
    current.attempts += 1;
    this.budgets.set(agent, current);
    return current.attempts;
  }

  /** Release the budget (a fresh assistant message / idle agent starts clean). */
  release(agent) {
    this.budgets.delete(agent);
  }
}
