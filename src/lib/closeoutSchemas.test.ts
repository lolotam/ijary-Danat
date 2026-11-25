import { describe, expect, it } from "vitest";

import {
  closeoutSchema,
  deductionSchema,
  disputeSchema,
  invoiceActionSchema,
} from "@/lib/closeoutSchemas";

/**
 * Zod schemas are exercised here directly.
 *
 * The server-fn Vitest harness mocks `.validator()` as a passthrough
 * (see src/fns/generateInvoices.test.ts), so Zod is never run through the
 * server fn path in unit tests — only through these direct schema tests.
 */

const baseCloseout = {
  contractId: "11111111-1111-4111-8111-111111111111",
  moveOutDate: "2026-08-01",
  outcome: "keep_terminated" as const,
  finalContractState: "terminated" as const,
  archiveTenant: false,
  deductions: [] as Array<{
    kind: "damages" | "cleaning" | "utilities" | "unpaid_rent" | "other";
    amount: number;
  }>,
  invoiceActions: [] as Array<{
    invoice_id: string;
    action: "leave" | "settle_from_deposit" | "write_off" | "cancel" | "mark_disputed";
    amount?: number;
  }>,
  idempotencyKey: "22222222-2222-4222-8222-222222222222",
};

describe("deductionSchema", () => {
  it("rejects zero and negative amounts", () => {
    expect(deductionSchema.safeParse({ kind: "damages", amount: 0 }).success).toBe(false);
    expect(deductionSchema.safeParse({ kind: "damages", amount: -1 }).success).toBe(false);
  });

  it("accepts a positive amount", () => {
    expect(deductionSchema.safeParse({ kind: "cleaning", amount: 12.5 }).success).toBe(true);
  });
});

describe("invoiceActionSchema", () => {
  it("rejects a non-uuid invoice_id", () => {
    expect(
      invoiceActionSchema.safeParse({
        invoice_id: "not-a-uuid",
        action: "leave",
        amount: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown action", () => {
    expect(
      invoiceActionSchema.safeParse({
        invoice_id: "11111111-1111-4111-8111-111111111111",
        action: "explode",
        amount: 0,
      }).success,
    ).toBe(false);
  });
});

describe("closeoutSchema", () => {
  it("rejects archiveTenant=true with outcome=keep_terminated", () => {
    const result = closeoutSchema.safeParse({
      ...baseCloseout,
      outcome: "keep_terminated",
      archiveTenant: true,
    });
    expect(result.success).toBe(false);
  });

  it("accepts archiveTenant=true with outcome=archive", () => {
    const result = closeoutSchema.safeParse({
      ...baseCloseout,
      outcome: "archive",
      archiveTenant: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("disputeSchema", () => {
  it("requires a reason when not clearing", () => {
    expect(
      disputeSchema.safeParse({
        invoiceId: "11111111-1111-4111-8111-111111111111",
        clear: false,
      }).success,
    ).toBe(false);
  });

  it("allows clear without a reason", () => {
    expect(
      disputeSchema.safeParse({
        invoiceId: "11111111-1111-4111-8111-111111111111",
        clear: true,
      }).success,
    ).toBe(true);
  });
});
