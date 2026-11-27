import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", async () =>
  (await import("@/fns/dispatchNotification.testkit")).tanstackStartModule(),
);
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));
vi.mock("@/company/requestCompany.server", async () =>
  (await import("@/fns/dispatchNotification.testkit")).requestCompanyModule(),
);
vi.mock("@/company/companyClient.server", async () =>
  (await import("@/fns/dispatchNotification.testkit")).companyClientModule(),
);
vi.mock("@/fns/evolutionSessionWatch", () => ({
  reportSendSessionDisconnected: vi.fn(),
}));

import {
  db,
  EVOLUTION,
  MAPPING,
  notification,
  requestedUrls,
  resetDispatchFixtures,
  RESEND,
  restoreDispatchFixtures,
  TEST_COMPANY,
} from "@/fns/dispatchNotification.testkit";
import { createNotificationDispatchHandler } from "@/jobs/handlers/notification";

/** The catalogue schema only accepts a uuid, and the row id is what it carries. */
const NOTIFICATION_ID = "11111111-1111-4111-8111-111111111111";

/** ما يرسله العامل إلى المعالج: الحمولة محقّقة مسبقاً بمخطط الكتالوج. */
function jobContext() {
  return {
    jobRequestId: "11111111-1111-4111-8111-111111111112",
    companyId: TEST_COMPANY.id,
    payload: { notificationId: NOTIFICATION_ID },
    attempt: 1,
  };
}

describe("the notification dispatch handler (T067)", () => {
  beforeEach(() => {
    resetDispatchFixtures();
    db.notification = notification({ id: NOTIFICATION_ID });
  });
  afterEach(restoreDispatchFixtures);

  it("sends the queued row and returns the state it ended in", async () => {
    db.providers = [RESEND];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-1" }), { status: 200 }),
    );
    const pace = vi.fn().mockResolvedValue(undefined);

    const result = await createNotificationDispatchHandler({ pace })(jobContext());

    expect(requestedUrls()).toEqual(["https://api.resend.com/emails"]);
    expect(result).toEqual({ notificationId: NOTIFICATION_ID, state: "sent" });
    // Pacing is a WhatsApp rule, so an email leg never waits for a slot.
    expect(pace).not.toHaveBeenCalled();
  });

  it("waits for the connection slot before a WhatsApp send", async () => {
    db.notification = notification({ id: NOTIFICATION_ID, channel: "whatsapp", subject: null });
    db.providers = [EVOLUTION];
    db.template = { ...MAPPING, provider_template_name: null };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ key: { id: "evo-1" } }), { status: 201 }),
    );
    const pace = vi.fn().mockResolvedValue(undefined);

    const result = await createNotificationDispatchHandler({ pace })(jobContext());

    // The connection key is the Evolution instance, one per company connection.
    expect(pace).toHaveBeenCalledWith("danat");
    expect(pace.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(globalThis.fetch).mock.invocationCallOrder[0],
    );
    expect(requestedUrls()).toEqual(["http://evolution:8080/message/sendText/danat"]);
    expect(result).toEqual({ notificationId: NOTIFICATION_ID, state: "sent" });
  });

  it("does not send a row that is already sent", async () => {
    // The relay republishes a row whose publish was older than five minutes,
    // and BullMQ may hand the same job over twice. A sent row stays sent and
    // the tenant is not messaged again.
    db.notification = notification({ id: NOTIFICATION_ID, state: "sent" });
    db.providers = [RESEND];

    const result = await createNotificationDispatchHandler({
      pace: vi.fn().mockResolvedValue(undefined),
    })(jobContext());

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result).toEqual({ notificationId: NOTIFICATION_ID, state: "sent" });
  });
});
