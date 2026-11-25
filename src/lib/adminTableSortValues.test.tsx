/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useTableSort } from "@/components/admin/SortableTable";
import {
  contractPaymentSortValue,
  generatedReportSortValue,
  moneyRecordSortValue,
  notificationLogSortValue,
  notificationTemplateSortValue,
  propertyUnitSortValue,
  reportPreviewSortValue,
  reportScheduleSortValue,
  tenantInvoiceSortValue,
  tenantWidePaymentSortValue,
  unitContractSortValue,
  unitInvoiceSortValue,
  unitPaymentSortValue,
} from "@/lib/adminTableSortValues";

let host: HTMLDivElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

/**
 * يشغّل useTableSort الحقيقي ويطبّق نقرات الرأس بالترتيب المعطى.
 *
 * The hook's direction lives in useState, so a static render cannot prove a
 * second click reverses. This is the same primitive the tables call — not a
 * copy of its compare.
 */
function sortAfterClicks<T>(
  rows: T[],
  getValue: (row: T, key: string) => unknown,
  clicks: string[],
): T[] {
  host = document.createElement("div");
  document.body.appendChild(host);
  let sorted = rows;
  let toggle = (_key: string) => {};

  function Probe() {
    const state = useTableSort(rows, getValue);
    sorted = state.sorted;
    toggle = state.toggle;
    return null;
  }

  const root = createRoot(host);
  act(() => {
    root.render(<Probe />);
  });
  for (const key of clicks) {
    act(() => {
      toggle(key);
    });
  }
  const result = [...sorted];
  act(() => {
    root.unmount();
  });
  return result;
}

/**
 * يثبت أن العمود يرتّب بالقيمة الخام، وأن النقر الثاني يعكس، وأن عموداً جديداً يعود تصاعدياً.
 */
function expectValueSort<T>(
  rows: T[],
  getValue: (row: T, key: string) => unknown,
  key: string,
  pick: (row: T) => unknown,
  expectedAsc: unknown[],
  otherKey: string,
) {
  const asc = sortAfterClicks(rows, getValue, [key]);
  expect(asc.map(pick)).toEqual(expectedAsc);
  const desc = sortAfterClicks(rows, getValue, [key, key]);
  expect(desc.map(pick)).toEqual([...expectedAsc].reverse());
  const switched = sortAfterClicks(rows, getValue, [key, otherKey]);
  const otherDirect = sortAfterClicks(rows, getValue, [otherKey]);
  expect(switched.map(pick)).toEqual(otherDirect.map(pick));
}

describe("property units table", () => {
  const rows = [
    {
      code: "U-10",
      default_rent: 10,
      floor: "1",
      name: "Shop 10",
      occupant: { name: "Zaid" },
      paci_no: "P10",
      status: "occupied",
      type: "shop",
    },
    {
      code: "U-9",
      default_rent: 9,
      floor: "2",
      name: "Shop 9",
      occupant: { name: "Ali" },
      paci_no: "P9",
      status: "vacant",
      type: "commercial",
    },
  ];

  it("sorts rent as a number so 9 comes before 10, not as '10 KWD' text", () => {
    expect(propertyUnitSortValue(rows[0], "rent")).toBe(10);
    expect(propertyUnitSortValue(rows[1], "rent")).toBe(9);
    expectValueSort(
      rows,
      propertyUnitSortValue,
      "rent",
      (row) => row.default_rent,
      [9, 10],
      "code",
    );
  });
});

describe("unit contracts table", () => {
  const rows = [
    {
      code: "C-10",
      end_date: "2027-10-01",
      monthly_amount: 10,
      start_date: "2026-10-01",
      state: "active",
      tenant: { name: "Zaid" },
    },
    {
      code: "C-9",
      end_date: "2027-09-01",
      monthly_amount: 9,
      start_date: "2026-09-01",
      state: "expired",
      tenant: { name: "Ali" },
    },
  ];

  it("sorts monthly amount as a number so 9 comes before 10", () => {
    expect(unitContractSortValue(rows[0], "monthly_amount")).toBe(10);
    expect(unitContractSortValue(rows[1], "monthly_amount")).toBe(9);
    expectValueSort(
      rows,
      unitContractSortValue,
      "monthly_amount",
      (row) => row.monthly_amount,
      [9, 10],
      "code",
    );
  });

  it("sorts start_date by ISO month order, not English month names", () => {
    // "October" < "September" as text; ISO 2026-09-01 < 2026-10-01.
    expect(unitContractSortValue(rows[0], "start_date")).toBe("2026-10-01");
    expectValueSort(
      rows,
      unitContractSortValue,
      "start_date",
      (row) => row.start_date,
      ["2026-09-01", "2026-10-01"],
      "code",
    );
  });
});

describe("unit monthly invoices table", () => {
  const rows = [
    {
      balance: 10,
      code: "INV-10",
      period_month: 10,
      period_year: 2026,
      state: "issued",
      total: 10,
    },
    { balance: 9, code: "INV-9", period_month: 9, period_year: 2026, state: "paid", total: 9 },
  ];

  it("sorts total as a number so 9 comes before 10", () => {
    expect(unitInvoiceSortValue(rows[0], "total")).toBe(10);
    expect(unitInvoiceSortValue(rows[1], "total")).toBe(9);
    expectValueSort(rows, unitInvoiceSortValue, "total", (row) => row.total, [9, 10], "code");
  });

  it("sorts the period by year then month, not as 'October 2026' text", () => {
    expect(unitInvoiceSortValue(rows[0], "period")).toBe(202610);
    expect(unitInvoiceSortValue(rows[1], "period")).toBe(202609);
    expectValueSort(
      rows,
      unitInvoiceSortValue,
      "period",
      (row) => unitInvoiceSortValue(row, "period"),
      [202609, 202610],
      "code",
    );
  });
});

describe("unit manual payments table", () => {
  const rows = [
    {
      amount: 10,
      code: "PAY-10",
      method: "cash",
      payment_date: "2026-10-01",
      status: "confirmed",
    },
    {
      amount: 9,
      code: "PAY-9",
      method: "knet",
      payment_date: "2026-09-01",
      status: "pending",
    },
  ];

  it("sorts amount as a number so 9 comes before 10", () => {
    expect(unitPaymentSortValue(rows[0], "amount")).toBe(10);
    expect(unitPaymentSortValue(rows[1], "amount")).toBe(9);
    expectValueSort(rows, unitPaymentSortValue, "amount", (row) => row.amount, [9, 10], "code");
  });

  it("sorts payment_date chronologically across months", () => {
    expect(unitPaymentSortValue(rows[0], "payment_date")).toBe("2026-10-01");
    expectValueSort(
      rows,
      unitPaymentSortValue,
      "payment_date",
      (row) => row.payment_date,
      ["2026-09-01", "2026-10-01"],
      "code",
    );
  });
});

describe("reports preview table", () => {
  const rows = [
    { amount: 10, code: "E-10", expense_date: "2026-10-01" },
    { amount: 9, code: "E-9", expense_date: "2026-09-01" },
  ];

  it("sorts a money column by the raw number, not a formatted string", () => {
    expect(reportPreviewSortValue(rows[0], "amount")).toBe(10);
    expect(reportPreviewSortValue(rows[1], "amount")).toBe(9);
    expectValueSort(rows, reportPreviewSortValue, "amount", (row) => row.amount, [9, 10], "code");
  });

  it("sorts a date column by the ISO value, not a locale month name", () => {
    expect(reportPreviewSortValue(rows[0], "expense_date")).toBe("2026-10-01");
    expectValueSort(
      rows,
      reportPreviewSortValue,
      "expense_date",
      (row) => row.expense_date,
      ["2026-09-01", "2026-10-01"],
      "code",
    );
  });
});

describe("scheduled reports table", () => {
  const rows = [
    {
      code: "S-10",
      frequency: "yearly",
      is_active: true,
      last_run_at: "2026-10-01T00:00:00.000Z",
      locale: "en",
      name_ar: "سنوي",
      name_en: "Yearly",
      next_run_at: "2026-11-01T00:00:00.000Z",
      recipients: ["b@x.com"],
    },
    {
      code: "S-9",
      frequency: "monthly",
      is_active: false,
      last_run_at: "2026-09-01T00:00:00.000Z",
      locale: "ar",
      name_ar: "شهري",
      name_en: "Monthly",
      next_run_at: "2026-10-01T00:00:00.000Z",
      recipients: ["a@x.com"],
    },
  ];
  const getValue = (row: (typeof rows)[number], key: string) =>
    reportScheduleSortValue(row, key, "en");

  it("sorts last_run_at chronologically across months", () => {
    expect(getValue(rows[0], "last_run_at")).toBe("2026-10-01T00:00:00.000Z");
    expectValueSort(
      rows,
      getValue,
      "last_run_at",
      (row) => row.last_run_at,
      ["2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"],
      "code",
    );
  });
});

describe("generated reports table", () => {
  const rows = [
    {
      created_at: "2026-10-01T12:00:00.000Z",
      locale: "en",
      period_end: "2026-10-31",
      period_start: "2026-10-01",
      schedule: { code: "S-10", name_ar: "سنوي", name_en: "Yearly" },
      sent: true,
    },
    {
      created_at: "2026-09-01T12:00:00.000Z",
      locale: "ar",
      period_end: "2026-09-30",
      period_start: "2026-09-01",
      schedule: { code: "S-9", name_ar: "شهري", name_en: "Monthly" },
      sent: false,
    },
  ];
  const getValue = (row: (typeof rows)[number], key: string) =>
    generatedReportSortValue(row, key, "en");

  it("sorts created_at (last run) chronologically across months", () => {
    expect(getValue(rows[0], "created_at")).toBe("2026-10-01T12:00:00.000Z");
    expectValueSort(
      rows,
      getValue,
      "created_at",
      (row) => row.created_at,
      ["2026-09-01T12:00:00.000Z", "2026-10-01T12:00:00.000Z"],
      "code",
    );
  });

  it("sorts period_start by ISO date, not as 'October 2026' text", () => {
    expect(getValue(rows[0], "period")).toBe("2026-10-01");
    expectValueSort(
      rows,
      getValue,
      "period",
      (row) => row.period_start,
      ["2026-09-01", "2026-10-01"],
      "code",
    );
  });
});

describe("notification pool table", () => {
  const rows = [
    {
      audience: "tenant",
      channel: "email",
      contract: null,
      failure_reason: "timeout",
      invoice: { code: "INV-10" },
      locale: "en",
      provider: "smtp",
      provider_message_id: "b",
      recipient_address: "b@x.com",
      retry_count: 10,
      scheduled_at: "2026-10-01T08:00:00.000Z",
      sender_address: "from@x.com",
      sent_at: "2026-10-01T09:00:00.000Z",
      state: "failed",
      template_code: "due_reminder",
      tenant: { name: "Zaid" },
      type: "due_reminder",
    },
    {
      audience: "admin",
      channel: "whatsapp",
      contract: { code: "C-9" },
      failure_reason: null,
      invoice: null,
      locale: "ar",
      provider: "twilio",
      provider_message_id: "a",
      recipient_address: "a@x.com",
      retry_count: 2,
      scheduled_at: "2026-09-01T08:00:00.000Z",
      sender_address: "from@x.com",
      sent_at: "2026-09-01T09:00:00.000Z",
      state: "sent",
      template_code: "receipt",
      tenant: { name: "Ali" },
      type: "receipt",
    },
  ];

  it("sorts scheduled_at chronologically across months", () => {
    expect(notificationLogSortValue(rows[0], "scheduledAt")).toBe("2026-10-01T08:00:00.000Z");
    expectValueSort(
      rows,
      notificationLogSortValue,
      "scheduledAt",
      (row) => row.scheduled_at,
      ["2026-09-01T08:00:00.000Z", "2026-10-01T08:00:00.000Z"],
      "tenant",
    );
  });

  it("sorts retry_count as a number so 2 comes before 10", () => {
    expect(notificationLogSortValue(rows[0], "retries")).toBe(10);
    expect(notificationLogSortValue(rows[1], "retries")).toBe(2);
    expectValueSort(
      rows,
      notificationLogSortValue,
      "retries",
      (row) => row.retry_count,
      [2, 10],
      "tenant",
    );
  });
});

describe("notification templates table", () => {
  const rows = [
    { channel: "email", code: "zebra", is_active: true, type: "receipt" },
    { channel: "whatsapp", code: "alpha", is_active: false, type: "due_reminder" },
  ];

  it("sorts is_active as a boolean, not as translated yes/no text", () => {
    expect(notificationTemplateSortValue(rows[0], "is_active")).toBe(true);
    expect(notificationTemplateSortValue(rows[1], "is_active")).toBe(false);
    expectValueSort(
      rows,
      notificationTemplateSortValue,
      "is_active",
      (row) => row.is_active,
      [false, true],
      "code",
    );
  });
});

describe("refund / partial / insurance payment tables", () => {
  const rows = [
    {
      amount: 10,
      contract_id: "c-10",
      note: "later",
      refund_date: "2026-10-01",
    },
    {
      amount: 9,
      contract_id: "c-9",
      note: "earlier",
      refund_date: "2026-09-01",
    },
  ];
  const contracts = {
    "c-10": { code: "C-10", complexName: "Tower B", tenantName: "Zaid", unitName: "U-10" },
    "c-9": { code: "C-9", complexName: "Tower A", tenantName: "Ali", unitName: "U-9" },
  };
  const getValue = (row: (typeof rows)[number], key: string) =>
    moneyRecordSortValue(row, key, {
      contract: contracts[row.contract_id as keyof typeof contracts],
      dateColumn: "refund_date",
    });

  it("sorts amount as a number so 9 comes before 10 on all three money-record tables", () => {
    expect(getValue(rows[0], "amount")).toBe(10);
    expect(getValue(rows[1], "amount")).toBe(9);
    expectValueSort(rows, getValue, "amount", (row) => row.amount, [9, 10], "note");
  });

  it("sorts the date column chronologically across months", () => {
    expect(getValue(rows[0], "date")).toBe("2026-10-01");
    expectValueSort(
      rows,
      getValue,
      "date",
      (row) => row.refund_date,
      ["2026-09-01", "2026-10-01"],
      "note",
    );
  });
});

/**
 * يغطّي الجداول الثلاثة في تفاصيل المستأجر — الفواتير، دفعات المستأجر الشامل، ودفعات العقد.
 *
 * Each table's money column must return a NUMBER so 9 sorts before 10 (not "10"
 * before "9" as text), its date column must return an ISO string that sorts
 * across a month boundary, and toggling the same header twice must reverse
 * direction while clicking a different header resets to ascending. The
 * `expectValueSort` helper pins all three behaviours at once.
 */
describe("tenant-detail invoices table", () => {
  const rows = [
    {
      balance: 10,
      code: "INV-10",
      discount: 10,
      due_date: "2026-10-10",
      period_month: 10,
      period_year: 2026,
      properties: [{ name_ar: "العقار ب", name_en: "Property B" }],
      state: "issued",
      total: 10,
      units: [{ code: "U-10", name: "Shop 10" }],
    },
    {
      balance: 9,
      code: "INV-9",
      discount: 9,
      due_date: "2026-09-10",
      period_month: 9,
      period_year: 2026,
      properties: [{ name_ar: "العقار أ", name_en: "Property A" }],
      state: "paid",
      total: 9,
      units: [{ code: "U-9", name: "Shop 9" }],
    },
  ];

  it("sorts total as a number so 9 comes before 10", () => {
    expect(tenantInvoiceSortValue(rows[0], "total")).toBe(10);
    expect(tenantInvoiceSortValue(rows[1], "total")).toBe(9);
    expectValueSort(rows, tenantInvoiceSortValue, "total", (row) => row.total, [9, 10], "code");
  });

  it("sorts balance as a number so 9 comes before 10", () => {
    expect(tenantInvoiceSortValue(rows[0], "balance")).toBe(10);
    expect(tenantInvoiceSortValue(rows[1], "balance")).toBe(9);
    expectValueSort(rows, tenantInvoiceSortValue, "balance", (row) => row.balance, [9, 10], "code");
  });

  it("sorts discount as the raw KWD amount, not the badge's month count", () => {
    expect(tenantInvoiceSortValue(rows[0], "discount")).toBe(10);
    expect(tenantInvoiceSortValue(rows[1], "discount")).toBe(9);
    expectValueSort(
      rows,
      tenantInvoiceSortValue,
      "discount",
      (row) => row.discount,
      [9, 10],
      "code",
    );
  });

  it("sorts due_date by ISO date across a month boundary", () => {
    expect(tenantInvoiceSortValue(rows[0], "due_date")).toBe("2026-10-10");
    expectValueSort(
      rows,
      tenantInvoiceSortValue,
      "due_date",
      (row) => row.due_date,
      ["2026-09-10", "2026-10-10"],
      "code",
    );
  });

  it("sorts period by year*100+month so 202609 precedes 202610", () => {
    expect(tenantInvoiceSortValue(rows[0], "period")).toBe(202610);
    expect(tenantInvoiceSortValue(rows[1], "period")).toBe(202609);
    expectValueSort(
      rows,
      tenantInvoiceSortValue,
      "period",
      (row) => tenantInvoiceSortValue(row, "period"),
      [202609, 202610],
      "code",
    );
  });
});

describe("tenant-wide payments table", () => {
  const rows = [
    {
      amount: 10,
      code: "PAY-10",
      method: "cash",
      payment_date: "2026-10-01",
      status: "confirmed",
    },
    {
      amount: 9,
      code: "PAY-9",
      method: "knet",
      payment_date: "2026-09-01",
      status: "pending",
    },
  ];

  it("sorts amount as a number so 9 comes before 10", () => {
    expect(tenantWidePaymentSortValue(rows[0], "amount")).toBe(10);
    expect(tenantWidePaymentSortValue(rows[1], "amount")).toBe(9);
    expectValueSort(
      rows,
      tenantWidePaymentSortValue,
      "amount",
      (row) => row.amount,
      [9, 10],
      "code",
    );
  });

  it("sorts date by ISO string across a month boundary", () => {
    expect(tenantWidePaymentSortValue(rows[0], "date")).toBe("2026-10-01");
    expectValueSort(
      rows,
      tenantWidePaymentSortValue,
      "date",
      (row) => row.payment_date,
      ["2026-09-01", "2026-10-01"],
      "code",
    );
  });
});

describe("per-contract payments table", () => {
  const rows = [
    {
      allocated: 10,
      amount: 10,
      code: "PAY-10",
      method: "cash",
      payment_date: "2026-10-01",
      status: "confirmed",
    },
    {
      allocated: 9,
      amount: 9,
      code: "PAY-9",
      method: "knet",
      payment_date: "2026-09-01",
      status: "pending",
    },
  ];

  it("sorts amount as a number so 9 comes before 10", () => {
    expect(contractPaymentSortValue(rows[0], "amount")).toBe(10);
    expect(contractPaymentSortValue(rows[1], "amount")).toBe(9);
    expectValueSort(rows, contractPaymentSortValue, "amount", (row) => row.amount, [9, 10], "code");
  });

  it("sorts allocated-to-contract as a number so 9 comes before 10", () => {
    expect(contractPaymentSortValue(rows[0], "allocated")).toBe(10);
    expect(contractPaymentSortValue(rows[1], "allocated")).toBe(9);
    expectValueSort(
      rows,
      contractPaymentSortValue,
      "allocated",
      (row) => row.allocated,
      [9, 10],
      "code",
    );
  });

  it("sorts date by ISO string across a month boundary", () => {
    expect(contractPaymentSortValue(rows[0], "date")).toBe("2026-10-01");
    expectValueSort(
      rows,
      contractPaymentSortValue,
      "date",
      (row) => row.payment_date,
      ["2026-09-01", "2026-10-01"],
      "code",
    );
  });
});

/**
 * يثبت سلوك التبديل بشكل صريح: نقرتان على نفس الرأس تعكسان، ورأس مختلف يعود تصاعدياً.
 *
 * `expectValueSort` already pins these behaviours for every column it covers.
 * This block names them directly so the contract is unmistakable and a future
 * regression in `useTableSort`'s `toggle` is caught here even if the per-column
 * suites are removed.
 */
describe("toggle behaviour on tenant-detail tables", () => {
  const rows = [
    { amount: 10, code: "A", method: "cash", payment_date: "2026-10-01", status: "confirmed" },
    { amount: 9, code: "B", method: "knet", payment_date: "2026-09-01", status: "pending" },
  ];

  it("toggling the same header twice reverses to descending", () => {
    const asc = sortAfterClicks(rows, tenantWidePaymentSortValue, ["amount"]);
    expect(asc.map((r) => r.amount)).toEqual([9, 10]);
    const desc = sortAfterClicks(rows, tenantWidePaymentSortValue, ["amount", "amount"]);
    expect(desc.map((r) => r.amount)).toEqual([10, 9]);
  });

  it("clicking a different header resets to ascending on that header", () => {
    // Sort by amount desc first, then switch to code — code should be ascending.
    const switched = sortAfterClicks(rows, tenantWidePaymentSortValue, [
      "amount",
      "amount",
      "code",
    ]);
    expect(switched.map((r) => r.code)).toEqual(["A", "B"]);
  });
});
