import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { fetchInChunks } from "@/lib/idChunks";

export type PortalPayableInvoice = {
  balance: number;
  discount: number;
  invoice_id: string;
  is_overdue: boolean;
  is_selectable: boolean;
  lock_reason: string | null;
  paid: number;
  period_month: number;
  period_year: number;
  sequence_order: number;
  state: string;
  total: number;
};

/**
 * فواتير البوابة القابلة للدفع، مع إمكانية قصرها على عقد واحد.
 *
 * The contract filter is applied by the RPC, not here: sequence_order and
 * is_selectable implement pay-oldest-first and must be renumbered inside the
 * filtered set, which only the database can do correctly. `discount` is joined
 * from invoices because the payable RPC does not return it, and the badge
 * must read the stored column — writing total alone would hide the discount.
 */
export function usePortalInvoices(tenantId: string | null, contractId: string | null = null) {
  return useQuery({
    queryKey: ["portal-invoices", tenantId, contractId],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<PortalPayableInvoice[]> => {
      const { data, error } = await supabase.rpc("evaluate_portal_payable_invoices", {
        p_tenant_id: tenantId!,
        ...(contractId ? { p_contract_id: contractId } : {}),
      });
      if (error) throw error;
      const rows = data ?? [];
      if (!rows.length) return [];
      // Chunked: a long-lease tenant's payable list runs to hundreds of invoices,
      // past the gateway URL ceiling for a single `in()` filter.
      const discounts = await fetchInChunks(
        rows.map((row) => row.invoice_id),
        (chunk) => supabase.from("invoices").select("id, discount").in("id", chunk),
      );
      const discountById = new Map(discounts.map((row) => [row.id, Number(row.discount ?? 0)]));
      return rows.map((row) => ({
        ...row,
        discount: discountById.get(row.invoice_id) ?? 0,
      }));
    },
  });
}
