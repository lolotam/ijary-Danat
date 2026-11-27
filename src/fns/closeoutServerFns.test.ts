import { describe, expect, it, vi } from "vitest";

// Mock createServerFn before importing modules under test.
// NOTE: `.validator()` is a passthrough in this harness — Zod is exercised only
// by src/lib/closeoutSchemas.test.ts, never through these server-fn tests.
//
// Each createServerFn() call MUST return a fresh chain object — a shared
// singleton would make the last imported handler overwrite every earlier one.
vi.mock("@tanstack/react-start", () => {
  function makeFn() {
    const fn: any = (data: any) => {
      return fn._handler({ data, context: fn._context });
    };
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockReturnValue(fn);
    fn.handler = vi.fn().mockImplementation((h: unknown) => {
      fn._handler = h;
      return fn;
    });
    return fn;
  }
  return {
    createServerFn: vi.fn().mockImplementation(() => makeFn()),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn: unknown) => middlewareFn),
    }),
  };
});

vi.mock("./notifyContractCloseout", () => ({
  notifyContractCloseoutRecord: vi.fn().mockResolvedValue({ skipped: true, reason: "test" }),
}));

vi.mock("./notifyContractRestored", () => ({
  notifyContractRestoredRecord: vi.fn().mockResolvedValue({ skipped: true, reason: "test" }),
}));

vi.mock("./notifyRefundRecorded", () => ({
  notifyRefundRecordedRecord: vi.fn().mockResolvedValue({ skipped: true, reason: "test" }),
}));

vi.mock("./notifyInvoiceWrittenOff", () => ({
  notifyInvoiceWrittenOffRecord: vi.fn().mockResolvedValue({ skipped: true, reason: "test" }),
}));

vi.mock("./notifyInvoiceDisputed", () => ({
  notifyInvoiceDisputedRecord: vi.fn().mockResolvedValue({ skipped: true, reason: "test" }),
}));

import { cancelContractCloseout } from "./cancelContractCloseout";
import { closeOutContract } from "./closeOutContract";
import { notifyContractCloseoutRecord } from "./notifyContractCloseout";
import { notifyContractRestoredRecord } from "./notifyContractRestored";
import { notifyInvoiceDisputedRecord } from "./notifyInvoiceDisputed";
import { notifyInvoiceWrittenOffRecord } from "./notifyInvoiceWrittenOff";
import { notifyRefundRecordedRecord } from "./notifyRefundRecorded";
import { previewContractCloseout } from "./previewContractCloseout";
import { restoreContract } from "./restoreContract";
import { reverseRefund } from "./reverseRefund";
import { setInvoiceDispute } from "./setInvoiceDispute";
import { voidRefund } from "./voidRefund";
import { writeOffInvoice } from "./writeOffInvoice";

type ServerFn = {
  _context: { supabase: { rpc: ReturnType<typeof vi.fn> }; userId: string };
  (data: unknown): Promise<unknown>;
};

function mockSupabase(handlers: Record<string, unknown> = {}) {
  return {
    rpc: vi.fn().mockImplementation((rpcName: string) => {
      if (rpcName === "has_permission") {
        const allowed = handlers.has_permission !== undefined ? handlers.has_permission : true;
        return { data: allowed, error: null };
      }
      if (handlers[rpcName] !== undefined) {
        const value = handlers[rpcName];
        if (value instanceof Error) {
          return { data: null, error: { message: value.message } };
        }
        return { data: value, error: null };
      }
      return { data: { ok: true }, error: null };
    }),
  };
}

function bind(fn: unknown, supabase: ReturnType<typeof mockSupabase>) {
  const gFn = fn as ServerFn;
  gFn._context = { supabase, userId: "test-user-id" };
  return gFn;
}

const closeoutInput = {
  contractId: "11111111-1111-4111-8111-111111111111",
  moveOutDate: "2026-08-01",
  outcome: "archive" as const,
  finalContractState: "terminated" as const,
  archiveTenant: true,
  deductions: [
    { kind: "damages" as const, amount: 10, description_ar: null, description_en: null },
  ],
  invoiceActions: [
    {
      invoice_id: "33333333-3333-4333-8333-333333333333",
      action: "leave" as const,
      amount: 0,
    },
  ],
  refundAmount: 50,
  note: "note",
  idempotencyKey: "22222222-2222-4222-8222-222222222222",
  expectedContractUpdatedAt: null as string | null,
};

describe("close-out server functions — permission codes", () => {
  const cases: Array<{
    name: string;
    fn: unknown;
    code: string;
    input: unknown;
    rpcName: string;
  }> = [
    {
      name: "closeOutContract",
      fn: closeOutContract,
      code: "contracts.close_out",
      input: closeoutInput,
      rpcName: "close_out_contract",
    },
    {
      name: "cancelContractCloseout",
      fn: cancelContractCloseout,
      code: "contracts.close_out",
      input: {
        closeoutId: "11111111-1111-4111-8111-111111111111",
        reason: "changed mind",
      },
      rpcName: "cancel_contract_closeout",
    },
    {
      name: "restoreContract",
      fn: restoreContract,
      code: "contracts.restore",
      input: {
        contractId: "11111111-1111-4111-8111-111111111111",
        targetState: "active",
        restoreTenant: true,
        reason: "restore",
      },
      rpcName: "restore_contract",
    },
    {
      name: "previewContractCloseout",
      fn: previewContractCloseout,
      code: "contracts.read",
      input: {
        contractId: "11111111-1111-4111-8111-111111111111",
        deductions: [],
        invoiceActions: [],
        refundAmount: null,
      },
      rpcName: "get_contract_closeout_preview",
    },
    {
      name: "reverseRefund",
      fn: reverseRefund,
      code: "refunds.reverse",
      input: { refundId: "11111111-1111-4111-8111-111111111111", reason: "oops" },
      rpcName: "reverse_refund",
    },
    {
      name: "voidRefund",
      fn: voidRefund,
      code: "refunds.void",
      input: { refundId: "11111111-1111-4111-8111-111111111111", reason: "void" },
      rpcName: "void_refund",
    },
    {
      name: "writeOffInvoice",
      fn: writeOffInvoice,
      code: "invoices.write_off",
      input: { invoiceId: "11111111-1111-4111-8111-111111111111", reason: "bad debt" },
      rpcName: "write_off_invoice",
    },
    {
      name: "setInvoiceDispute",
      fn: setInvoiceDispute,
      code: "invoices.dispute",
      input: {
        invoiceId: "11111111-1111-4111-8111-111111111111",
        reason: "disputed",
        clear: false,
      },
      rpcName: "set_invoice_dispute",
    },
  ];

  it.each(cases)("$name checks has_permission with $code", async ({ fn, code, input }) => {
    const supabase = mockSupabase();
    const bound = bind(fn, supabase);
    await bound(input);
    expect(supabase.rpc).toHaveBeenCalledWith("has_permission", {
      _code: code,
      _user_id: "test-user-id",
    });
  });

  it.each(cases)(
    "$name throws a named Error (not Response) on denial and records it",
    async ({ fn, input, rpcName }) => {
      const supabase = mockSupabase({ has_permission: false });
      const bound = bind(fn, supabase);
      // A sentence naming the refused action, not the bare "Forbidden" these
      // used to throw — it reaches the operator as a toast.
      await expect(bound(input)).rejects.toThrow(/^You do not have permission to /);
      await expect(bound(input)).rejects.not.toBeInstanceOf(Response);
      expect(supabase.rpc).toHaveBeenCalledWith(
        "write_audit",
        expect.objectContaining({ p_action: "permission.denied", p_error_code: "FORBIDDEN" }),
      );
      expect(supabase.rpc).not.toHaveBeenCalledWith(rpcName, expect.anything());
    },
  );

  it.each(cases)("$name returns { ok: true } on success", async ({ fn, input }) => {
    const supabase = mockSupabase({
      reverse_refund: [{ reversal_refund_id: "r1" }],
    });
    const bound = bind(fn, supabase);
    const result = (await bound(input)) as { ok: true };
    expect(result.ok).toBe(true);
  });
});

describe("closeOutContract RPC parameter names", () => {
  it("passes the EXACT SQL parameter names from migration 87", async () => {
    const supabase = mockSupabase({ close_out_contract: { closeout_id: "c1" } });
    const bound = bind(closeOutContract, supabase);
    await bound(closeoutInput);

    expect(supabase.rpc).toHaveBeenCalledWith("close_out_contract", {
      p_contract_id: closeoutInput.contractId,
      p_move_out_date: closeoutInput.moveOutDate,
      p_outcome: closeoutInput.outcome,
      p_final_contract_state: closeoutInput.finalContractState,
      p_archive_tenant: closeoutInput.archiveTenant,
      p_deductions: closeoutInput.deductions,
      p_invoice_actions: closeoutInput.invoiceActions,
      p_refund_amount: closeoutInput.refundAmount,
      p_note: closeoutInput.note,
      p_idempotency_key: closeoutInput.idempotencyKey,
      p_expected_contract_updated_at: null,
    });
  });
});

describe("setInvoiceDispute clear path", () => {
  it("calls clear_invoice_dispute when clear is true", async () => {
    const supabase = mockSupabase();
    const bound = bind(setInvoiceDispute, supabase);
    await bound({
      invoiceId: "11111111-1111-4111-8111-111111111111",
      clear: true,
    });
    expect(supabase.rpc).toHaveBeenCalledWith("clear_invoice_dispute", {
      p_invoice_id: "11111111-1111-4111-8111-111111111111",
    });
  });
});

describe("money mutations send nothing themselves (T072)", () => {
  // الإرسال انتقل إلى أحداث المال: الدالة نفسها لا تلمس حدود الإرسال إطلاقاً،
  // والحدث الذي تخرجه المعاملة هو ما يشغّل المُرسِل في العامل.
  const cases: Array<{
    name: string;
    fn: unknown;
    input: unknown;
    rpcName: string;
    sender: ReturnType<typeof vi.fn>;
  }> = [
    {
      name: "closeOutContract",
      fn: closeOutContract,
      input: closeoutInput,
      rpcName: "close_out_contract",
      sender: vi.mocked(notifyContractCloseoutRecord),
    },
    {
      name: "restoreContract",
      fn: restoreContract,
      input: {
        contractId: "11111111-1111-4111-8111-111111111111",
        targetState: "active",
        restoreTenant: true,
        reason: "restore",
      },
      rpcName: "restore_contract",
      sender: vi.mocked(notifyContractRestoredRecord),
    },
    {
      name: "writeOffInvoice",
      fn: writeOffInvoice,
      input: { invoiceId: "11111111-1111-4111-8111-111111111111", reason: "bad debt" },
      rpcName: "write_off_invoice",
      sender: vi.mocked(notifyInvoiceWrittenOffRecord),
    },
    {
      name: "setInvoiceDispute",
      fn: setInvoiceDispute,
      input: {
        invoiceId: "11111111-1111-4111-8111-111111111111",
        reason: "disputed",
        clear: false,
      },
      rpcName: "set_invoice_dispute",
      sender: vi.mocked(notifyInvoiceDisputedRecord),
    },
  ];

  it.each(cases)(
    "$name calls no sender after the money RPC",
    async ({ fn, input, rpcName, sender }) => {
      sender.mockClear();
      vi.mocked(notifyRefundRecordedRecord).mockClear();
      const supabase = mockSupabase({
        close_out_contract: {
          closeout_id: "c1",
          refund_id: "55555555-5555-4555-8555-555555555555",
          refund_total: 50,
        },
      });
      const bound = bind(fn, supabase);

      const outcome = (await bound(input)) as { ok: true };

      expect(outcome.ok).toBe(true);
      expect(supabase.rpc).toHaveBeenCalledWith(rpcName, expect.anything());
      // لا حدود إرسال تُلمس: المُرسلون جميعاً صامتون، مهما حمل ردّ الـ RPC.
      expect(sender).not.toHaveBeenCalled();
      expect(notifyRefundRecordedRecord).not.toHaveBeenCalled();
      expect(notifyContractCloseoutRecord).not.toHaveBeenCalled();
      expect(notifyContractRestoredRecord).not.toHaveBeenCalled();
      expect(notifyInvoiceWrittenOffRecord).not.toHaveBeenCalled();
      expect(notifyInvoiceDisputedRecord).not.toHaveBeenCalled();
    },
  );

  it("closeOutContract carries no notification warning any more", async () => {
    // لا تحمل نتيجة التصفية أي قناة تحذير: الحقل حُذف من العقد بعدما صار
    // الإرسال خارج الطلب كلياً، فلا حاجة لتنبيه يقرأه المسار (route).
    vi.mocked(notifyContractCloseoutRecord).mockClear();
    const supabase = mockSupabase({
      close_out_contract: { closeout_id: "c1", refund_id: null, refund_total: 0 },
    });

    const outcome = await bind(closeOutContract, supabase)(closeoutInput);

    expect(outcome).toMatchObject({ ok: true });
    expect(outcome).not.toHaveProperty("notificationWarning");
    expect(notifyContractCloseoutRecord).not.toHaveBeenCalled();
  });

  it("a refund-less close-out still reaches no send boundary", async () => {
    vi.mocked(notifyRefundRecordedRecord).mockClear();
    const supabase = mockSupabase({
      close_out_contract: { closeout_id: "c1", refund_id: null, refund_total: 0 },
    });

    await bind(closeOutContract, supabase)({ ...closeoutInput, refundAmount: 0 });

    expect(notifyRefundRecordedRecord).not.toHaveBeenCalled();
    expect(notifyContractCloseoutRecord).not.toHaveBeenCalled();
  });
});
