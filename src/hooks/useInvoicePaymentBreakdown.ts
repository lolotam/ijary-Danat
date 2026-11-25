import { supabase } from "@/integrations/supabase/client";
import { parseInvoicePaymentBreakdown } from "@/lib/invoicePaymentBreakdown";
import type { InvoicePaymentBreakdown } from "@/lib/invoicePaymentBreakdown";

/**
 * The jsonb parser moved to `@/lib/invoicePaymentBreakdown` so the server-side
 * document renderer can reuse it without importing the browser client. Re-
 * exported because the tests and the portal both import it from here.
 */
export { parseInvoicePaymentBreakdown };

/**
 * يجلب لقطة سداد الفاتورة؛ يفشل بصوت عالٍ إن غابت أو رُفضت.
 *
 * A null RPC result means the caller may not see the invoice. Printing a
 * document without the snapshot would silently omit the payments section.
 */
export async function fetchInvoicePaymentBreakdown(
  invoiceId: string,
): Promise<InvoicePaymentBreakdown> {
  const { data, error } = await supabase.rpc("get_invoice_payment_breakdown", {
    p_invoice_id: invoiceId,
  });
  if (error) throw error;
  return parseInvoicePaymentBreakdown(data);
}
