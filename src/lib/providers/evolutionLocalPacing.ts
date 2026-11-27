/**
 * إيقاع إرسال واتساب داخل العملية، لكل اتصال Evolution على حدة.
 *
 * WhatsApp bans numbers that send back-to-back, and Evolution runs one
 * instance per company connection — so the gap belongs to the connection, not
 * to the process (FR-067, research.md R7). The notify worker enforces it
 * across every worker process with a Redis lock; this module is the fallback
 * for the paths that send outside the worker: the notification drain, the
 * manual re-send from the notification log, and the chat composers — the
 * drain is the dangerous one, because it walks a whole backlog.
 *
 * One message takes one slot on the connection: the parts of a message all go
 * to the same recipient, and the burst that gets a number banned is a backlog
 * of messages, not the attachments of one of them.
 *
 * The gap below mirrors the worker's Redis lock (`src/worker/pacing.ts`). The
 * two constants live apart on purpose: the worker owns the lock that holds
 * across processes, and this module owns the in-process one, and a provider
 * module must not depend on the worker.
 */

/** أقل فاصل بين رسالتي واتساب على الاتصال نفسه، بالمللي ثانية. */
const PACING_MIN_MS = 1_500;

/** مقدار العشوائية الزائد على أقل فاصل، بالمللي ثانية. */
const PACING_JITTER_MS = 1_500;

/** حالة إيقاع اتصال واحد داخل هذه العملية. */
interface ConnectionPacing {
  /** لحظة آخر خانة إرسال استُهلكت على هذا الاتصال، أو null قبل أول خانة. */
  lastSlotAt: number | null;
  /** سلسلة الانتظار: كل خانة تُحجز بعد سابقتها. */
  tail: Promise<void>;
}

/** حالة الإيقاع لكل اتصال Evolution داخل هذه العملية. */
const connections = new Map<string, ConnectionPacing>();

/**
 * ينتظر مدّة معطاة.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * يحجز الخانة التالية في الطابور ويشغّل العمل داخلها.
 *
 * The chain is what makes two senders on one connection take turns instead of
 * both measuring the same gap and firing at the same moment. A failed slot
 * does not break the chain: the next sender still gets its turn.
 */
function enqueueSlot(state: ConnectionPacing, work: () => Promise<void>): Promise<void> {
  const run = state.tail.then(work);
  state.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * يحجز خانة الإرسال على اتصال: ينتظر الفاصل عن آخر خانة ثم يسجّل الحجز.
 *
 * The gap is measured from the moment the previous slot was taken, not from
 * the moment its send finished: the slot is the moment the message goes out,
 * so this is the interval between two messages on the number.
 */
async function takeSlot(connectionKey: string): Promise<void> {
  const state = connections.get(connectionKey) ?? { lastSlotAt: null, tail: Promise.resolve() };
  connections.set(connectionKey, state);

  await enqueueSlot(state, async () => {
    const gap = PACING_MIN_MS + Math.random() * PACING_JITTER_MS;
    if (state.lastSlotAt !== null) {
      const elapsed = Date.now() - state.lastSlotAt;
      if (elapsed < gap) await sleep(gap - elapsed);
    }
    state.lastSlotAt = Date.now();
  });
}

/**
 * ينشئ منظّم إيقاع محلي لاتصال واتساب: خانة إرسال واحدة لكل رسالة.
 *
 * The returned function is the provider's `pace` hook, and the provider calls
 * it before every part of a message: the first call waits for the
 * connection's slot and the later ones resolve at once, so one message costs
 * one slot and its parts do not each cost a gap.
 */
export function evolutionLocalPacer(connectionKey: string): () => Promise<void> {
  let slot: Promise<void> | null = null;
  return () => {
    slot ??= takeSlot(connectionKey);
    return slot;
  };
}

/**
 * يعيد ضبط ساعة الإيقاع — للاختبارات فقط.
 */
export function resetEvolutionLocalPacing(): void {
  connections.clear();
}
