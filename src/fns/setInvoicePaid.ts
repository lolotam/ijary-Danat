import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { notifyManualPaymentInvoice } from "@/fns/notifyPaymentSuccess.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";

/**
 * Exported for tests. `setInvoicePaid.test.ts` mocks `createServerFn`, and the
 * mock's `.validator()` returns the function untouched — so nothing in that
 * suite ever executes this schema. Asserting on it directly is the only way the
 * "a reason is required" rule is actually covered.
 */
export const setInvoicePaidSchema = z
  .object({
    invoiceId: z.string().uuid(),
    paymentMethod: z.string().min(1).max(100).nullable().optional(),
    paid: z.boolean(),
  })
  // Required on the way in, meaningless on the way out. Validated here rather
  // than only in the dialog so the method cannot be skipped by calling the
  // server function directly.
  .refine((value) => !value.paid || Boolean(value.paymentMethod), {
    message: "A payment method is required when marking an invoice paid.",
    path: ["paymentMethod"],
  });

export type SetInvoicePaidInput = z.infer<typeof setInvoicePaidSchema>;

/**
 * Flip an invoice between paid and unpaid from the admin invoices table.
 *
 * Marking it paid records a confirmed payment for the remaining balance,
 * dated inside that invoice's own period, and allocates it to the invoice.
 * Reverting deletes only the payment that was created this way (matched by
 * its `AUTO-INV:<code>` reference) — manual and gateway payments are never
 * touched — and recomputes the invoice from its surviving allocations.
 *
 * Marking paid notifies through the `manual-payment-invoice` workflow. This
 * reverses an earlier decision to send nothing here, and does it the way that
 * decision asked for: the concern was an *unconditional* receipt firing every
 * time an admin ticked the box, including while correcting a mistake. The send
 * is now opt-in per install — an admin owns both the on/off switch and the
 * recipient targets — so a company that treats this purely as reconciliation
 * can aim it at staff only, or switch it off, without also silencing the
 * receipt a tenant gets for their own card payment.
 *
 * Reverting sends nothing. It deletes the payment it created, and there is no
 * such thing as an un-receipt.
 *
 * The notify call is deliberately swallowed. A payment has already been
 * recorded by the time it runs; a mail outage must not surface as a failed
 * payment, nor undo one.
 *
 * Failure paths throw an `Error`, never a `Response`. TanStack Start returns a
 * thrown `Response` to the caller instead of rejecting, so a
 * `throw new Response("Forbidden", { status: 403 })` here resolved the caller's
 * `await` and fired its success toast while nothing changed — see
 * `deleteAppUser.ts` for the same trap. The return value is
 * `{ updated: true, rows }` rather than bare rows so the caller can assert on a
 * flag that no failure path can produce.
 */
export const setInvoicePaid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(setInvoicePaidSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "invoices.update",
      attempted: "invoice.set_paid",
      refusal: "You do not have permission to change invoice payment state.",
      entityType: "invoice",
      entityId: data.invoiceId,
    });
    const { data: rows, error } = await context.supabase.rpc("set_invoice_paid", {
      p_invoice_id: data.invoiceId,
      // `p_method` is authoritative; the RPC mirrors it onto
      // `manual_payment_reason` so both columns describe the same event.
      p_method: data.paid ? (data.paymentMethod ?? null) : null,
      p_paid: data.paid,
    });
    if (error) throw new Error(error.message);

    // Audit after the money move, never before: a failed audit write must not
    // undo a payment that already landed, so this is logged and swallowed.
    const { error: auditError } = await context.supabase.rpc("write_audit", {
      p_action: data.paid ? "invoice.mark_paid" : "invoice.unmark_paid",
      p_entity_type: "invoice",
      p_entity_id: data.invoiceId,
      p_before: null,
      p_after: {
        payment_method: data.paid ? (data.paymentMethod ?? null) : null,
        paid: data.paid,
        rows,
      },
      p_result: "success",
      p_error_code: null,
    });
    if (auditError) {
      console.error("Audit write failed for set_invoice_paid", auditError);
    }

    // Only on the way in, and only when a payment was actually created. The RPC
    // returns a null payment_id when the invoice had nothing left to settle, and
    // a receipt for a payment that does not exist is worse than no receipt.
    const paymentId = data.paid ? (rows?.[0]?.payment_id ?? null) : null;
    if (paymentId) {
      try {
        await notifyManualPaymentInvoice([paymentId]);
      } catch (notifyError) {
        console.error("Manual payment notification failed", notifyError);
      }
    }

    return { updated: true as const, rows };
  });
