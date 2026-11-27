import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { evolutionLocalPacer, resetEvolutionLocalPacing } from "./evolutionLocalPacing";

/**
 * اختبارات منظّم الإيقاع المحلي: الساعة وهمية، لأن الفاصل بين الإرسالات وقت
 * حقيقي في الإنتاج وليس في الاختبار.
 */
describe("the local Evolution pacing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEvolutionLocalPacing();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetEvolutionLocalPacing();
  });

  it("does not hold back the first send on a connection", async () => {
    const send = evolutionLocalPacer("inst-a");
    const startedAt = Date.now();

    const first = send();
    await vi.advanceTimersByTimeAsync(0);
    await first;

    expect(Date.now()).toBe(startedAt);
  });

  it("spaces two sends on the same instance by at least the minimum gap", async () => {
    // A backlog sent back-to-back is exactly what gets a WhatsApp number
    // banned, so the second message on a connection must wait the gap.
    const first = evolutionLocalPacer("inst-a");
    const second = evolutionLocalPacer("inst-a");

    const firstSend = first();
    await vi.advanceTimersByTimeAsync(0);
    await firstSend;

    const secondSend = second();
    let sent = false;
    void secondSend.then(() => {
      sent = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_499);
    expect(sent).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await secondSend;
    expect(sent).toBe(true);
  });

  it("does not serialise two different instances", async () => {
    // Two companies have two connections and two numbers, so one company's
    // backlog must not hold back the other company's message.
    const one = evolutionLocalPacer("inst-a");
    const other = evolutionLocalPacer("inst-b");

    await one();
    await vi.advanceTimersByTimeAsync(0);

    const startedAt = Date.now();
    await other();

    expect(Date.now() - startedAt).toBe(0);
  });

  it("gives the parts of one message a single slot", async () => {
    // The parts of a message all go to the same recipient; the gap exists to
    // space messages, so the second part must not pay for another slot.
    const send = evolutionLocalPacer("inst-a");

    const first = send();
    await vi.advanceTimersByTimeAsync(0);
    await first;

    const startedAt = Date.now();
    const second = send();
    await vi.advanceTimersByTimeAsync(0);
    await second;

    expect(Date.now()).toBe(startedAt);
  });

  it("resets the connection clock so a test does not inherit the previous wait", async () => {
    const first = evolutionLocalPacer("inst-a");
    await first();
    await vi.advanceTimersByTimeAsync(0);

    resetEvolutionLocalPacing();

    const afterReset = evolutionLocalPacer("inst-a");
    const startedAt = Date.now();
    const send = afterReset();
    await vi.advanceTimersByTimeAsync(0);
    await send;

    expect(Date.now()).toBe(startedAt);
  });
});
