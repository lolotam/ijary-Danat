import { vi } from "vitest";

/**
 * يحاكي مزوّداً قبل الاتصال ثم توقّف عن الرد، ويعيد دالة تُطلق انتهاء المهلة يدوياً.
 *
 * `AbortSignal.timeout` runs on Node's internal timers, which Vitest's fake
 * timers do not drive, so waiting out the real 20s is the only other option.
 * Instead this hands the provider a signal the test fires itself: `fetch`
 * never settles unless that signal aborts, exactly like a hung socket. A
 * provider that forgot to pass `signal` would hang the test, not pass it.
 */
export function stubHungFetch(): {
  fireTimeout: () => void;
  timeoutSpy: ReturnType<typeof vi.spyOn>;
} {
  const controller = new AbortController();
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  vi.mocked(globalThis.fetch).mockImplementation(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
  );
  return {
    fireTimeout: () => controller.abort(new DOMException("timed out", "TimeoutError")),
    timeoutSpy,
  };
}
