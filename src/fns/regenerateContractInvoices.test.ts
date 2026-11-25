import { describe, expect, it, test, vi } from "vitest";

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

import { regenerateContractInvoices, summarizeRegeneration } from "./regenerateContractInvoices";

describe("summarizeRegeneration", () => {
  test("counts each action separately", () => {
    expect(
      summarizeRegeneration([
        { action: "updated" },
        { action: "updated" },
        { action: "inserted" },
        { action: "cancelled" },
        { action: "skipped" },
        { action: "deleted" },
        { action: "blocked" },
      ]),
    ).toEqual({ updated: 2, inserted: 1, cancelled: 1, deleted: 1, skipped: 1, blocked: 1 });
  });

  test("surfaces cancellations rather than folding them into a total", () => {
    // A cancelled invoice left the contract's range while still carrying money
    // or a live payment link — it needs a human. A single count would bury it.
    const summary = summarizeRegeneration([
      { action: "updated" },
      { action: "updated" },
      { action: "cancelled" },
    ]);
    expect(summary.cancelled).toBe(1);
  });

  test("surfaces blocked months, which claim no synchronisation happened", () => {
    // Migration 139: a month the contract says is billable that the engine
    // refuses to touch — a discounted invoice inside a newly-free month, or a
    // month whose only invoice is cancelled. Reporting a clean result for those
    // would claim a synchronisation that did not happen.
    const summary = summarizeRegeneration([{ action: "updated" }, { action: "blocked" }]);
    expect(summary.blocked).toBe(1);
  });

  test("an empty or absent result is all zeros, not a crash", () => {
    const zero = { updated: 0, inserted: 0, cancelled: 0, deleted: 0, skipped: 0, blocked: 0 };
    expect(summarizeRegeneration([])).toEqual(zero);
    expect(summarizeRegeneration(null)).toEqual(zero);
    expect(summarizeRegeneration(undefined)).toEqual(zero);
  });

  test("an unrecognised action is ignored rather than creating a key", () => {
    const summary = summarizeRegeneration([{ action: "teleported" }, { action: "updated" }]);
    expect(summary).toEqual({
      updated: 1,
      inserted: 0,
      cancelled: 0,
      deleted: 0,
      skipped: 0,
      blocked: 0,
    });
  });
});

describe("regenerateContractInvoices server function", () => {
  it("executes regenerate_contract_invoices RPC when user has permission", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName, params) => {
      if (rpcName === "has_permission") {
        return { data: true, error: null };
      }
      if (rpcName === "regenerate_contract_invoices") {
        return { data: [{ action: "updated" }], error: null };
      }
      return { data: null, error: null };
    });

    const gFn = regenerateContractInvoices as any;
    gFn._context = {
      supabase: { rpc: mockRpc },
      userId: "test-user-id",
    };

    const result = await gFn({ contractId: "contract-uuid" });

    expect(mockRpc).toHaveBeenCalledWith("has_permission", {
      _code: "invoices.create",
      _user_id: "test-user-id",
    });
    expect(mockRpc).toHaveBeenCalledWith("regenerate_contract_invoices", {
      p_contract_id: "contract-uuid",
    });
    expect(result).toEqual([{ action: "updated" }]);
  });

  // Regression guard for the audit finding: the guard used to
  // `throw new Response("Forbidden", { status: 403 })`, which TanStack Start
  // hands back to the caller instead of rejecting — the await resolved and the
  // contract save toasted success while its invoices were never reconciled.
  // The refusal must reject with a named Error, and the RPC must never run.
  it("rejects with a permission Error when user lacks permission", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName) => {
      if (rpcName === "has_permission") {
        return { data: false, error: null };
      }
      return { data: null, error: null };
    });

    const gFn = regenerateContractInvoices as any;
    gFn._context = {
      supabase: { rpc: mockRpc },
      userId: "test-user-id",
    };

    await expect(gFn({ contractId: "contract-uuid" })).rejects.toThrow(
      "You do not have permission to regenerate contract invoices.",
    );

    expect(mockRpc).not.toHaveBeenCalledWith("regenerate_contract_invoices", expect.anything());
  });
});
