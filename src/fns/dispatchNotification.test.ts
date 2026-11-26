import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", async () =>
  (await import("./dispatchNotification.testkit")).tanstackStartModule(),
);
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));
vi.mock("@/company/requestCompany.server", async () =>
  (await import("./dispatchNotification.testkit")).requestCompanyModule(),
);
vi.mock("@/company/companyClient.server", async () =>
  (await import("./dispatchNotification.testkit")).companyClientModule(),
);

import { stubHungFetch } from "@/lib/providers/hungProvider.fixture";
import { DELIVERY_INDETERMINATE } from "@/lib/providers/types";

import { dispatchNotificationRecord } from "./dispatchNotification";
import {
  CLOUD,
  db,
  MAPPING,
  notification,
  POSTORA,
  requestedUrls,
  RESEND,
  resetDispatchFixtures,
  restoreDispatchFixtures,
  SMTP,
  TWILIO,
} from "./dispatchNotification.testkit";

/** Email, Meta Cloud API, Twilio and Postora. Evolution has its own file. */
describe("dispatchNotificationRecord", () => {
  beforeEach(resetDispatchFixtures);
  afterEach(restoreDispatchFixtures);

  it("sends email through Resend when Resend is the enabled email provider", async () => {
    db.providers = [RESEND];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-1" }), { status: 200 }),
    );

    const result = await dispatchNotificationRecord("n-1");

    expect(requestedUrls()).toEqual(["https://api.resend.com/emails"]);
    expect(result.state).toBe("sent");
    expect(result.provider).toBe("resend");
    expect(result.provider_message_id).toBe("resend-1");
  });

  it("sends the notification row id to Resend as the idempotency key", async () => {
    // The drain retries the same row, so a send that timed out after Resend
    // accepted it reaches Resend again with the same key and is not re-sent.
    db.providers = [RESEND];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-key" }), { status: 200 }),
    );

    await dispatchNotificationRecord("n-1");

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(
      /^n-1\/[0-9a-f]{32}$/,
    );
  });

  it("splits a comma-joined recipient_address so every mailbox is a To: entry", async () => {
    // Scheduled reports store every recipient in the single text column.
    // Treating that string as one address hid everyone after the first from
    // uniqueRecipients and from the provider.
    db.notification = notification({
      audience: "admin",
      recipient_address: "ops@example.com, finance@example.com",
      payload: { recipients: ["ops@example.com", "finance@example.com"] },
      tenant_id: null,
    });
    db.tenant = null;
    db.providers = [RESEND];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-split" }), { status: 200 }),
    );

    await dispatchNotificationRecord("n-1");

    const body = JSON.parse(
      String((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body),
    );
    expect(body.to).toEqual(["ops@example.com", "finance@example.com"]);
  });

  it("sends through Resend when both are enabled and neither is marked primary", async () => {
    // Both on is legitimate since migration 225 (default + fallback); with no
    // `is_primary` row the pre-225 preference still decides the sender.
    db.providers = [SMTP, RESEND];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-2" }), { status: 200 }),
    );

    const result = await dispatchNotificationRecord("n-1");

    expect(requestedUrls()).toEqual(["https://api.resend.com/emails"]);
    expect(result.provider).toBe("resend");
  });

  it("sends WhatsApp through the Cloud API using the recorded template mapping", async () => {
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.providers = [CLOUD];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }),
    );

    const result = await dispatchNotificationRecord("n-1");

    expect(requestedUrls()).toEqual(["https://graph.facebook.com/v23.0/999/messages"]);
    const body = JSON.parse(
      String((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body),
    );
    expect(body.template.name).toBe("danat_receipt_ar");
    expect(body.template.components[0].parameters).toEqual([{ type: "text", text: "أحمد" }]);
    expect(result.provider).toBe("whatsapp_cloud_api");
  });

  it("sends through Twilio with the Content SID when Twilio is the enabled provider", async () => {
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.providers = [TWILIO];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ sid: "SM1" }), { status: 201 }),
    );

    const result = await dispatchNotificationRecord("n-1");

    expect(requestedUrls()).toEqual([
      "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json",
    ]);
    const params = new URLSearchParams(
      String((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body),
    );
    expect(params.get("ContentSid")).toBe("HXabc");
    expect(result.provider).toBe("twilio");
  });

  it("prefers the Cloud API over Twilio if both rows are somehow enabled", async () => {
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.providers = [TWILIO, CLOUD];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.2" }] }), { status: 200 }),
    );

    const result = await dispatchNotificationRecord("n-1");

    expect(requestedUrls()).toEqual(["https://graph.facebook.com/v23.0/999/messages"]);
    expect(result.provider).toBe("whatsapp_cloud_api");
  });

  it("skips WhatsApp and sends nothing when no WhatsApp provider is enabled", async () => {
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.providers = [RESEND];

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.state).toBe("skipped");
    expect(result.failure_reason).toMatch(/no active WhatsApp provider/);
  });

  it("skips a proactive tenant email when the tenant has reminders disabled", async () => {
    // The reminders switch is channel-agnostic: until now only the WhatsApp
    // branch read it, so an opted-out tenant still got the email.
    db.notification = notification({ type: "overdue_reminder" });
    db.providers = [RESEND];
    db.tenant = { ...db.tenant, reminders_enabled: false };

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.state).toBe("skipped");
    expect(result.failure_reason).toMatch(/reminders are disabled for this tenant/i);
  });

  it("still sends an admin alert email for the same opted-out tenant", async () => {
    // Admin alert rows carry the same tenant_id and type as the tenant's
    // reminder; an opted-out tenant must not silence the office.
    db.notification = notification({
      type: "contract_expiry",
      audience: "admin",
      recipient_address: "admin@example.test",
      tenant_id: "t-1",
    });
    db.providers = [RESEND];
    db.tenant = { ...db.tenant, reminders_enabled: false };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-admin" }), { status: 200 }),
    );

    const result = await dispatchNotificationRecord("n-1");

    expect(requestedUrls()).toEqual(["https://api.resend.com/emails"]);
    expect(result.state).toBe("sent");
  });

  it("skips a tenant-audience notification when the tenant is paused", async () => {
    // Owner decision 2026-10-20: the pause stops everything that
    // reaches the tenant. This path catches the rows queued before the switch
    // was turned on — the enqueue path never saw the pause.
    db.notification = notification({ audience: "tenant" });
    db.providers = [RESEND];
    db.tenant = { ...db.tenant, notifications_paused: true };

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.state).toBe("skipped");
    expect(result.failure_reason).toBe("Tenant notifications are paused.");
  });

  it("still sends an admin-audience notification for a paused tenant", async () => {
    // The admin copy is the office's, not the tenant's: a paused tenant must
    // not silence the office.
    db.notification = notification({
      audience: "admin",
      recipient_address: "admin@example.test",
      tenant_id: "t-1",
    });
    db.providers = [RESEND];
    db.tenant = { ...db.tenant, notifications_paused: true };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-admin-paused" }), { status: 200 }),
    );

    const result = await dispatchNotificationRecord("n-1");

    expect(requestedUrls()).toEqual(["https://api.resend.com/emails"]);
    expect(result.state).toBe("sent");
  });

  it("names the missing tenant number and the missing provider in the skip reason", async () => {
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.tenant = { ...db.tenant, whatsapp: null, mobile: null };
    db.providers = [CLOUD];

    const noNumber = await dispatchNotificationRecord("n-1");
    expect(noNumber.state).toBe("skipped");
    expect(noNumber.failure_reason).toMatch(/no WhatsApp number .*tenant/i);

    db.tenant = { ...db.tenant, whatsapp: "+96550123456" };
    db.providers = [];
    const noProvider = await dispatchNotificationRecord("n-1");
    expect(noProvider.state).toBe("skipped");
    expect(noProvider.failure_reason).toMatch(/provider_configs/);
  });

  it("refuses to send when no approved provider template is recorded", async () => {
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.providers = [CLOUD];
    db.template = { ...MAPPING, provider_template_name: null };

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    // A missing mapping is a configuration fault, not a routine skip, so it is
    // recorded as failed and stays visible in the Notification Log.
    expect(result.state).toBe("failed");
    expect(result.failure_reason).toMatch(/No approved Meta template name/);
  });

  it("refuses to send when the payload lacks a required template variable", async () => {
    db.notification = notification({ channel: "whatsapp", payload: {}, subject: null });
    db.providers = [CLOUD];

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.failure_reason).toMatch(/missing Meta template variables: tenant_name/);
  });

  it("records a partial failure truthfully for a channel:both notification", async () => {
    db.notification = notification({ channel: "both" });
    db.providers = [RESEND, CLOUD];
    db.template = { ...MAPPING, provider_template_name: null };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-3" }), { status: 200 }),
    );

    const result = await dispatchNotificationRecord("n-1");

    // Convention: `state` reflects whether ANY channel was delivered;
    // `failure_reason` always names the channels that were not.
    expect(result.state).toBe("sent");
    expect(result.provider_message_id).toBe("resend-3");
    expect(result.failure_reason).toMatch(/WhatsApp not sent/);
  });

  it("does not re-send a notification that is already sent", async () => {
    db.notification = notification({ state: "sent" });
    db.providers = [RESEND];

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.state).toBe("sent");
    expect(db.update).toBeNull();
  });

  it("records a provider rejection as failed and increments the retry count", async () => {
    db.providers = [RESEND];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ name: "validation_error", message: "domain not verified" }), {
        status: 403,
      }),
    );

    const result = await dispatchNotificationRecord("n-1");

    expect(result.state).toBe("failed");
    expect(result.retry_count).toBe(1);
    expect(result.failure_reason).toMatch(/domain not verified/);
  });

  it("sends WhatsApp through Postora when postora is the enabled WhatsApp provider", async () => {
    // This test FAILS without `configs.get("postora")` in whatsappProvider():
    // the selector would return null and the notification would be skipped
    // instead of routed to Postora. The send branch alone cannot reach this
    // path unless the selector recognises postora.
    db.notification = notification({
      id: "11111111-1111-1111-1111-111111111111",
      channel: "whatsapp",
      subject: null,
    });
    db.providers = [POSTORA];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true, message_id: "wamid.POST" }), { status: 200 }),
    );

    const result = await dispatchNotificationRecord("11111111-1111-1111-1111-111111111111");

    expect(requestedUrls()).toEqual(["https://api.postora.cloud/functions/v1/partner-api"]);
    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.action).toBe("send_template");
    expect(body.template_name).toBe("danat_receipt_ar");
    expect(result.provider).toBe("postora");
    expect(result.provider_message_id).toBe("wamid.POST");
    // The notification row id is the idempotency key the drain job replays.
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("records a Twilio timeout as possibly delivered, so the drain will not resend it", async () => {
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.providers = [TWILIO];
    const { fireTimeout } = stubHungFetch();

    const dispatch = dispatchNotificationRecord("n-1");
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    fireTimeout();
    const result = await dispatch;

    expect(result.state).toBe("failed");
    expect(result.error_code).toBe(DELIVERY_INDETERMINATE);
  });

  it("persists the Postora error code so the drain job can act on it", async () => {
    // Without error_code persistence the drain-job guard (Task 4) is dead code:
    // the column would never be written by the path that later reads it.
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.providers = [POSTORA];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: {
            code: "idempotency_indeterminate",
            message: "may have been delivered",
            retryable: false,
          },
          request_id: "req-9",
        }),
        { status: 409 },
      ),
    );

    const result = await dispatchNotificationRecord("n-1");

    expect(result.state).toBe("failed");
    expect(result.error_code).toBe("idempotency_indeterminate");
    expect(result.failure_reason).toMatch(/idempotency_indeterminate/);
  });

  it("records a missing email recipient as skipped, not failed", async () => {
    // M6: nothing is wrong with the message — there is simply no mailbox to
    // send it to. `failed` would hand the row to the drain job's retry queue
    // and then to needs_review, where no retry can conjure an address.
    db.notification = notification({
      audience: "admin",
      payload: {},
      recipient_address: null,
      tenant_id: null,
    });
    db.tenant = null;
    db.providers = [RESEND];

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(db.update).toMatchObject({ state: "skipped" });
    expect(db.update?.failure_reason).toBe("No email recipient is available.");
    expect(result.state).toBe("skipped");
  });

  it("records a disabled email provider as skipped, not failed", async () => {
    // Same class of configuration gap: enabling a provider is an admin
    // action, and three retries cannot perform it.
    db.providers = [];

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(db.update).toMatchObject({ state: "skipped" });
    expect(db.update?.failure_reason).toBe("No email provider is enabled.");
    expect(result.state).toBe("skipped");
  });

  it("keeps a refused WhatsApp send failed so the drain job can retry it", async () => {
    // The builder refusing to construct the message (here: no approved Meta
    // template) is a send attempt that did not happen for a reason a fix
    // plus retry addresses — the opposite of a not-applicable skip.
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.providers = [CLOUD];
    db.template = { ...MAPPING, provider_template_name: null };

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(db.update).toMatchObject({ state: "failed" });
    expect(db.update?.failure_reason).toBe(
      "WhatsApp not sent: No approved Meta template name is recorded for this notification template. " +
        "Record the approved name in notification_templates.provider_template_name.",
    );
    expect(result.state).toBe("failed");
  });

  it("keeps a mixed batch failed when email skips but WhatsApp fails", async () => {
    // The `every` regression guard: a careless `some`-style fix marks this
    // row skipped, and the drain job never retries the WhatsApp leg that a
    // retry could actually deliver.
    db.notification = notification({
      audience: "admin",
      channel: "both",
      payload: { tenant_name: "أحمد" },
      recipient_address: null,
      subject: null,
    });
    db.providers = [CLOUD];
    db.template = { ...MAPPING, provider_template_name: null };

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(db.update).toMatchObject({ state: "failed" });
    expect(db.update?.failure_reason).toBe(
      "No email recipient is available. WhatsApp not sent: No approved Meta template name is recorded for this notification template. " +
        "Record the approved name in notification_templates.provider_template_name.",
    );
    expect(result.state).toBe("failed");
  });
});
