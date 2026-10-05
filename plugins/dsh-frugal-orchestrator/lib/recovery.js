/** A terminal turn counts only after native consumed-work accounting and receipt matching. */
import { requireFromBases, importFromBases } from './resolve.js';
const loaded = requireFromBases('@deepseek-ai/dsh-agent');
const native = loaded.ok ? loaded.module : await importFromBases('@deepseek-ai/dsh-agent');

export function terminalReceipt(events, inheritedEventCount, receipts = []) {
  if (typeof native?.foldConsumedWork !== 'function') return null;
  const own = events.slice(inheritedEventCount);
  const { end, droppedUnrun } = native.foldConsumedWork(own);
  if (!end || droppedUnrun) return null;
  const inbox = { 'next-turn': [], 'next-step': [] };
  const inputs = [];
  let open = false;
  for (const event of own) {
    if (event.type === 'turn/start') open = true;
    if (event.type === 'turn/end') open = false;
    if (event.type === 'user/message') inputs.push({ message: event.data, seq: event.seq });
    if (event.type === 'agent/inbox/spliced') {
      const { target, start, removedCount = 0, inserted = [] } = event.data;
      if (!inbox[target] || !Number.isSafeInteger(start)) return null;
      inbox[target].splice(start, removedCount, ...inserted);
      for (const message of inserted) inputs.push({ message, seq: event.seq });
    }
  }
  if (open || Object.values(inbox).some((messages) => messages.length)) return null;
  const lastInput = inputs.at(-1);
  if (!lastInput || lastInput.seq > end.seq) return null;
  for (const receipt of receipts) {
    if (receipt.status === 'queued') return null;
    if (!receipt.id) continue; // native Team creation: own initial input is the receipt
    if (!inputs.some(({ message, seq }) => seq <= end.seq && (message.id === receipt.id || message.source?.messageId === receipt.id))) return null;
  }
  return { stopReason: end.data.reason?.kind ?? 'unknown', seq: end.seq };
}
