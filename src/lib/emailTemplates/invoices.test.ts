import { describe, expect, test } from "vitest";

import { invoiceDocumentTemplate } from "@/lib/emailTemplates/invoices";

/** مدخلات فاتورة واحدة صالحة لكلا اللغتين. */
function invoiceInput(locale: "ar" | "en") {
  return {
    locale,
    tenantName: "Acme Trading",
    unitName: "Shop 4",
    propertyName: "Souq Building",
    invoiceNumber: "INV-0001",
    period: "يناير 2026",
    issueDate: "2026-01-01",
    dueDate: "2026-02-01",
    subtotal: "770 KWD",
    discount: null,
    paid: "0 KWD",
    total: "770 KWD",
  };
}

/**
 * Owner rename 2026-09-29: the invoice email names the counter-party
 * المستثمر/Investor — the same label the printed invoice and receipt carry,
 * so the message and its attachment never name the same field two ways.
 */
describe("the invoice email names the counter-party as the investor", () => {
  test("the Arabic party row reads المستثمر", () => {
    const { html, text } = invoiceDocumentTemplate(invoiceInput("ar"));

    expect(html).toContain("المستثمر");
    expect(html).not.toContain("المستأجر");
    expect(text).not.toContain("المستأجر");
  });

  test("the English party row reads Investor", () => {
    const { html, text } = invoiceDocumentTemplate(invoiceInput("en"));

    expect(html).toContain(">Investor<");
    expect(html).not.toContain(">Tenant<");
    expect(html).not.toContain("Tenant:");
    expect(text).not.toContain("Tenant");
  });
});
