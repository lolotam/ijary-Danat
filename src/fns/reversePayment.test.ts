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

import { reversePayment } from "./reversePayment";

describe("reversePayment server function", () => {
  it("executes reverse_payment RPC when user has permission", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName, params) => {
      if (rpcName === "has_permission") {
        return { data: true, error: null };
      }
      if (rpcName === "reverse_payment") {
        return { data: { success: true }, error: null };
      }
      return { data: null, error: null };
    });

    const mockSupabase = {
      rpc: mockRpc,
    };

    const gFn = reversePayment as any;
    gFn._context = {
      supabase: mockSupabase,
      userId: "test-user-id",
    };

    const result = await gFn({
      paymentId: "payment-uuid",
      reason: "Double charge",
    });

    expect(mockRpc).toHaveBeenCalledWith("has_permission", {
      _code: "payments.reverse",
      _user_id: "test-user-id",
    });
    expect(mockRpc).toHaveBeenCalledWith("reverse_payment", {
      p_payment_id: "payment-uuid",
      p_reason: "Double charge",
    });
    expect(result).toEqual({ success: true });
  });

  // Regression guard for the audit finding: the guard used to
  // `throw new Response("Forbidden", { status: 403 })`, which TanStack Start
  // hands back to the caller instead of rejecting — the await resolved and
  // admin.payments toasted "payment reversed" while nothing was reversed. The
  // refusal must reject with a named Error, and the money RPC must never run.
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

    const gFn = reversePayment as any;
    gFn._context = {
      supabase: mockSupabase,
      userId: "test-user-id",
    };

    await expect(
      gFn({
        paymentId: "payment-uuid",
        reason: "Accidental entry",
      }),
    ).rejects.toThrow("You do not have permission to reverse a payment.");

    expect(mockRpc).not.toHaveBeenCalledWith("reverse_payment", expect.anything());
  });

  /**
   * Review finding on PR #206: `reverse_payment` is granted directly to
   * `authenticated` and does its own permission check, so a call straight to
   * PostgREST reverses the payment without this handler ever running. An audit
   * row written here would therefore be absent in exactly the case it exists
   * for. Migration 213 moved it inside the RPC, and this pins that the wrapper
   * no longer writes a second one — the row's content is asserted against a
   * real database in `src/db/moneyRpcAudit.sqltest.ts`.
   */
  it("leaves the audit row to the RPC rather than writing a second one", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName: string) => {
      if (rpcName === "has_permission") return { data: true, error: null };
      if (rpcName === "reverse_payment") {
        return { data: [{ reversal_payment_id: "reversal-uuid" }], error: null };
      }
      return { data: null, error: null };
    });

    const gFn = reversePayment as any;
    gFn._context = { supabase: { rpc: mockRpc }, userId: "test-user-id" };

    await gFn({ paymentId: "payment-uuid", reason: "Double charge" });

    expect(mockRpc).toHaveBeenCalledWith("reverse_payment", {
      p_payment_id: "payment-uuid",
      p_reason: "Double charge",
    });
    expect(mockRpc).not.toHaveBeenCalledWith("write_audit", expect.anything());
  });

  /**
   * The Audit screen could show what a person did and never what they were
   * stopped from doing, so a repeated attempt to reverse money by someone
   * without the permission was invisible.
   */
  it("records the refusal when the user lacks the permission", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName: string) => {
      if (rpcName === "has_permission") return { data: false, error: null };
      return { data: null, error: null };
    });

    const gFn = reversePayment as any;
    gFn._context = { supabase: { rpc: mockRpc }, userId: "test-user-id" };

    await expect(gFn({ paymentId: "payment-uuid", reason: "Accidental entry" })).rejects.toThrow();

    expect(mockRpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({
        p_action: "permission.denied",
        p_result: "failure",
        p_error_code: "FORBIDDEN",
        p_after: { attempted: "payment.reverse", permission: "payments.reverse" },
      }),
    );
    expect(mockRpc).not.toHaveBeenCalledWith("reverse_payment", expect.anything());
  });

  /**
   * Review finding on PR #206: the guard refuses on
   * `permissionError || !allowed`, so an errored has_permission RPC would have
   * been recorded as a denial — a decision nobody made.
   */
  it("records a failed permission check as an error rather than a refusal", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName: string) => {
      if (rpcName === "has_permission") return { data: null, error: { message: "RPC missing" } };
      return { data: null, error: null };
    });

    const gFn = reversePayment as any;
    gFn._context = { supabase: { rpc: mockRpc }, userId: "test-user-id" };

    await expect(gFn({ paymentId: "payment-uuid", reason: "x" })).rejects.toThrow();

    expect(mockRpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({ p_result: "error", p_error_code: "PERMISSION_CHECK_FAILED" }),
    );
  });
});
