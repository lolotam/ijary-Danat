/**
 * مسار المال في تسوية البوابة: ما تحصّله ماي فاتورة يُسجَّل كاملاً، لا أكثر ولا أقل.
 *
 * The gateway charges `payment_requests.amount`, fixed when the link was issued.
 * Settlement books each month at that invoice's CURRENT balance. Before the
 * Phase 2C fix, a month paid or part-paid elsewhere between issuing the link and
 * the tenant paying it was skipped or booked smaller, and the difference —
 * captured by MyFatoorah — was recorded nowhere.
 *
 * Every case asserts the same invariant: the payments carrying this request's
 * `payment_request_id` add up to exactly what the gateway captured. Excess is
 * recorded as one confirmed, UNALLOCATED payment the office can allocate or
 * refund — never spent on invoices the tenant did not choose.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeDb,
  paymentsTotalForRequest,
  type FakeDb,
} from "@/fns/gatewaySettlementFakeDb.test-support";

const fake = vi.hoisted(() => ({ db: null as FakeDb | null }));
const notifyPaymentSuccess = vi.hoisted(() => vi.fn());

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: (table: string) => (fake.db as FakeDb).client.from(table),
    rpc: (name: string, args: Record<string, unknown>) =>
      (fake.db as FakeDb).client.rpc(name, args),
  }),
}));
vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => ({
    id: "company-1",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
  requireRequestCompany: () => ({
    id: "company-1",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
  runWithRequestCompany: (_company: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/fns/notifyPaymentSuccess.server", () => ({
  notifyPaymentSuccess: (ids: string[]) => notifyPaymentSuccess(ids),
}));
vi.mock("@/lib/suppressedPayments", () => ({
  getSuppressedPaymentIds: async () => new Set<string>(),
}));

const { settleGatewayPayment } = await import("@/fns/gatewaySettlement");

const PREFIX = "MF:7050025";
const EXCESS_REFERENCE = `${PREFIX}#EXCESS`;

const DETAILS = {
  eventType: "webhook",
  invoiceId: "7050025",
  method: "knet" as const,
  paymentId: "100621810000012471",
  providerEventId: "evt-1",
  status: "Paid",
};

/** فاتورة شهرية مفتوحة بالقيمة المعطاة. */
function invoice(id: string, month: number, total: number, paid = 0) {
  return {
    id,
    code: `INV-${id}`,
    tenant_id: "tenant-1",
    unit_id: "unit-1",
    contract_id: "contract-1",
    period_year: 2026,
    period_month: month,
    state: paid >= total ? "paid" : "due",
    total,
    paid,
    balance: total - paid,
  };
}

/** طلب دفع معلّق لفواتير محددة بمبلغ ثابت ساعة إصدار الرابط. */
function paymentRequest(amount: number, invoiceIds: string[]) {
  return {
    id: "preq-1",
    code: "PREQ-0000001",
    status: "pending",
    amount,
    currency: "KWD",
    tenant_id: "tenant-1",
    requested_invoice_ids: invoiceIds,
    provider_invoice_id: "7050025",
    provider_payment_id: null,
    resulting_payment_id: null,
    gateway_response: null,
  };
}

/** دفعة سُجّلت خارج البوابة ومخصّصة لفاتورة (نقداً أو شيك أو دفعة مؤقتة). */
function paidElsewhere(id: string, invoiceId: string, amount: number, reference: string | null) {
  return {
    payment: { id, code: `PAY-${id}`, method: "cash", status: "confirmed", amount, reference },
    allocation: { invoice_id: invoiceId, payment_id: id, amount },
  };
}

/** يبني القاعدة الوهمية ويجعلها ما يراه supabaseAdmin. */
function seed(rows: {
  invoices: ReturnType<typeof invoice>[];
  request: ReturnType<typeof paymentRequest>;
  elsewhere?: ReturnType<typeof paidElsewhere>[];
  payments?: Record<string, unknown>[];
}) {
  const elsewhere = rows.elsewhere ?? [];
  fake.db = createFakeDb({
    invoices: rows.invoices,
    payment_requests: [rows.request],
    tenants: [{ id: "tenant-1", company_id: "co-1" }],
    payments: [...elsewhere.map((entry) => entry.payment), ...(rows.payments ?? [])],
    payment_allocations: elsewhere.map((entry) => entry.allocation),
    receipts: [...elsewhere.map((entry) => entry.payment), ...(rows.payments ?? [])].map(
      (payment) => ({ id: `rcpt-${payment.id}`, payment_id: payment.id, visible_to_tenant: false }),
    ),
  });
  return fake.db;
}

/** دفعات هذا الطلب كما سُجّلت. */
function requestPayments(db: FakeDb) {
  return db.tables.payments.filter((payment) => payment.payment_request_id === "preq-1");
}

/** دفعة الفائض إن وُجدت. */
function excessPayment(db: FakeDb) {
  return db.tables.payments.filter((payment) => payment.reference === EXCESS_REFERENCE);
}

/** مجموع ما خُصّص من دفعة. */
function allocatedFrom(db: FakeDb, paymentId: string) {
  return db.tables.payment_allocations
    .filter((allocation) => allocation.payment_id === paymentId)
    .reduce((sum, allocation) => sum + Number(allocation.amount), 0);
}

/** يتحقق أن دفعات الطلب تساوي ما حصّلته البوابة بالضبط. */
function expectCapturedEqualsBooked(db: FakeDb, captured: number) {
  expect(paymentsTotalForRequest(db, "preq-1")).toBe(captured);
}

beforeEach(() => {
  vi.clearAllMocks();
  notifyPaymentSuccess.mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("gateway settlement books exactly what the gateway captured", () => {
  it("normal: two open months settle as two allocated payments, no excess", async () => {
    const db = seed({
      invoices: [invoice("1", 7, 350), invoice("2", 8, 350)],
      request: paymentRequest(700, ["1", "2"]),
    });

    await settleGatewayPayment(DETAILS, {});

    expect(requestPayments(db).map((payment) => payment.amount)).toEqual([350, 350]);
    expect(db.tables.invoices.map((row) => row.balance)).toEqual([0, 0]);
    expect(excessPayment(db)).toHaveLength(0);
    expectCapturedEqualsBooked(db, 700);
  });

  it("a month paid elsewhere before the callback becomes an unallocated excess payment", async () => {
    const db = seed({
      invoices: [invoice("1", 7, 350), invoice("2", 8, 350, 350)],
      request: paymentRequest(700, ["1", "2"]),
      elsewhere: [paidElsewhere("cash-1", "2", 350, "Cash desk")],
    });

    await settleGatewayPayment(DETAILS, {});

    const [excess] = excessPayment(db);
    expect(excess).toMatchObject({
      amount: 350,
      status: "confirmed",
      payment_request_id: "preq-1",
    });
    expect(allocatedFrom(db, excess.id as string)).toBe(0);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ p_action: "payment.gateway_excess" }),
    );
    expectCapturedEqualsBooked(db, 700);
  });

  it("a month part-paid in cash books its remaining balance and the cash share as excess", async () => {
    const db = seed({
      invoices: [invoice("1", 7, 350), invoice("2", 8, 350, 100)],
      request: paymentRequest(700, ["1", "2"]),
      elsewhere: [paidElsewhere("cash-1", "2", 100, "Cash desk")],
    });

    await settleGatewayPayment(DETAILS, {});

    const monthly = requestPayments(db).filter((payment) => payment.reference !== EXCESS_REFERENCE);
    expect(monthly.map((payment) => payment.amount)).toEqual([350, 250]);
    expect(excessPayment(db)[0]).toMatchObject({ amount: 100 });
    expect(db.tables.invoices.map((row) => row.balance)).toEqual([0, 0]);
    expectCapturedEqualsBooked(db, 700);
  });

  it("every month already paid by a real payment: the whole charge is excess, nothing re-allocated", async () => {
    const db = seed({
      invoices: [invoice("1", 7, 350, 350)],
      request: paymentRequest(350, ["1"]),
      elsewhere: [paidElsewhere("chq-1", "1", 350, "Cheque 4471")],
    });
    const allocationsBefore = db.tables.payment_allocations.length;

    await settleGatewayPayment(DETAILS, {});

    expect(excessPayment(db)[0]).toMatchObject({ amount: 350 });
    expect(db.tables.payment_allocations).toHaveLength(allocationsBefore);
    expect(db.tables.payment_requests[0]).toMatchObject({
      status: "completed",
      resulting_payment_id: excessPayment(db)[0].id,
    });
    expectCapturedEqualsBooked(db, 350);
  });

  it("every month paid by admin placeholders: they are adopted, and there is no excess", async () => {
    const db = seed({
      invoices: [invoice("1", 7, 350, 350)],
      request: paymentRequest(350, ["1"]),
      elsewhere: [paidElsewhere("auto-1", "1", 350, "AUTO-INV:INV-1")],
    });

    await settleGatewayPayment(DETAILS, {});

    expect(db.tables.payments.find((payment) => payment.id === "auto-1")).toMatchObject({
      method: "knet",
      payment_request_id: "preq-1",
    });
    expect(excessPayment(db)).toHaveLength(0);
    expectCapturedEqualsBooked(db, 350);
  });

  it("a balance that grew after the link was issued is capped at what was captured", async () => {
    const db = seed({
      invoices: [invoice("1", 7, 400), invoice("2", 8, 350)],
      request: paymentRequest(700, ["1", "2"]),
    });

    await settleGatewayPayment(DETAILS, {});

    expect(requestPayments(db).map((payment) => payment.amount)).toEqual([400, 300]);
    expect(db.tables.invoices.map((row) => row.balance)).toEqual([0, 50]);
    expect(excessPayment(db)).toHaveLength(0);
    expectCapturedEqualsBooked(db, 700);
  });

  it("two concurrent settlements carrying different payment ids book the charge once", async () => {
    // T155 review #1: the reference prefix used to come from the caller's
    // paymentId, so a failed retry's id and the paid id wrote two references
    // and a second payment with no money behind it.
    const db = seed({
      invoices: [invoice("1", 7, 350), invoice("2", 8, 350)],
      request: paymentRequest(700, ["1", "2"]),
    });

    await Promise.allSettled([
      settleGatewayPayment(DETAILS, {}),
      settleGatewayPayment(
        { ...DETAILS, paymentId: "100621810000099999", providerEventId: "evt-2" },
        {},
      ),
    ]);

    expect(
      requestPayments(db).every((payment) => String(payment.reference).startsWith(PREFIX)),
    ).toBe(true);
    expectCapturedEqualsBooked(db, 700);
  });

  it("a replayed webhook after a full settlement writes nothing new", async () => {
    const db = seed({
      invoices: [invoice("1", 7, 350), invoice("2", 8, 350, 350)],
      request: paymentRequest(700, ["1", "2"]),
      elsewhere: [paidElsewhere("cash-1", "2", 350, "Cash desk")],
    });
    await settleGatewayPayment(DETAILS, {});
    const paymentsAfterFirst = db.tables.payments.length;
    const allocationsAfterFirst = db.tables.payment_allocations.length;

    await settleGatewayPayment(DETAILS, {});

    expect(db.tables.payments).toHaveLength(paymentsAfterFirst);
    expect(db.tables.payment_allocations).toHaveLength(allocationsAfterFirst);
    expectCapturedEqualsBooked(db, 700);
  });

  it("resuming after a crash counts payments already written and records the excess once", async () => {
    const db = seed({
      invoices: [invoice("1", 7, 350), invoice("2", 8, 350, 350)],
      request: paymentRequest(700, ["1", "2"]),
      elsewhere: [paidElsewhere("cash-1", "2", 350, "Cash desk")],
      // The first run created month 1's payment and the excess, then died
      // before allocating or completing the request.
      payments: [
        {
          id: "prior-1",
          code: "PAY-prior-1",
          method: "knet",
          status: "confirmed",
          amount: 350,
          reference: `${PREFIX}#INV-1`,
          payment_request_id: "preq-1",
        },
        {
          id: "prior-x",
          code: "PAY-prior-x",
          method: "knet",
          status: "confirmed",
          amount: 350,
          reference: EXCESS_REFERENCE,
          payment_request_id: "preq-1",
        },
      ],
    });

    await settleGatewayPayment(DETAILS, {});

    expect(requestPayments(db)).toHaveLength(2);
    expect(allocatedFrom(db, "prior-1")).toBe(350);
    expect(excessPayment(db)).toHaveLength(1);
    expect(db.tables.invoices[0]).toMatchObject({ balance: 0 });
    expectCapturedEqualsBooked(db, 700);
  });
});
