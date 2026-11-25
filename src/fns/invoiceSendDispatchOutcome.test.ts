import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@tanstack/react-start", async () =>
  (await import("./dispatchNotification.testkit")).tanstackStartModule(),
);
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", async () =>
  (await import("./dispatchNotification.testkit")).supabaseAdminModule(),
);

import { dispatchNotificationRecord } from "./dispatchNotification";
import { CLOUD, db, notification, resetDispatchFixtures } from "./dispatchNotification.testkit";
import { invoiceSendRowBucket, invoiceSendToast } from "@/lib/invoiceSendOutcome";
import type { InvoiceSendOutcome } from "@/lib/invoiceSendOutcome";

beforeEach(() => {
  resetDispatchFixtures();
  db.notification = notification({
    channel: "whatsapp",
    type: "invoice",
    template_code: "invoice-document",
    recipient_address: "+96550000000",
  });
  db.providers = [CLOUD];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** يعرض حصيلة الصف الذي أعاده المرسل الحقيقي حتى لا يخفي موك داخلي رفض المزوّد. */
async function dispatchedInvoiceFeedback() {
  const row = await dispatchNotificationRecord("n-1");
  const outcome: InvoiceSendOutcome = { sent: [], queued: [], failed: [], refused: [] };
  outcome[invoiceSendRowBucket(row.state)].push(row.id);
  return { state: row.state, feedback: invoiceSendToast(outcome) };
}

describe("invoice feedback follows real dispatch outcomes (PR #214)", () => {
  test("missing provider mapping returns a failed row and error feedback", async () => {
    db.template = null;

    expect(await dispatchedInvoiceFeedback()).toEqual({
      state: "failed",
      feedback: { kind: "error", key: "invoices.sendFailed" },
    });
  });

  test("a provider rejection is reported as failed despite the existing row id", async () => {
    db.template = { provider_template_name: "invoice_ar", provider_param_keys: [] };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Template rejected" } }), { status: 400 }),
    );

    expect(await dispatchedInvoiceFeedback()).toEqual({
      state: "failed",
      feedback: { kind: "error", key: "invoices.sendFailed" },
    });
  });

  test("provider acceptance returns sent feedback", async () => {
    db.template = { provider_template_name: "invoice_ar", provider_param_keys: [] };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.accepted" }] }), { status: 200 }),
    );

    expect(await dispatchedInvoiceFeedback()).toEqual({
      state: "sent",
      feedback: { kind: "success", key: "invoices.sent" },
    });
  });
});
