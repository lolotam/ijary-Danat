import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { visiblePortalTabs, type PortalTab, type PortalTabOverrides } from "@/lib/portalTabs";

/**
 * Permission codes granted to the `tenant` role.
 *
 * Deliberately NOT `usePermissions()`. That hook answers "what may the signed-in
 * user do", and short-circuits to true for admins — so an admin previewing a
 * tenant portal via `?tenant=` would see all six tabs regardless of
 * configuration, and the preview would misrepresent what the tenant gets.
 * Tab visibility is a property of the tenant, so it always resolves against the
 * tenant role.
 *
 * `role_permissions` is readable by any authenticated user
 * (role_permissions_select_authenticated, migration 03), so tenants can run
 * this for themselves.
 */
function useTenantRolePermissions() {
  return useQuery({
    queryKey: ["tenant-role-permissions"],
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from("role_permissions")
        .select("permission_code")
        .eq("role", "tenant");

      if (error) throw error;
      return data.map(({ permission_code }) => permission_code);
    },
    staleTime: 5 * 60 * 1000,
  });
}

export interface PortalTabAccess {
  tabs: PortalTab[];
  /** True until the role permissions have loaded — render nav only after. */
  isLoading: boolean;
}

/**
 * The portal tabs a given tenant may see: the tenant role's defaults, with the
 * tenant's own overrides applied on top.
 *
 * `hasLinkedShop` controls the shop tab's declared requirement — see
 * `PortalTab.requiresLinkedShop`. When undefined (still loading) the shop tab
 * stays hidden so it never flashes.
 */
export function usePortalTabAccess(
  overrides: PortalTabOverrides | null,
  options?: { hasLinkedShop?: boolean },
): PortalTabAccess {
  const rolePermissions = useTenantRolePermissions();

  const tabs = useMemo(() => {
    // Resolve against an empty grant set while loading rather than a full one,
    // so tabs never flash into view and then disappear.
    const granted = new Set(rolePermissions.data ?? []);
    return visiblePortalTabs(overrides, granted, {
      hasLinkedShop: options?.hasLinkedShop,
    });
  }, [overrides, rolePermissions.data, options?.hasLinkedShop]);

  return { tabs, isLoading: rolePermissions.isLoading };
}
