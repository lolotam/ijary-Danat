import { useQuery } from "@tanstack/react-query";

import { FINANCE_QUERY_OPTIONS } from "@/hooks/financeQueryOptions";
import { supabase } from "@/integrations/supabase/client";
import type { InvoiceState, Json } from "@/integrations/supabase/database.types";
import type { PartialPaymentEditContext } from "@/lib/partialPaymentRemaining";

/**
 * مفتاح استعلام سياق تعديل الدفعة الجزئية، حتى تُبطله الطفرات بعد الحفظ.
 */
export function partialPaymentEditContextKey(id: string | null) {
  return ["partial-payment-edit-context", id] as const;
}

/**
 * يحوّل jsonb الذي يعيده RPC السياق إلى أرقام حقيقية.
 *
 * Postgres numeric arrives as a string through json, and adding it to `balance`
 * as a string would concatenate. The dialog cap is money.
 */
function asContext(payload: Json | null): PartialPaymentEditContext | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  const invoiceRaw = row.invoice;
  let invoice: PartialPaymentEditContext["invoice"] = null;
  if (invoiceRaw && typeof invoiceRaw === "object" && !Array.isArray(invoiceRaw)) {
    const invoiceRow = invoiceRaw as Record<string, unknown>;
    if (typeof invoiceRow.id === "string") {
      invoice = {
        id: invoiceRow.id,
        code: typeof invoiceRow.code === "string" ? invoiceRow.code : "",
        period_year: Number(invoiceRow.period_year),
        period_month: Number(invoiceRow.period_month),
        balance: Number(invoiceRow.balance),
        state: invoiceRow.state as InvoiceState,
      };
    }
  }
  return {
    settled: Boolean(row.settled),
    credited_amount: Number(row.credited_amount ?? 0),
    invoice,
  };
}

/**
 * يجلب سياق تعديل الدفعة الجزئية: هل هي مسدَّدة، وكم رصيدها على فاتورة الحوار.
 *
 * Keyed on the row id and enabled only while the dialog is open. `staleTime: 0`
 * is what makes "every open refetches" true: toggling `enabled` inside the
 * shared 30-second window would otherwise reuse the cached balance, and a
 * payment made meanwhile would leave the dialog offering an amount the RPC
 * then rejects.
 */
export function usePartialPaymentEditContext(partialId: string | null, open: boolean) {
  return useQuery({
    queryKey: partialPaymentEditContextKey(partialId),
    enabled: open && Boolean(partialId),
    ...FINANCE_QUERY_OPTIONS,
    staleTime: 0,
    queryFn: async (): Promise<PartialPaymentEditContext> => {
      const { data, error } = await supabase.rpc("get_partial_payment_edit_context", {
        p_id: partialId!,
      });
      if (error) throw error;
      const parsed = asContext(data);
      if (!parsed) throw new Error("partial_payment_edit_context_missing");
      return parsed;
    },
  });
}
