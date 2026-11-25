import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/database.types";
import { allocatedAmountByPayment, attributePaymentsToContract } from "@/lib/contractPayments";
import { fetchInChunks } from "@/lib/idChunks";

export type ContractPayment = Tables<"payments"> & {
  /** The share of this payment that landed on this contract's invoices. */
  allocated: number;
};

/**
 * The payments that paid one contract, with the amount allocated to it.
 *
 * Three hops, because `payments` has no `contract_id`: this contract's invoices,
 * the allocations against them, then the payments behind those allocations.
 * See `lib/contractPayments` for why the allocated share is what gets shown.
 *
 * Parent-scoped to one contract. Do **not** paginate: the contract payments tab
 * and any balance derived from this list need every allocation that landed on
 * the contract's invoices. Truncating would understate paid totals.
 */
export function useContractPayments(contractId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["contract-payments", contractId],
    enabled: Boolean(contractId) && enabled,
    queryFn: async (): Promise<ContractPayment[]> => {
      if (!contractId) return [];
      const { data: invoices, error: invoiceError } = await supabase
        .from("invoices")
        .select("id")
        .eq("contract_id", contractId);
      if (invoiceError) throw invoiceError;
      if (!invoices.length) return [];

      // Chunked: a twenty-year lease holds ~240 invoices, and one `in()` filter
      // that wide is a 414 from the gateway rather than a slow query.
      const allocations = await fetchInChunks(
        invoices.map((invoice) => invoice.id),
        (chunk) =>
          supabase
            .from("payment_allocations")
            .select("payment_id, invoice_id, amount")
            .in("invoice_id", chunk),
      );
      if (!allocations.length) return [];

      const allocatedByPayment = allocatedAmountByPayment(
        allocations,
        invoices.map((invoice) => invoice.id),
      );
      // `fetchInChunks` orders within a chunk, not across them, so the newest-first
      // order this tab relies on is re-established here rather than trusted from
      // the query.
      const payments = await fetchInChunks([...allocatedByPayment.keys()], (chunk) =>
        supabase
          .from("payments")
          .select("*")
          .in("id", chunk)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false }),
      );
      payments.sort(
        (left, right) =>
          right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
      );

      return attributePaymentsToContract(payments, allocatedByPayment);
    },
  });
}
