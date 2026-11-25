import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/database.types";
import { applyAllocationForCurrentSession } from "@/lib/applyAllocation";
import { fetchInChunks } from "@/lib/idChunks";
import {
  EXTRA_CHARGE_ITEM_COLUMNS,
  resolveExtraChargesByInvoice,
  type ExtraChargeLine,
} from "@/lib/invoiceExtraCharges";
import { PERMISSIONS } from "@/lib/permissions";
import { FINANCE_QUERY_OPTIONS } from "@/hooks/financeQueryOptions";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

export interface AllocationWithInvoice extends Tables<"payment_allocations"> {
  invoice: Tables<"invoices"> | null;
  /**
   * The settled invoice's recurring service-charge lines, printed on the
   * receipt so the tenant can tell rent from cleaning.
   *
   * Optional because the receipt renders without it: the server path that
   * builds the emailed PDF treats a failed lookup as a degradation rather than
   * an outage, and every caller that constructs an allocation by hand predates
   * the field.
   */
  extraCharges?: ExtraChargeLine[];
}

/** Query key for one payment's allocations — shared by the hook and the
 * imperative fetcher so both read and write the same cache entry. */
export function paymentAllocationsKey(paymentId: string) {
  return ["payment-allocations", paymentId] as const;
}

/**
 * Load a payment's allocations (each joined to its invoice).
 *
 * Parent-scoped to one payment. Do **not** paginate this collection: receipt
 * printing, allocation UI, and paid-balance math require every row for the
 * payment. A single payment's allocation count is naturally bounded by the
 * number of invoices it settles.
 *
 * Kept as a plain async function — not only a hook — because the portal's
 * row actions need the allocations as a *return value* at click time. Reading
 * them off a hook there would either fire a disabled query or hand back the
 * previous render's `data`, and the receipt would print with no breakdown.
 */
export async function fetchPaymentAllocations(paymentId: string): Promise<AllocationWithInvoice[]> {
  if (!paymentId) return [];
  const { data, error } = await supabase
    .from("payment_allocations")
    .select("*")
    .eq("payment_id", paymentId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  const invoiceIds = data.map((allocation) => allocation.invoice_id);
  const invoiceResult = invoiceIds.length
    ? await supabase.from("invoices").select("*").in("id", invoiceIds)
    : { data: [] as Tables<"invoices">[], error: null };
  if (invoiceResult.error) throw invoiceResult.error;
  const invoices = new Map(invoiceResult.data.map((invoice) => [invoice.id, invoice]));
  // Chunked where the invoices query above is not: one payment settles few
  // invoices, but a consolidated multi-unit invoice carries several lines each,
  // and a response clipped at the row cap would silently drop a charge.
  const itemRows = await fetchInChunks(invoiceIds, (chunk) =>
    supabase.from("invoice_items").select(EXTRA_CHARGE_ITEM_COLUMNS).in("invoice_id", chunk),
  );
  const extraChargesFor = resolveExtraChargesByInvoice(itemRows);
  return data.map((allocation) => ({
    ...allocation,
    invoice: invoices.get(allocation.invoice_id) ?? null,
    extraCharges: extraChargesFor.get(allocation.invoice_id) ?? [],
  })) as AllocationWithInvoice[];
}

export function usePaymentAllocations(paymentId: string | null) {
  return useQuery({
    queryKey: paymentId ? paymentAllocationsKey(paymentId) : ["payment-allocations", null],
    enabled: Boolean(paymentId),
    ...FINANCE_QUERY_OPTIONS,
    queryFn: () => fetchPaymentAllocations(paymentId!),
  });
}

export function useApplyPaymentAllocation() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: {
      allocations: { amount: number; invoice_id: string }[];
      paymentId: string;
    }) => {
      if (!permissions.can(PERMISSIONS.PAYMENTS_CREATE)) throw new Error("Permission denied.");
      // `applyAllocation` records `allocation.apply` server-side. Review finding
      // on PR #206: keeping this second write produced two audit rows per
      // allocation under two different action codes, and the browser-written one
      // covered neither a direct call to the server function nor a forged body.
      return applyAllocationForCurrentSession(input);
    },
    onSuccess: (_, input) => {
      queryClient.invalidateQueries({ queryKey: ["payment-allocations", input.paymentId] });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void invalidatePortalViews(queryClient);
      queryClient.invalidateQueries({ queryKey: ["invoice-month-summary"] });
      queryClient.invalidateQueries({ queryKey: ["receipts"] });
    },
  });
}
