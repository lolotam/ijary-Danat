import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";
import type { Database } from "@/integrations/supabase/database.types";
import { fetchInChunks } from "@/lib/idChunks";
import { findOutOfOrderAllocation } from "@/lib/invoiceSettlement";

const allocationSchema = z.object({
  invoice_id: z.string().uuid(),
  amount: z.number().positive(),
});
const schema = z.object({
  paymentId: z.string().uuid(),
  allocations: z.array(allocationSchema).min(1),
});

export type ApplyAllocationInput = z.infer<typeof schema>;

/**
 * يرفض توزيعاً يسدّد فاتورة أحدث بينما فاتورة أقدم للعقد نفسه ما زالت مفتوحة.
 *
 * Reads as the calling user (RLS applies), after the permission check, so a
 * refused caller learns nothing about invoices. Every open invoice of each
 * touched contract is read, not only the allocated ones: an older month nobody
 * selected is exactly what the rule protects.
 *
 * Both reads go through `fetchInChunks` (Codex review, PR #220): it keeps each
 * URL under the gateway's request-line limit however many invoices one payment
 * settles, and splits any chunk whose response reached the row cap — so five
 * twenty-year leases in one payment are read whole, one contract at a time if
 * need be, instead of being refused as clipped. A single contract that alone
 * reaches the cap still throws rather than judging order from a partial list.
 */
async function assertChronologicalAllocation(
  supabase: SupabaseClient<Database>,
  allocations: ApplyAllocationInput["allocations"],
): Promise<void> {
  const invoiceIds = [...new Set(allocations.map((allocation) => allocation.invoice_id))];
  const targets = await fetchInChunks(invoiceIds, (chunk) =>
    supabase.from("invoices").select("contract_id").in("id", chunk),
  );
  const contractIds = [...new Set(targets.map((row) => row.contract_id))];
  if (!contractIds.length) return;
  // Chunked on `contract_id`, so one contract's invoices never split across
  // chunks. `contract_id` is kept so each allocation is judged against its own
  // contract only — pooling two contracts let one's arrears block the other.
  const siblings = await fetchInChunks(contractIds, (chunk) =>
    supabase
      .from("invoices")
      .select("id, contract_id, balance, code, period_month, period_year, state")
      .in("contract_id", chunk),
  );
  const rows = siblings.map((row) => ({ ...row, balance: Number(row.balance) }));
  if (findOutOfOrderAllocation(rows, allocations)) {
    throw new Error("Settle the oldest open invoice first: an earlier month is still unpaid.");
  }
}

export const applyAllocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "payments.create",
      attempted: "allocation.apply",
      refusal: "You do not have permission to apply a payment allocation.",
    });
    // Checked here first for the clearer error. Since migration 217 the RPC
    // enforces the same rule for `authenticated` callers too, so a direct
    // PostgREST call cannot skip it; `service_role` (the gateway webhook and
    // the reconcile job) stays exempt so gateway money is never stranded
    // mid-webhook (audit H8).
    await assertChronologicalAllocation(context.supabase, data.allocations);
    const { data: rows, error } = await context.supabase.rpc("apply_payment_allocation", {
      p_payment_id: data.paymentId,
      p_allocations: data.allocations,
    });
    if (error) throw new Error(error.message);

    // No audit write here, for the same reason as `reversePayment`:
    // `apply_payment_allocation` is granted directly to `authenticated`, so a
    // direct PostgREST call would settle invoices with nothing recorded.
    // Migration 213 moved the row inside the RPC.
    return rows;
  });
