import { describe, expect, test } from "vitest";

import type { Company } from "@/hooks/useCompany";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import type { InvoicePaymentBreakdown } from "@/lib/invoicePaymentBreakdown";
import { buildInvoicePrintHtml } from "@/lib/invoicePrintHtml";

const company = {
  name_ar: "دانة المستقبل العقارية",
  name_en: "Danat Al Mustaqbal",
} as unknown as Company;

/**
 * فاتورة 750 إيجارًا + 20 نظافة، فإجماليها الفرعي 770 كما تحسبه قاعدة البيانات.
 *
 * These are CON-00048's real figures. `subtotal` is the sum of rent and charges
 * because `contract_period_amounts` prices it that way, which is exactly why the
 * document has to split it back out.
 */
function invoice(overrides: Partial<InvoiceWithRelations> = {}): InvoiceWithRelations {
  return {
    code: "INV-0011460",
    period_month: 1,
    period_year: 2026,
    issue_date: "2026-01-01",
    due_date: "2026-01-05",
    subtotal: 770,
    discount: 0,
    paid: 0,
    total: 770,
    tenant: { name: "شركة الدانة", name_en: "Danat Co" },
    units: [],
    properties: [],
    extraCharges: [{ amount: 20, description_ar: "النظافة", description_en: "Cleaning" }],
    ...overrides,
  } as unknown as InvoiceWithRelations;
}

/**
 * لقطة سداد تطابق أرقام الفاتورة ما لم يُمرَّر خلاف ذلك.
 */
function breakdownFor(
  row: InvoiceWithRelations,
  overrides: Partial<InvoicePaymentBreakdown> = {},
): InvoicePaymentBreakdown {
  return {
    invoice: {
      code: row.code,
      subtotal: row.subtotal,
      discount: row.discount,
      total: row.total,
      paid: row.paid,
      balance: row.total - row.paid,
      state: (row as { state?: string }).state ?? (row.paid > 0 ? "partially_paid" : "due"),
    },
    paid_from_allocations: row.paid,
    reconciled: true,
    groups: [],
    ...overrides,
  };
}

/**
 * يستخرج صفوف جدول المبالغ كأزواج (التسمية، المبلغ).
 *
 * Amounts read as whole numbers because `formatKwd` truncates at the display
 * boundary (the 2026-08 product rule), so a charge below one dinar prints as
 * `0 KWD` here exactly as it does everywhere else in the app.
 */
function amountRows(html: string): Array<[string, string]> {
  const table = html.slice(html.indexOf('<table class="doc-amounts">'));
  return [...table.matchAll(/<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/g)].map((match) => [
    match[1].trim(),
    match[2].trim(),
  ]);
}

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
 * Owner request 2026-09-24: the paper shows when the tenant paid, not when the
 * platform generated the invoice, and names months instead of printing 9/2026.
 */
describe("the printed invoice's dates", () => {
  test("a paid invoice shows its latest payment date, not its issue date", () => {
    const row = invoice({ paid: 770, issue_date: "2026-01-01" });
    const html = buildInvoicePrintHtml(
      row,
      company,
      "en",
      breakdownFor(row, {
        groups: [
          {
            source: "manual",
            method: "cash",
            amount: 300,
            first_paid_on: "2026-02-03",
            last_paid_on: "2026-02-03",
            payments: 1,
          },
          {
            source: "gateway",
            method: "knet",
            amount: 470,
            first_paid_on: "2026-03-01",
            last_paid_on: "2026-09-24",
            payments: 2,
          },
        ],
      }),
    );

    expect(detailRows(html)["Payment date"]).toBe("2026-09-24");
    expect(html).not.toContain("Issue date");
  });

  test("an unpaid invoice has no payment date yet", () => {
    const row = invoice();
    const html = buildInvoicePrintHtml(row, company, "ar", breakdownFor(row));

    expect(detailRows(html)["تاريخ الدفع"]).toBe("—");
  });

  test.each([
    ["ar", "الفترة", "تاريخ الاستحقاق", "سبتمبر 2026"],
    ["en", "Period", "Due date", "September 2026"],
  ] as const)("names the month for the period and due date in %s", (locale, period, due, month) => {
    const row = invoice({ period_month: 9, period_year: 2026, due_date: "2026-09-01" });
    const rows = detailRows(buildInvoicePrintHtml(row, company, locale, breakdownFor(row)));

    expect(rows[period]).toBe(month);
    expect(rows[due]).toBe(month);
  });
});

/**
 * The reported gap: a 750 rent plus a 20 cleaning charge printed as one 770
 * with nothing saying what the 20 was for, so a tenant reading the invoice
 * could not tell the office had billed anything beyond the lease.
 */
describe("the printed invoice separates the contract amount from its service charges", () => {
  test("lists the rent, then the charge with its category, and still totals to the invoice", () => {
    expect(
      amountRows(buildInvoicePrintHtml(invoice(), company, "en", breakdownFor(invoice()))),
    ).toEqual([
      ["Contract amount", "750 KWD"],
      ["Extra expense (Cleaning)", "20 KWD"],
      ["Invoice total", "770 KWD"],
      ["Paid", "0 KWD"],
      ["Remaining", "770 KWD"],
    ]);
  });

  test("says the same in Arabic", () => {
    const rows = amountRows(
      buildInvoicePrintHtml(invoice(), company, "ar", breakdownFor(invoice())),
    );
    expect(rows.map(([label]) => label)).toEqual([
      "قيمة العقد",
      "مصروفات إضافية (النظافة)",
      "إجمالي الفاتورة",
      "المدفوع",
      "المتبقي",
    ]);
  });

  test("shows the discount row only when the invoice carries one", () => {
    const withDiscount = { ...invoice(), discount: 50 };
    const rows = amountRows(
      buildInvoicePrintHtml(withDiscount, company, "en", breakdownFor(withDiscount)),
    );
    expect(rows.map(([label]) => label)).toContain("Discount");
    const without = amountRows(
      buildInvoicePrintHtml(invoice(), company, "en", breakdownFor(invoice())),
    );
    expect(without.map(([label]) => label)).not.toContain("Discount");
  });

  test("keeps the row, at zero, on an invoice that bills rent alone", () => {
    // Every invoice carries the field by design. Dropping the row on the
    // ordinary case would make its absence indistinguishable from a month the
    // office forgot to add a charge to — and the operator checking their work
    // has nothing to read.
    const rows = amountRows(
      buildInvoicePrintHtml(
        invoice({ extraCharges: [] }),
        company,
        "en",
        breakdownFor(invoice({ extraCharges: [] })),
      ),
    );
    expect(rows[0]).toEqual(["Contract amount", "770 KWD"]);
    expect(rows[1]).toEqual(["Extra expense", "0 KWD"]);
  });

  test("names every category when a contract carries more than one charge", () => {
    const html = buildInvoicePrintHtml(
      invoice({
        subtotal: 785,
        total: 785,
        extraCharges: [
          { amount: 20, description_ar: "النظافة", description_en: "Cleaning" },
          { amount: 15, description_ar: "الإعلانات", description_en: "Advertising" },
        ],
      }),
      company,
      "en",
      breakdownFor(
        invoice({
          subtotal: 785,
          total: 785,
        }),
      ),
    );
    expect(amountRows(html)[0]).toEqual(["Contract amount", "750 KWD"]);
    expect(amountRows(html)[1]).toEqual(["Extra expense (Cleaning, Advertising)", "35 KWD"]);
  });

  test("a discount comes off the total, not off the charges row", () => {
    // Migration 171 caps a discount at the rent, so a discounted month still
    // shows its charge at full value. A document that netted the two would
    // contradict what the invoice actually billed.
    const html = buildInvoicePrintHtml(
      invoice({ discount: 750, total: 20 }),
      company,
      "en",
      breakdownFor(invoice({ discount: 750, total: 20 })),
    );
    expect(amountRows(html)).toEqual([
      ["Contract amount", "750 KWD"],
      ["Extra expense (Cleaning)", "20 KWD"],
      ["Discount", "750 KWD"],
      ["Invoice total", "20 KWD"],
      ["Paid", "0 KWD"],
      ["Remaining", "20 KWD"],
    ]);
  });
});

/**
 * Owner rename 2026-09-29: the counter-party on invoices and receipts is the
 * investor (المستثمر), not the tenant. The label is the observable contract —
 * a reverted dictionary key would print the old word on every document.
 */
describe("the printed invoice names the counter-party as the investor", () => {
  test.each([
    ["ar", "المستثمر", "شركة الدانة"],
    ["en", "Investor", "Danat Co"],
  ] as const)("the party row is labelled %s in %s", (locale, label, partyName) => {
    const row = invoice();
    const rows = detailRows(buildInvoicePrintHtml(row, company, locale, breakdownFor(row)));

    expect(rows[label]).toBe(partyName);
  });

  test("the old tenant wording appears nowhere in either locale", () => {
    const row = invoice();
    const ar = buildInvoicePrintHtml(row, company, "ar", breakdownFor(row));
    const en = buildInvoicePrintHtml(row, company, "en", breakdownFor(row));

    expect(ar).toContain("المستثمر");
    expect(ar).not.toContain("المستأجر");
    expect(Object.keys(detailRows(en))).toContain("Investor");
    expect(Object.keys(detailRows(en))).not.toContain("Tenant");
    expect(en).not.toContain("Tenant:");
    expect(en).not.toContain(">Tenant<");
  });
});

describe("the payments section and status line", () => {
  test("an unpaid invoice names remaining and says unpaid", () => {
    const html = buildInvoicePrintHtml(invoice(), company, "en", breakdownFor(invoice()));
    expect(html).toContain("Unpaid");
    expect(amountRows(html).at(-1)).toEqual(["Remaining", "770 KWD"]);
  });

  test("a partial payment lists the group and remaining", () => {
    const row = invoice({ paid: 200, total: 770 });
    const html = buildInvoicePrintHtml(
      row,
      company,
      "en",
      breakdownFor(row, {
        groups: [
          {
            source: "partial",
            method: "cash",
            amount: 200,
            first_paid_on: "2026-01-10",
            last_paid_on: "2026-01-10",
            payments: 1,
          },
        ],
      }),
    );
    expect(html).toContain("Partial payment (Cash)");
    expect(html).toMatch(/Partially paid/);
    expect(amountRows(html).at(-1)).toEqual(["Remaining", "570 KWD"]);
  });

  test("paid in full with one method lists the group and says paid in full", () => {
    const row = invoice({ paid: 770, total: 770 });
    const html = buildInvoicePrintHtml(
      row,
      company,
      "en",
      breakdownFor(row, {
        invoice: {
          code: row.code,
          subtotal: row.subtotal,
          discount: row.discount,
          total: 770,
          paid: 770,
          balance: 0,
          state: "paid",
        },
        paid_from_allocations: 770,
        groups: [
          {
            source: "manual",
            method: "cash",
            amount: 770,
            first_paid_on: "2026-01-10",
            last_paid_on: "2026-01-10",
            payments: 1,
          },
        ],
      }),
    );
    expect(html).toContain("Manual (Cash)");
    expect(html).toContain("Paid in full");
    expect(html).not.toContain("using");
    expect(amountRows(html).at(-1)).toEqual(["Remaining", "0 KWD"]);
  });

  test("paid in full with two methods names them and says so", () => {
    const row = invoice({ paid: 770, total: 770 });
    const html = buildInvoicePrintHtml(
      row,
      company,
      "en",
      breakdownFor(row, {
        invoice: {
          code: row.code,
          subtotal: row.subtotal,
          discount: row.discount,
          total: 770,
          paid: 770,
          balance: 0,
          state: "paid",
        },
        paid_from_allocations: 770,
        groups: [
          {
            source: "partial",
            method: "cash",
            amount: 200,
            first_paid_on: "2026-01-10",
            last_paid_on: "2026-01-10",
            payments: 1,
          },
          {
            source: "gateway",
            method: "knet",
            amount: 570,
            first_paid_on: "2026-01-15",
            last_paid_on: "2026-01-15",
            payments: 1,
          },
        ],
      }),
    );
    expect(html).toContain("Partial payment (Cash)");
    expect(html).toContain("Payment link (KNET)");
    expect(html).toContain("Paid in full, using 2 payment methods");
    expect(amountRows(html).at(-1)).toEqual(["Remaining", "0 KWD"]);
  });

  test("cancelled, waived and zero-total have their own status lines", () => {
    expect(
      buildInvoicePrintHtml(
        invoice(),
        company,
        "en",
        breakdownFor(invoice(), {
          invoice: { ...breakdownFor(invoice()).invoice, state: "cancelled" },
        }),
      ),
    ).toContain("Cancelled");
    expect(
      buildInvoicePrintHtml(
        invoice(),
        company,
        "en",
        breakdownFor(invoice(), {
          invoice: { ...breakdownFor(invoice()).invoice, state: "waived" },
        }),
      ),
    ).toContain("Written off");
    expect(
      buildInvoicePrintHtml(
        invoice({ total: 0, subtotal: 0, extraCharges: [] }),
        company,
        "en",
        breakdownFor(invoice({ total: 0, subtotal: 0 }), {
          invoice: {
            code: "INV-0011460",
            subtotal: 0,
            discount: 0,
            total: 0,
            paid: 0,
            balance: 0,
            state: "due",
          },
        }),
      ),
    ).toContain("Nothing due");
  });

  test("an unreconciled snapshot prints stored totals without group rows", () => {
    const row = invoice({ paid: 770 });
    const html = buildInvoicePrintHtml(
      row,
      company,
      "en",
      breakdownFor(row, {
        reconciled: false,
        groups: [
          {
            source: "partial",
            method: "cash",
            amount: 200,
            first_paid_on: "2026-01-10",
            last_paid_on: "2026-01-10",
            payments: 1,
          },
        ],
      }),
    );
    expect(html).not.toContain("Partial payment");
    expect(amountRows(html)).toContainEqual(["Paid", "770 KWD"]);
  });
});
