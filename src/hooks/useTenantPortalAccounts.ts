import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages } from "@/lib/pagedQuery";

/**
 * معرّفات المستأجرين الذين لديهم حساب بوابة فعلي، كمجموعة سريعة الفحص.
 *
 * `tenants.tenant_portal_enabled` is a switch an admin can set on its own, and
 * 54 of 57 tenants have it on while only 29 have an account behind it. The flag
 * therefore promises a portal login that in most cases does not exist, and the
 * gap was only ever discovered by phone call. This set is what the list needs
 * to tell the two apart.
 *
 * `profiles` is readable only with `users.read` (its RLS policy is
 * `uid() = id OR has_permission(uid(), 'users.read')`), so the caller passes
 * that permission as `enabled`. Without it the query never runs and the badge
 * is simply absent — a staff member who cannot see accounts is not shown a
 * claim about them either way.
 */
export function useTenantIdsWithPortalAccount(enabled = true) {
  return useQuery({
    queryKey: ["profiles", "tenant-ids"],
    enabled,
    // The account-management screens invalidate the `["profiles"]` root when an
    // account is created, so this key is caught by that. `refetchOnMount`
    // covers everything else — linking, revoking and deleting refresh only
    // their own keys, and with the router's 30-second staleTime and
    // refetchOnWindowFocus disabled, a remount would otherwise keep serving a
    // stale answer indefinitely. Review finding on PR #208.
    refetchOnMount: "always",
    queryFn: async (): Promise<Set<string>> => {
      // Paged rather than a bare select. PostgREST answers an unranged request
      // with its first thousand rows and *no error*, so past that the query
      // would succeed while silently omitting tenants — and every omitted one
      // would be shown the destructive "No account" badge. Same cap that
      // shortened a CSV export in PR #160.
      const { rows } = await fetchAllPages<{ id: string; tenant_id: string | null }>((after) => {
        let query = supabase
          .from("profiles")
          .select("id, tenant_id")
          .not("tenant_id", "is", null)
          .order("id", { ascending: true });
        if (after) query = query.gt("id", after.id);
        return query;
      });
      return new Set(rows.flatMap((row) => (row.tenant_id ? [row.tenant_id] : [])));
    },
  });
}
