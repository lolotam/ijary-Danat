import { describe, expect, test } from "vitest";

import type { ContractCloseoutWithLines } from "@/hooks/useContractCloseouts";
import { closeoutStatementHtml } from "@/lib/closeoutStatement";

function makeCloseout(
  overrides: Partial<ContractCloseoutWithLines> = {},
): ContractCloseoutWithLines {
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    contract_id: "contract-1",
    tenant_id: "tenant-1",
    unit_id: "unit-1",
    building_id: null,
    company_id: null,
    status: "completed",
    outcome: "archive",
    final_contract_state: "terminated",
    archive_tenant: false,
    move_out_date: "2026-08-01",
    // Header totals deliberately disagree with line items — HEADER must win.
    deposit_held: 1000,
    deductions_total: 999,
    settled_total: 888,
    written_off_total: 777,
    refund_total: 666,
    balance_due_tenant: 555,
    refund_id: null,
    idempotency_key: "idem-1",
    result: {
      invoice_actions: [
        {
          invoice_id: "inv-1",
          invoice_code: "INV-1",
          action: "leave",
          amount: 1,
          previous_state: "due",
          resulting_state: "due",
        },
      ],
      unit_status: "vacant",
      tenant_archived: false,
      archived_at: "2026-08-01T12:00:00Z",
    },
    contract_updated_at: null,
    note: "note",
    created_by: null,
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T12:00:00Z",
    completed_by: "user-1",
    completed_at: "2026-08-01T12:00:00Z",
    cancelled_at: null,
    cancelled_by: null,
    deductions: [
      {
        id: "d1",
        closeout_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        line: 1,
        kind: "damages",
        description_ar: "ضرر",
        description_en: "Damage",
        amount: 1, // disagrees with header 999
        created_at: "2026-08-01T10:00:00Z",
      },
    ],
    invoiceActions: [
      {
        id: "a1",
        closeout_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        invoice_id: "inv-1",
        action: "leave",
        amount: 1, // disagrees with header settled/written-off
        previous_state: "due",
        resulting_state: "due",
        created_at: "2026-08-01T10:00:00Z",
      },
    ],
    ...overrides,
  };
}

const baseArgs = {
  contract: {
    code: "CTR-1",
    start_date: "2025-01-01",
    end_date: "2025-12-31",
    state: "terminated",
  },
  tenant: { name: "Sara", code: "T-1" },
  unit: { name: "Unit 12", code: "U-12", property_name: "Tower" },
  company: { name_ar: "دانة", name_en: "Danat", phone: null, logo_url: null },
};

describe("closeoutStatementHtml", () => {
  test("renders the PERSISTED header totals, not recomputed line sums", () => {
    const doc = closeoutStatementHtml({
      ...baseArgs,
      closeout: makeCloseout(),
      locale: "en",
    });

    // Header values must appear; the tiny line amounts must not replace them.
    expect(doc.html).toContain("999");
    expect(doc.html).toContain("888");
    expect(doc.html).toContain("777");
    expect(doc.html).toContain("666");
    expect(doc.html).toContain("555");
    expect(doc.html).toContain("1,000");
    // Document shape
    expect(doc.dir).toBe("ltr");
    expect(doc.filename).toMatch(/\.pdf$/);
    expect(doc.title.length).toBeGreaterThan(0);
  });

  test("locale=ar sets dir=rtl and contains Arabic labels", () => {
    const doc = closeoutStatementHtml({
      ...baseArgs,
      closeout: makeCloseout(),
      locale: "ar",
    });

    expect(doc.dir).toBe("rtl");
    expect(doc.html).toContain('dir="rtl"');
    expect(doc.html).toContain("بيان إغلاق عقد");
    expect(doc.html).toContain("المستأجر");
    expect(doc.html).toContain("مبلغ الاسترداد");
  });

  test("labels the written-off row as written off in Arabic, matching the figure it prints", () => {
    // The Arabic label once read "total remaining before settlement" over the
    // written-off amount — a different figure under the same row on a document
    // a departing tenant receives.
    const doc = closeoutStatementHtml({
      ...baseArgs,
      closeout: makeCloseout(),
      locale: "ar",
    });
    const row = doc.html.match(/<td>إجمالي المبالغ المشطوبة<\/td>\s*<td>([^<]*)<\/td>/);
    expect(row?.[1]).toContain("777");
    expect(doc.html).not.toContain("إجمالي المتبقي (قبل التسوية)");
  });
});
