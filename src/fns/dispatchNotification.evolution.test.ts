import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reportSendSessionDisconnected = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

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
vi.mock("@/fns/evolutionSessionWatch", () => ({
  reportSendSessionDisconnected: () => reportSendSessionDisconnected(),
}));

import { dispatchNotificationRecord } from "./dispatchNotification";
import {
  CLOUD,
  db,
  EVOLUTION,
  MAPPING,
  notification,
  POSTORA,
  requestedUrls,
  resetDispatchFixtures,
  restoreDispatchFixtures,
  TEST_COMPANY,
} from "./dispatchNotification.testkit";

function evolutionOk(id: string) {
  return new Response(JSON.stringify({ key: { id } }), { status: 201 });
}

/** The Evolution (QR-session) provider path of dispatchNotificationRecord. */
describe("dispatchNotificationRecord through Evolution", () => {
  beforeEach(() => {
    resetDispatchFixtures();
    reportSendSessionDisconnected.mockClear();
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.providers = [EVOLUTION];
    db.template = { ...MAPPING, provider_template_name: null };
  });
  afterEach(restoreDispatchFixtures);

  it("sends free text with no template required", async () => {
    // This test FAILS without `configs.get("evolution_api")` in
    // whatsappProvider() AND the evolutionMessage builder: with the Cloud API
    // builder the missing-template guard would block the send.
    vi.mocked(globalThis.fetch).mockResolvedValue(evolutionOk("evo-msg-1"));

    const result = await dispatchNotificationRecord("n-1");

    expect(requestedUrls()).toEqual(["http://evolution:8080/message/sendText/danat"]);
    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).apikey).toBe("evo-global-key");
    const body = JSON.parse(String(init.body));
    // Bare international digits — Evolution appends the JID itself.
    expect(body.number).toBe("96550123456");
    expect(body.text).toBe("Payment received.");
    expect(result.provider).toBe("evolution_api");
    expect(result.provider_message_id).toBe("evo-msg-1");
  });

  it("sends the receipt PDF as a media part after the text", async () => {
    db.notification = notification({
      channel: "whatsapp",
      subject: null,
      payload: { attachment_paths: ["receipts/INV-1.pdf"], attachment_bucket: "receipts" },
    });
    db.attachments["receipts/INV-1.pdf"] = {
      bytes: new TextEncoder().encode("%PDF-1.7 fake"),
      type: "application/pdf",
    };
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(evolutionOk("evo-t"))
      .mockResolvedValueOnce(evolutionOk("evo-m"));

    const result = await dispatchNotificationRecord("n-1");

    expect(requestedUrls()).toEqual([
      "http://evolution:8080/message/sendText/danat",
      "http://evolution:8080/message/sendMedia/danat",
    ]);
    const mediaBody = JSON.parse(
      String((vi.mocked(globalThis.fetch).mock.calls[1][1] as RequestInit).body),
    );
    expect(mediaBody.mediatype).toBe("document");
    expect(mediaBody.fileName).toBe("INV-1.pdf");
    expect(mediaBody.media).toBe(Buffer.from("%PDF-1.7 fake").toString("base64"));
    expect(result.state).toBe("sent");
    expect(result.provider_message_id).toBe("evo-t,evo-m");
  });

  it("caches the sent receipt PDF in whatsapp-media so the inbox bubble outlives Evolution's store", async () => {
    db.notification = notification({
      channel: "whatsapp",
      subject: null,
      payload: { attachment_paths: ["receipts/INV-1.pdf"], attachment_bucket: "receipts" },
    });
    db.attachments["receipts/INV-1.pdf"] = {
      bytes: new TextEncoder().encode("%PDF-1.7 fake"),
      type: "application/pdf",
    };
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(evolutionOk("evo-t"))
      .mockResolvedValueOnce(evolutionOk("evo-m"));

    await dispatchNotificationRecord("n-1");

    expect(db.uploads).toEqual([`companies/${TEST_COMPANY.id}/chat/96550123456/evo-m/INV-1.pdf`]);
  });

  it("fails the WhatsApp leg with a reason when the body is empty", async () => {
    db.notification = notification({ channel: "whatsapp", subject: null, body: "  " });

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.state).toBe("failed");
    expect(result.failure_reason).toMatch(/message body/i);
  });

  it("persists session_disconnected when the QR session was never paired", async () => {
    db.connection = null;

    const result = await dispatchNotificationRecord("n-1");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(reportSendSessionDisconnected).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("failed");
    expect(result.error_code).toBe("session_disconnected");
    expect(result.failure_reason).toMatch(/QR/);
  });

  it("refuses to send while the recorded session is closed and the live probe agrees", async () => {
    // The webhook recorded `close` when WhatsApp unlinked the device. Sending
    // anyway just burns a retry on a gateway that answers 500 — the row must
    // land on the needs_review code that tells an admin to re-scan.
    db.connection = { instance_name: "danat", last_connection_state: "close" };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ instance: { state: "close" } }), { status: 200 }),
    );

    const result = await dispatchNotificationRecord("n-1");

    expect(requestedUrls()).toEqual(["http://evolution:8080/instance/connectionState/danat"]);
    expect(reportSendSessionDisconnected).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("failed");
    expect(result.error_code).toBe("session_disconnected");
    expect(result.failure_reason).toMatch(/re-scan/i);
  });

  it("heals a stale closed record when the live probe says open, and sends", async () => {
    // A webhook that never arrived (Evolution restarted, app was deploying)
    // must not silence every WhatsApp until someone opens the settings page.
    db.connection = { instance_name: "danat", last_connection_state: "close" };
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ instance: { state: "open" } }), { status: 200 }),
      )
      .mockResolvedValueOnce(evolutionOk("evo-healed"));

    const result = await dispatchNotificationRecord("n-1");

    expect(requestedUrls()).toEqual([
      "http://evolution:8080/instance/connectionState/danat",
      "http://evolution:8080/message/sendText/danat",
    ]);
    expect(result.state).toBe("sent");
    expect(db.connectionUpdates).toEqual([{ last_connection_state: "open" }]);
  });

  it("is preferred over the other WhatsApp providers if somehow co-enabled", async () => {
    db.providers = [CLOUD, POSTORA, EVOLUTION];
    db.template = MAPPING;
    vi.mocked(globalThis.fetch).mockResolvedValue(evolutionOk("evo-first"));

    const result = await dispatchNotificationRecord("n-1");

    expect(requestedUrls()).toEqual(["http://evolution:8080/message/sendText/danat"]);
    expect(result.provider).toBe("evolution_api");
  });
});
