/**
 * رابط قديم استُبدل ثم دُفع: يجب أن يُسجَّل ما حصّلته البوابة عليه كاملاً.
 *
 * Since migration 223 a replaced link keeps its own `superseded` request row.
 * Every charge — on the old link or the new one, in either order — must land
 * as payments carrying ITS request's id and adding up to exactly what that
 * link captured: months where there is still a balance, `#EXCESS` for the
 * rest. Before this, the old row was reset in place and a charge on its link
 * matched nothing.
 *
 * The reconcile job is part of the path: the webhook does not settle in
 * production, so the cron's poll is what finds a paid superseded link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeDb,
  paymentsTotalForRequest,
  type FakeDb,
} from "@/fns/gatewaySettlementFakeDb.test-support";

const fake = vi.hoisted(() => ({ db: null as FakeDb | null }));
const notifyPaymentSuccess = vi.hoisted(() => vi.fn());
const fetchGatewayPaymentStatus = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => (fake.db as FakeDb).client.from(table),
    rpc: (name: string, args: Record<string, unknown>) =>
      (fake.db as FakeDb).client.rpc(name, args),
  },
}));
vi.mock("@/fns/notifyPaymentSuccess", () => ({
  notifyPaymentSuccess: (ids: string[]) => notifyPaymentSuccess(ids),
}));
vi.mock("@/fns/myfatoorahGateway", () => ({
  gatewayConfigFromEnv: () => ({ apiKey: "k", baseUrl: "https://apitest.myfatoorah.com" }),
}));
vi.mock("@/fns/confirmGatewayPayment", async () => {
  const actual =
    await vi.importActual<typeof import("./confirmGatewayPayment")>("./confirmGatewayPayment");
  return {
    paymentOutcome: actual.paymentOutcome,
    fetchGatewayPaymentStatus: (...args: unknown[]) => fetchGatewayPaymentStatus(...args),
  };
});

const { settleGatewayPayment } = await import("@/fns/gatewaySettlement");
const { reservePaymentRequest } = await import("@/fns/paymentRequestReservation");
const { runPaymentReconcileJob } = await import("@/fns/paymentReconcileJob");

const NOW = new Date("2026-09-24T12:00:00.000Z");

/** فاتورة شهرية مفتوحة بالقيمة المعطاة. */
function invoice(id: string, month: number, total: number) {
  return {
    id,
    code: `INV-${id}`,
    tenant_id: "tenant-1",
    unit_id: "unit-1",
    contract_id: "contract-1",
    period_year: 2026,
    period_month: month,
    state: "due",
    total,
    paid: 0,
    balance: total,
  };
}

/** يحجز طلباً لكل الفواتير المفتوحة بطريقة معيّنة ويكتب رابطه كما تفعل البوابة. */
async function issueLink(providerInvoiceId: string, method: "KNET" | "GOOGLE_PAY") {
  const reservation = await reservePaymentRequest({
    selection: {
      invoiceIds: ["1", "2"],
      invoices: [],
      total: 700,
    },
    tenantId: "tenant-1",
    userId: "user-1",
    paymentMethod: method,
  });
  const row = (fake.db as FakeDb).tables.payment_requests.find(
    (request) => request.id === reservation.request.id,
  )!;
  Object.assign(row, {
    provider_invoice_id: providerInvoiceId,
    payment_url: `https://myfatoorah.com/${providerInvoiceId}`,
    request_payload: { PaymentMethod: method },
  });
  return row.id as string;
}

/** حدث بوابة مدفوع لرابط معيّن. */
function paidEvent(providerInvoiceId: string, paymentId: string) {
  return {
    eventType: "webhook",
    invoiceId: providerInvoiceId,
    method: "knet" as const,
    paymentId,
    providerEventId: `evt-${paymentId}`,
    status: "Paid",
  };
}

/** صف طلب الدفع بمعرّفه. */
function requestRow(id: string) {
  return (fake.db as FakeDb).tables.payment_requests.find((row) => row.id === id)!;
}

/** دفعات الفائض المسجّلة لطلب. */
function excessFor(requestId: string) {
  return (fake.db as FakeDb).tables.payments.filter(
    (payment) =>
      payment.payment_request_id === requestId && String(payment.reference).endsWith("#EXCESS"),
  );
}

/** يُنشئ رابطاً قديماً بـ KNET ثم يستبدله برابط Google Pay للفواتير نفسها. */
async function oldAndNewLinks() {
  const oldId = await issueLink("MF-OLD", "KNET");
  const newId = await issueLink("MF-NEW", "GOOGLE_PAY");
  expect(requestRow(oldId).status).toBe("superseded");
  return { oldId, newId };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.clearAllMocks();
  notifyPaymentSuccess.mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake.db = createFakeDb({
    invoices: [invoice("1", 8, 350), invoice("2", 9, 350)],
    tenants: [{ id: "tenant-1", company_id: "co-1" }],
    contracts: [{ id: "contract-1", suppress_tenant_billing_docs: false, hide_from_portal: false }],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a replaced payment link settles on its own request", () => {
  it("the new link paid normally books both months against the new request", async () => {
    const { oldId, newId } = await oldAndNewLinks();

    await settleGatewayPayment(paidEvent("MF-NEW", "PAY-NEW"), {});

    expect(paymentsTotalForRequest(fake.db!, newId)).toBe(700);
    expect(excessFor(newId)).toHaveLength(0);
    expect(requestRow(newId).status).toBe("completed");
    expect(requestRow(oldId).status).toBe("superseded");
  });

  it("the old link paid after the new one settled: its whole charge is excess on the old request", async () => {
    const { oldId, newId } = await oldAndNewLinks();
    await settleGatewayPayment(paidEvent("MF-NEW", "PAY-NEW"), {});

    await settleGatewayPayment(paidEvent("MF-OLD", "PAY-OLD"), {});

    expect(excessFor(oldId)[0]).toMatchObject({ amount: 700 });
    // An ordinary contract's excess receipt is shown to the tenant.
    const excessReceipt = fake.db!.tables.receipts.find(
      (receipt) => receipt.payment_id === excessFor(oldId)[0].id,
    );
    expect(excessReceipt).toMatchObject({ visible_to_tenant: true });
    expect(requestRow(oldId)).toMatchObject({
      status: "completed",
      resulting_payment_id: excessFor(oldId)[0].id,
    });
    expect(paymentsTotalForRequest(fake.db!, oldId)).toBe(700);
    expect(paymentsTotalForRequest(fake.db!, newId)).toBe(700);
  });

  it("the old link paid first settles normally, and the new link's charge becomes excess", async () => {
    const { oldId, newId } = await oldAndNewLinks();

    await settleGatewayPayment(paidEvent("MF-OLD", "PAY-OLD"), {});
    await settleGatewayPayment(paidEvent("MF-NEW", "PAY-NEW"), {});

    expect(excessFor(oldId)).toHaveLength(0);
    expect(excessFor(newId)[0]).toMatchObject({ amount: 700 });
    expect(paymentsTotalForRequest(fake.db!, oldId)).toBe(700);
    expect(paymentsTotalForRequest(fake.db!, newId)).toBe(700);
  });
});

/** يحذف فواتير من القاعدة الوهمية كما يفعل إعادة توليد الفواتير. */
function deleteInvoices(...ids: string[]) {
  const db = fake.db as FakeDb;
  db.tables.invoices = db.tables.invoices.filter((row) => !ids.includes(row.id as string));
}

/**
 * Invoice regeneration is blocked only while a request is `pending`
 * (`invoice_has_pending_request`, migration 55), so a superseded link can
 * outlive the invoices it was issued for. Its charge must still be booked in
 * full: what survives settles normally, the rest is `#EXCESS`.
 */
describe("a paid link whose invoices were regenerated away", () => {
  it("books the surviving month and records the missing month's share as excess", async () => {
    const { oldId } = await oldAndNewLinks();
    deleteInvoices("2");

    await settleGatewayPayment(paidEvent("MF-OLD", "PAY-OLD"), {});

    const monthly = fake.db!.tables.payments.filter(
      (payment) =>
        payment.payment_request_id === oldId && !String(payment.reference).endsWith("#EXCESS"),
    );
    expect(monthly.map((payment) => payment.amount)).toEqual([350]);
    expect(excessFor(oldId)[0]).toMatchObject({ amount: 350 });
    expect(paymentsTotalForRequest(fake.db!, oldId)).toBe(700);
    expect(requestRow(oldId).status).toBe("completed");
  });

  it("records the whole charge as excess when every invoice is gone", async () => {
    const { oldId } = await oldAndNewLinks();
    deleteInvoices("1", "2");

    await settleGatewayPayment(paidEvent("MF-OLD", "PAY-OLD"), {});

    expect(excessFor(oldId)[0]).toMatchObject({ amount: 700 });
    expect(requestRow(oldId)).toMatchObject({
      status: "completed",
      resulting_payment_id: excessFor(oldId)[0].id,
    });
    expect(paymentsTotalForRequest(fake.db!, oldId)).toBe(700);
  });
});

describe("the reconcile job polls superseded links", () => {
  /** حالة البوابة لرابط معيّن كما يعيدها GetPaymentStatus. */
  function gatewayStatus(
    providerInvoiceId: string,
    invoiceStatus: string,
    transactionStatus: string,
  ) {
    return {
      error: null,
      invoiceId: providerInvoiceId,
      invoiceStatus,
      methodRaw: "KNET",
      providerPaymentId: `PAY-${providerInvoiceId}`,
      raw: {},
      transactionStatus,
    };
  }

  it("settles a superseded link the gateway reports paid and marks it completed", async () => {
    const { oldId } = await oldAndNewLinks();
    fetchGatewayPaymentStatus.mockImplementation(async (_config: unknown, id: string) =>
      id === "MF-OLD"
        ? gatewayStatus(id, "Paid", "Success")
        : gatewayStatus(id, "Pending", "Pending"),
    );

    const result = await runPaymentReconcileJob();

    expect(result).toMatchObject({ count: 2, settled: 1 });
    expect(requestRow(oldId).status).toBe("completed");
    expect(paymentsTotalForRequest(fake.db!, oldId)).toBe(700);
  });

  it("polls a superseded link past the pending window until it settles", async () => {
    const { oldId } = await oldAndNewLinks();
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000));
    fetchGatewayPaymentStatus.mockImplementation(async (_config: unknown, id: string) =>
      gatewayStatus(id, "Paid", "Success"),
    );

    const result = await runPaymentReconcileJob();

    expect(requestRow(oldId).status).toBe("completed");
    expect(paymentsTotalForRequest(fake.db!, oldId)).toBe(700);
    // The 10-day-old PENDING link is past its abandonment window and not asked about.
    expect(result.count).toBe(1);
    expect(fetchGatewayPaymentStatus).not.toHaveBeenCalledWith(expect.anything(), "MF-NEW");
  });

  it.each([
    ["still unpaid", "Pending", "Pending"],
    ["failed at the gateway", "Pending", "Failed"],
  ])("leaves a superseded link that is %s superseded", async (_case, invoiceStatus, txStatus) => {
    const { oldId, newId } = await oldAndNewLinks();
    fetchGatewayPaymentStatus.mockImplementation(async (_config: unknown, id: string) =>
      id === "MF-OLD"
        ? gatewayStatus(id, invoiceStatus, txStatus)
        : gatewayStatus(id, "Pending", "Pending"),
    );

    await runPaymentReconcileJob();

    expect(requestRow(oldId).status).toBe("superseded");
    expect(requestRow(newId).status).toBe("pending");
  });
});
