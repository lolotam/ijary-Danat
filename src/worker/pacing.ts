/**
 * إيقاع الإرسال لكل اتصال واتساب: قفل Redis بمهلة تساوي فاصل الإرسال.
 *
 * WhatsApp bans numbers that send back-to-back, and Evolution runs one
 * instance per company connection — so the gap belongs to the connection, not
 * to the process (FR-067, research.md R7). The lock lives in Redis because the
 * rule has to hold across every worker process, not only inside one.
 */

/** أقل فاصل بين إرسالي واتساب على الاتصال نفسه، بالمللي ثانية. */
const PACING_MIN_MS = 1_500;

/** مقدار العشوائية الزائد على أقل فاصل، بالمللي ثانية. */
const PACING_JITTER_MS = 1_500;

/**
 * السطح الأدنى من Redis الذي يستخدمه منظّم الإيقاع: قفل بمهلة، وقراءة ما
 * تبقّى من مدته.
 *
 * `Redis` from ioredis satisfies this shape, so the worker hands over its own
 * connection unchanged; the test fake implements these two commands only.
 */
export interface PacingRedis {
  set(key: string, value: string, mode: "PX", ttlMs: number, condition: "NX"): Promise<"OK" | null>;
  pttl(key: string): Promise<number>;
}

/** الاعتماديات التي يحتاجها منظّم الإيقاع: Redis وساعتان قابلتان للحقن. */
export interface ConnectionPacerDependencies {
  redis: PacingRedis;
  /** مصدر العشوائية في الفاصل — يُحقن في الاختبار لتثبيت الفاصل. */
  random?: () => number;
  /** الانتظار بين المحاولات — يُحقن في الاختبار حتى لا يمرّ وقت حقيقي. */
  sleep?: (ms: number) => Promise<void>;
}

/** نتيجة محاولة واحدة للحصول على خانة الإرسال. */
export type PaceAttempt = { acquired: true } | { acquired: false; retryInMs: number };

/** منظّم إيقاع لاتصال واتساب واحد. */
export interface ConnectionPacer {
  /** يحاول حجز خانة الإرسال لهذا الاتصال دون انتظار. */
  tryAcquire(connectionId: string): Promise<PaceAttempt>;
  /** ينتظر حتى تتحقّر الخانة ثم يحجزها. */
  waitForSlot(connectionId: string): Promise<void>;
}

/**
 * ينتظر مدّة معطاة — الافتراضي حين لا يُحقن نوم مزيّف.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * يبني مفتاح قفل الإيقاع لاتصال معيّن.
 *
 * The prefix keeps the key clear of every other Redis use in the worker, and
 * the connection id keeps the pace per company connection (FR-067).
 */
function paceKey(connectionId: string): string {
  return `pace:whatsapp:${connectionId}`;
}

/**
 * يبني منظّم إيقاع يحجز خانة الإرسال بقفل Redis على كل اتصال.
 *
 * The lock is taken with `SET … PX … NX`, so the winner of the race gets the
 * slot and every other sender is told how long to wait — the shape the notify
 * worker needs before it sends (contracts/jobs.md section 4).
 */
export function createConnectionPacer(deps: ConnectionPacerDependencies): ConnectionPacer {
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? defaultSleep;

  const tryAcquire = async (connectionId: string): Promise<PaceAttempt> => {
    const gap = PACING_MIN_MS + random() * PACING_JITTER_MS;
    const key = paceKey(connectionId);
    // Redis counts whole milliseconds, and rounding down would shorten the gap.
    const acquired = await deps.redis.set(key, "1", "PX", Math.ceil(gap), "NX");
    if (acquired === "OK") return { acquired: true };

    const remaining = await deps.redis.pttl(key);
    // A negative PTTL means the key expired between the refused SET and this
    // read: the slot is free right now, so the caller retries immediately
    // instead of waiting for a time that no longer exists.
    return { acquired: false, retryInMs: remaining > 0 ? remaining : 0 };
  };

  const waitForSlot = async (connectionId: string): Promise<void> => {
    for (;;) {
      const attempt = await tryAcquire(connectionId);
      if (attempt.acquired) return;
      await sleep(attempt.retryInMs);
    }
  };

  return { tryAcquire, waitForSlot };
}
