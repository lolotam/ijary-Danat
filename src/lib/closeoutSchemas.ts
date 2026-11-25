import { z } from "zod";

/**
 * Shared Zod schemas for the contract close-out engine.
 *
 * Client and server both import from here (same pattern as bulkImportSchemas).
 * PostgREST RPCs resolve by argument NAME; the server fns map camelCase fields
 * below to the exact SQL parameter names in migration 87.
 */

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : (value ?? null)));

export const deductionSchema = z.object({
  kind: z.enum(["damages", "cleaning", "utilities", "unpaid_rent", "other"]),
  description_ar: optionalTrimmed(300),
  description_en: optionalTrimmed(300),
  amount: z.number().positive(),
});

export const invoiceActionSchema = z.object({
  invoice_id: z.string().uuid(),
  action: z.enum(["leave", "settle_from_deposit", "write_off", "cancel", "mark_disputed"]),
  amount: z.number().nonnegative().default(0),
});

export const closeoutSchema = z
  .object({
    contractId: z.string().uuid(),
    moveOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    outcome: z.enum(["keep_terminated", "freeze", "archive"]),
    finalContractState: z.enum(["terminated", "expired"]),
    archiveTenant: z.boolean(),
    deductions: z.array(deductionSchema).max(50),
    invoiceActions: z.array(invoiceActionSchema).max(200),
    refundAmount: z.number().nonnegative().nullable().optional(),
    note: optionalTrimmed(2000),
    idempotencyKey: z.string().uuid(),
    /**
     * `offset: true` is load-bearing, not defensive. This is fed straight from
     * `contracts.updated_at` as PostgREST renders it — `…+00:00`, not `…Z` — and
     * bare `.datetime()` rejects the offset form. Without it `form.trigger()`
     * failed on a field with no visible input, so the wizard showed only
     * "Fix required fields before submitting" and no close-out could ever commit.
     */
    expectedContractUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((value) => !value.archiveTenant || value.outcome === "archive", {
    message: "archiveTenant may only be true when outcome is archive",
    path: ["archiveTenant"],
  });

export const restoreSchema = z.object({
  contractId: z.string().uuid(),
  targetState: z.enum([
    "draft",
    "active",
    "frozen",
    "suspended",
    "expired",
    "terminated",
    "renewed",
  ]),
  restoreTenant: z.boolean(),
  reason: z.string().trim().min(1).max(2000),
});

export const reverseRefundSchema = z.object({
  refundId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
});

export const voidRefundSchema = z.object({
  refundId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
});

export const writeOffSchema = z.object({
  invoiceId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
});

export const disputeSchema = z
  .object({
    invoiceId: z.string().uuid(),
    /** Required when clearing is false. */
    reason: z.string().trim().min(1).max(2000).optional(),
    /** When true, calls clear_invoice_dispute instead of set_invoice_dispute. */
    clear: z.boolean().optional().default(false),
  })
  .refine((value) => value.clear || Boolean(value.reason?.trim()), {
    message: "A dispute reason is required when setting a dispute",
    path: ["reason"],
  });

export const cancelCloseoutSchema = z.object({
  closeoutId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
});

export const previewCloseoutSchema = z.object({
  contractId: z.string().uuid(),
  deductions: z.array(deductionSchema).max(50),
  invoiceActions: z.array(invoiceActionSchema).max(200),
  refundAmount: z.number().nonnegative().nullable().optional(),
});

export type CloseoutInput = z.infer<typeof closeoutSchema>;
export type RestoreInput = z.infer<typeof restoreSchema>;
export type ReverseRefundInput = z.infer<typeof reverseRefundSchema>;
export type VoidRefundInput = z.infer<typeof voidRefundSchema>;
export type WriteOffInput = z.infer<typeof writeOffSchema>;
export type DisputeInput = z.infer<typeof disputeSchema>;
export type CancelCloseoutInput = z.infer<typeof cancelCloseoutSchema>;
export type PreviewCloseoutInput = z.infer<typeof previewCloseoutSchema>;
export type DeductionInput = z.infer<typeof deductionSchema>;
export type InvoiceActionInput = z.infer<typeof invoiceActionSchema>;
