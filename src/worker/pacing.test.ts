import { describe, expect, test } from "vitest";

import { createConnectionPacer, type PacingRedis } from "./pacing";

const CONNECTION_A = "conn-a";
const CONNECTION_B = "conn-b";

/**
 * ساعة وهمية يتقدّمها الاختبار بنفسه.
 *
 * The clock is a system boundary, so the fake Redis reads its deadlines from
 * here instead of from the wall clock — the gap never elapses on its own.
 */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

/**
 * Redis وهمي ينفّذ `SET … PX … NX` و`PTTL` على ساعة وهمية.
 *
 * Redis is a system boundary, so the fake keeps real TTL bookkeeping: a key
 * lives until its deadline passes, and `SET NX` on a live key is refused.
 */
function fakeRedis(clock: ReturnType<typeof fakeClock>) {
  const deadlines = new Map<string, number>();
  const setCalls: Array<{ key: string; ttlMs: number }> = [];

  const redis: PacingRedis = {
    async set(key, _value, _mode, ttlMs) {
      setCalls.push({ key, ttlMs });
      const deadline = deadlines.get(key);
      if (deadline !== undefined && deadline > clock.now()) return null;
      deadlines.set(key, clock.now() + ttlMs);
      return "OK";
    },
    async pttl(key) {
      const deadline = deadlines.get(key);
      if (deadline === undefined) return -2;
      if (deadline <= clock.now()) {
        deadlines.delete(key);
        return -2;
      }
      return deadline - clock.now();
    },
  };

  return { redis, setCalls };
}

describe("the WhatsApp pacer holds one slot per connection (T057)", () => {
  test("the first send on a connection takes the slot right away", async () => {
    const clock = fakeClock();
    const { redis } = fakeRedis(clock);
    const pacer = createConnectionPacer({ redis, random: () => 0 });

    expect(await pacer.tryAcquire(CONNECTION_A)).toEqual({ acquired: true });
  });

  test("a second send inside the gap is refused and gets the time left", async () => {
    const clock = fakeClock();
    const { redis } = fakeRedis(clock);
    const pacer = createConnectionPacer({ redis, random: () => 0 });

    await pacer.tryAcquire(CONNECTION_A);
    clock.advance(400);

    expect(await pacer.tryAcquire(CONNECTION_A)).toEqual({ acquired: false, retryInMs: 1100 });
  });

  test("another connection is not blocked by the one that holds the slot", async () => {
    // FR-067: the pace belongs to the company connection, so a second
    // connection sends at once while the first one waits out its gap.
    const clock = fakeClock();
    const { redis, setCalls } = fakeRedis(clock);
    const pacer = createConnectionPacer({ redis, random: () => 0 });

    await pacer.tryAcquire(CONNECTION_A);

    expect(await pacer.tryAcquire(CONNECTION_B)).toEqual({ acquired: true });
    expect(setCalls.map((call) => call.key)).toEqual([
      `pace:whatsapp:${CONNECTION_A}`,
      `pace:whatsapp:${CONNECTION_B}`,
    ]);
  });

  test("the connection takes the slot again once the gap has passed", async () => {
    const clock = fakeClock();
    const { redis } = fakeRedis(clock);
    const pacer = createConnectionPacer({ redis, random: () => 0 });

    await pacer.tryAcquire(CONNECTION_A);
    clock.advance(1500);

    expect(await pacer.tryAcquire(CONNECTION_A)).toEqual({ acquired: true });
  });

  test("waitForSlot sleeps the rest of the gap, then takes the slot", async () => {
    const clock = fakeClock();
    const { redis } = fakeRedis(clock);
    const slept: number[] = [];
    const pacer = createConnectionPacer({
      redis,
      random: () => 0,
      sleep: async (ms) => {
        slept.push(ms);
        clock.advance(ms);
      },
    });

    await pacer.tryAcquire(CONNECTION_A);
    clock.advance(300);

    await pacer.waitForSlot(CONNECTION_A);

    expect(slept).toEqual([1200]);
    // The slot is held again by the time waitForSlot returns.
    expect(await pacer.tryAcquire(CONNECTION_A)).toEqual({ acquired: false, retryInMs: 1500 });
  });

  const GAP_CASES = [
    { jitter: 0, expectedTtlMs: 1500 },
    { jitter: 0.999_999, expectedTtlMs: 3000 },
  ];

  test.each(GAP_CASES)(
    "the lock lasts $expectedTtlMs ms when the jitter is $jitter",
    async ({ jitter, expectedTtlMs }) => {
      const clock = fakeClock();
      const { redis, setCalls } = fakeRedis(clock);
      const pacer = createConnectionPacer({ redis, random: () => jitter });

      await pacer.tryAcquire(CONNECTION_A);

      expect(setCalls).toEqual([{ key: `pace:whatsapp:${CONNECTION_A}`, ttlMs: expectedTtlMs }]);
      expect(await pacer.tryAcquire(CONNECTION_A)).toEqual({
        acquired: false,
        retryInMs: expectedTtlMs,
      });
    },
  );
});
