/**
 * Pure budget and compaction policy math.
 *
 * NO host imports: every function here is a total function of its arguments, so
 * the whole decision surface is testable without cordis, a session, or a model.
 * The host half (`../index.js`) owns the wiring; this module owns the numbers.
 *
 * The design follows pi / oh-my-pi (see the plan §2):
 *
 *   - `reserveTokens` is INDEPENDENT of the per-request output cap. A summarizer
 *     needs room; the model's advertised output capability does not. Coupling the
 *     two is what made a 256000/256000 model entry leave 23232 usable tokens.
 *   - `thresholdTokens = clamp(window - reserve, 1, window - 1)`, with an optional
 *     absolute (`thresholdTokens`) or percent (`thresholdPercent`, e.g. "80%")
 *     override — the ompi `compaction.threshold*` pair.
 *   - the per-request output cap is a WISH: `fitOutputTokens` narrows it to what
 *     actually fits (`window - prompt - headroom`) only when it would not.
 *
 * @module @nu11dev/dsh-compaction-policy/lib/policy
 */

/** Fallback policy; every field mirrors the Config schema defaults. */
export const POLICY_DEFAULTS = Object.freeze({
  /** Reserve as a fraction of the window (ompi `effectiveReserveTokens`). */
  reserveRatio: 0.15,
  /** Floor of that reserve, in tokens (pi/ompi's fixed 16384). */
  reserveFloorTokens: 16384,
  /** Recent tail kept verbatim across one compaction (pi/ompi keepRecentTokens). */
  keepRecentTokens: 20000,
  /** Safety gap under the window when fitting an output cap (ompi: 64). */
  fitHeadroomTokens: 64,
  /** Floors the fitted cap so a request is still dispatchable (ompi: 1024). */
  minFittedOutputTokens: 1024,
  /** Local-estimate inflation denominator when no provider usage anchor exists. */
  estimateMarginDivisor: 10,
  /** Summary attempts allowed for one pressure event. */
  compactionRetries: 2,
  /** Overflow recoveries allowed per agent before the original error is kept. */
  maxOverflowRetries: 1,
});

/** Whether a value can be used as a positive token count. */
export function isTokenCount(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/** One policy value, falling back to {@link POLICY_DEFAULTS} when unusable. */
function pick(policy, key, predicate) {
  const value = policy === undefined || policy === null ? undefined : policy[key];
  return predicate(value) ? value : POLICY_DEFAULTS[key];
}

/**
 * Reserve the summarizer needs below the window.
 * @param contextWindow - the routed model's context capacity.
 * @param policy - policy overrides.
 * @returns `max(floor(ratio * window), floorTokens)`, or undefined without a window.
 */
export function resolveReserveTokens(contextWindow, policy) {
  if (!isTokenCount(contextWindow)) return undefined;
  const ratio = pick(policy, "reserveRatio", (value) => Number.isFinite(value) && value > 0 && value < 1);
  const floor = pick(policy, "reserveFloorTokens", (value) => Number.isSafeInteger(value) && value >= 0);
  return Math.max(Math.floor(contextWindow * ratio), floor);
}

/**
 * Parse an ABSOLUTE override: `90000`, `"90000"`, `""`, `-1`.
 * @param value - the configured override.
 * @returns an absolute token count, or undefined for "no override".
 */
export function parseThresholdOverride(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  const text = String(value).trim();
  if (text.length === 0 || text === "-1") return undefined;
  const absolute = Number(text);
  return Number.isFinite(absolute) && absolute > 0 ? Math.floor(absolute) : undefined;
}

/**
 * Parse a PERCENT override: `80`, `"80"`, `"80%"`.
 *
 * Kept separate from {@link parseThresholdOverride} because the Config exposes
 * both fields, exactly like ompi's `thresholdPercent` / `thresholdTokens` pair:
 * a bare `80` in the percent field means 80%, never 80 tokens.
 * @param value - the configured percent.
 * @param contextWindow - window the percent is resolved against.
 * @returns an absolute token count, or undefined for "no override".
 */
export function parsePercentOverride(value, contextWindow) {
  if (!isTokenCount(contextWindow)) return undefined;
  if (value === undefined || value === null) return undefined;
  const raw = typeof value === "number" ? value : Number(String(value).trim().replace(/%$/, ""));
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.floor((contextWindow * Math.min(raw, 100)) / 100);
}

/** Clamp a threshold into `[1, window - 1]` so it can never equal the window. */
export function clampThreshold(tokens, contextWindow) {
  if (!isTokenCount(contextWindow)) return undefined;
  return Math.min(Math.max(Math.floor(tokens), 1), contextWindow - 1);
}

/**
 * Resolve the pressure threshold for one routed target.
 * @param input.contextWindow - routed model capacity.
 * @param input.reserveTokens - resolved reserve (defaults to {@link resolveReserveTokens}).
 * @param input.thresholdTokens - absolute override (positive integer).
 * @param input.thresholdPercent - percent override ("80%" or 80).
 * @param input.policy - policy overrides.
 * @returns the clamped threshold, or undefined without a window.
 */
export function resolveThresholdTokens(input) {
  const { contextWindow, policy } = input;
  if (!isTokenCount(contextWindow)) return undefined;
  const explicit = isTokenCount(input.thresholdTokens)
    ? input.thresholdTokens
    : parsePercentOverride(input.thresholdPercent, contextWindow);
  if (isTokenCount(explicit)) return clampThreshold(explicit, contextWindow);
  const reserve = isTokenCount(input.reserveTokens) ? input.reserveTokens : resolveReserveTokens(contextWindow, policy);
  return clampThreshold(contextWindow - reserve, contextWindow);
}

/**
 * Tokens retained verbatim at the tail after one compaction.
 * @param input.thresholdTokens - the effective pressure threshold.
 * @param input.keepRecentTokens - configured tail budget.
 * @returns `clamp(keepRecentTokens, 0, threshold - 1)`, so a compaction can
 *   always remove something.
 */
export function resolveRetentionTokens(input) {
  const threshold = input.thresholdTokens;
  if (!isTokenCount(threshold)) return 0;
  const configured = Number.isSafeInteger(input.keepRecentTokens) && input.keepRecentTokens >= 0
    ? input.keepRecentTokens
    : POLICY_DEFAULTS.keepRecentTokens;
  return Math.max(0, Math.min(configured, threshold - 1));
}

/**
 * Inflate a local estimate when the provider gave no usage anchor.
 * @param input.totalTokens - the meter's replay-priced total.
 * @param input.extraTokens - incoming messages plus the assembled prompt.
 * @param input.anchored - true when the meter's baseline is real provider usage.
 * @param input.policy - policy overrides.
 * @returns the conservatively priced prompt size.
 */
export function estimatePromptTokens(input) {
  const total = Number.isFinite(input.totalTokens) ? input.totalTokens : 0;
  const extra = Number.isFinite(input.extraTokens) ? input.extraTokens : 0;
  const base = Math.max(0, total + extra);
  if (input.anchored === true) return base;
  const divisor = pick(input.policy, "estimateMarginDivisor", (value) => Number.isSafeInteger(value) && value > 0);
  return Math.ceil(base + base / divisor);
}

/**
 * Narrow a requested output cap to what still fits under the window.
 *
 * `room = window - prompt - headroom`; the result is
 * `min(desired, max(minFitted, room))`. Only a cap that would not fit is
 * narrowed — the model keeps its advertised output capability otherwise.
 * @param input.contextWindow - routed model capacity.
 * @param input.promptTokens - priced prompt (see {@link estimatePromptTokens}).
 * @param input.desiredOutputCap - the cap the request asked for.
 * @param input.policy - policy overrides.
 * @returns the fitted cap, or undefined when no window/cap is known.
 */
export function fitOutputTokens(input) {
  const { contextWindow, desiredOutputCap } = input;
  if (!isTokenCount(contextWindow) || !isTokenCount(desiredOutputCap)) return undefined;
  const headroom = pick(input.policy, "fitHeadroomTokens", (value) => Number.isSafeInteger(value) && value >= 0);
  const floor = pick(input.policy, "minFittedOutputTokens", (value) => isTokenCount(value));
  const prompt = Number.isFinite(input.promptTokens) ? Math.max(0, input.promptTokens) : 0;
  const room = contextWindow - prompt - headroom;
  return Math.min(desiredOutputCap, Math.max(floor, room));
}

/**
 * Read one agent's threshold override (ompi `agentCompactionThresholdOverrides`).
 * @param overrides - map from agent id to `90000` | `"80%"`.
 * @param agentId - the agent to look up.
 * @returns the raw override, or undefined.
 */
export function overrideForAgent(overrides, agentId) {
  if (overrides === null || typeof overrides !== "object" || typeof agentId !== "string") return undefined;
  const value = overrides[agentId];
  return value === undefined ? undefined : value;
}

/** Whether the pressure reading crossed the threshold. */
export function exceedsThreshold(pressureTokens, thresholdTokens) {
  return Number.isFinite(pressureTokens) && isTokenCount(thresholdTokens) && pressureTokens >= thresholdTokens;
}
