/**
 * The frugal orchestrator's delegation surface: the `subagent` and
 * `wait_subagent` tools, plus the run bookkeeping that makes waiting possible.
 *
 * WHY THIS MODULE EXISTS (and why it is not the preset's own `subagent` row):
 *   - The model must be able to CONTINUE the child it already paid for, and to
 *     WAIT for it without a busy loop. The upstream delegation tool has neither
 *     an `agent_id` parameter nor any wait seam (`@deepseek-ai/dsh-subagent`
 *     publishes `start`/`end` events but deliberately replays nothing and
 *     offers no `get`/`status`), so both have to be built here.
 *   - A child is always created through `ctx.subagents.startContinuable(...)`
 *     with the real `spawn` provider, so it is durably resumable. The gate NEVER
 *     routes a call through the inherited upstream tool and then inspects what
 *     came back: by the time a wrong-mode call returns, an unrecoverable
 *     one-shot child already exists.
 *
 * WHAT `wait_subagent` CAN AND CANNOT CLAIM:
 *   - It waits for the CURRENT WORK a child accepted as a whole (the last
 *     delivery this agent made, plus anything delivered while waiting). It does
 *     not claim a one-to-one mapping between a single message and a single
 *     answer.
 *   - Settlement evidence is the `subagent/end` of the residency epoch that
 *     CARRIES the accepted delivery (`runId` identity, matched against the
 *     event boundary taken before the delivery started). An epoch that opened —
 *     and even closed — while `sendMessage` was still in flight belongs to this
 *     delivery and still settles it; an end of the previous epoch never does.
 *   - `agent.status === 'idle'` is never used as completion: pending inbox work
 *     and owned children keep an idle child unsettled.
 *   - Events are push-only and never replayed. For an id this process has no
 *     history for (a reload, another tool), the tool returns `unknown` with the
 *     concrete next step instead of pretending the child finished — and it never
 *     hangs forever waiting for evidence that cannot arrive.
 *
 * Pure `node:` builtins plus relative imports, so the linked bundle resolves
 * everything it needs (see `./resolve.js`).
 *
 * @module @nu11dev/dsh-frugal-orchestrator/lib/delegation
 */

import { requireFromBases, importFromBases, describeThrown } from './resolve.js';

/** The one delegation tool name this gate shadows in the agent's own scope. */
export const SUBAGENT_TOOL_NAME = 'subagent';

/** The wait tool. Never reuses the Agent Teams `wait_agent`/`send_message` names. */
export const WAIT_TOOL_NAME = 'wait_subagent';

/** Tool names this gate registers into the governed agent's OWN layer. */
export const GATE_TOOL_NAMES = [SUBAGENT_TOOL_NAME, WAIT_TOOL_NAME];

/** The real in-process provider every child is created on. */
export const SPAWN_PROVIDER = 'spawn';

/** Delegation budget of the `frugal` preset: children cannot delegate further. */
export const MAX_SUBAGENT_DEPTH = 1;

/** Default `timeout_ms` of `wait_subagent`. */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

/**
 * Hard cap on one wait: a single call never blocks for longer than this.
 *
 * Aligned with the host's native Team `wait_agent` bound (`10000..3600000`), so
 * one configuration value can describe both modes and a 5-minute wait is
 * expressible in either.
 */
export const MAX_WAIT_TIMEOUT_MS = 3_600_000;

/** The budget used when no configuration is handed in. */
export const DEFAULT_WAIT_BUDGET = Object.freeze({
  minMs: 0, defaultMs: DEFAULT_WAIT_TIMEOUT_MS, maxMs: MAX_WAIT_TIMEOUT_MS, invalid: undefined,
});

/**
 * Resolve the configured minimum wait into the budget `wait_subagent` uses.
 *
 * `minWaitTimeoutMs` is a GUI string so that BLANK can mean "no plugin lower
 * bound" without colliding with a legitimate `0` (which means the same thing
 * here, per the field's contract). Every other spelling has to be a non-negative
 * safe integer no larger than {@link MAX_WAIT_TIMEOUT_MS}: a typo must not
 * silently become a lower bound, and it must not fail open into "no minimum"
 * either — so it is REPORTED (`invalid`) and the caller logs it, while the
 * effective budget stays the documented no-minimum one.
 *
 * The effective default is `max(30000, minMs)`: with a 5-minute minimum, an
 * omitted `timeout_ms` must not produce a 30-second wait the guard would reject.
 * @param value - the raw `minWaitTimeoutMs` (string or number; blank = no minimum).
 * @returns `{ minMs, defaultMs, maxMs, invalid }`.
 */
export function resolveWaitBudget(value) {
  const maxMs = MAX_WAIT_TIMEOUT_MS;
  if (value === undefined || value === null) return DEFAULT_WAIT_BUDGET;
  const raw = typeof value === 'number' ? value : String(value).trim();
  if (raw === '') return DEFAULT_WAIT_BUDGET;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxMs) {
    return {
      minMs: 0,
      defaultMs: DEFAULT_WAIT_TIMEOUT_MS,
      maxMs,
      invalid: `CONFIG-INVALID: minWaitTimeoutMs=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`
        + ` is not a non-negative safe integer no greater than ${maxMs}; keeping no plugin lower bound`,
    };
  }
  return {
    minMs: parsed, defaultMs: Math.max(DEFAULT_WAIT_TIMEOUT_MS, parsed), maxMs, invalid: undefined,
  };
}

/** Cap on one child's rendered closing output. */
const OUTPUT_LIMIT = 8_000;

/** Cap on remembered terminal epochs per child. */
const END_HISTORY = 32;

/**
 * The child agents' persona.
 *
 * REQUIRED at creation, not cosmetic: a child joins its parent's preset
 * (`applyChildComposition` -> `composeFrom`), and the `frugal` preset's persona
 * row is `complete: true` — the whole orchestrator prompt. `tool-subagent`
 * shadows that section per child, so a child created by THIS tool has to bring
 * its own persona or it would answer as the orchestrator. Kept textually in
 * sync with the preset's `tool-subagent.persona` (asserted by the test suite).
 */
export const CHILD_PERSONA = `你是被派来干活的子 agent，负责按明确要求执行一个具体子任务并汇报。
- 直接用工具在真实工作区里动手：读/改文件、跑命令、检索资料、按需加载 skill；不要只给建议或方案。
- 汇报必须带原文证据：文件路径、命令、关键行号或输出片段，引用要能复核。
- 不擅自越范围：只做被明确要求的事；不顺手重构、不扩大改动面、不替 parent 拍板关键设计。
- 关键设计或取舍一旦模糊，先返回事实与可选项（各自的代价），让 parent 决定，不要自行决定后继续。
- 不要反问「是否继续」；信息不够就先自己查清楚，确实需要人来决定时，在结论里写清楚需要什么。
- 汇报结构：做了什么 / 证据 / 结论 / 遗留风险或未完成的部分。`;

/** The runtime package whose `defineTool` builds the two definitions. */
const TOOLS_PACKAGE = '@deepseek-ai/dsh-tools';

/** Memoised resolution of {@link TOOLS_PACKAGE}. */
const toolModuleState = { module: undefined, error: undefined, pending: undefined };

/**
 * Adopt a resolved module when it really exports the tool factory.
 *
 * @param module - a loaded module namespace.
 * @returns the module, or undefined when it is not the tools package.
 */
function adoptToolModule(module) {
  if (typeof module?.defineTool !== 'function') return undefined;
  toolModuleState.module = module;
  toolModuleState.error = undefined;
  return module;
}

/**
 * Load `@deepseek-ai/dsh-tools` synchronously, once.
 *
 * @returns the module namespace, or undefined (see {@link toolModuleFailure}).
 */
export function loadToolModule() {
  if (toolModuleState.module !== undefined) return toolModuleState.module;
  const resolved = requireFromBases(TOOLS_PACKAGE);
  if (resolved.ok) {
    const adopted = adoptToolModule(resolved.module);
    if (adopted !== undefined) return adopted;
    toolModuleState.error = new Error(`${TOOLS_PACKAGE} (resolved from ${resolved.base}) exports no defineTool()`);
  } else {
    toolModuleState.error = new Error(`cannot resolve ${TOOLS_PACKAGE}: ${resolved.tried.join(' | ')}`);
  }
  return undefined;
}

/**
 * Start the asynchronous fallback load, and return immediately.
 *
 * A Node without `require(esm)` cannot be served synchronously; the row is
 * mounted long before the first agent is created, so an `import()` started here
 * has normally landed by then. Never throws.
 *
 * @returns the pending load, when one was started.
 */
export function prewarmToolModule() {
  if (toolModuleState.module !== undefined) return undefined;
  if (loadToolModule() !== undefined) return undefined;
  if (toolModuleState.pending !== undefined) return toolModuleState.pending;
  toolModuleState.pending = importFromBases(TOOLS_PACKAGE).then((module) => {
    const adopted = module === undefined ? undefined : adoptToolModule(module);
    if (adopted === undefined && toolModuleState.error === undefined) {
      toolModuleState.error = new Error(`${TOOLS_PACKAGE} could not be imported with a defineTool() export`);
    }
    return adopted;
  }, (error) => {
    toolModuleState.error = new Error(`cannot import ${TOOLS_PACKAGE}: ${describeThrown(error)}`);
    return undefined;
  });
  return toolModuleState.pending;
}

/** The reason {@link loadToolModule} could not deliver, when it has one. */
export function toolModuleFailure() {
  return toolModuleState.error;
}

/** A short, safe rendering of one value. */
function describe(value) {
  try {
    return String(value);
  } catch {
    return '<unprintable>';
  }
}

/** The first `limit` characters of one string, with a truncation marker. */
function clip(text, limit = OUTPUT_LIMIT) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated, ${text.length - limit} more characters]`;
}

/**
 * Render one child's closing content blocks as plain text.
 *
 * @param blocks - `lastAssistantMessage` from a `subagent/end` payload.
 * @returns the joined text, clipped to {@link OUTPUT_LIMIT}.
 */
export function outputText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return clip(parts.join(''));
}

/** The first non-empty line of a prompt, as a default child label. */
export function deriveLabel(prompt) {
  const line = String(prompt).split('\n').find((entry) => entry.trim().length > 0) ?? 'subagent task';
  const text = line.trim();
  return text.length <= 60 ? text : `${text.slice(0, 57)}...`;
}

/**
 * The fail-closed configuration error for an unusable delegation surface.
 *
 * The gate refuses to install a governed agent without a working delegation
 * surface: falling back to the preset's own tool would silently downgrade the
 * model's toolset (no `agent_id`, no wait), and renaming the tool to dodge a
 * conflict would be a fourth tool nobody documented.
 *
 * @param reason - what could not be provided.
 * @param cause - the underlying failure, when there is one.
 * @returns the error to throw out of the agent's setup.
 */
export function toolsUnavailableError(reason, cause) {
  const error = new Error(
    `CONFIG-TOOLS-UNAVAILABLE: frugal-gate cannot install the orchestrator tool set `
    + `(${GATE_TOOL_NAMES.join(', ')}): ${reason}`
    + `${cause === undefined ? '' : ` (${describeThrown(cause)})`}. `
    + 'FAIL-CLOSED: this agent is not created with a delegation surface the gate cannot guarantee — '
    + 'it does not fall back to the preset\'s own tools and it does not rename anything. '
    + `Load @deepseek-ai/dsh-subagents with the "${SPAWN_PROVIDER}" provider (and a session-persistence backend) `
    + 'and restart dsh, or point frugal-gate\'s `presetId` away from this preset.',
  );
  error.name = 'FrugalToolsUnavailableError';
  error.code = 'CONFIG-TOOLS-UNAVAILABLE';
  return error;
}

/**
 * Re-throw a service failure as a model-visible error that keeps its code.
 *
 * The subagent seam's typed codes (`NOT_RESUMABLE`, `UNAUTHORIZED`,
 * `PERSISTENCE_UNAVAILABLE`, `ACTIVATION_CLOSING`, the capacity limit, …) are
 * the actionable part of the failure, so they are carried through verbatim
 * instead of being flattened into prose.
 *
 * @param error - the thrown value.
 * @param action - what the caller was doing.
 * @returns an error carrying the original code.
 */
export function relayFailure(error, action) {
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const ErrorType = requireFromBases('@deepseek-ai/dsh-llm').module?.HarnessError ?? Error;
  const wrapped = new ErrorType(
    `${action} failed: ${describeThrown(error)}`
    + `${code === undefined ? '' : ` [code: ${code}]`}`
    + (code === 'NOT_RESUMABLE'
      ? ' — that child has no continuable conversation state (for example an old one-shot subagent); it cannot be upgraded. '
        + `Start a new child with ${SUBAGENT_TOOL_NAME}({ prompt: "..." }) and continue that one instead.`
      : ''),
    code,
  );
  wrapped.name = 'FrugalDelegationError';
  if (code !== undefined) wrapped.code = code;
  if (error !== undefined) wrapped.cause = error;
  return wrapped;
}

/**
 * The per-child run bookkeeping behind {@link WAIT_TOOL_NAME}.
 *
 * One tracker belongs to ONE governed agent, and its listeners are registered on
 * that agent's own scope, so it only ever sees that agent's delegations.
 *
 * Vocabulary:
 *   - `delivery`   — one `subagent` call this agent made for the child: the
 *                    create, or one follow-up. `accepted` means the child's
 *                    inbox took it (i.e. the call returned its `message_id`).
 *   - epoch        — one residency epoch of a continuable child, identified by
 *                    the `runId` of its `subagent/start`. A follow-up delivered
 *                    into a resident child continues its open epoch; a
 *                    follow-up delivered to an idle (released) child
 *                    cold-resumes, which opens a NEW epoch with a new `runId`.
 *   - settlement   — the `subagent/end` of the epoch that carries one
 *                    accepted delivery. It is matched by EPOCH IDENTITY
 *                    (`runId`) against the boundary taken before the delivery
 *                    started, never by "an end that arrived after the
 *                    acceptance": the cold-resume epoch is materialized (and can
 *                    even settle) while `sendMessage` is still in flight, so the
 *                    accepting call may learn about the end only at
 *                    resolution time (`SubagentContinuations.sendMessage` ->
 *                    `deliverFollowup` -> `coldResume` -> `materialize`, which
 *                    publishes `subagent/start` before the inbox acceptance).
 *
 * @returns the tracker.
 */
export function createChildRuns() {
  /** childId -> record. */
  const records = new Map();
  /** Change subscribers, notified after every observed lifecycle edge. */
  const watchers = new Set();

  const notify = () => {
    for (const watcher of [...watchers]) {
      try {
        watcher();
      } catch {
        // A subscriber must never break the bookkeeping that feeds every wait.
      }
    }
  };

  const ensure = (id) => {
    let record = records.get(id);
    if (record === undefined) {
      record = {
        id,
        seq: 0,
        generation: 0,
        openEpoch: undefined,
        lastStart: undefined,
        lastEnd: undefined,
        ends: [],
        delivery: undefined,
        chain: Promise.resolve(),
      };
      records.set(id, record);
    }
    return record;
  };

  /**
   * The residency epoch that carries one delivery.
   *
   * Two shapes, both observed through the event stream:
   *   - COLD RESUME — no epoch was open when the delivery began, so the resume
   *     materializes a NEW epoch and publishes its `start` while `sendMessage`
   *     is in flight. That epoch carries the delivery EVEN IF IT ALREADY CLOSED
   *     before the inbox acceptance became visible here, so the identity has to
   *     be remembered from the start edge; reading `openEpoch` at acceptance
   *     time loses exactly that epoch (`observeEnd` has already cleared it).
   *   - RESIDENT — an epoch was already open and had not ended: it consumes the
   *     new message, so it carries the delivery even though it started earlier.
   *
   * An epoch that ended during the in-flight window and was NOT replaced by a
   * new start is deliberately NOT treated as carrying this delivery: from the
   * event stream that is indistinguishable from "the delivery reached a closing
   * activation and is about to cold-resume" (the more common shape, see
   * `deliverFollowup`'s disposal branch), and a previous round's end must never
   * settle work the child has not taken yet.
   *
   * @param record - the child's record.
   * @param beginSeq - the event boundary snapshotted before the delivery began.
   * @returns the carrying epoch's `runId`, or undefined when the epoch that will
   *   carry the delivery has not opened yet (the next start edge claims it).
   */
  const carryingEpoch = (record, beginSeq) => {
    const started = record.lastStart;
    if (started !== undefined && started.seq > beginSeq) return started.runId;
    return record.openEpoch?.runId;
  };

  /**
   * The terminal edge that settles the child's CURRENT accepted work, if any.
   * @param record - the child's record.
   * @returns the settling end edge, or undefined.
   */
  const settlementEvidence = (record) => {
    const delivery = record.delivery;
    if (delivery === undefined || delivery.accepted !== true) return undefined;
    // The pre-delivery boundary: an end observed BEFORE the delivery started
    // belongs to work that was already finished and can never settle this one.
    const boundary = delivery.beginSeq ?? 0;
    if (delivery.epochAtAccept !== undefined) {
      // Matched by the carrying epoch's identity, so an end that raced ahead of
      // the acceptance (the epoch opened — and closed — during the await) is
      // still this delivery's own settlement, while a previous epoch's end
      // never matches, whatever its sequence number.
      for (const end of record.ends) {
        if (end.runId === delivery.epochAtAccept && end.seq > boundary) return end;
      }
      return undefined;
    }
    // Accepted while no epoch was open: the next epoch to open carries it.
    if (delivery.carryingRunId !== undefined) {
      for (const end of record.ends) {
        if (end.runId === delivery.carryingRunId) return end;
      }
    }
    return undefined;
  };

  return {
    /**
     * Record one `subagent/start` (a published one-shot run or a continuable
     * activation's residency epoch).
     * @param info - the event payload.
     */
    observeStart(info) {
      const id = info?.id;
      if (typeof id !== 'string' || id.length === 0) return;
      const record = ensure(id);
      record.seq += 1;
      record.openEpoch = { runId: info.runId, provider: info.provider, seq: record.seq };
      // Kept even after the epoch closes: a resume can open AND close its epoch
      // before the delivering call resolves, and that runId is the only thing
      // that can settle the delivery then.
      record.lastStart = { runId: info.runId, provider: info.provider, seq: record.seq };
      const delivery = record.delivery;
      if (delivery !== undefined && delivery.accepted === true
        && delivery.epochAtAccept === undefined && delivery.carryingRunId === undefined) {
        delivery.carryingRunId = info.runId;
      }
      notify();
    },

    /**
     * Record one `subagent/end`.
     * @param info - the event payload.
     */
    observeEnd(info) {
      const id = info?.id;
      if (typeof id !== 'string' || id.length === 0) return;
      const record = ensure(id);
      record.seq += 1;
      const end = {
        runId: info.runId,
        provider: info.provider,
        stopReason: typeof info.stopReason === 'string' ? info.stopReason : 'error',
        output: outputText(info.lastAssistantMessage),
        at: Date.now(),
        seq: record.seq,
      };
      record.ends.push(end);
      if (record.ends.length > END_HISTORY) record.ends.shift();
      if (record.openEpoch !== undefined && record.openEpoch.runId === end.runId) record.openEpoch = undefined;
      record.lastEnd = end;
      notify();
    },

    /**
     * Mark that a delivery for this child is about to be attempted.
     *
     * Called BEFORE `sendMessage` resolves, so an end that arrives during the
     * await is attributed to the previous work rather than to this one.
     * @param id - the durable child id.
     * @returns the generation this delivery owns.
     */
    beginDelivery(id) {
      const record = ensure(id);
      record.generation += 1;
      record.delivery = {
        generation: record.generation,
        accepted: false,
        failed: false,
        // The event boundary BEFORE this delivery: everything the delivery's own
        // epochs do lives after it, and every earlier end stays out of reach.
        beginSeq: record.seq,
        acceptedSeq: record.seq,
        epochAtAccept: undefined,
        carryingRunId: undefined,
        startedAt: Date.now(),
      };
      notify();
      return record.generation;
    },

    /**
     * Mark one delivery accepted by the child's inbox and snapshot the epoch
     * bookkeeping that will decide its settlement.
     * @param id - the durable child id.
     * @param generation - the generation {@link beginDelivery} returned.
     * @returns whether this delivery was still the current one.
     */
    acceptDelivery(id, generation) {
      const record = records.get(id);
      if (record === undefined || record.delivery === undefined) return false;
      if (record.delivery.generation !== generation) return false;
      record.delivery.accepted = true;
      record.delivery.acceptedSeq = record.seq;
      record.delivery.epochAtAccept = carryingEpoch(record, record.delivery.beginSeq);
      record.delivery.carryingRunId = undefined;
      record.delivery.acceptedAt = Date.now();
      notify();
      return true;
    },

    /**
     * Attach the delivery of a freshly created child.
     *
     * The start edge of a creation is emitted while the child is being
     * materialized (`ContinuableActivationRegistry.materialize` calls
     * `observer.start()`), i.e. before `startContinuable` resolves with the id,
     * so the epoch that will settle this work is normally already observed here
     * — and, for a child that somehow settled that fast, already closed, which
     * is why the epoch is resolved through {@link carryingEpoch} instead of
     * reading `openEpoch` alone.
     * @param id - the durable child id.
     */
    attachCreate(id) {
      const record = ensure(id);
      record.generation += 1;
      record.delivery = {
        generation: record.generation,
        accepted: true,
        failed: false,
        beginSeq: 0,
        acceptedSeq: record.seq,
        epochAtAccept: carryingEpoch(record, 0),
        carryingRunId: undefined,
        startedAt: Date.now(),
        acceptedAt: Date.now(),
      };
      notify();
    },

    /**
     * Drop a delivery whose acceptance failed (the child was never handed the
     * work, so nothing is outstanding for it).
     *
     * A failed delivery must not mask what this process already knows about the
     * child: it reported `pending` only while the acceptance was genuinely in
     * flight, so the state BEFORE the attempt (a still-open epoch, or the last
     * observed end) is what a wait sees afterwards. Otherwise one rejected
     * `sendMessage` would make a settled child look unfinished forever.
     * @param id - the durable child id.
     * @param generation - the generation {@link beginDelivery} returned.
     * @param error - the rejection, for the model-visible detail.
     */
    failDelivery(id, generation, error) {
      const record = records.get(id);
      if (record === undefined || record.delivery === undefined) return;
      if (record.delivery.generation !== generation) return;
      record.delivery.accepted = false;
      record.delivery.failed = true;
      record.delivery.error = describeThrown(error);
      notify();
    },

    /**
     * Serialise deliveries per child.
     *
     * Two concurrent follow-ups to one child must not interleave their
     * acceptance bookkeeping; the queue is per child, and a failed task never
     * poisons the next one.
     * @param id - the durable child id.
     * @param task - the work to run alone for this child.
     * @returns the task's own result.
     */
    chain(id, task) {
      const record = ensure(id);
      const run = record.chain.then(() => task(), () => task());
      record.chain = run.then(() => undefined, () => undefined);
      return run;
    },

    /**
     * The current state of one child, judged only from observed evidence.
     * @param id - the durable child id.
     * @returns `{ id, status, ... }`; `status` is `settled`, `running`,
     *   `pending`, `unknown`, or `unobserved` (no local history at all).
     */
    describe(id) {
      const record = records.get(id);
      if (record === undefined) return { id, status: 'unobserved' };
      const evidence = settlementEvidence(record);
      if (evidence !== undefined) {
        return {
          id,
          status: 'settled',
          stopReason: evidence.stopReason,
          output: evidence.output,
          at: evidence.at,
          generation: record.delivery?.generation,
        };
      }
      const delivery = record.delivery;
      if (delivery !== undefined && delivery.accepted !== true && delivery.failed !== true) {
        return { id, status: 'pending', since: delivery.startedAt, generation: delivery.generation };
      }
      if (delivery !== undefined && delivery.accepted === true) {
        return {
          id,
          status: 'running',
          since: delivery.acceptedAt ?? delivery.startedAt,
          generation: delivery.generation,
          epoch: record.openEpoch?.runId ?? delivery.epochAtAccept,
        };
      }
      if (record.openEpoch !== undefined) return { id, status: 'running', observed: true };
      if (record.lastEnd !== undefined) {
        return {
          id,
          status: 'settled',
          stopReason: record.lastEnd.stopReason,
          output: record.lastEnd.output,
          at: record.lastEnd.at,
          observed: true,
        };
      }
      if (delivery !== undefined && delivery.failed === true) {
        return {
          id,
          status: 'unknown',
          generation: delivery.generation,
          detail: `the last message to this child was not accepted by its inbox (${delivery.error ?? 'unknown failure'}), `
            + 'so no work of this agent is outstanding for it — this is NOT a finished child',
        };
      }
      return { id, status: 'unknown', detail: 'no lifecycle edge observed for this child in this process' };
    },

    /**
     * Whether an id has any local history at all.
     * @param id - the durable child id.
     * @returns whether this tracker observed or issued a delivery for it.
     */
    knows(id) {
      return records.has(id);
    },

    /**
     * Subscribe to lifecycle changes.
     * @param watcher - called after every observed edge.
     * @returns the unsubscribe function.
     */
    onChange(watcher) {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },

    /**
     * Resolve on the next lifecycle change, the deadline, or cancellation.
     * @param remainingMs - milliseconds left in the caller's budget.
     * @param signal - the caller's cancellation signal, when it has one.
     * @returns `'change'`, `'timeout'`, or `'abort'`.
     */
    nextChange(remainingMs, signal) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (reason) => {
          if (settled) return;
          settled = true;
          unsubscribe();
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          resolve(reason);
        };
        const unsubscribe = this.onChange(() => finish('change'));
        const onAbort = () => finish('abort');
        const timer = setTimeout(() => finish('timeout'), Math.max(0, remainingMs));
        if (signal !== undefined && signal !== null) {
          if (signal.aborted === true) {
            finish('abort');
            return;
          }
          signal.addEventListener?.('abort', onAbort, { once: true });
        }
      });
    },

    /** Drop every record (the governed agent is gone). */
    reset() {
      records.clear();
    },
  };
}

/**
 * Read one service off the agent's own scoped context.
 *
 * @param agentCtx - the governed agent's scoped context.
 * @param name - the service name (`llm`, …).
 * @returns the service, or undefined when this scope cannot see it.
 */
function serviceOf(agentCtx, name) {
  try {
    const direct = agentCtx?.[name];
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    // An accessor that throws is treated as "not reachable from this scope".
  }
  try {
    return agentCtx?.get?.(name);
  } catch {
    return undefined;
  }
}

/**
 * Resolve one explicitly configured child LLM route before any child exists.
 *
 * WHAT THIS PREVENTS: `startContinuable` materializes (and persists) the child
 * FIRST; a bad provider/model/effort is normally discovered inside the child's
 * own first request, i.e. after a real child was created for a call the model
 * only meant to try. The public `llm.resolveCallConfig(selection, signal)` is
 * the runtime's own route validation (provider registration, exact-model
 * metadata, effort validation), so it is run here — before `startContinuable`.
 *
 * BOUNDARY (not faked): a route this scope cannot check because no `llm`
 * service is reachable is NOT reported as valid. The preflight is skipped and
 * said so in the diagnostics; the child is then validated by the service at
 * materialization time, which rolls back an unusable child instead of
 * returning ids.
 *
 * @param llm - the live LLM runtime, when reachable.
 * @param route - the configured child route (`provider`/`model`/`reasoningEffort`).
 * @param signal - the tool call's cancellation signal.
 * @param note - diagnostic sink (`(line) => void`).
 * @returns nothing.
 * @throws {Error} the model-visible route failure (`CHILD_ROUTE_UNRESOLVED`
 *   when the runtime threw without a code of its own).
 */
async function preflightChildRoute(llm, route, signal, note) {
  if (route === undefined) return;
  const provider = typeof route.provider === 'string' ? route.provider : '';
  const model = typeof route.model === 'string' ? route.model : '';
  // A partial route is completed by the delegation service (parent inheritance /
  // adapter defaults), so there is nothing exact to resolve here.
  if (provider.length === 0 || model.length === 0) return;
  if (llm === undefined || typeof llm.resolveCallConfig !== 'function') {
    note(
      `${SUBAGENT_TOOL_NAME}: no llm service is reachable from this scope, so the configured child route `
      + `${provider}/${model} was not preflighted; the service validates it at materialization time`,
    );
    return;
  }
  const reasoningEffort = typeof route.reasoningEffort === 'string' ? route.reasoningEffort : '';
  try {
    await llm.resolveCallConfig({
      provider,
      model,
      ...reasoningEffort.length === 0 ? {} : { reasoningEffort },
    }, signal);
  } catch (error) {
    const failure = new Error(
      `${SUBAGENT_TOOL_NAME}: the configured child model route "${provider}/${model}" cannot be used, so NO child was `
      + `created (${describeThrown(error)})${typeof error?.code === 'string' ? ` [code: ${error.code}]` : ''}. `
      + 'That route comes from the gate\'s subagent provider/model/reasoning-effort settings: fix it and retry. '
      + `The delegation provider itself stays "${SPAWN_PROVIDER}" and is not affected.`,
    );
    failure.name = 'FrugalDelegationError';
    failure.code = typeof error?.code === 'string' ? error.code : 'CHILD_ROUTE_UNRESOLVED';
    failure.cause = error;
    throw failure;
  }
}

/**
 * The model-visible refusal of a foreground delegation.
 *
 * `run_in_background: false` is not silently ignored and never downgraded to a
 * blocking one-shot call: the whole point of this surface is a child that
 * outlives the tool call, and the caller has to say what it actually wants.
 *
 * @returns the parameter error to throw before any side effect.
 */
export function backgroundRefusedError() {
  const error = new Error(
    'run_in_background: false is not supported by this tool. ' + SUBAGENT_TOOL_NAME
    + ' always dispatches to the background: it returns the new child\'s `agent_id` as soon as the child accepted the '
    + `message, and the child keeps working on its own. Wait for it with ${WAIT_TOOL_NAME}({ agent_ids: ["<agent_id>"] }) `
    + '(a timeout ends only the wait), and read how it ended from that result. Do not replace this with a foreground call '
    + 'or a poll loop.',
  );
  error.name = 'FrugalDelegationArgumentError';
  error.code = 'BACKGROUND_REFUSED';
  return error;
}

/**
 * Build the two model-facing tool definitions for one governed agent.
 *
 * @param options - see the individual fields.
 * @param options.agent - the governed depth-0 agent (the delegation parent).
 * @param options.subagents - the live `ctx.subagents` service.
 * @param options.agents - the live `ctx.agents` registry, when available.
 * @param options.tracker - the run bookkeeping (one per governed agent).
 * @param options.childAgentOptions - provider/model/reasoning-effort overrides
 *   for the child, or undefined to inherit the parent's route.
 * @param options.llm - the live `ctx.llm` runtime, used to resolve the
 *   configured child route before a child is materialized (optional).
 * @param options.maxDepth - the delegation budget passed with every creation.
 * @param options.waitBudget - the resolved `wait_subagent` budget (default/min/max), from
 *   {@link resolveWaitBudget}; defaults to "no plugin minimum, 30s default, 1h cap".
 * @param options.note - diagnostic sink (`(line) => void`).
 * @param options.defineTool - the official factory resolved from
 *   `@deepseek-ai/dsh-tools`.
 * @returns the definitions, keyed by name.
 */
function buildTools(options) {
  const {
    agent, subagents, agents, tracker, childAgentOptions, llm, maxDepth, note, defineTool,
    waitBudget = DEFAULT_WAIT_BUDGET,
  } = options;

  const parentId = () => {
    const id = agent?.session?.id ?? agent?.id;
    return typeof id === 'string' ? id : '<no-id>';
  };

  /**
   * The calling agent, checked to be this tool's own agent.
   * @param exec - the tool execution context.
   * @returns the parent agent.
   */
  const requireParent = (exec) => {
    const caller = exec?.agent;
    if (caller === undefined || caller === null) {
      throw new Error(`${SUBAGENT_TOOL_NAME}: this call needs a calling agent (exec.agent was undefined)`);
    }
    if (caller !== agent) {
      throw new Error(
        `${SUBAGENT_TOOL_NAME}: this tool instance belongs to one agent's own tool layer and cannot delegate for another agent`,
      );
    }
    return caller;
  };

  const requireService = () => {
    if (subagents === undefined || subagents === null) {
      throw new Error(
        `${SUBAGENT_TOOL_NAME}: the subagents service is unavailable; this deployment cannot create or continue child agents`,
      );
    }
    return subagents;
  };

  /**
   * Create one continuable child through the real `spawn` provider.
   * @param parent - the delegating agent.
   * @param prompt - the child's first, self-contained task.
   * @param description - the model's label, or '' to derive one.
   * @param signal - the call's cancellation signal (owns pre-acceptance work).
   * @returns the structured tool value.
   */
  const createChild = async (parent, prompt, description, signal) => {
    const service = requireService();
    const provider = typeof service.getProvider === 'function' ? service.getProvider(SPAWN_PROVIDER) : undefined;
    if (provider === undefined) {
      throw new Error(
        `${SUBAGENT_TOOL_NAME}: the "${SPAWN_PROVIDER}" subagent provider is not registered, so a durably resumable child `
        + `cannot be created (registered providers: ${JSON.stringify(typeof service.list === 'function' ? service.list() : [])}). `
        + 'Load the in-process spawn provider; the gate will not fall back to a mode that cannot be continued.',
      );
    }
    if (typeof provider.prepareContinuable !== 'function') {
      throw new Error(
        `${SUBAGENT_TOOL_NAME}: provider "${SPAWN_PROVIDER}" cannot create continuable children `
        + '(no prepareContinuable capability), so the child could not be continued or waited for later. '
        + 'Fix the provider configuration instead of degrading this call.',
      );
    }
    const label = description.length > 0 ? description : deriveLabel(prompt);
    // Before the first side effect: an unusable configured child route must be
    // reported instead of materializing (and persisting) a child for it.
    await preflightChildRoute(llm, childAgentOptions, signal, note);
    const request = {
      prompt: [{ type: 'text', text: prompt }],
      parent,
      persona: CHILD_PERSONA,
      maxDepth,
      ...childAgentOptions === undefined ? {} : { agentOptions: childAgentOptions },
    };
    let started;
    try {
      started = await service.startContinuable({
        provider: SPAWN_PROVIDER,
        label,
        request,
        signal,
      });
    } catch (error) {
      throw relayFailure(error, `${SUBAGENT_TOOL_NAME}: creating a child`);
    }
    const childId = typeof started?.childId === 'string' ? started.childId : '';
    const messageId = typeof started?.messageId === 'string' ? started.messageId : '';
    if (childId.length === 0) {
      throw relayFailure(
        new Error('startContinuable resolved without a child id'),
        `${SUBAGENT_TOOL_NAME}: creating a child`,
      );
    }
    tracker.attachCreate(childId);
    note(`${SUBAGENT_TOOL_NAME} create id=${childId.slice(0, 8)} label=${JSON.stringify(label)} message=${messageId.slice(0, 8)} accepted=true`);
    return {
      kind: 'continuable',
      agent_id: childId,
      message_id: messageId,
      accepted: true,
      continued: false,
      note: `started child ${childId}`,
    };
  };

  /**
   * Deliver one more message to an existing direct child.
   * @param parent - the delegating agent.
   * @param childId - the durable direct-child id.
   * @param prompt - the follow-up message.
   * @param signal - the call's cancellation signal.
   * @returns the structured tool value.
   */
  const continueChild = async (parent, childId, prompt, signal) => {
    const service = requireService();
    if (childId === parentId()) {
      throw new Error(`${SUBAGENT_TOOL_NAME}: an agent cannot continue itself; pass the agent_id of a child you created`);
    }
    return tracker.chain(childId, async () => {
      const generation = tracker.beginDelivery(childId);
      const liveBefore = typeof agents?.get === 'function' ? agents.get(childId) !== undefined : undefined;
      let messageId;
      try {
        messageId = await service.sendMessage(
          parent,
          childId,
          [{ type: 'text', text: prompt }],
          { signal },
        );
      } catch (error) {
        tracker.failDelivery(childId, generation, error);
        throw relayFailure(error, `${SUBAGENT_TOOL_NAME}: continuing child ${childId}`);
      }
      tracker.acceptDelivery(childId, generation);
      const accepted = typeof messageId === 'string' ? messageId : '';
      note(
        `${SUBAGENT_TOOL_NAME} continue id=${childId.slice(0, 8)} message=${accepted.slice(0, 8)} accepted=true `
        + `liveBefore=${String(liveBefore)}`,
      );
      return {
        kind: 'continuable',
        agent_id: childId,
        message_id: accepted,
        accepted: true,
        continued: true,
        note: `continued child ${childId}`,
      };
    });
  };

  const guidance = (childId) => [
    `Continue this child with ${SUBAGENT_TOOL_NAME}({ agent_id: "${childId}", prompt: "..." }) — it keeps its own context across calls.`,
    `Wait for it with ${WAIT_TOOL_NAME}({ agent_ids: ["${childId}"] }).`,
    'Do not use send_message or wait_agent for a subagent: those are Agent Tools for teammates, not for delegated children.',
  ].join(' ');

  const subagent = defineTool({
    name: SUBAGENT_TOOL_NAME,
    description: 'Delegate to a subagent: a separate agent with its own context and its own (cheaper) model. '
      + 'WITHOUT `agent_id` this CREATES a child and returns its `agent_id` immediately; the child always runs in the background. '
      + 'WITH `agent_id` it CONTINUES one of your direct children: `prompt` becomes the next message in that child\'s own '
      + 'conversation, so it keeps everything it already learned and needs only what is new. '
      + `Wait for a child with ${WAIT_TOOL_NAME}({ agent_ids: [...] }); never poll and never use a foreground call. `
      + 'This is not an Agent Teams tool: `send_message`/`wait_agent` address teammates and cannot reach a subagent.',
    parameters: {
      description: {
        type: 'string',
        description: 'Short (3-5 word) label for a NEW child, shown in the UI and stored with it. Optional: '
          + 'when omitted, the first line of `prompt` is used. Ignored when `agent_id` is given.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The task. For a new child this must be self-contained (a child does not see this conversation, '
          + 'or any sibling): goal, relevant context, scope/paths, the operation wanted, limits, deliverable format, and '
          + 'how completion is judged. When continuing, this is the next message — the child still has its own history.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Optional, and only `true` (the default) is accepted. Delegation is always background; '
          + `\`false\` is rejected with an error that points at ${WAIT_TOOL_NAME}, and never becomes a blocking call.`,
      },
      agent_id: {
        type: 'string',
        description: 'Durable id returned by an earlier call to this tool. Supply it to continue THAT child instead of '
          + 'creating a new one. It must be a direct child of yours (an id you created or continued).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'continuable' },
          agent_id: { type: 'string', required: true },
          message_id: { type: 'string', required: true },
          accepted: { type: 'boolean', required: true },
          continued: { type: 'boolean', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.continued ? 'continued' : 'started'} subagent ${value.agent_id} `
          + `(message ${value.message_id} accepted; it is running in the background). ${guidance(value.agent_id)}`,
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = requireParent(exec);
      const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
      if (prompt.trim().length === 0) {
        throw new Error(`${SUBAGENT_TOOL_NAME}: \`prompt\` must be a non-empty string`);
      }
      if (args?.run_in_background === false) {
        // Before every side effect: a refused spelling must not create anything.
        throw backgroundRefusedError();
      }
      const rawId = typeof args?.agent_id === 'string' ? args.agent_id.trim() : '';
      const description = typeof args?.description === 'string' ? args.description.trim() : '';
      if (rawId.length === 0) return createChild(parent, prompt, description, exec?.signal);
      return continueChild(parent, rawId, prompt, exec?.signal);
    },
  });

  /**
   * The model-visible statuses that end a wait.
   */
  const TERMINAL = new Set(['settled', 'unknown', 'invalid', 'unavailable']);

  const wait = defineTool({
    name: WAIT_TOOL_NAME,
    description: 'Wait until the subagents dispatched with `subagent` have finished their current work. Every id in '
      + '`agent_ids` must be a direct child of yours (one this agent created or continued) — never yourself and never '
      + 'another agent\'s child. Returns one entry per id: `settled` with the child\'s closing output, `running` when the '
      + 'timeout expired first, `unknown` when this process holds no lifecycle history for that child (for example one '
      + 'created before the plugin reloaded — send it new work with `subagent({ agent_id, prompt })` to open an observably '
      + 'new round, then wait again), `invalid` for an id that is not your child, or `unavailable` when the child catalog '
      + 'cannot be read. A timeout, and an abort, end only the WAIT: the child keeps running and can be waited for again. '
      + 'Waiting again on an already settled child returns its cached result immediately. This is not the Agent Teams '
      + '`wait_agent`: that waits for teammates, this waits for your own delegated children.',
    parameters: {
      agent_ids: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Ids returned by `subagent` (the `agent_id` field). At least one, no duplicates needed.',
      },
      timeout_ms: {
        type: 'integer',
        description: `How long to wait before returning the current status. Default ${waitBudget.defaultMs}`
          + `${waitBudget.minMs > 0 ? `, minimum ${waitBudget.minMs} (configured by minWaitTimeoutMs; a smaller value is rejected)` : ''}`
          + `, maximum ${waitBudget.maxMs}; a larger value is rejected because one wait never blocks longer than that.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timed_out: { type: 'boolean', required: true },
          aborted: { type: 'boolean' },
          settled: { type: 'integer', required: true },
          pending: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                agent_id: { type: 'string', required: true },
                status: { type: 'string', required: true },
                stop_reason: { type: 'string' },
                output: { type: 'string' },
                detail: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = value.results.map((entry) => {
          const head = `${entry.agent_id}: ${entry.status}`
            + `${entry.stop_reason === undefined ? '' : ` (${entry.stop_reason})`}`;
          const body = entry.output === undefined || entry.output.length === 0 ? '' : `\n${entry.output}`;
          const detail = entry.detail === undefined ? '' : `\n${entry.detail}`;
          return `${head}${detail}${body}`;
        });
        lines.push(value.aborted === true
          ? 'the wait was cancelled; nothing was interrupted — the children keep running, wait again to collect them'
          : value.timed_out
            ? `the wait timed out; nothing was interrupted — the children keep running, wait again (max ${waitBudget.maxMs}ms per call)`
            : `settled ${value.settled}, still running ${value.pending}`);
        return [{ type: 'text', text: lines.join('\n\n') }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = requireParent(exec);
      const service = requireService();
      const ids = normaliseIds(args?.agent_ids);
      const timeoutMs = normaliseTimeout(args?.timeout_ms, waitBudget);
      const signal = exec?.signal;
      const self = parentId();

      // One catalog read classifies every id this process has no history for;
      // it is also what proves "direct child" without loading or resuming one.
      const catalog = { loaded: false, entries: undefined, failure: undefined };
      const readCatalog = async () => {
        if (catalog.loaded) return catalog;
        catalog.loaded = true;
        const listChildren = service.listChildren;
        if (typeof listChildren !== 'function') {
          catalog.failure = 'the subagents service exposes no listChildren(), so an unknown id cannot be checked';
          return catalog;
        }
        try {
          const entries = await service.listChildren(parent?.session?.id ?? parent?.id, signal);
          catalog.entries = Array.isArray(entries) ? entries : [];
        } catch (error) {
          catalog.failure = `the child catalog could not be read (${describeThrown(error)})`;
        }
        return catalog;
      };
      await readCatalog();

      const statusOf = (id) => {
        if (id === self) {
          return {
            agent_id: id,
            status: 'invalid',
            detail: 'that is your own session id; wait_subagent only waits for direct children you delegated to',
          };
        }
        const local = tracker.describe(id);
        if (local.status !== 'unobserved') {
          note(`${WAIT_TOOL_NAME} id=${id.slice(0, 8)} local=${local.status}${local.stopReason === undefined ? '' : `/${local.stopReason}`}`);
          return { ...local, agent_id: id };
        }
        if (catalog.failure !== undefined) {
          return {
            agent_id: id,
            status: 'unavailable',
            detail: `${catalog.failure}. This process has no lifecycle history for this child either, so its state is `
              + 'unknown here — it is NOT reported as finished. Send it new work with '
              + `${SUBAGENT_TOOL_NAME}({ agent_id: "${id}", prompt: "..." }) to open an observably new round, then wait again; `
              + 'if the catalog error persists, fix the session-query/persistence services.',
          };
        }
        const entry = (catalog.entries ?? []).find((candidate) => candidate?.id === id);
        if (entry === undefined) {
          return {
            agent_id: id,
            status: 'invalid',
            detail: 'not a direct child of this agent (ids not created or continued by this agent cannot be waited for)',
          };
        }
        if (entry.mode === 'one-shot') {
          return {
            agent_id: id,
            status: 'unknown',
            detail: 'that child was created as a one-shot run, which has no resumable conversation and no waitable epoch. '
              + `Start a continuable child with ${SUBAGENT_TOOL_NAME}({ prompt: "..." }) instead.`,
          };
        }
        return {
          agent_id: id,
          status: 'unknown',
          detail: `this child is a direct child of yours (label: ${JSON.stringify(entry.label ?? '')}) but this process `
            + 'observed no lifecycle edge for it — it was most likely created before the plugin (re)loaded, and start/end '
            + 'events are never replayed. Its state is NOT reported as finished. '
            + `Send it new work with ${SUBAGENT_TOOL_NAME}({ agent_id: "${id}", prompt: "..." }): that opens a new epoch whose `
            + 'end is observable here, and then wait_subagent returns its result.',
        };
      };

      const snapshot = () => ids.map(statusOf);
      const build = (results, timedOut, aborted) => ({
        timed_out: timedOut,
        ...aborted ? { aborted: true } : {},
        settled: results.filter((entry) => entry.status === 'settled').length,
        pending: results.filter((entry) => !TERMINAL.has(entry.status)).length,
        results: results.map((entry) => ({
          agent_id: entry.agent_id,
          status: entry.status,
          ...entry.stopReason === undefined ? {} : { stop_reason: entry.stopReason },
          ...entry.output === undefined || entry.output.length === 0 ? {} : { output: entry.output },
          ...entry.detail === undefined ? {} : { detail: entry.detail },
        })),
      });

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const results = snapshot();
        if (results.every((entry) => TERMINAL.has(entry.status))) return build(results, false, false);
        const remaining = deadline - Date.now();
        if (remaining <= 0) return build(snapshot(), true, false);
        const change = await tracker.nextChange(remaining, signal);
        if (change === 'abort') return build(snapshot(), false, true);
        if (change === 'timeout') return build(snapshot(), true, false);
      }
    },
  });

  return { [SUBAGENT_TOOL_NAME]: subagent, [WAIT_TOOL_NAME]: wait };
}

/**
 * Validate and de-duplicate the wait tool's id list.
 *
 * @param value - the raw `agent_ids` argument.
 * @returns distinct, non-empty ids in call order.
 * @throws when the list is empty or holds a non-string entry.
 */
export function normaliseIds(value) {
  if (!Array.isArray(value)) throw new Error(`${WAIT_TOOL_NAME}: \`agent_ids\` must be an array of child ids`);
  const ids = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`${WAIT_TOOL_NAME}: every \`agent_ids\` entry must be a non-empty child id string`);
    }
    const id = entry.trim();
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) throw new Error(`${WAIT_TOOL_NAME}: \`agent_ids\` must name at least one child`);
  return ids;
}

/**
 * Validate the wait tool's budget.
 *
 * The wait is a DEADLINE, not a forced sleep: it returns as soon as the work
 * settles. A configured minimum therefore only refuses calls that would give up
 * too early — it never pads a wait that already has its answer.
 * @param value - the raw `timeout_ms` argument.
 * @param budget - the resolved budget from {@link resolveWaitBudget}.
 * @returns the effective timeout.
 * @throws when the value is not an integer in `[minMs, maxMs]`.
 */
export function normaliseTimeout(value, budget = DEFAULT_WAIT_BUDGET) {
  const { minMs, defaultMs, maxMs } = budget;
  if (value === undefined || value === null) return defaultMs;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${WAIT_TOOL_NAME}: \`timeout_ms\` must be a non-negative integer number of milliseconds`);
  }
  if (value > maxMs) {
    throw new Error(
      `${WAIT_TOOL_NAME}: \`timeout_ms\` must not exceed ${maxMs} — one wait call never blocks longer than that. `
      + 'Pass a smaller value and wait again; nothing is cancelled by a timeout.',
    );
  }
  if (value < minMs) {
    throw new Error(
      `${WAIT_TOOL_NAME}: \`timeout_ms\` must be at least ${minMs} (this deployment configures a minimum wait, `
      + 'minWaitTimeoutMs; a shorter wait returns before the work can make progress). '
      + `Omit \`timeout_ms\` to use the default ${defaultMs}, or pass ${minMs} or more. Nothing is cancelled by a timeout.`,
    );
  }
  return value;
}

/**
 * Release a list of disposers, tolerating the ones that are already released.
 *
 * Used only by the rollbacks below, so that a partially installed surface never
 * leaves a listener or a tool behind.
 *
 * @param disposers - the disposers to call, in the order they were obtained.
 */
function releaseAll(disposers) {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      // Already released.
    }
  }
}

/**
 * Install the `subagent/start` and `subagent/end` listeners of one governed
 * agent.
 *
 * WHY THIS IS A SEPARATE, PUBLIC INSTALL: these two listeners are the only
 * channel through which this process can ever learn that a child settled
 * (`@deepseek-ai/dsh-subagent` replays nothing), so they are durable state and
 * have to live exactly as long as the tracker they feed — NOT as long as one
 * application of the effect set. A settings write re-applies that set; tearing
 * the listeners down with the tools would destroy the bookkeeping of children
 * that are still running. So: install them once per governed agent, keep the
 * returned disposers (until the agent is disposed), and re-register the tools
 * with `installDelegationTools({ ..., observeLifecycle: false })`.
 *
 * The handlers are synchronous and touch nothing but the tracker. The listeners
 * are registered FIRST, because a missed edge is a settlement that can never be
 * reconstructed. Nothing is registered twice, and a failure registers nothing:
 * a listener this call already installed is released again before the error
 * leaves. A listener the CALLER owns is never touched here — it is not passed
 * to this function at all.
 *
 * @param options - see the individual fields.
 * @param options.agentCtx - the governed agent's own scoped context.
 * @param options.tracker - the run bookkeeping these listeners feed.
 * @param options.note - diagnostic sink for the end edge (`(line) => void`).
 * @returns the disposers releasing exactly the listeners installed by this call.
 * @throws {Error} `CONFIG-TOOLS-UNAVAILABLE` when this scope cannot observe the
 *   lifecycle, when the tracker cannot record it, or when a listener could not
 *   be registered — fail-closed, so a half-observed agent is never left behind.
 */
export function installChildRunObservers(options) {
  const { agentCtx, tracker, note } = options ?? {};
  if (agentCtx === undefined || agentCtx === null || typeof agentCtx.on !== 'function') {
    throw toolsUnavailableError('the agent scope exposes no event API for the subagent lifecycle', undefined);
  }
  if (tracker === undefined || tracker === null
    || typeof tracker.observeStart !== 'function' || typeof tracker.observeEnd !== 'function') {
    throw toolsUnavailableError(
      'no run tracker that can record subagent lifecycle edges was provided, so no creation or follow-up '
      + 'could ever be observed to settle',
      undefined,
    );
  }

  const disposers = [];
  try {
    disposers.push(agentCtx.on('subagent/start', (info) => {
      tracker.observeStart(info);
    }));
    disposers.push(agentCtx.on('subagent/end', (info) => {
      tracker.observeEnd(info);
      note(
        `subagent/end id=${typeof info?.id === 'string' ? info.id.slice(0, 8) : '<none>'} `
        + `stop=${describe(info?.stopReason)} output=${outputText(info?.lastAssistantMessage).length}chars`,
      );
    }));
  } catch (error) {
    releaseAll(disposers);
    throw toolsUnavailableError('the subagent lifecycle listeners could not be registered', error);
  }
  return disposers;
}

/**
 * Install the delegation surface on one governed agent.
 *
 * The listeners come FIRST: a creation or a follow-up may only be attempted once
 * `subagent/start` and `subagent/end` are being recorded, because a missed edge
 * is a settlement this process can never reconstruct (the service replays
 * nothing).
 *
 * TWO LIFETIMES, TWO SEAMS. The listeners are durable state — the only
 * settlement evidence there is — while the two registrations are not: a settings
 * write releases and re-registers the tools of an agent whose children keep
 * running. A caller that owns the listeners itself installs them ONCE with
 * {@link installChildRunObservers}, hands them back in `observerDisposers`, and
 * re-registers the tools with `observeLifecycle: false`; then a re-install adds
 * no listener and releases none of the caller's. The default
 * `observeLifecycle: true` keeps the original one-shot shape (listeners and
 * tools installed and released together) for callers that own neither.
 *
 * Every failure here is fail-closed: the caller gets an error it must not
 * swallow, because a governed agent whose three tools are not the promised three
 * would silently run with a different (or a shadowed, or an absent) delegation
 * surface.
 *
 * @param options - see the individual fields.
 * @param options.agentCtx - the governed agent's own scoped context.
 * @param options.agent - the governed agent.
 * @param options.registry - the scope-bound tool registry (`agentCtx.tools`).
 * @param options.subagents - the live `ctx.subagents` service.
 * @param options.agents - the live `ctx.agents` registry, when available.
 * @param options.tracker - the per-agent run bookkeeping.
 * @param options.childAgentOptions - the child's provider/model/effort, from the
 *   live settings; undefined keeps the preset's own route.
 * @param options.llm - the live `ctx.llm` runtime; resolved from `agentCtx`
 *   when omitted, and skipped when this scope cannot see it.
 * @param options.maxDepth - delegation budget for created children.
 * @param options.waitBudget - the resolved `wait_subagent` budget from
 *   {@link resolveWaitBudget} (the configured minimum wait, its default and the cap).
 * @param options.note - diagnostic sink.
 * @param options.logError - `logger.error`-style sink.
 * @param options.observeLifecycle - install the two lifecycle listeners as part
 *   of this call (default `true`). `false` installs only the two tools and
 *   returns only their disposers: the caller has the listeners already (see
 *   `observerDisposers`) and keeps them across re-installs.
 * @param options.observerDisposers - the listeners of an earlier
 *   {@link installChildRunObservers} call, when the caller already owns them.
 *   They are acknowledged, never installed a second time, and NEVER released by
 *   this call — not even by the rollback that runs when a registration below
 *   fails.
 * @returns `{ disposers, observerDisposers, definitions }`. `disposers` releases
 *   everything THIS call installed, in registration order — the listeners too
 *   when it installed them (the historical four disposers). `observerDisposers`
 *   are the listeners backing this surface: the ones installed here, or the
 *   caller's own. Only `observerDisposers` has to survive a re-install.
 * @throws {Error} `CONFIG-TOOLS-UNAVAILABLE` when the surface cannot be
 *   installed completely.
 * @throws {Error} `CONFIG-TOOLS-UNAVAILABLE` when the surface cannot be
 *   installed completely.
 */
export function installDelegationTools(options) {
  const {
    agentCtx, agent, registry, subagents, agents, tracker, childAgentOptions, maxDepth, note, logError,
  } = options;
  const waitBudget = options.waitBudget ?? DEFAULT_WAIT_BUDGET;
  // The child's LLM route is resolved through the live LLM runtime before a
  // child is materialized. Read from this agent's own scope (the row does not
  // have to hand it in), and tolerate a deployment where it is not reachable.
  const llm = options.llm ?? serviceOf(agentCtx, 'llm');
  // The two seams: `observeLifecycle: false` + `observerDisposers` is the
  // re-install shape (the caller owns the listeners); the default installs them
  // here and releases them with the tools.
  const observeLifecycle = options.observeLifecycle !== false;
  const callerObservers = options.observerDisposers ?? [];
  if (!Array.isArray(callerObservers) || callerObservers.some((dispose) => typeof dispose !== 'function')) {
    throw toolsUnavailableError(
      'options.observerDisposers is not the disposer array returned by installChildRunObservers()',
      undefined,
    );
  }

  const module = loadToolModule();
  const defineTool = module?.defineTool;
  if (typeof defineTool !== 'function') {
    throw toolsUnavailableError(
      `the official tool factory (defineTool from ${TOOLS_PACKAGE}) could not be loaded`,
      toolModuleFailure(),
    );
  }
  if (agentCtx === undefined || agentCtx === null || typeof agentCtx.on !== 'function') {
    throw toolsUnavailableError('the agent scope exposes no event API for the subagent lifecycle', undefined);
  }
  if (typeof registry?.register !== 'function') {
    throw toolsUnavailableError('the agent scope exposes no tool registry with register()', undefined);
  }
  if (subagents === undefined || subagents === null) {
    throw toolsUnavailableError('the subagents service is not available in this deployment', undefined);
  }

  // What THIS call installs, in registration order. The rollback below releases
  // exactly this list, so a listener the CALLER owns is never released here.
  const disposers = [];
  let observerDisposers = callerObservers;
  if (callerObservers.length === 0 && observeLifecycle) {
    observerDisposers = installChildRunObservers({ agentCtx, tracker, note });
    disposers.push(...observerDisposers);
  } else if (callerObservers.length === 0) {
    // Honoured as documented — the two tools only — but named loudly: a tool set
    // with no live listener can never report anything but `unknown` here.
    logError?.(
      'frugal-gate: installDelegationTools({ observeLifecycle: false }) was called without `observerDisposers`: '
      + 'no subagent/start or subagent/end listener backs these tools, so no child can ever be observed to settle here',
    );
  }

  const tools = buildTools({
    agent, subagents, agents, tracker, childAgentOptions, llm, maxDepth, note, defineTool, waitBudget,
  });

  try {
    for (const name of GATE_TOOL_NAMES) {
      disposers.push(registry.register(tools[name]));
    }
  } catch (error) {
    // Only what THIS call installed; the caller's persistent listeners are not
    // in this list and stay registered.
    releaseAll(disposers);
    logError?.(`frugal-gate: could not register ${GATE_TOOL_NAMES.join(', ')} — ${describeThrown(error)}`);
    throw toolsUnavailableError(
      `the tool registry refused ${GATE_TOOL_NAMES.join(', ')} `
      + '(a same-layer registration with one of those names already exists, or the registry rejected the definition)',
      error,
    );
  }

  return { disposers, observerDisposers, definitions: tools };
}
