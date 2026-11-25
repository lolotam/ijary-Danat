import { describe, expect, test } from "vitest";

import {
  extraChargeLabel,
  resolveExtraChargesByInvoice,
  summarizeExtraCharges,
  type ExtraChargeItemRow,
} from "@/lib/invoiceExtraCharges";

/** بند نظافة بعشرين دينارًا، ما لم يُقل غير ذلك. */
function item(overrides: Partial<ExtraChargeItemRow> = {}): ExtraChargeItemRow {
  return {
    invoice_id: "inv-1",
    line: 2,
    amount: 20,
    is_extra_charge: true,
    description_ar: "النظافة",
    description_en: "Cleaning",
    ...overrides,
  };
}

describe("resolveExtraChargesByInvoice", () => {
  test("keeps only the flagged lines", () => {
    // `is_extra_charge` is the ONLY marker: `unit_id is null` means "extra
    // charge" on a line written since migration 163 and "rent" on one written
    // before 112 added the column, so a rent line is indistinguishable by
    // shape. Reading the flag wrong bills the tenant's rent twice on paper.
    const byInvoice = resolveExtraChargesByInvoice([
      item({ line: 1, amount: 750, is_extra_charge: false, description_en: "Rent" }),
      item(),
    ]);
    expect(byInvoice.get("inv-1")).toEqual([
      { amount: 20, description_ar: "النظافة", description_en: "Cleaning" },
    ]);
  });

  test("an invoice with no flagged line is absent, not present with an empty list", () => {
    // Callers distinguish the two with `?? []`; an empty entry would say the
    // invoice was looked at and found to have none, which is the same answer
    // here but not the same fact.
    expect(resolveExtraChargesByInvoice([item({ is_extra_charge: false })]).size).toBe(0);
  });

  test("orders the charges by line, whatever order the rows arrive in", () => {
    // PostgreSQL guarantees no order for an unordered select, and fetchInChunks
    // documents that its ordering holds within a chunk only. Left to the
    // transport, one invoice would print "(Cleaning, Advertising)" on one
    // render and "(Advertising, Cleaning)" on the next — two documents for one
    // invoice, which is the drift the printed paper exists to not have.
    // `line` comes from contract_extra_charges.line_order, so it is the
    // operator's own ordering and not an accident of storage.
    const byInvoice = resolveExtraChargesByInvoice([
      item({ line: 3, description_en: "Advertising" }),
      item({ line: 2, description_en: "Cleaning" }),
    ]);
    expect(byInvoice.get("inv-1")?.map((line) => line.description_en)).toEqual([
      "Cleaning",
      "Advertising",
    ]);
  });

  test("keeps each invoice's lines to itself", () => {
    const byInvoice = resolveExtraChargesByInvoice([
      item({ invoice_id: "inv-1" }),
      item({ invoice_id: "inv-2", amount: 15 }),
    ]);
    expect(byInvoice.get("inv-1")).toHaveLength(1);
    expect(byInvoice.get("inv-2")?.[0].amount).toBe(15);
  });
});

describe("summarizeExtraCharges", () => {
  test("sums several charges and lists each category once", () => {
    const summary = summarizeExtraCharges(
      [
        { amount: 20, description_ar: "النظافة", description_en: "Cleaning" },
        { amount: 15, description_ar: "الإعلانات", description_en: "Advertising" },
        { amount: 5, description_ar: "النظافة", description_en: "Cleaning" },
      ],
      "en",
    );
    expect(summary).toEqual({ total: 40, categories: ["Cleaning", "Advertising"] });
  });

  test("numeric strings from PostgREST add up instead of concatenating", () => {
    // Supabase hands `numeric` back as a string; "20" + "15" is "2015", which
    // would print a 2,015 KWD cleaning charge on a receipt.
    const summary = summarizeExtraCharges(
      [
        { amount: "20" as unknown as number, description_ar: null, description_en: "Cleaning" },
        { amount: "15" as unknown as number, description_ar: null, description_en: "Cleaning" },
      ],
      "en",
    );
    expect(summary.total).toBe(35);
  });

  test("rounds to the column's three places", () => {
    // 20.1 + 0.2 is 20.299999999999997 in float64. Printed against a subtotal
    // Postgres rounded to three places, the invoice's rows would not add up to
    // its own total.
    expect(
      summarizeExtraCharges(
        [
          { amount: 20.1, description_ar: null, description_en: "A" },
          { amount: 0.2, description_ar: null, description_en: "A" },
        ],
        "en",
      ).total,
    ).toBe(20.3);
  });

  test("falls back to the other language when a description is missing", () => {
    // `expense_categories.name_en` is nullable and `name_ar` is not, so this is
    // the direction the fallback actually runs in. Every category in production
    // carries both today, which is why an empty pair of brackets would ship
    // unnoticed the first time someone adds one without an English name.
    expect(
      summarizeExtraCharges([{ amount: 20, description_ar: "النظافة", description_en: null }], "en")
        .categories,
    ).toEqual(["النظافة"]);
  });

  test("an invoice with no charges is zero, not undefined", () => {
    expect(summarizeExtraCharges(undefined, "ar")).toEqual({ total: 0, categories: [] });
  });
});

describe("extraChargeLabel", () => {
  test.each([
    ["ar" as const, "مصروفات إضافية (النظافة)"],
    ["en" as const, "Extra expense (Cleaning)"],
  ])("names the category in brackets in %s", (locale, expected) => {
    const summary = summarizeExtraCharges(
      [{ amount: 20, description_ar: "النظافة", description_en: "Cleaning" }],
      locale,
    );
    expect(extraChargeLabel(summary, locale)).toBe(expected);
  });

  test("joins several categories with the locale's own separator", () => {
    const summary = { total: 35, categories: ["Cleaning", "Advertising"] };
    expect(extraChargeLabel(summary, "en")).toBe("Extra expense (Cleaning, Advertising)");
    expect(extraChargeLabel({ ...summary, categories: ["النظافة", "الإعلانات"] }, "ar")).toBe(
      "مصروفات إضافية (النظافة، الإعلانات)",
    );
  });

  test("leaves the brackets off entirely when there is no charge", () => {
    // The row still prints, at zero — empty brackets would read as a charge
    // whose category nobody recorded.
    expect(extraChargeLabel({ total: 0, categories: [] }, "en")).toBe("Extra expense");
  });
});
