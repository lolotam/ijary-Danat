import { beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();
const rpc = vi.fn();
const notifyPaymentSuccess = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => from(table),
    rpc: (name: string, args: unknown) => rpc(name, args),
  },
}));
vi.mock("@/fns/notifyPaymentSuccess", () => ({
  notifyPaymentSuccess: (ids: string[]) => notifyPaymentSuccess(ids),
}));

const { settleGatewayPayment } = await import("./myfatoorahWebhook");

const PREQ = {
  id: "preq-1",
  code: "PREQ-0000001",
  status: "pending",
  amount: "450.000",
  tenant_id: "tenant-1",
  requested_invoice_ids: ["inv-1"],
  provider_invoice_id: "7050025",
  provider_payment_id: null,
  resulting_payment_id: null,
  gateway_response: null,
};

/** Balance 0 is what puts settlement into the adoption branch at all. */
const INVOICE = {
  id: "inv-1",
  code: "INV-0000006",
  balance: "0.000",
  total: "450.000",
  tenant_id: "tenant-1",
  unit_id: "unit-1",
};

const DETAILS = {
  eventType: "cron.reconcile",
  invoiceId: "7050025",
  method: "knet" as const,
  paymentId: "100621810000012471",
  providerEventId: "reconcile:PREQ-0000001",
  status: "Paid",
};

/**
 * Minimal PostgREST-shaped stub: every chained builder method returns the same
 * object, and awaiting it (or calling single/maybeSingle) yields the per-table
 * result. Enough for the read-mostly path the adoption branch takes.
 */
function stubTables(overrides: Record<string, unknown>) {
  from.mockImplementation((table: string) => {
    const result = overrides[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "update", "insert", "eq", "in", "order", "limit"]) {
      chain[method] = () => chain;
    }
    chain.single = async () => result;
    chain.maybeSingle = async () => result;
    chain.then = (resolve: (value: unknown) => unknown) => resolve(result);
    return chain;
  });
}

function allocation(paymentId: string, code: string, method: string, reference: string | null) {
  return {
    invoice_id: "inv-1",
    payment_id: paymentId,
    payments: { id: paymentId, code, method, reference, status: "confirmed" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  notifyPaymentSuccess.mockResolvedValue({ ok: true });
});

describe("settleGatewayPayment adoption branch", () => {
  it("adopts an AUTO-INV placeholder, audits the real prior method, and notifies", async () => {
    stubTables({
      payment_requests: { data: PREQ, error: null },
      invoices: { data: [INVOICE], error: null },
      payments: { data: [], error: null },
      tenants: { data: { company_id: "co-1" }, error: null },
      payment_allocations: {
        data: [allocation("pay-1", "PAY-0000006", "cash", "AUTO-INV:INV-0000006")],
        error: null,
      },
      receipts: { data: { id: "rcpt-1" }, error: null },
    });

    await settleGatewayPayment(DETAILS, {});

    expect(rpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({
        p_action: "payment.gateway_reconciled",
        p_before: { method: "cash", reference: "AUTO-INV:INV-0000006" },
      }),
    );
    expect(notifyPaymentSuccess).toHaveBeenCalledWith(["pay-1"]);
  });

  it("does not adopt or notify when a real payment collides", async () => {
    stubTables({
      payment_requests: { data: PREQ, error: null },
      invoices: { data: [INVOICE], error: null },
      payments: { data: [], error: null },
      tenants: { data: { company_id: "co-1" }, error: null },
      payment_allocations: {
        data: [allocation("pay-9", "PAY-0000009", "cheque", "Cheque 4471")],
        error: null,
      },
      receipts: { data: { id: "rcpt-9" }, error: null },
    });

    await settleGatewayPayment(DETAILS, {});

    expect(rpc).not.toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({ p_action: "payment.gateway_reconciled" }),
    );
    expect(notifyPaymentSuccess).not.toHaveBeenCalled();
  });

  it("still throws when nothing at all is allocated", async () => {
    stubTables({
      payment_requests: { data: PREQ, error: null },
      invoices: { data: [INVOICE], error: null },
      payments: { data: [], error: null },
      tenants: { data: { company_id: "co-1" }, error: null },
      payment_allocations: { data: [], error: null },
    });

    await expect(settleGatewayPayment(DETAILS, {})).rejects.toThrow(/nothing left to settle/);
  });

  it("ignores a reversed payment, which holds no balance down", async () => {
    stubTables({
      payment_requests: { data: PREQ, error: null },
      invoices: { data: [INVOICE], error: null },
      payments: { data: [], error: null },
      tenants: { data: { company_id: "co-1" }, error: null },
      payment_allocations: {
        data: [
          {
            invoice_id: "inv-1",
            payment_id: "pay-rev",
            payments: {
              id: "pay-rev",
              code: "PAY-0000005",
              method: "cash",
              reference: "AUTO-INV:INV-0000006",
              status: "reversed",
            },
          },
        ],
        error: null,
      },
    });

    await expect(settleGatewayPayment(DETAILS, {})).rejects.toThrow(/nothing left to settle/);
  });
});
