import { describe, expect, it } from "vitest";

import { paymentAdminAlertTemplate, paymentReceiptTemplate } from "./emailTemplates";
import { buildPaymentReceiptHtml } from "./paymentReceiptHtml";
import type { Tables } from "@/integrations/supabase/database.types";

/**
 * The conditional "Reason of manual payment" row.
 *
 * The bug worth catching here is the gateway case: a tenant who paid by card
 * has no manual reason, and a receipt that shows an empty or placeholder reason
 * row invites them to ask what went wrong when nothing did.
 */
describe("paymentReceiptTemplate manual reason row", () => {
  const base = {
    amount: "450.000 KWD",
    paymentDate: "2026-08-06",
    reference: "PAY-0000006",
    tenantName: "Acme Trading",
  } as const;

  it("omits the reason row entirely for a gateway payment", () => {
    const receipt = paymentReceiptTemplate({ ...base, locale: "en" });

    expect(receipt.html).not.toContain("Reason of manual payment");
    expect(receipt.text).not.toContain("Reason of manual payment");
  });

  it("renders the reason in the html and the text body when one is present", () => {
    const receipt = paymentReceiptTemplate({
      ...base,
      locale: "en",
      manualPaymentReason: "Bank transfer",
    });

    expect(receipt.html).toContain("Reason of manual payment");
    expect(receipt.html).toContain("Bank transfer");
    // WhatsApp reads the text body, not the HTML — a row added to only one of
    // them is invisible on whichever channel the tenant actually uses.
    expect(receipt.text).toContain("Bank transfer");
  });

  it("renders the Arabic label for an Arabic receipt", () => {
    const receipt = paymentReceiptTemplate({
      ...base,
      locale: "ar",
      manualPaymentReason: "تحويل بنكي",
    });

    expect(receipt.html).toContain("سبب الدفع اليدوي");
    expect(receipt.html).toContain("تحويل بنكي");
  });

  it("escapes a reason containing markup", () => {
    const receipt = paymentReceiptTemplate({
      ...base,
      locale: "en",
      manualPaymentReason: '<img src=x onerror="alert(1)">',
    });

    expect(receipt.html).not.toContain("<img");
    expect(receipt.html).toContain("&lt;img");
  });
});

describe("paymentAdminAlertTemplate manual reason row", () => {
  const base = {
    amount: "450.000 KWD",
    paymentCodes: "PAY-0000006",
    periods: "8/2026",
    tenantName: "Acme Trading",
  } as const;

  it("omits the reason for a gateway payment", () => {
    const alert = paymentAdminAlertTemplate({ ...base, locale: "en" });

    expect(alert.html).not.toContain("Reason of manual payment");
    expect(alert.text).not.toContain("reason of manual payment");
  });

  it("includes the reason for a manually settled invoice", () => {
    const alert = paymentAdminAlertTemplate({
      ...base,
      locale: "en",
      manualPaymentReason: "Audit / data adjustment",
    });

    expect(alert.html).toContain("Reason of manual payment");
    expect(alert.html).toContain("Audit / data adjustment");
    expect(alert.text).toContain("Audit / data adjustment");
  });
});

/**
 * The same row on the receipt *document* — the A4 page that becomes the PDF
 * attached to the receipt email, and that the portal prints.
 *
 * Kept beside the email-template tests because the rule is one rule: a manually
 * settled payment names its reason, a gateway payment does not. Splitting them
 * across two files is how one half quietly loses the row.
 */
describe("buildPaymentReceiptHtml manual reason row", () => {
  const payment = {
    amount: 450,
    code: "PAY-0000006",
    method: "bank_transfer",
    payment_date: "2026-08-06",
    reference: "REF-6",
    status: "confirmed",
  } as unknown as Tables<"payments">;

  it("omits the row entirely for a gateway payment", () => {
    expect(buildPaymentReceiptHtml(payment, [], null, "en")).not.toContain(
      "Reason of manual payment",
    );
  });

  it("renders the reason beside the payment method when one is given", () => {
    const html = buildPaymentReceiptHtml(payment, [], null, "en", {
      manualPaymentReason: "Bank transfer",
    });

    // Both rows, because the pair is the point: the method says how the money
    // arrived, the reason says why it was recorded by hand.
    expect(html).toContain("Payment method");
    expect(html).toContain("Bank transfer");
    expect(html).toContain("Reason of manual payment");
  });

  it("names the row in Arabic on an Arabic receipt", () => {
    const html = buildPaymentReceiptHtml(payment, [], null, "ar", {
      manualPaymentReason: "تحويل بنكي",
    });

    expect(html).toContain("سبب الدفع اليدوي");
  });

  it("escapes the reason rather than trusting the catalog label", () => {
    // Labels are admin-editable at Settings > Lists, so they are user input.
    const html = buildPaymentReceiptHtml(payment, [], null, "en", {
      manualPaymentReason: '<img src=x onerror="alert(1)">',
    });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
