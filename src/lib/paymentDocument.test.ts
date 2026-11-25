import { describe, expect, it } from "vitest";

import { buildPaymentReceiptDocument } from "@/lib/paymentDocument";
import { buildPaymentReceiptHtml } from "@/lib/paymentReceiptHtml";
import type { Company } from "@/hooks/useCompany";
import type { AllocationWithInvoice } from "@/hooks/usePaymentAllocations";
import type { Tables } from "@/integrations/supabase/database.types";

const payment = {
  id: "pay-1",
  code: "PMT-2026-0007",
  amount: 750,
  currency: "KWD",
  method: "knet",
  status: "confirmed",
  paid_at: "2026-07-20T09:00:00.000Z",
  reference: "REF-99",
} as unknown as Tables<"payments">;

const company = {
  name_ar: "دانة المستقبل العقارية",
  name_en: "Danat Al Mustaqbal",
  bank_name: "NBK",
  iban: "KW81CBKU0000000000001234560101",
} as unknown as Company;

function allocation(
  id: string,
  amount: number,
  invoice: Partial<Tables<"invoices">> | null,
): AllocationWithInvoice {
  return {
    id,
    payment_id: payment.id,
    invoice_id: invoice ? `inv-${id}` : "missing",
    amount,
    invoice: invoice ? ({ id: `inv-${id}`, ...invoice } as Tables<"invoices">) : null,
  } as AllocationWithInvoice;
}

const allocations: AllocationWithInvoice[] = [
  allocation("a1", 500, { code: "INV-2026-0001", period_month: 6, period_year: 2026 }),
  allocation("a2", 250, { code: "INV-2026-0002", period_month: 7, period_year: 2026 }),
];

describe("buildPaymentReceiptHtml", () => {
  it("sets direction and language from the locale", () => {
    expect(buildPaymentReceiptHtml(payment, allocations, company, "ar")).toContain('dir="rtl"');
    expect(buildPaymentReceiptHtml(payment, allocations, company, "en")).toContain('dir="ltr"');
  });

  it("lists every allocation with its invoice code", () => {
    const html = buildPaymentReceiptHtml(payment, allocations, company, "en");
    expect(html).toContain("INV-2026-0001");
    expect(html).toContain("INV-2026-0002");
  });

  it("still renders when no allocations are loaded", () => {
    // The receipt must degrade to a single total line, never throw — this is
    // the shape the portal actions hit before the allocations resolve.
    const html = buildPaymentReceiptHtml(payment, [], company, "en");
    expect(html).toContain("PMT-2026-0007");
    expect(html).not.toContain("INV-2026-0001");
  });

  it("tolerates an allocation whose invoice failed to join", () => {
    const orphan = [allocation("a3", 100, null)];
    expect(() => buildPaymentReceiptHtml(payment, orphan, company, "en")).not.toThrow();
  });

  it("tolerates a null company", () => {
    expect(() => buildPaymentReceiptHtml(payment, allocations, null, "ar")).not.toThrow();
  });

  it("escapes HTML in free-text fields", () => {
    const hostile = { ...payment, reference: "<img src=x onerror=1>" } as Tables<"payments">;
    const html = buildPaymentReceiptHtml(hostile, allocations, company, "en");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("renders the bank block only when bank details exist", () => {
    const withBank = buildPaymentReceiptHtml(payment, allocations, company, "en");
    expect(withBank).toContain("KW81CBKU0000000000001234560101");

    const noBank = { ...company, bank_name: null, iban: null } as Company;
    expect(buildPaymentReceiptHtml(payment, allocations, noBank, "en")).not.toContain("IBAN");
  });
});

describe("buildPaymentReceiptDocument", () => {
  it("names the tab after the payment code and the company", () => {
    const doc = buildPaymentReceiptDocument(payment, allocations, company, "ar", "Receipt");
    expect(doc.title).toBe("PMT-2026-0007 — دانة المستقبل العقارية");
    expect(doc.dir).toBe("rtl");
  });

  it("falls back to the supplied title when no company name is on record", () => {
    const doc = buildPaymentReceiptDocument(payment, allocations, null, "en", "Receipt");
    expect(doc.title).toBe("PMT-2026-0007 — Receipt");
    expect(doc.dir).toBe("ltr");
  });

  it("derives a safe .pdf filename from the payment code", () => {
    const doc = buildPaymentReceiptDocument(payment, allocations, company, "en", "Receipt");
    expect(doc.filename).toMatch(/\.pdf$/);
    expect(doc.filename).not.toMatch(/[/\\:*?"<>|]/);
  });

  it("carries the print CSS and the same HTML as the direct builder", () => {
    const doc = buildPaymentReceiptDocument(payment, allocations, company, "en", "Receipt");
    expect(doc.extraCss).toBeTruthy();
    expect(doc.html).toBe(buildPaymentReceiptHtml(payment, allocations, company, "en"));
  });

  it("prints the commercial name as the party when a tenant is supplied", () => {
    const tenant = { commercial_name: "Danat Cafe", name: "شركة x", name_en: "Company X" };
    const html = buildPaymentReceiptHtml(payment, allocations, company, "en", { tenant });
    expect(html).toContain("Danat Cafe");
    expect(html).not.toContain("Company X");
  });
});
