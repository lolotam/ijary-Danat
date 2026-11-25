import { describe, it, expect, vi, beforeEach } from "vitest";

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

// Boundary mock: the real sender reaches the database and the mail queue.
vi.mock("@/fns/notifyPaymentSuccess", () => ({
  notifyManualPaymentInvoice: vi.fn().mockResolvedValue({ ok: true, skipped: false, ids: [] }),
}));

import { notifyManualPaymentInvoice } from "@/fns/notifyPaymentSuccess";
import { setInvoicePaid, setInvoicePaidSchema } from "./setInvoicePaid";

const INVOICE_ID = "3f1d2c4e-8a6b-4d5f-9e0a-1b2c3d4e5f60";

/**
 * Wires a fake user-scoped supabase client onto the mocked server fn.
 * `overrides` replaces the result of a named RPC.
 */
function arrange(overrides: Record<string, { data: unknown; error: unknown }> = {}) {
  const results: Record<string, { data: unknown; error: unknown }> = {
    has_permission: { data: true, error: null },
    set_invoice_paid: { data: [{ invoice_state: "paid", payment_id: "pay-1" }], error: null },
    write_audit: { data: "audit-1", error: null },
    ...overrides,
  };
  const rpc = vi.fn((name: string) => results[name] ?? { data: null, error: null });
  (setInvoicePaid as any)._context = { supabase: { rpc }, userId: "test-user-id" };
  return rpc;
}

describe("setInvoicePaid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(notifyManualPaymentInvoice).mockResolvedValue({
      ok: true,
      skipped: false,
      ids: [],
    });
  });

  // Regression guard: on 2026-08-03 an admin marked 12 invoices paid. The
  // payments and allocations were written correctly, but /admin/audit stayed
  // empty — this handler never wrote an audit row, so a money-moving action
  // left no trace of who did it.
  it("records the payment and writes an invoice.mark_paid audit row", async () => {
    const rpc = arrange();

    const result = await (setInvoicePaid as any)({
      invoiceId: INVOICE_ID,
      paymentMethod: "bank_transfer",
      paid: true,
    });

    expect(rpc).toHaveBeenCalledWith("has_permission", {
      _code: "invoices.update",
      _user_id: "test-user-id",
    });
    expect(rpc).toHaveBeenCalledWith("set_invoice_paid", {
      p_invoice_id: INVOICE_ID,
      p_method: "bank_transfer",
      p_paid: true,
    });
    expect(rpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({
        p_action: "invoice.mark_paid",
        p_entity_type: "invoice",
        p_entity_id: INVOICE_ID,
        p_result: "success",
      }),
    );
    expect(result).toEqual({
      updated: true,
      rows: [{ invoice_state: "paid", payment_id: "pay-1" }],
    });
  });

  // The dialog disables its submit button without a method, but the server
  // function is directly callable — a UI-only rule is not a rule.
  //
  // Asserted against the schema rather than through the handler on purpose:
  // this suite mocks createServerFn, and the mock's .validator() returns the
  // function untouched, so calling the handler never runs the schema at all.
  describe("input validation", () => {
    it("rejects marking paid with no method", () => {
      const parsed = setInvoicePaidSchema.safeParse({ invoiceId: INVOICE_ID, paid: true });

      expect(parsed.success).toBe(false);
    });

    it("rejects an empty-string method", () => {
      const parsed = setInvoicePaidSchema.safeParse({
        invoiceId: INVOICE_ID,
        paymentMethod: "",
        paid: true,
      });

      expect(parsed.success).toBe(false);
    });

    it("accepts marking paid with a method", () => {
      const parsed = setInvoicePaidSchema.safeParse({
        invoiceId: INVOICE_ID,
        paymentMethod: "bank_transfer",
        paid: true,
      });

      expect(parsed.success).toBe(true);
    });

    // Un-marking is an undo, not an accounting event; demanding a method for it
    // would imply otherwise.
    it("accepts un-marking with no method", () => {
      const parsed = setInvoicePaidSchema.safeParse({ invoiceId: INVOICE_ID, paid: false });

      expect(parsed.success).toBe(true);
    });
  });

  it("sends no method when reverting, so an un-marked invoice keeps none", async () => {
    const rpc = arrange({
      set_invoice_paid: { data: [{ invoice_state: "due", payment_id: null }], error: null },
    });

    await (setInvoicePaid as any)({
      invoiceId: INVOICE_ID,
      paymentMethod: "bank_transfer",
      paid: false,
    });

    expect(rpc).toHaveBeenCalledWith("set_invoice_paid", {
      p_invoice_id: INVOICE_ID,
      p_method: null,
      p_paid: false,
    });
  });

  it("writes an invoice.unmark_paid audit row when reverting", async () => {
    const rpc = arrange({
      set_invoice_paid: { data: [{ invoice_state: "due", payment_id: null }], error: null },
    });

    await (setInvoicePaid as any)({ invoiceId: INVOICE_ID, paid: false });

    expect(rpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({ p_action: "invoice.unmark_paid" }),
    );
  });

  // Regression guard. The handler used to `throw new Response("Forbidden",
  // { status: 403 })`, which TanStack Start hands back to the caller instead of
  // rejecting: the await RESOLVED and the invoices page toasted success while
  // nothing had changed. A passing await here is the bug, so assert on
  // rejection — and assert the invoice was never touched, because a denial that
  // still moved money would be worse than the toast.
  /**
   * The refusal is identical either way — nothing is written and the caller is
   * rejected. Review finding on PR #206: only the audit row may distinguish a
   * decision that was made from a check that never ran, so the two rows are
   * asserted separately rather than collapsed into one case.
   */
  it.each([
    [
      "the user lacks invoices.update",
      { data: false, error: null },
      { p_result: "failure", p_error_code: "FORBIDDEN" },
    ],
    [
      "the permission check itself errors",
      { data: null, error: { message: "boom" } },
      { p_result: "error", p_error_code: "PERMISSION_CHECK_FAILED" },
    ],
  ])("refuses, changes nothing and records why when %s", async (_scenario, permission, audited) => {
    const rpc = arrange({ has_permission: permission as { data: unknown; error: unknown } });

    await expect(
      (setInvoicePaid as any)({
        invoiceId: INVOICE_ID,
        paymentMethod: "bank_transfer",
        paid: true,
      }),
    ).rejects.toThrow(/permission/i);

    expect(rpc).not.toHaveBeenCalledWith("set_invoice_paid", expect.anything());
    expect(rpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({
        p_action: "permission.denied",
        p_entity_type: "invoice",
        p_entity_id: INVOICE_ID,
        ...audited,
      }),
    );
  });

  it("propagates a set_invoice_paid failure and writes no audit row", async () => {
    const rpc = arrange({
      set_invoice_paid: { data: null, error: { message: "invoice is cancelled" } },
    });

    await expect(
      (setInvoicePaid as any)({
        invoiceId: INVOICE_ID,
        paymentMethod: "bank_transfer",
        paid: true,
      }),
    ).rejects.toThrow("invoice is cancelled");

    expect(rpc).not.toHaveBeenCalledWith("write_audit", expect.anything());
  });

  // The payment has already landed by the time the audit is written. Losing the
  // audit row is bad; reporting a completed payment as failed is worse.
  it("still reports success when the audit write fails", async () => {
    arrange({ write_audit: { data: null, error: { message: "audit down" } } });

    const result = await (setInvoicePaid as any)({
      invoiceId: INVOICE_ID,
      paymentMethod: "bank_transfer",
      paid: true,
    });

    expect(result.updated).toBe(true);
  });

  describe("manual-payment-invoice notification", () => {
    it("notifies with the payment the RPC created", async () => {
      arrange();

      await (setInvoicePaid as any)({
        invoiceId: INVOICE_ID,
        paymentMethod: "bank_transfer",
        paid: true,
      });

      expect(notifyManualPaymentInvoice).toHaveBeenCalledWith(["pay-1"]);
    });

    // Reverting deletes the payment it created. "Your payment was un-received"
    // is not a message a tenant should get from an admin fixing a typo.
    it("sends nothing when reverting an invoice to unpaid", async () => {
      arrange({
        set_invoice_paid: { data: [{ invoice_state: "due", payment_id: null }], error: null },
      });

      await (setInvoicePaid as any)({ invoiceId: INVOICE_ID, paid: false });

      expect(notifyManualPaymentInvoice).not.toHaveBeenCalled();
    });

    // set_invoice_paid returns a null payment_id when the invoice had nothing
    // left to settle. A receipt for a payment that does not exist is worse than
    // no receipt.
    it("sends nothing when the invoice had no balance to settle", async () => {
      arrange({
        set_invoice_paid: { data: [{ invoice_state: "paid", payment_id: null }], error: null },
      });

      await (setInvoicePaid as any)({
        invoiceId: INVOICE_ID,
        paymentMethod: "bank_transfer",
        paid: true,
      });

      expect(notifyManualPaymentInvoice).not.toHaveBeenCalled();
    });

    // The payment is already recorded. A mail outage must not surface as a
    // failed payment, nor undo one.
    it("still reports success when the notification throws", async () => {
      arrange();
      vi.mocked(notifyManualPaymentInvoice).mockRejectedValueOnce(new Error("smtp down"));

      const result = await (setInvoicePaid as any)({
        invoiceId: INVOICE_ID,
        paymentMethod: "bank_transfer",
        paid: true,
      });

      expect(result.updated).toBe(true);
    });

    it("does not notify when permission was denied", async () => {
      arrange({ has_permission: { data: false, error: null } });

      await expect(
        (setInvoicePaid as any)({
          invoiceId: INVOICE_ID,
          paymentMethod: "bank_transfer",
          paid: true,
        }),
      ).rejects.toThrow(/permission/i);

      expect(notifyManualPaymentInvoice).not.toHaveBeenCalled();
    });
  });

  // A thrown Response resolves as SUCCESS on the client through x-tss-raw, so
  // the chronological block would silently do nothing. The SQL path raises this
  // message; the handler must surface it as Error.
  it("throws a plain Error, never a Response, when mark-paid is out of order", async () => {
    arrange({
      set_invoice_paid: {
        data: null,
        error: { message: "Invoices must be paid in chronological order." },
      },
    });

    const thrown = await (setInvoicePaid as any)({
      invoiceId: INVOICE_ID,
      paymentMethod: "bank_transfer",
      paid: true,
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(Response);
    expect((thrown as Error).message).toMatch(/chronological order/);
  });
});
