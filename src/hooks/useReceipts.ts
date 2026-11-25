import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/database.types";
import { FINANCE_QUERY_OPTIONS } from "@/hooks/financeQueryOptions";

/**
 * Receipts for one payment or one tenant.
 *
 * Parent-scoped on purpose: a receipt is 1:1 with a payment in normal flow, so
 * the legitimate child set is tiny. Pagination is not applied — silently
 * truncating receipts would hide financial documents. The query is disabled
 * until a parent id is provided so the global table is never pulled into the
 * browser.
 *
 * `html_snapshot` is omitted from the select: the print UI rebuilds HTML from
 * the payment + allocations, and the snapshot can be large.
 */
export const RECEIPT_LIST_COLUMNS =
  "id, code, payment_id, tenant_id, amount, currency, issue_date, storage_path, visible_to_tenant, created_at";

export type ReceiptListItem = Omit<Tables<"receipts">, "html_snapshot">;

/** مفتاح الاستعلام المشترك بين الخطّاف والجالب المباشر. */
export function receiptsKey(paymentId?: string | null, tenantId?: string | null) {
  return ["receipts", { paymentId: paymentId ?? null, tenantId: tenantId ?? null }] as const;
}

/**
 * يجلب إيصالات دفعة أو مستأجر.
 *
 * Kept as a plain async function — not only a hook — because the portal's row
 * actions need the receipt as a *return value* at click time, the same reason
 * `fetchPaymentAllocations` exists. RLS decides what comes back: staff see
 * every receipt, a tenant only the ones flagged `visible_to_tenant`, so an
 * empty result here is a permission answer, not an error.
 */
export async function fetchReceipts(
  paymentId?: string | null,
  tenantId?: string | null,
): Promise<ReceiptListItem[]> {
  let query = supabase
    .from("receipts")
    .select(RECEIPT_LIST_COLUMNS)
    .order("issue_date", { ascending: false })
    .order("id", { ascending: false });
  if (paymentId) query = query.eq("payment_id", paymentId);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as ReceiptListItem[];
}

/**
 * يجلب رمز الإيصال الذي سُدِّدت به فاتورة، أو null إن لم يوجد.
 *
 * Fetched at click time rather than per row: the invoice tables render up to a
 * page of rows at once, and only the row whose Download button is pressed needs
 * this. Two hops because a receipt hangs off the payment, not the invoice —
 * allocations name the payments, and the receipt is 1:1 with a payment.
 *
 * The newest receipt wins when several payments settled one invoice. A partial
 * payment followed by the one that completed it leaves two, and the number the
 * tenant is holding for a settled invoice is the last one issued. A reversal's
 * mirror allocation cannot mislead here: it points at the same payment, and so
 * at the same receipt.
 *
 * Returns null rather than throwing on a query error. A missing receipt code
 * costs the file its preferred name; a throw would cost the user their
 * download, and the caller already falls back to the invoice code.
 */
export async function fetchInvoiceReceiptCode(invoiceId: string): Promise<string | null> {
  const allocations = await supabase
    .from("payment_allocations")
    .select("payment_id")
    .eq("invoice_id", invoiceId);
  if (allocations.error) {
    console.error("[useReceipts] allocation lookup failed", invoiceId, allocations.error.message);
    return null;
  }
  if (!allocations.data?.length) return null;

  const paymentIds = [...new Set(allocations.data.map((row) => row.payment_id))];
  const receipts = await supabase
    .from("receipts")
    .select("code, issue_date")
    .in("payment_id", paymentIds)
    .order("issue_date", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);
  if (receipts.error) {
    console.error("[useReceipts] receipt lookup failed", invoiceId, receipts.error.message);
    return null;
  }
  return receipts.data?.[0]?.code ?? null;
}

export function useReceipts(paymentId?: string | null, tenantId?: string | null) {
  const hasParent = Boolean(paymentId || tenantId);
  return useQuery({
    queryKey: receiptsKey(paymentId, tenantId),
    enabled: hasParent,
    ...FINANCE_QUERY_OPTIONS,
    queryFn: () => fetchReceipts(paymentId, tenantId),
  });
}
