import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { fetchInChunks } from "@/lib/idChunks";
import type { LinkedConcession } from "@/lib/invoiceDiscountColumn";

/**
 * يقرأ التنازل المرتبط بكل فاتورة، لعرض نوع الخصم ونسبته في جدول الفواتير.
 *
 * The inverse of useConcessionInvoiceCoverage, which is keyed by concession.
 * The invoice table needs the other direction: given an invoice, which
 * concession discounted it.
 *
 * It deliberately does *not* count how many invoices each concession covers.
 * That count belongs to the concession and is shown in `ConcessionsDialog`;
 * fetching it here meant a second full `concession_invoices` scan on every page
 * of the table to feed a badge the Discount column no longer shows.
 */
export function useInvoiceDiscounts(invoiceIds: string[]) {
  const key = [...invoiceIds].sort().join(",");
  return useQuery({
    queryKey: ["invoice-discounts", key],
    enabled: invoiceIds.length > 0,
    queryFn: async (): Promise<Map<string, LinkedConcession>> => {
      // Chunked: a contract tab now hands over every invoice it holds, and past
      // ~200 ids the `in()` filter overruns the gateway URL limit (414).
      const links = await fetchInChunks(invoiceIds, (chunk) =>
        supabase
          .from("concession_invoices")
          .select("concession_id, invoice_id")
          .in("invoice_id", chunk),
      );
      if (!links.length) return new Map();

      const concessionIds = [...new Set(links.map((row) => row.concession_id))];
      const concessionRows = await fetchInChunks(concessionIds, (chunk) =>
        supabase.from("concessions").select("id, type, discount_percent").in("id", chunk),
      );

      const byConcessionId = new Map(
        concessionRows.map((row) => [
          row.id,
          {
            type: row.type as string,
            discount_percent: row.discount_percent,
          } satisfies LinkedConcession,
        ]),
      );

      const byInvoice = new Map<string, LinkedConcession>();
      for (const link of links) {
        const concession = byConcessionId.get(link.concession_id);
        if (concession) byInvoice.set(link.invoice_id, concession);
      }
      return byInvoice;
    },
  });
}
