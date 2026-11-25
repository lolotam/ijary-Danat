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

import { backfillContractInvoices } from "./backfillContractInvoices";

describe("backfillContractInvoices server function", () => {
  it("executes backfill_contract_invoices RPC when user has permission", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName, params) => {
      if (rpcName === "has_permission") {
        return { data: true, error: null };
      }
      if (rpcName === "backfill_contract_invoices") {
        return { data: [{ id: "inv-1" }], error: null };
      }
      return { data: null, error: null };
    });

    const mockSupabase = {
      rpc: mockRpc,
    };

    const gFn = backfillContractInvoices as any;
    gFn._context = {
      supabase: mockSupabase,
      userId: "test-user-id",
    };

    const result = await gFn({ contractId: "contract-uuid" });

    expect(mockRpc).toHaveBeenCalledWith("has_permission", {
      _code: "invoices.create",
      _user_id: "test-user-id",
    });
    expect(mockRpc).toHaveBeenCalledWith("backfill_contract_invoices", {
      p_contract_id: "contract-uuid",
    });
    expect(result).toEqual([{ id: "inv-1" }]);
  });

  // Regression guard for the audit finding: the guard used to
  // `throw new Response("Forbidden", { status: 403 })`, which TanStack Start
  // hands back to the caller instead of rejecting — the await resolved and the
  // UI fired its success path while no invoice was backfilled. The refusal must
  // reject with a named Error, and the backfill RPC must never run.
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

    const gFn = backfillContractInvoices as any;
    gFn._context = {
      supabase: mockSupabase,
      userId: "test-user-id",
    };

    await expect(gFn({ contractId: "contract-uuid" })).rejects.toThrow(
      "You do not have permission to backfill contract invoices.",
    );

    expect(mockRpc).not.toHaveBeenCalledWith("backfill_contract_invoices", expect.anything());
  });
});
