import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

/** مفتاح الاستعلام المشترك بين الخطّاف والجالب المباشر. */
export function suppressedContractsKey(tenantId: string | null | undefined) {
  return ["portal-suppressed-contracts", tenantId ?? null] as const;
}

/**
 * يجلب معرّفات عقود المستأجر التي لا يجوز إصدار مستندات لها: المكبوتة والمخفية عن البوابة.
 *
 * Kept as a plain async function as well as a hook, the same reason
 * `fetchPaymentAllocations` is: the payment row's document builder needs this
 * as a *return value* at click time, not as the previous render's `data`.
 *
 * Portal RLS already lets a tenant read their own contracts — `/portal/lease`
 * does it — so no new policy is needed. Filtering server-side rather than
 * fetching every contract keeps the suppressed set explicit.
 */
export async function fetchSuppressedContractIds(tenantId: string): Promise<Set<string>> {
  // Either flag denies the paper. Review finding on PR #209: `buildDoc` filters
  // the settled invoices through this set alone, so a contract hidden with
  // migration 210's switch but never suppressed would still hand the tenant a
  // printable document for an invoice the rest of the portal denies exists.
  // Migration 212 stops them reading those invoices at all, which covers the
  // tenant's own session; this covers the staff preview, which is RLS-exempt.
  const { data, error } = await supabase
    .from("contracts")
    .select("id")
    .eq("tenant_id", tenantId)
    .or("suppress_tenant_billing_docs.eq.true,hide_from_portal.eq.true");
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.id));
}

/**
 * المجموعة المكبوتة لعرض الصفحة — استعلام واحد للصفحة كلها لا لكل صف.
 *
 * The payments table would otherwise fan out a query per row on mount, which is
 * exactly why `PaymentRowActions` loads its allocations lazily at click time.
 */
export function useSuppressedContractIds(tenantId: string | null) {
  return useQuery({
    queryKey: suppressedContractsKey(tenantId),
    enabled: Boolean(tenantId),
    queryFn: () => fetchSuppressedContractIds(tenantId!),
  });
}
