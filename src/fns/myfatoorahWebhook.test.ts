import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock supabaseAdmin inline to avoid ReferenceError
vi.mock("@/integrations/supabase/client.server", () => {
  const adminMock = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnThis(),
    rpc: vi.fn(),
  };
  return {
    supabaseAdmin: adminMock,
  };
});

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  canonicalSignatureString,
  invoicePaymentReference,
  respondToMyFatoorahWebhook,
} from "./myfatoorahWebhook";

/**
 * A trimmed copy of a **real** PAYMENT_STATUS_CHANGED delivery, taken from the
 * production `webhook_events` row for the 2,390 KWD KNET payment of
 * 2026-08-08 that this endpoint rejected. Shape matters more than the values:
 * the fields are nested (`Data.Invoice.Id`), and reading them as flat keys is
 * what made every extracted detail null.
 */
function livePaymentPayload() {
  return {
    Data: {
      Invoice: {
        Id: "222404883",
        Status: "PAID",
        Reference: "2026000003",
        UserDefinedField: "",
        ExternalIdentifier: "",
      },
      Transaction: {
        Id: "622012003592820",
        Status: "SUCCESS",
        PaymentId: "100622026000123957",
        PaymentMethod: "KNET",
      },
    },
    Event: {
      Code: 1,
      Name: "PAYMENT_STATUS_CHANGED",
      Reference: "WH-35939205",
      CountryIsoCode: "KWT",
    },
  };
}

async function signCanonical(canonical: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(canonical));
  return btoa(String.fromCharCode(...new Uint8Array(signed)));
}

describe("myfatoorahWebhook respondToMyFatoorahWebhook", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns 503 if MYFATOORAH_WEBHOOK_SECRET is not configured", async () => {
    delete process.env.MYFATOORAH_WEBHOOK_SECRET;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const request = new Request("https://example.com/api/myfatoorah-webhook", {
      method: "POST",
      body: JSON.stringify({ Data: { PaymentId: "123" } }),
    });

    const response = await respondToMyFatoorahWebhook(request);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain("webhook secret is not configured");
    // A silent 503 is how this stayed broken: the gateway retries, gives up,
    // and nothing in the logs says the endpoint was ever reached.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("MYFATOORAH_WEBHOOK_SECRET"));

    warn.mockRestore();
  });

  it("returns 401 if signature validation fails", async () => {
    process.env.MYFATOORAH_WEBHOOK_SECRET = "test-webhook-secret";

    const request = new Request("https://example.com/api/myfatoorah-webhook", {
      method: "POST",
      headers: {
        "x-myfatoorah-signature": "invalid-signature",
      },
      body: JSON.stringify({ Data: { PaymentId: "123" } }),
    });

    const response = await respondToMyFatoorahWebhook(request);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toContain("Invalid webhook signature");
  });

  it("handles duplicate/replay events gracefully", async () => {
    process.env.MYFATOORAH_WEBHOOK_SECRET = "test-webhook-secret";

    const payloadObj = livePaymentPayload();
    const rawBody = JSON.stringify(payloadObj);
    const signatureBase64 = await signCanonical(
      canonicalSignatureString(payloadObj)!,
      "test-webhook-secret",
    );

    // First call to single (for the insert) returns unique violation error (23505)
    vi.mocked((supabaseAdmin as any).single).mockResolvedValueOnce({
      data: null,
      error: { code: "23505", message: "Unique violation" } as any,
    });

    // Second call to single (for the select existing) returns the duplicate event
    vi.mocked((supabaseAdmin as any).single).mockResolvedValueOnce({
      data: { id: "existing-event-id", processed: true, result: "completed" },
      error: null,
    });

    const request = new Request("https://example.com/api/myfatoorah-webhook", {
      method: "POST",
      headers: {
        "x-myfatoorah-signature": signatureBase64,
      },
      body: rawBody,
    });

    const response = await respondToMyFatoorahWebhook(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.replay).toBe(true);
  });
});

describe("canonicalSignatureString", () => {
  // Production incident 2026-08-09: five consecutive webhooks were recorded
  // `invalid_signature`, including a 2,390 KWD live KNET payment, because this
  // endpoint HMAC'd the raw JSON body. MyFatoorah signs an ordered key=value
  // string instead. https://docs.myfatoorah.com/docs/webhook-signature
  it("builds the documented ordered key=value string for a payment event", () => {
    expect(canonicalSignatureString(livePaymentPayload())).toBe(
      "Invoice.Id=222404883,Invoice.Status=PAID,Transaction.Status=SUCCESS," +
        "Transaction.PaymentId=100622026000123957,Invoice.ExternalIdentifier=",
    );
  });

  it("renders a missing or null property as an empty value, not as 'null'", () => {
    const payload = livePaymentPayload();
    payload.Data.Invoice.Status = null as unknown as string;
    // The spec says an absent value becomes an empty string. "null" or
    // "undefined" leaking into the string changes the hash and rejects a
    // perfectly good delivery.
    expect(canonicalSignatureString(payload)).toContain("Invoice.Status=,");
  });

  it("builds the deposit string for a real BALANCE_TRANSFERRED delivery", () => {
    // Values copied from the production webhook_events row of 2026-08-09 — a
    // 4,927.20 KWD KFH transfer. Only three Deposit fields are signed; the Bank
    // and Supplier blocks in the same payload are not.
    const payload = {
      Event: { Name: "BALANCE_TRANSFERRED", Code: 3 },
      Data: {
        Bank: { IBAN: "KW65KFHO0000000000021010064744", Name: "Kuwait Finance House (KFH)" },
        Deposit: {
          Reference: "2026000001",
          BaseCurrency: "KWD",
          ValueInBaseCurrency: "4927.2",
          NumberOfTransactions: "3",
        },
      },
    };
    expect(canonicalSignatureString(payload)).toBe(
      "Deposit.Reference=2026000001,Deposit.ValueInBaseCurrency=4927.2,Deposit.NumberOfTransactions=3",
    );
  });

  it("builds the refund string in its own documented order", () => {
    // A different order and different fields from the payment event — which is
    // the whole reason the order is keyed on the event type rather than shared.
    const payload = {
      Event: { Name: "REFUND_STATUS_CHANGED" },
      Data: {
        Refund: { Id: "77", Status: "SUCCESS" },
        Amount: { ValueInBaseCurrency: "12.500" },
        ReferencedInvoice: { Id: "222404883" },
      },
    };
    expect(canonicalSignatureString(payload)).toBe(
      "Refund.Id=77,Refund.Status=SUCCESS,Amount.ValueInBaseCurrency=12.500," +
        "ReferencedInvoice.Id=222404883",
    );
  });

  it("returns null for an event type whose field order we do not have", () => {
    // Guessing an order would forge a mismatch that looks identical to an
    // attack, so an unknown type is reported as unverifiable instead.
    const payload = { Event: { Name: "SOMETHING_NEW" }, Data: {} };
    expect(canonicalSignatureString(payload)).toBeNull();
  });
});

describe("events this app does not consume", () => {
  it.each([
    "RECURRING_STATUS_CHANGED",
    "DISPUTE_STATUS_CHANGED",
    "SUPPLIER_UPDATE_REQUEST_CHANGED",
    "SUPPLIER_BANK_DETAILS_CHANGED",
  ])("acknowledges %s instead of failing it", async (eventName) => {
    // All seven event types are switched on in the merchant portal. Answering
    // 401 to the four we ignore would make MyFatoorah retry and eventually
    // disable the endpoint — taking the payment webhook down with it.
    process.env.MYFATOORAH_WEBHOOK_SECRET = "test-webhook-secret";

    const response = await respondToMyFatoorahWebhook(
      new Request("https://example.com/api/myfatoorah-webhook", {
        method: "POST",
        headers: { "myfatoorah-signature": "whatever" },
        body: JSON.stringify({ Event: { Name: eventName }, Data: {} }),
      }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).reason).toBe("event_not_consumed");
  });
});

describe("a verified payment event is acted on, not filed as ignored", () => {
  it("recognises the nested v2 payload as a successful payment", async () => {
    // The second half of the 2026-08-09 incident. `eventDetails` read flat keys
    // (`Data.InvoiceId`) from a payload that nests them (`Data.Invoice.Id`), so
    // every field came back null, `isSuccessfulEvent` saw nothing, and the
    // delivery was recorded "ignored". Fixing only the signature would have
    // moved the failure rather than removed it — this is what proves otherwise.
    process.env.MYFATOORAH_WEBHOOK_SECRET = "test-webhook-secret";
    const payload = livePaymentPayload();
    const rawBody = JSON.stringify(payload);
    const signature = await signCanonical(
      canonicalSignatureString(payload)!,
      "test-webhook-secret",
    );

    // claimWebhookEvent inserts a fresh (non-replay) event row.
    vi.mocked((supabaseAdmin as any).single).mockResolvedValueOnce({
      data: { id: "event-1", processed: false, result: null },
      error: null,
    });

    const response = await respondToMyFatoorahWebhook(
      new Request("https://example.com/api/myfatoorah-webhook", {
        method: "POST",
        headers: { "myfatoorah-signature": signature },
        body: rawBody,
      }),
    );
    const body = await response.json();

    // Settlement itself needs the whole database behind it, so it may fail here.
    // What must never happen is the silent "ignored" verdict, which is how a
    // real payment goes unrecorded while the endpoint answers 200 OK.
    expect(body.ignored).toBeUndefined();
  });
});

describe("webhook accepts either reading of the secret", () => {
  it("accepts a signature keyed on the base64-decoded secret", async () => {
    // MyFatoorah issues a base64-looking secret and the spec says only "in
    // binary mode", so this branch may well be the one production uses. Without
    // a test it would be the untested half of a coin-flip, and its failure mode
    // is every webhook silently rejected — the exact incident being fixed.
    const base64Secret = btoa("binary-secret-bytes");
    process.env.MYFATOORAH_WEBHOOK_SECRET = base64Secret;
    const payload = livePaymentPayload();
    const canonical = canonicalSignatureString(payload)!;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("binary-secret-bytes"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical));
    const signature = btoa(String.fromCharCode(...new Uint8Array(signed)));

    vi.mocked((supabaseAdmin as any).single).mockResolvedValueOnce({
      data: { id: "event-2", processed: false, result: null },
      error: null,
    });

    const response = await respondToMyFatoorahWebhook(
      new Request("https://example.com/api/myfatoorah-webhook", {
        method: "POST",
        headers: { "myfatoorah-signature": signature },
        body: JSON.stringify(payload),
      }),
    );

    // Anything but 401 proves the signature was accepted; settlement beyond that
    // needs the real database.
    expect(response.status).not.toBe(401);
  });
});

describe("webhook signature rejects the pre-fix scheme", () => {
  it("does not accept a signature computed over the raw JSON body", async () => {
    // The exact bug: signing the body verified nothing and rejected everything.
    // If someone reverts to it, this fails rather than silently passing.
    process.env.MYFATOORAH_WEBHOOK_SECRET = "test-webhook-secret";
    const payload = livePaymentPayload();
    const rawBody = JSON.stringify(payload);
    const rawBodySignature = await signCanonical(rawBody, "test-webhook-secret");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await respondToMyFatoorahWebhook(
      new Request("https://example.com/api/myfatoorah-webhook", {
        method: "POST",
        headers: { "myfatoorah-signature": rawBodySignature },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(401);
    // The rejection must say what it compared, or the next person is back to
    // guessing against a live gateway.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("signature rejected"),
      expect.stringContaining("Invoice.Id=222404883"),
    );
    warn.mockRestore();
  });

  it("never logs the signature the payload would need", async () => {
    // Logging the expected signature would make this endpoint a forgery oracle:
    // post any payload, read back the signature it needs, resubmit, and settle
    // an invoice without ever knowing the secret. Anyone with log access could
    // do it. The diagnostic value does not justify that, and the canonical
    // string alone is enough to diagnose offline.
    process.env.MYFATOORAH_WEBHOOK_SECRET = "test-webhook-secret";
    const payload = livePaymentPayload();
    const expectedSignature = await signCanonical(
      canonicalSignatureString(payload)!,
      "test-webhook-secret",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await respondToMyFatoorahWebhook(
      new Request("https://example.com/api/myfatoorah-webhook", {
        method: "POST",
        headers: { "myfatoorah-signature": "wrong-signature" },
        body: JSON.stringify(payload),
      }),
    );

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("Invoice.Id=222404883");
    expect(logged).not.toContain(expectedSignature);
    expect(logged).not.toContain("test-webhook-secret");
    warn.mockRestore();
  });
});

describe("invoicePaymentReference", () => {
  it("gives each invoice month its own payment reference", () => {
    const prefix = "MF:pay-123";
    const references = ["INV-0007", "INV-0008", "INV-0009"].map((code) =>
      invoicePaymentReference(prefix, code),
    );

    // A multi-month settlement must not collapse into one payment row: the
    // references are distinct, so each month inserts its own payment.
    expect(references).toEqual([
      "MF:pay-123#INV-0007",
      "MF:pay-123#INV-0008",
      "MF:pay-123#INV-0009",
    ]);
    expect(new Set(references).size).toBe(3);
  });

  it("is stable for the same invoice so a replayed webhook reuses the payment", () => {
    expect(invoicePaymentReference("MF:pay-1", "INV-0001")).toBe(
      invoicePaymentReference("MF:pay-1", "INV-0001"),
    );
  });
});
