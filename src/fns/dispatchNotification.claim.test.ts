import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * اختبار حجز إعادة المحاولة (GR-010): محاولتان متزامنتان على صف فاشل واحد
 * تُرسِلان الرسالة مرة واحدة بالضبط.
 *
 * Only the boundaries are faked — the database and the provider's HTTP call.
 * `retryFailedNotificationRecord` and the dispatcher run for real, so "exactly
 * one dispatch" is observed as exactly one outbound provider request, not as a
 * mock's call count. The fake database applies the claim's conditional update
 * the way Postgres does: the first update that matches wins the row and the
 * second matches nothing.
 */
vi.mock("@tanstack/react-start", async () =>
  (await import("@/fns/dispatchNotification.testkit")).tanstackStartModule(),
);
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));
vi.mock("@/fns/evolutionSessionWatch", () => ({ reportSendSessionDisconnected: vi.fn() }));
vi.mock("@/company/companyClient.server", async () =>
  (await import("@/jobs/handlers/idempotency.testkit")).companyClientModule(),
);
vi.mock("@/company/requestCompany.server", async () =>
  (await import("@/jobs/handlers/idempotency.testkit")).requestCompanyModule(),
);

import { resetDispatchFixtures, restoreDispatchFixtures } from "@/fns/dispatchNotification.testkit";
import {
  COMPANY_ID,
  NOTIFICATION_ID,
  resetDatabase,
  rowsOf,
  seedNotification,
} from "@/jobs/handlers/idempotency.testkit";

import { retryFailedNotificationRecord } from "./dispatchNotification";

/**
 * رد المزوّد الذي قبِل الرسالة.
 *
 * A factory, not a value: a `Response` body can be read once, so handing the
 * same instance to a second send would fail on the read instead of on the
 * provider.
 */
function acceptedByProvider(): Response {
  return new Response(JSON.stringify({ id: "resend-1" }), { status: 200 });
}

/** يزرع صف إشعار فاشل: ما تقرأه مسحا الإشعارات قبل إعادة المحاولة. */
function seedFailedNotification(): void {
  seedNotification({
    state: "failed",
    retry_count: 2,
    error_code: "provider_down",
    failure_reason: "The provider refused the message.",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDispatchFixtures();
  resetDatabase();
});
afterEach(restoreDispatchFixtures);

describe("retryFailedNotificationRecord claims before it dispatches (GR-010)", () => {
  test("two concurrent claims of one failed row dispatch it exactly once", async () => {
    seedFailedNotification();
    const provider = vi.mocked(globalThis.fetch);
    provider.mockImplementation(async () => acceptedByProvider());

    // المحاولتان قرأتا الصف فاشلاً بعدد محاولتين 2 — الحجز الشرطي هو ما يفرز
    // الفائز، لا ترتيب النداء.
    const [first, second] = await Promise.all([
      retryFailedNotificationRecord(NOTIFICATION_ID, 2, COMPANY_ID),
      retryFailedNotificationRecord(NOTIFICATION_ID, 2, COMPANY_ID),
    ]);

    // واحد فقط يحصل على الصف ويرسل؛ الآخر لا ينال شيئاً ولا يُصرِّف.
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(rowsOf("notifications")[0]).toMatchObject({ state: "sent" });
  });

  test.each([
    {
      expectation: "its retry_count moved under the caller",
      seed: () => seedFailedNotification(),
      seenRetryCount: 1,
      expected: { state: "failed", retry_count: 2 },
    },
    {
      expectation: "it was already delivered",
      seed: () => seedNotification({ state: "sent", retry_count: 2 }),
      seenRetryCount: 2,
      expected: { state: "sent", retry_count: 2 },
    },
    {
      expectation: "another sender claimed it and is dispatching",
      seed: () => seedNotification({ state: "queued", retry_count: 2 }),
      seenRetryCount: 2,
      expected: { state: "queued", retry_count: 2 },
    },
  ])("a row is left alone when $expectation", async ({ seed, seenRetryCount, expected }) => {
    // ما قرأه هذا المتصل لم يعد هو الصف: الحجز يرفضه، فلا إرسال ولا تغيير.
    seed();

    const result = await retryFailedNotificationRecord(NOTIFICATION_ID, seenRetryCount, COMPANY_ID);

    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(rowsOf("notifications")[0]).toMatchObject(expected);
  });

  test("the claim clears the parked partner code before the new attempt", async () => {
    // سبب الفشل وشفرة الشريك لا يحكمان المحاولة الجديدة: زر إعادة المحاولة
    // يمسحهما، والحجز يفعل ذلك قبل الإرسال لا بعده.
    seedFailedNotification();
    const provider = vi.mocked(globalThis.fetch);
    provider.mockImplementation(async () => acceptedByProvider());

    const result = await retryFailedNotificationRecord(NOTIFICATION_ID, 2, COMPANY_ID);

    expect(result).toMatchObject({ state: "sent" });
    expect(rowsOf("notifications")[0]).toMatchObject({
      error_code: null,
      failure_reason: null,
    });
  });
});
