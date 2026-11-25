import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/auth/AuthProvider";
import { supabase } from "@/integrations/supabase/client";
import { logAuditForCurrentSession } from "@/lib/audit";

export interface UserTenantLink {
  id: string;
  user_id: string;
  tenant_id: string;
}

// `user_tenants` arrived in migration 39 and is not in the hand-maintained
// database.types.ts yet — same escape hatch useCustomRoles uses.
const table = supabase.from("user_tenants" as never) as never;

/**
 * Tenant links for every user, keyed by user id.
 *
 * RLS returns only the caller's own links unless they hold `users.read`, so
 * the same query serves both the admin users screen and the portal switcher.
 */
export function useUserTenants(enabled = true) {
  return useQuery({
    queryKey: ["user-tenants"],
    enabled,
    queryFn: async (): Promise<Map<string, string[]>> => {
      const { data, error } = await (table as any).select("user_id, tenant_id");
      if (error) throw error;
      const byUser = new Map<string, string[]>();
      for (const link of (data ?? []) as UserTenantLink[]) {
        byUser.set(link.user_id, [...(byUser.get(link.user_id) ?? []), link.tenant_id]);
      }
      return byUser;
    },
  });
}

/**
 * Replaces a user's tenant links with `tenantIds`.
 *
 * Written as delete-then-insert rather than a diff: the lists are small, and a
 * full replace keeps the result identical no matter what the previous state was.
 */
export function useSetUserTenants() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ userId, tenantIds }: { userId: string; tenantIds: string[] }) => {
      const { data: before, error: beforeError } = await (table as any)
        .select("tenant_id")
        .eq("user_id", userId);
      if (beforeError) throw beforeError;

      const { error: deleteError } = await (table as any).delete().eq("user_id", userId);
      if (deleteError) throw deleteError;

      if (tenantIds.length) {
        const { error: insertError } = await (table as any).insert(
          tenantIds.map((tenantId) => ({
            user_id: userId,
            tenant_id: tenantId,
            created_by: user?.id ?? null,
          })),
        );
        if (insertError) throw insertError;
      }

      await logAuditForCurrentSession({
        action: "user.tenants.assign",
        entityType: "user",
        entityId: userId,
        before: { tenant_ids: ((before ?? []) as { tenant_id: string }[]).map((r) => r.tenant_id) },
        after: { tenant_ids: tenantIds },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["user-tenants"] }),
  });
}
