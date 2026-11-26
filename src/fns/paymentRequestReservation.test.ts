/**
 * متى يُعاد استخدام رابط دفع قائم، ومتى يُستبدل الطلب كله بطلب جديد.
 *
 * `reservePaymentRequest` decides whether a tenant gets the link already on
 * their pending payment request or a new one. A new link now means a new ROW:
 * the old row is marked `superseded` and keeps its provider ids, because its
 * link stays payable at the gateway and a charge on it must still find it
 * (migration 223). Run on the stateful fake so the unique idempotency key
 * behaves as in Postgres — it is the constraint that forces the old row to
 * release its key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/fns/gatewaySettlementFakeDb.test-support";

const fake = vi.hoisted(() => ({ db: null as FakeDb | null }));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: (table: string) => (fake.db as FakeDb).client.from(table),
    rpc: (name: string, args: Record<string, unknown>) =>
      (fake.db as FakeDb).client.rpc(name, args),
  }),
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: "company-1",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

const { linkIsFresh, reservePaymentRequest } = await import("./paymentRequestReservation");

const NOW = new Date("2026-09-24T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

/** اختيار فاتورة واحدة بالرصيد المعطى. */
function selection(total: number) {
  return {
    invoiceIds: ["inv-1"],
    invoices: [
      {
        invoice_id: "inv-1",
        balance: total,
        is_selectable: true,
        period_month: 9,
        period_year: 2026,
      },
    ],
    total,
  };
}

/** يحجز طلب دفع للمستأجر بالمبلغ والطريقة المعطاة. */
function reserve(total = 50, paymentMethod: "KNET" | "GOOGLE_PAY" = "KNET") {
  return reservePaymentRequest({
    selection: selection(total),
    tenantId: "tenant-1",
    userId: "user-1",
    paymentMethod,
  });
}

/** يحاكي saveGatewayExecution: يكتب رابط البوابة ومعرّفها على الصف. */
function issueLink(requestId: string, providerInvoiceId: string, method = "KNET") {
  const row = (fake.db as FakeDb).tables.payment_requests.find((r) => r.id === requestId)!;
  Object.assign(row, {
    provider_invoice_id: providerInvoiceId,
    payment_url: `https://myfatoorah.com/${providerInvoiceId}`,
    request_payload: { PaymentMethod: method },
  });
}

/** يقدّم الساعة بعدد الساعات المعطى. */
function advanceHours(hours: number) {
  vi.setSystemTime(new Date(Date.now() + hours * HOUR));
}

/** صفوف طلبات الدفع كما هي الآن. */
function requests() {
  return (fake.db as FakeDb).tables.payment_requests;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  fake.db = createFakeDb({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("linkIsFresh", () => {
  it("keeps a link fresh for just under 24 hours and stale from 24 hours on", () => {
    expect(linkIsFresh(new Date(NOW.getTime() - 23.99 * HOUR).toISOString(), NOW)).toBe(true);
    expect(linkIsFresh(new Date(NOW.getTime() - 24 * HOUR).toISOString(), NOW)).toBe(false);
  });
});

describe("reservePaymentRequest", () => {
  it("hands back a link issued an hour ago when nothing about the payment changed", async () => {
    const first = await reserve();
    issueLink(first.request.id, "MF-1");
    advanceHours(1);

    const second = await reserve();

    expect(second).toMatchObject({ reused: true, request: { id: first.request.id } });
    expect(requests()).toHaveLength(1);
  });

  it("supersedes a link issued 25 hours ago and puts the new link on a new row", async () => {
    const first = await reserve();
    issueLink(first.request.id, "MF-1");
    advanceHours(25);

    const second = await reserve();

    expect(second.reused).toBe(false);
    expect(second.request.id).not.toBe(first.request.id);
    // The old row keeps what a late charge on its link needs to find it.
    expect(requests()[0]).toMatchObject({
      status: "superseded",
      idempotency_key: null,
      provider_invoice_id: "MF-1",
    });
    expect(requests()[1]).toMatchObject({ status: "pending", provider_invoice_id: null });
    expect(requests()[1].idempotency_key).toEqual(expect.any(String));
  });

  it.each([
    ["the amount changed", 80, "KNET" as const],
    ["the method changed", 50, "GOOGLE_PAY" as const],
  ])("supersedes a fresh link when %s", async (_case, total, method) => {
    const first = await reserve();
    issueLink(first.request.id, "MF-1");

    const second = await reserve(total, method);

    expect(second.reused).toBe(false);
    expect(requests().map((row) => row.status)).toEqual(["superseded", "pending"]);
    expect(second.request).toMatchObject({ amount: total });
  });

  it("refuses while another call is still creating the link, then two clicks leave one row", async () => {
    const results = await Promise.allSettled([reserve(), reserve()]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((result) => result.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason.message).toMatch(/already being created/);
    expect(requests()).toHaveLength(1);
  });

  it("losing the insert race to a call that already has its link returns that link", async () => {
    // A concurrent call inserts its row — and gets its link — between this
    // call's lookup and its insert, so this insert hits the unique key.
    const db = fake.db as FakeDb;
    const from = db.client.from;
    db.client.from = (table: string) => {
      const query = from(table) as { insert: (values: Record<string, unknown>) => unknown };
      if (table !== "payment_requests") return query;
      const insert = query.insert;
      query.insert = (values) => {
        db.tables.payment_requests.push({
          ...values,
          id: "preq-winner",
          status: "pending",
          created_at: new Date().toISOString(),
          payment_url: "https://myfatoorah.com/MF-WIN",
          request_payload: { PaymentMethod: "KNET" },
        });
        return insert(values);
      };
      return query;
    };

    const result = await reserve();

    expect(result).toMatchObject({ reused: true, request: { id: "preq-winner" } });
    expect(requests()).toHaveLength(1);
  });

  it("replaces a request whose link was never written back once it is past 24 hours", async () => {
    await reserve();
    advanceHours(25);

    const second = await reserve();

    expect(second.reused).toBe(false);
    expect(requests().map((row) => row.status)).toEqual(["superseded", "pending"]);
  });

  it("replaces a failed request without relabelling it", async () => {
    const first = await reserve();
    requests()[0].status = "failed";

    const second = await reserve();

    expect(second.request.id).not.toBe(first.request.id);
    expect(requests()[0]).toMatchObject({ status: "failed", idempotency_key: null });
  });

  it("refuses a selection that has already been paid", async () => {
    await reserve();
    requests()[0].status = "completed";

    await expect(reserve()).rejects.toThrow(/already been paid/);
    expect(requests()).toHaveLength(1);
  });
});
