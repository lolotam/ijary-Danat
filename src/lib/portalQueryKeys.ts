import type { QueryClient } from "@tanstack/react-query";

/**
 * كل مفاتيح كاش البوابة التي تعرض بيانات المستأجر — القائمة الوحيدة لها.
 *
 * Staff open the tenant portal as that tenant (`/portal?tenant=<id>`), and that
 * page runs in the SAME React Query cache as the admin app. An admin mutation
 * that does not invalidate these keys leaves the preview showing pre-mutation
 * data for the shared thirty-second `staleTime` (focus refetching is off). It
 * already happened once: adding a discount and switching to the preview showed
 * the pre-discount lease, because the concession mutations invalidated only the
 * admin-side keys.
 *
 * Audit M22 found the fix written four different ways — this helper for
 * concessions, two inline arrays, and one key nested under an admin key — with
 * the most frequent mutations (recording, allocating and reversing payments,
 * generating invoices, closing out a contract) covered by none of them. One
 * list, one call: a new portal query cannot be added without it sitting here.
 *
 * `["insurance_payments", "portal-total", …]` in `usePortalData.ts` is
 * deliberately NOT here. It nests under the admin `insurance_payments` key so
 * the insurance mutations' own sweep reaches it; its comment explains the
 * stale total a standalone `portal-…` key caused.
 */
export const PORTAL_QUERY_KEYS = [
  "portal-identity",
  "portal-lease",
  "portal-invoices",
  "portal-invoice-summary",
  "portal-contracts",
  "portal-payments",
] as const;

/**
 * يُبطل كاش كل صفحات البوابة بعد أي تعديل إداري على الفواتير أو الدفعات.
 *
 * Invalidates by prefix, so every tenant's cached copy goes — a staff preview
 * may be open on any of them. Returns the promise so a caller that must wait
 * for the refetch (the payment callback) can. Only reaches this browser's
 * cache; a tenant on their own device sees the change on their next load.
 */
export function invalidatePortalViews(queryClient: QueryClient): Promise<void> {
  return Promise.all(
    PORTAL_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
  ).then(() => undefined);
}
