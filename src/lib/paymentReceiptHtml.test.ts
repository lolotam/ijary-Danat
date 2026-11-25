import { describe, expect, test } from "vitest";

import type { Company } from "@/hooks/useCompany";
import type { Tables } from "@/integrations/supabase/database.types";
import { buildPaymentReceiptHtml } from "@/lib/paymentReceiptHtml";

const company = {
  name_ar: "دانة المستقبل العقارية",
  name_en: "Danat Al Mustaqbal",
} as unknown as Company;

type Payment = Tables<"payments">;

/** دفعة مؤكدة نقداً بلا تخصيصات — الجدول ينكمش إلى سطر الإجمالي وحده. */
function payment(): Payment {
  return {
    code: "PAY-0001",
    amount: 1400,
    currency: "KWD",
    method: "cash",
    reference: null,
    status: "confirmed",
    payment_date: "2026-01-15",
  } as unknown as Payment;
}

const tenant = { name: "شركة الدانة", name_en: "Danat Co" } as never;

/**
 * يستخرج صفوف شبكة التفاصيل كقاموس (التسمية ← القيمة).
 */
function detailRows(html: string): Record<string, string> {
  return Object.fromEntries(
    [
      ...html.matchAll(/<span class="label">([^<]*)<\/span>\s*<span class="value[^"]*">([^<]*)</g),
    ].map((match) => [match[1].trim(), match[2].trim()]),
  );
}

/**
 * Owner rename 2026-09-29: the counter-party on invoices and receipts is the
 * investor (المستثمر), not the tenant — same wording as the invoice sheet so
 * the two papers an investor holds never disagree about who they are.
 */
describe("the printed receipt names the counter-party as the investor", () => {
  test.each([
    ["ar", "المستثمر", "شركة الدانة"],
    ["en", "Investor", "Danat Co"],
  ] as const)("the party row is labelled %s in %s", (locale, label, partyName) => {
    const html = buildPaymentReceiptHtml(payment(), [], company, locale, { tenant });

    expect(detailRows(html)[label]).toBe(partyName);
  });

  test("the old tenant wording appears nowhere in either locale", () => {
    const ar = buildPaymentReceiptHtml(payment(), [], company, "ar", { tenant });
    const en = buildPaymentReceiptHtml(payment(), [], company, "en", { tenant });

    expect(ar).toContain("المستثمر");
    expect(ar).not.toContain("المستأجر");
    expect(Object.keys(detailRows(en))).toContain("Investor");
    expect(Object.keys(detailRows(en))).not.toContain("Tenant");
    expect(en).not.toContain("Tenant:");
    expect(en).not.toContain(">Tenant<");
  });

  test("without a tenant the party row is skipped, not dashed", () => {
    // Callers that have not loaded the tenant yet still render; a dashed
    // party row would read as a redacted name on a filed document.
    const html = buildPaymentReceiptHtml(payment(), [], company, "en", {});
    expect(Object.keys(detailRows(html))).not.toContain("Investor");
  });
});
