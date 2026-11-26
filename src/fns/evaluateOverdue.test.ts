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

const supabaseAdmin = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => supabaseAdmin,
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

import { evaluateOverdue, runEvaluateOverdueJob } from "./evaluateOverdue";

describe("evaluateOverdue server function and job", () => {
  describe("runEvaluateOverdueJob (cron helper)", () => {
    it("calls evaluate_overdue RPC using supabaseAdmin", async () => {
      vi.mocked(supabaseAdmin.rpc).mockResolvedValueOnce({
        data: [{ id: "invoice-1", status: "overdue" }],
        error: null,
      } as any);

      const result = await runEvaluateOverdueJob("2026-07-15");

      expect(supabaseAdmin.rpc).toHaveBeenCalledWith("evaluate_overdue", {
        p_as_of: "2026-07-15",
      });
      expect(result).toEqual({
        count: 1,
        transitions: [{ id: "invoice-1", status: "overdue" }],
      });
    });
  });

  describe("evaluateOverdue server function (admin UI action)", () => {
    it("executes evaluate_overdue RPC when user has permission", async () => {
      const mockRpc = vi.fn().mockImplementation((rpcName, params) => {
        if (rpcName === "has_permission") {
          return { data: true, error: null };
        }
        if (rpcName === "evaluate_overdue") {
          return { data: [{ id: "invoice-1" }], error: null };
        }
        return { data: null, error: null };
      });

      const mockSupabase = {
        rpc: mockRpc,
      };

      const gFn = evaluateOverdue as any;
      gFn._context = {
        supabase: mockSupabase,
        userId: "test-user-id",
      };

      const result = await gFn({ asOf: "2026-07-15" });

      expect(mockRpc).toHaveBeenCalledWith("has_permission", {
        _code: "invoices.update",
        _user_id: "test-user-id",
      });
      expect(mockRpc).toHaveBeenCalledWith("evaluate_overdue", {
        p_as_of: "2026-07-15",
      });
      expect(result).toEqual([{ id: "invoice-1" }]);
    });

    // Regression guard for the audit finding: the guard used to
    // `throw new Response("Forbidden", { status: 403 })`, which TanStack Start
    // hands back to the caller instead of rejecting — the await resolved and
    // the UI fired its success path while no status was re-evaluated. The
    // refusal must reject with a named Error, and the RPC must never run.
    it("rejects with a permission Error when user lacks permission", async () => {
      const mockRpc = vi.fn().mockImplementation((rpcName) => {
        if (rpcName === "has_permission") {
          return { data: false, error: null };
        }
        return { data: null, error: null };
      });

      const gFn = evaluateOverdue as any;
      gFn._context = {
        supabase: { rpc: mockRpc },
        userId: "test-user-id",
      };

      await expect(gFn({ asOf: "2026-07-15" })).rejects.toThrow(
        "You do not have permission to evaluate overdue invoices.",
      );

      expect(mockRpc).not.toHaveBeenCalledWith("evaluate_overdue", expect.anything());
    });
  });
});
