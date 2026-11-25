import { describe, it, expect, vi } from "vitest";

// Mock createServerFn before importing the module under test
vi.mock("@tanstack/react-start", () => {
  const fn: any = (data: any) => {
    return fn._handler({ data, context: fn._context });
  };
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h) => {
    fn._handler = h;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn) => middlewareFn),
    }),
  };
});

import { applyAllocation } from "./applyAllocation";

type InvoiceRow = {
  id: string;
  contract_id: string;
  balance: number;
  code: string;
  period_month: number;
  period_year: number;
  state: string;
};

/**
 * يحاكي جدول الفواتير كما تراه دالة الخادم: تصفية بالمعرّف أو بالعقد فقط.
 *
 * Only the two reads the ordering check makes are modelled — the fake answers
 * `.in("id", …)` and `.in("contract_id", …)` from one row list, so a test
 * describes a contract's invoices once and both reads agree.
 */
const inChunkSizes: number[] = [];

function invoicesTable(rows: InvoiceRow[]) {
  return vi.fn(() => ({
    select: () => ({
      in: (column: "id" | "contract_id", values: string[]) => {
        inChunkSizes.push(values.length);
        return Promise.resolve({
          data: rows.filter((row) => values.includes(row[column])),
          error: null,
        });
      },
    }),
  }));
}

/** فاتورة شهرية على عقد واحد برصيد مفتوح. */
function monthly(id: string, month: number, balance = 100): InvoiceRow {
  return {
    id,
    contract_id: "contract-1",
    balance,
    code: `INV-${month}`,
    period_month: month,
    period_year: 2026,
    state: "due",
  };
}

describe("applyAllocation server function", () => {
  it("executes apply_payment_allocation RPC when user has permission", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName, params) => {
      if (rpcName === "has_permission") {
        return { data: true, error: null };
      }
      if (rpcName === "apply_payment_allocation") {
        return { data: [{ id: "allocation-1" }], error: null };
      }
      return { data: null, error: null };
    });

    const mockSupabase = {
      rpc: mockRpc,
      from: invoicesTable([monthly("invoice-uuid", 1)]),
    };

    const gFn = applyAllocation as any;
    gFn._context = {
      supabase: mockSupabase,
      userId: "test-user-id",
    };

    const result = await gFn({
      paymentId: "payment-uuid",
      allocations: [{ invoice_id: "invoice-uuid", amount: 100 }],
    });

    expect(mockRpc).toHaveBeenCalledWith("has_permission", {
      _code: "payments.create",
      _user_id: "test-user-id",
    });
    expect(mockRpc).toHaveBeenCalledWith("apply_payment_allocation", {
      p_payment_id: "payment-uuid",
      p_allocations: [{ invoice_id: "invoice-uuid", amount: 100 }],
    });
    expect(result).toEqual([{ id: "allocation-1" }]);
  });

  // Regression guard for the audit finding: the guard used to
  // `throw new Response("Forbidden", { status: 403 })`, which TanStack Start
  // hands back to the caller instead of rejecting — the await resolved and the
  // payments page toasted success while nothing was allocated. The refusal must
  // reject with a named Error, and the settling RPC must never run.
  it("rejects with a permission Error when user lacks permission", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName) => {
      if (rpcName === "has_permission") {
        return { data: false, error: null };
      }
      return { data: null, error: null };
    });

    const mockSupabase = {
      rpc: mockRpc,
    };

    const gFn = applyAllocation as any;
    gFn._context = {
      supabase: mockSupabase,
      userId: "test-user-id",
    };

    await expect(
      gFn({
        paymentId: "payment-uuid",
        allocations: [{ invoice_id: "invoice-uuid", amount: 100 }],
      }),
    ).rejects.toThrow("You do not have permission to apply a payment allocation.");

    expect(mockRpc).not.toHaveBeenCalledWith("apply_payment_allocation", expect.anything());
  });

  // Audit H8: this rule lived only in the admin dialog, so anyone holding
  // payments.create who called the server fn directly — or had a stale page
  // open — settled a newer month while older arrears stood, and nothing marked
  // it. The check now runs here, before any money moves.
  it("refuses to settle a newer month while an older one on the contract is open", async () => {
    const mockRpc = vi
      .fn()
      .mockImplementation((rpcName) =>
        rpcName === "has_permission" ? { data: true, error: null } : { data: [], error: null },
      );
    const gFn = applyAllocation as any;
    gFn._context = {
      supabase: { rpc: mockRpc, from: invoicesTable([monthly("jan", 1), monthly("feb", 2)]) },
      userId: "test-user-id",
    };

    await expect(
      gFn({ paymentId: "payment-uuid", allocations: [{ invoice_id: "feb", amount: 100 }] }),
    ).rejects.toThrow("Settle the oldest open invoice first");

    expect(mockRpc).not.toHaveBeenCalledWith("apply_payment_allocation", expect.anything());
  });

  it("lets the admin dialog's one-invoice-per-call loop through, oldest first", async () => {
    // settleInvoices allocates each month in its own call; by the time February
    // is allocated, January's balance is already zero.
    const mockRpc = vi
      .fn()
      .mockImplementation((rpcName) =>
        rpcName === "has_permission" ? { data: true, error: null } : { data: [], error: null },
      );
    const gFn = applyAllocation as any;
    gFn._context = {
      supabase: { rpc: mockRpc, from: invoicesTable([monthly("jan", 1, 0), monthly("feb", 2)]) },
      userId: "test-user-id",
    };

    await gFn({ paymentId: "payment-uuid", allocations: [{ invoice_id: "feb", amount: 100 }] });

    expect(mockRpc).toHaveBeenCalledWith("apply_payment_allocation", expect.anything());
  });

  it("reads a long lease's allocation in URL-sized chunks, not one oversized filter", async () => {
    // Codex review, PR #220: a payment settling ~250 months of a twenty-year
    // lease put every invoice UUID in one PostgREST URL, which the gateway
    // answers with 414 before the allocation runs.
    inChunkSizes.length = 0;
    const months = Array.from({ length: 250 }, (_, index) => ({
      ...monthly(`m-${index}`, (index % 12) + 1),
      period_year: 2006 + Math.floor(index / 12),
    }));
    const mockRpc = vi
      .fn()
      .mockImplementation((rpcName) =>
        rpcName === "has_permission" ? { data: true, error: null } : { data: [], error: null },
      );
    const gFn = applyAllocation as any;
    gFn._context = { supabase: { rpc: mockRpc, from: invoicesTable(months) }, userId: "u" };

    await gFn({
      paymentId: "payment-uuid",
      allocations: months.map((row) => ({ invoice_id: row.id, amount: row.balance })),
    });

    expect(Math.max(...inChunkSizes)).toBeLessThanOrEqual(200);
    expect(mockRpc).toHaveBeenCalledWith("apply_payment_allocation", expect.anything());
  });
});
