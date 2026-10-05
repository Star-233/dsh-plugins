/**
 * Compaction policy — host half (top-level row).
 *
 * WHAT THIS REPLACES
 * v0.3 implemented "context budget" inside the frugal orchestration plugin: it
 * forced a per-request `maxTokens` from config, derived the pressure threshold
 * from that same number, and then tried to compact through `ctx.get('compaction')`
 * — which is unreachable from a host-plane row (see ../bridge.js). The result was
 * a threshold of `window - cap - 32768` (23232 for the shipped 256000/200000
 * configuration) and a compaction path that could only ever throw.
 *
 * WHAT IT DOES NOW (the plan's B + C + D)
 *   B — the pressure threshold is `window - reserve`, where
 *       `reserve = max(15% of window, 16384)` (ompi's `effectiveReserveTokens`),
 *       or a configured percent / absolute token override. The per-request output
 *       cap no longer participates.
 *   C — the request's output cap is a WISH: `agent/request` narrows it to
 *       `window - prompt - 64` (floor 1024) only when it would not fit. A small
 *       prompt keeps the model's full advertised output capability.
 *   D — the engine is resolved per agent through `agentPresets.serviceFor`, which
 *       finds what the preset's bridge row republished. A preset without that row
 *       is not governed at all.
 *
 * FAILURE SEMANTICS (pi / oh-my-pi): nothing here terminates a turn. Every
 * failure is logged and the turn continues; a provider context overflow is
 * recovered by `agent/request-error` → one forced compaction → `{kind:'retry'}`.
 *
 * WHY A TOP-LEVEL ROW: the Web settings document is built from
 * `configEditor.entries()`, which keeps only direct children of an `include`
 * entry — a row nested inside a preset tree can never grow a configure page.
 *
 * @module @nu11dev/dsh-compaction-policy
 */

import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolutionBases } from './lib/resolve.js';
import { ENGINE_SERVICE, PRUNER_SERVICE } from './bridge.js';
import {
  POLICY_DEFAULTS, estimatePromptTokens, exceedsThreshold, fitOutputTokens, isTokenCount,
  overrideForAgent, parsePercentOverride, resolveReserveTokens, resolveRetentionTokens, resolveThresholdTokens,
} from './lib/policy.js';
import { enginesFor, measurePressure, prune, selectSafeRange, serviceOf } from './lib/engine.js';
import { OverflowGuard } from './lib/overflow.js';

/** Cordis plugin name. */
export const name = 'compaction-policy';

/** Cap on the diagnostic log before it is restarted from scratch. */
const LOG_MAX_BYTES = 512 * 1024;

/** Provider-confirmed overflow code, resolved loosely so a rename cannot crash the row. */
function contextWindowExceededCode() {
  for (const base of resolutionBases()) {
    try {
      const loaded = createRequire(base)('@deepseek-ai/dsh-llm');
      const module = loaded?.default ?? loaded;
      if (typeof module?.CONTEXT_WINDOW_EXCEEDED_CODE === 'string') return module.CONTEXT_WINDOW_EXCEEDED_CODE;
    } catch {
      // Try the next base.
    }
  }
  return 'CONTEXT_WINDOW_EXCEEDED';
}

const CONTEXT_WINDOW_EXCEEDED = contextWindowExceededCode();

/**
 * Resolve the schemastery factory the Config schema is built from.
 *
 * `@deepseek-ai/schemastery` is a peer of every host plugin, but this package may
 * be linked into the profile (`link:`) and therefore evaluated from a directory
 * outside the profile's resolution root.
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
    'compaction-policy: cannot resolve @deepseek-ai/schemastery. The row needs it to declare the volatile '
    + 'Config the Web GUI edits; install the plugin inside the profile instead of linking it, or make '
    + 'DSH_PROFILE_DIR name a profile whose node_modules holds @deepseek-ai/schemastery.',
  );
}

const z = loadSchemaFactory();

/**
 * The switches the Web GUI edits; every field is `.volatile()` (a write commits
 * into this running fiber, so a change applies to live agents without a remount).
 */
export const Config = z.object({
  /** Reserve as a fraction of the window (ompi: 15%). */
  reserveRatio: z.number().min(0.01).max(0.99).default(POLICY_DEFAULTS.reserveRatio).volatile(),
  /** Floor of that reserve (pi/ompi: 16384). */
  reserveFloorTokens: z.number().step(1).min(0).default(POLICY_DEFAULTS.reserveFloorTokens).volatile(),
  /** Percent override, e.g. "80%" or 80; blank keeps the reserve formula. */
  thresholdPercent: z.string().default('').volatile(),
  /** Absolute override in tokens; 0 keeps the reserve formula. */
  thresholdTokens: z.number().step(1).min(0).default(0).volatile(),
  /** Output cap every request asks for; 0 = the model's advertised capability. */
  desiredOutputCap: z.number().step(1).min(0).default(0).volatile(),
  /** Output cap for delegated children; 0 = same as above (decision A). */
  workerOutputCap: z.number().step(1).min(0).default(0).volatile(),
  /** Safety gap under the window when fitting (ompi: 64). */
  fitHeadroomTokens: z.number().step(1).min(0).default(POLICY_DEFAULTS.fitHeadroomTokens).volatile(),
  /** Floor of a fitted cap (ompi: 1024). */
  minFittedOutputTokens: z.number().step(1).min(1).default(POLICY_DEFAULTS.minFittedOutputTokens).volatile(),
  /** Local-estimate inflation denominator without a usage anchor. */
  estimateMarginDivisor: z.number().step(1).min(1).default(POLICY_DEFAULTS.estimateMarginDivisor).volatile(),
  /** Recent tail kept verbatim across one compaction. */
  keepRecentTokens: z.number().step(1).min(0).default(POLICY_DEFAULTS.keepRecentTokens).volatile(),
  /** Summary attempts per pressure event. */
  compactionRetries: z.number().step(1).min(0).default(POLICY_DEFAULTS.compactionRetries).volatile(),
  /** Overflow recoveries per agent. */
  maxOverflowRetries: z.number().step(1).min(0).default(POLICY_DEFAULTS.maxOverflowRetries).volatile(),
  /** Per-agent thresholds: "id=90000, id2=80%". */
  agentThresholdOverrides: z.string().default('').volatile(),
  /** Routes whose output cap is never fitted: "provider/model, model". */
  skipFitTargets: z.string().default('').volatile(),
  /** Append every decision to `$DSH_HOME/compaction-policy.log`. */
  diagnostics: z.boolean().default(true).volatile(),
});

/** Read the live value behind a config field (a volatile reference, not a value). */
function unwrap(value) {
  let current = value;
  for (let step = 0; step < 4; step += 1) {
    if (current === null || typeof current !== 'object') break;
    if (typeof current.get !== 'function' || Object.getOwnPropertySymbols(current).length === 0) break;
    current = current.get();
  }
  return current;
}

/** Split a comma/space separated list. */
function listOf(value) {
  const text = String(value ?? '').trim();
  return text.length === 0 ? [] : text.split(/[,\s]+/).filter((entry) => entry.length > 0);
}

/** Parse "id=90000, id2=80%" into a lookup map. */
function overridesOf(value) {
  const map = {};
  for (const entry of listOf(value)) {
    const at = entry.indexOf('=');
    if (at <= 0 || at === entry.length - 1) continue;
    map[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return map;
}

/** Project the live config into plain, already-defaulted settings. */
function settingsOf(config) {
  const read = (key, fallback) => {
    const value = unwrap(config?.[key]);
    return value === undefined || value === null ? fallback : value;
  };
  return {
    reserveRatio: Number(read('reserveRatio', POLICY_DEFAULTS.reserveRatio)),
    reserveFloorTokens: Number(read('reserveFloorTokens', POLICY_DEFAULTS.reserveFloorTokens)),
    thresholdPercent: String(read('thresholdPercent', '')),
    thresholdTokens: Number(read('thresholdTokens', 0)),
    desiredOutputCap: Number(read('desiredOutputCap', 0)),
    workerOutputCap: Number(read('workerOutputCap', 0)),
    fitHeadroomTokens: Number(read('fitHeadroomTokens', POLICY_DEFAULTS.fitHeadroomTokens)),
    minFittedOutputTokens: Number(read('minFittedOutputTokens', POLICY_DEFAULTS.minFittedOutputTokens)),
    estimateMarginDivisor: Number(read('estimateMarginDivisor', POLICY_DEFAULTS.estimateMarginDivisor)),
    keepRecentTokens: Number(read('keepRecentTokens', POLICY_DEFAULTS.keepRecentTokens)),
    compactionRetries: Number(read('compactionRetries', POLICY_DEFAULTS.compactionRetries)),
    maxOverflowRetries: Number(read('maxOverflowRetries', POLICY_DEFAULTS.maxOverflowRetries)),
    overrides: overridesOf(read('agentThresholdOverrides', '')),
    skipFit: listOf(read('skipFitTargets', '')),
    diagnostics: read('diagnostics', true) === true,
  };
}

/** The subset of settings the pure policy math consumes. */
function policyOf(settings) {
  return {
    reserveRatio: settings.reserveRatio,
    reserveFloorTokens: settings.reserveFloorTokens,
    fitHeadroomTokens: settings.fitHeadroomTokens,
    minFittedOutputTokens: settings.minFittedOutputTokens,
    estimateMarginDivisor: settings.estimateMarginDivisor,
    keepRecentTokens: settings.keepRecentTokens,
  };
}

/** A short, safe rendering of one agent id. */
function shortId(agent) {
  const id = agent?.id ?? agent?.session?.id;
  return typeof id === 'string' ? id.slice(0, 8) : '<no-id>';
}

/** An agent's delegation depth, mirroring dsh-subagent's own rule. */
function depthOf(agent) {
  const header = agent?.session?.header?.delegationDepth;
  const runtime = agent?.options?.subagentDepth;
  return Math.max(
    typeof header === 'number' && Number.isSafeInteger(header) ? header : 0,
    typeof runtime === 'number' && Number.isSafeInteger(runtime) ? runtime : 0,
  );
}

/** The durable route the agent is currently on. */
function routeOf(agent) {
  const config = agent?.session?.requestHeader?.()?.config;
  if (config !== undefined && typeof config.provider === 'string' && typeof config.model === 'string') return config;
  const provider = agent?.options?.provider;
  const model = agent?.options?.model;
  if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) return { provider, model };
  return undefined;
}

/** Append one line to the diagnostic log. Never throws. */
function makeNote(settingsOfLive) {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  const logPath = join(home, 'compaction-policy.log');
  return (settings, line) => {
    if (settings?.diagnostics !== true) return;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      try {
        if (statSync(logPath).size > LOG_MAX_BYTES) writeFileSync(logPath, '');
      } catch {
        // No log yet: the append below creates it.
      }
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Diagnostics must never break a request.
    }
  };
}

/**
 * Install the policy hooks.
 * @param ctx - the top-level row's context.
 * @param config - the row's resolved config (volatile references included).
 */
export function apply(ctx, config) {
  const settings = () => settingsOf(config);
  const note = makeNote(settings);

  /** Assembled tools/prompt plus the loop's pending messages, per agent. */
  const pending = new WeakMap();
  /** Agents already reported as ungoverned, so the log says it once per agent. */
  const reported = new WeakSet();
  const overflow = new OverflowGuard();

  const servicesFor = (agent) => {
    const services = enginesFor(ctx, agent);
    if (services === undefined && agent !== undefined && !reported.has(agent)) {
      reported.add(agent);
      note(settings(), `ungoverned id=${shortId(agent)} reason=no-bridge (this preset keeps its built-in compaction)`);
    }
    return services;
  };

  const readingFor = (agent, config2) => measurePressure(ctx, agent, config2, pending.get(agent));

  const pressureOf = (reading, policy) => estimatePromptTokens({
    totalTokens: reading?.measurement?.totalTokens ?? 0,
    extraTokens: reading?.extraTokens ?? 0,
    anchored: reading?.anchored === true,
    policy,
  });

  const thresholdFor = (agent, window, settingsValue, policy) => {
    const override = overrideForAgent(settingsValue.overrides, agent?.id);
    if (typeof override === 'string' && override.trim().endsWith('%')) {
      return resolveThresholdTokens({ contextWindow: window, thresholdPercent: override, policy });
    }
    if (override !== undefined) {
      return resolveThresholdTokens({ contextWindow: window, thresholdTokens: Number(override), policy });
    }
    return resolveThresholdTokens({
      contextWindow: window,
      reserveTokens: resolveReserveTokens(window, policy),
      thresholdTokens: isTokenCount(settingsValue.thresholdTokens) ? settingsValue.thresholdTokens : undefined,
      thresholdPercent: settingsValue.thresholdPercent,
      policy,
    });
  };

  /**
   * Prune and compact until the next request fits under the threshold.
   * Never throws into the turn: every failure is logged and returned.
   */
  async function compactForPressure(agent, services, signal) {
    const current = settings();
    const policy = policyOf(current);
    const llm = serviceOf(ctx, 'llm');
    const meter = serviceOf(ctx, 'tokenMeter');
    const route = routeOf(agent);
    if (route === undefined || typeof llm?.resolveModelInfo !== 'function' || typeof meter?.measure !== 'function') {
      note(current, `pressure-skip id=${shortId(agent)} reason=no-route-or-meter`);
      return null;
    }
    const info = await llm.resolveModelInfo(route.provider, route.model, signal);
    const window = info?.context?.contextWindow;
    if (!isTokenCount(window)) {
      note(current, `pressure-skip id=${shortId(agent)} reason=no-contextWindow`);
      return null;
    }
    const threshold = thresholdFor(agent, window, current, policy);
    const retention = resolveRetentionTokens({ thresholdTokens: threshold, keepRecentTokens: current.keepRecentTokens });
    let reading = readingFor(agent, route);
    if (reading === undefined) {
      note(current, `pressure-skip id=${shortId(agent)} reason=no-token-meter`);
      return null;
    }
    const reserve = isTokenCount(current.thresholdTokens) || current.thresholdPercent !== ''
      ? undefined
      : resolveReserveTokens(window, policy);
    let pressure = pressureOf(reading, policy);
    let pruned = false;
    let compacted = 0;
    if (exceedsThreshold(pressure, threshold) && services.pruner !== undefined) {
      prune(services.pruner, agent.session);
      pruned = true;
      reading = readingFor(agent, route);
      pressure = pressureOf(reading, policy);
    }
    for (let attempt = 0; attempt <= current.compactionRetries && exceedsThreshold(pressure, threshold); attempt += 1) {
      const range = await selectSafeRange(agent.session, reading.measurement, retention, serviceOf(ctx, 'sessionQuery'), signal);
      if (range === null) {
        note(current, `compaction-no-range id=${shortId(agent)} pressure=${pressure} threshold=${threshold}`);
        break;
      }
      await services.engine.compactRegion(range.start, range.end, agent, signal);
      compacted += 1;
      reading = readingFor(agent, route);
      pressure = pressureOf(reading, policy);
    }
    note(current, `pressure id=${shortId(agent)} route=${route.provider}/${route.model} window=${window} reserve=${reserve ?? 'override'} threshold=${threshold} pressure=${pressure} source=${reading.measurement.baseline.kind} pruned=${pruned} compacted=${compacted}`);
    return { window, threshold, pressure, compacted };
  }

  /** Narrow this request's output cap to what actually fits. Never throws. */
  async function fitRequest(agent, base, signal) {
    const current = settings();
    const policy = policyOf(current);
    const llm = serviceOf(ctx, 'llm');
    if (typeof llm?.resolveModelInfo !== 'function') return base;
    const info = await llm.resolveModelInfo(base.provider, base.model, signal);
    const window = info?.context?.contextWindow;
    if (!isTokenCount(window)) return base;
    const target = `${base.provider}/${base.model}`;
    if (current.skipFit.some((entry) => entry === target || entry === base.model)) {
      note(current, `fit-skip id=${shortId(agent)} target=${target} reason=compat`);
      return base;
    }
    const configured = depthOf(agent) > 0
      ? (isTokenCount(current.workerOutputCap) ? current.workerOutputCap : current.desiredOutputCap)
      : current.desiredOutputCap;
    const desired = isTokenCount(configured) ? configured : (isTokenCount(info.defaultMaxTokens) ? info.defaultMaxTokens : base.maxTokens);
    if (!isTokenCount(desired)) return base;
    const reading = readingFor(agent, base);
    if (reading === undefined) return base;
    const promptTokens = pressureOf(reading, policy);
    const fitted = fitOutputTokens({ contextWindow: window, promptTokens, desiredOutputCap: desired, policy });
    if (!isTokenCount(fitted) || fitted === base.maxTokens) {
      note(current, `fit id=${shortId(agent)} target=${target} window=${window} prompt=${promptTokens} desired=${desired} cap=${base.maxTokens ?? 'none'} kept`);
      return base;
    }
    note(current, `fit id=${shortId(agent)} target=${target} window=${window} prompt=${promptTokens} desired=${desired} cap=${base.maxTokens ?? 'none'} fitted=${fitted}`);
    return { ...base, maxTokens: fitted };
  }

  /** One forced compaction after a provider-confirmed context overflow. */
  async function recoverOverflow(agent, services, signal) {
    const generation = agent.session.surface.replaceGeneration;
    if (services.pruner !== undefined) prune(services.pruner, agent.session);
    const route = routeOf(agent);
    if (route === undefined) return false;
    const reading = readingFor(agent, route);
    if (reading === undefined) return false;
    const range = await selectSafeRange(agent.session, reading.measurement, 0, serviceOf(ctx, 'sessionQuery'), signal);
    if (range === null) return false;
    await services.engine.compactRegion(range.start, range.end, agent, signal);
    return agent.session.surface.replaceGeneration > generation;
  }

  // The assembled tool table and prompt are not on the session surface yet, so
  // price them explicitly (C needs the real prompt size to fit against).
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next();
    const agent = context?.agent;
    if (agent === undefined) return result;
    if (enginesFor(ctx, agent) === undefined) return result;
    const previous = pending.get(agent) ?? {};
    pending.set(agent, {
      ...previous,
      tools: result.tools,
      prompt: result.sections.map((section) => section.text).join('\n\n'),
    });
    return result;
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent;
    const services = agent === undefined ? undefined : servicesFor(agent);
    if (services !== undefined && payload?.signal?.aborted !== true) {
      try {
        await compactForPressure(agent, services, payload.signal);
      } catch (error) {
        // A budget or compaction failure never terminates the turn.
        note(settings(), `pressure-error id=${shortId(agent)} message=${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const decision = await next();
    if (services !== undefined && decision?.kind === 'enter') {
      pending.set(agent, { ...(pending.get(agent) ?? {}), messages: decision.messages });
    }
    return decision;
  });

  ctx.on('agent/request', async (payload, next) => {
    const base = await next();
    const agent = payload?.agent;
    if (agent === undefined || servicesFor(agent) === undefined) return base;
    try {
      return await fitRequest(agent, base, payload.signal);
    } catch (error) {
      note(settings(), `fit-error id=${shortId(agent)} message=${error instanceof Error ? error.message : String(error)}`);
      return base;
    }
  });

  ctx.on('agent/request-error', async (payload, next) => {
    const agent = payload?.agent;
    const services = agent === undefined ? undefined : servicesFor(agent);
    if (services === undefined || payload?.failure?.code !== CONTEXT_WINDOW_EXCEEDED || payload?.signal?.aborted === true) return next();
    const current = settings();
    if (overflow.attempts(agent) >= current.maxOverflowRetries) {
      note(current, `overflow-exhausted id=${shortId(agent)} attempts=${overflow.attempts(agent)}`);
      return next();
    }
    try {
      const progressed = await recoverOverflow(agent, services, payload.signal);
      if (!progressed || payload.signal?.aborted === true) {
        note(current, `overflow-no-progress id=${shortId(agent)}`);
        return next();
      }
      const attempts = overflow.spend(agent);
      note(current, `overflow-retry id=${shortId(agent)} attempt=${attempts}`);
      return { kind: 'retry' };
    } catch (error) {
      note(current, `overflow-error id=${shortId(agent)} message=${error instanceof Error ? error.message : String(error)}`);
      return next();
    }
  });

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle' && agent !== undefined) overflow.release(agent);
  });

  note(settings(), `boot services=${['llm', 'tokenMeter', 'sessionQuery', 'agentPresets'].map((key) => `${key}:${serviceOf(ctx, key) === undefined ? 'no' : 'yes'}`).join(' ')} engine-name=${ENGINE_SERVICE} pruner-name=${PRUNER_SERVICE} overflow-code=${CONTEXT_WINDOW_EXCEEDED}`);
}
