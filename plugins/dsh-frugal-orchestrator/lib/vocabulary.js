/**
 * Session-event vocabulary registration for this bundle's own log record.
 *
 * `frugal/state` is not part of the harness's generated event vocabulary
 * (`KNOWN_SESSION_EVENT_TYPES` in `@deepseek-ai/dsh-session`), and
 * `Session.append()` on 0.2.x offers no way to mark an event `ignorable`. The
 * persistence read path therefore REFUSES to interpret any log that carries
 * such a record: `validateStoredEvents` throws
 * `contains event type "frugal/state" … unknown to this harness and not marked
 * ignorable`, which surfaced as `HTTP 500` from `/api/session.export` and
 * would equally break a cold resume of the same session.
 *
 * The harness documents the `ignorable` envelope marker as the mechanism for
 * out-of-repo plugin events and explicitly rejects name registration as
 * composition-dependent. That marker is unreachable from `append()` on this
 * host version, so this module owns the gap: it declares the one type this
 * bundle writes, on the host's own exported set, once, at plugin load.
 *
 * Declaring it (rather than skipping the write) keeps the log faithful: the
 * ledger is still part of the session's durable history, the `frugal` session
 * projection still folds it, and a reader that does have this plugin loaded
 * reconstructs the mode and the admission ledger exactly.
 *
 * The registration is idempotent and fail-open: when the host package cannot be
 * resolved, the plugin still runs — only cold reads and export of sessions that
 * carry the record are affected, which is exactly the behaviour this fixes.
 *
 * @module @nu11dev/dsh-frugal-orchestrator/lib/vocabulary
 */

import { FRUGAL_EVENT } from './telemetry.js';
import { describeThrown, requireFromBases } from './resolve.js';

const SESSION_PACKAGE = '@deepseek-ai/dsh-session';

/**
 * Declare this bundle's session event types on the host's vocabulary.
 *
 * @returns `{ ok: true }` once every type is declared, or `{ ok: false, code,
 *   message }` describing why the declaration did not happen. Never throws:
 *   a deployment that cannot reach the host package keeps working.
 */
export function declareEventVocabulary() {
  const loaded = requireFromBases(SESSION_PACKAGE);
  if (!loaded.ok) return { ok: false, code: 'VOCABULARY-UNAVAILABLE', message: `${SESSION_PACKAGE} could not be resolved: ${describeThrown(new Error(loaded.tried.join('; ')))}` };
  const vocabulary = loaded.module?.KNOWN_SESSION_EVENT_TYPES;
  if (!(vocabulary instanceof Set)) return { ok: false, code: 'VOCABULARY-UNAVAILABLE', message: `${SESSION_PACKAGE} exports no KNOWN_SESSION_EVENT_TYPES set` };
  if (!vocabulary.has(FRUGAL_EVENT)) vocabulary.add(FRUGAL_EVENT);
  return { ok: true };
}
