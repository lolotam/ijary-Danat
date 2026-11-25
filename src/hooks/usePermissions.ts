import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/auth/AuthProvider";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "@/integrations/supabase/database.types";
import { isPermissionCode, type PermissionCode } from "@/lib/permissions";

export function useMyRoles() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["my-roles", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async (): Promise<AppRole[]> => {
      if (!user) return [];

      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);

      if (error) throw error;
      return data.map(({ role }) => role);
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function usePermissions() {
  const rolesQuery = useMyRoles();
  const roles = rolesQuery.data ?? [];
  const isAdmin = roles.includes("admin");

  const permissionsQuery = useQuery({
    queryKey: ["my-permissions", [...roles].sort()],
    enabled: rolesQuery.isSuccess && roles.length > 0 && !isAdmin,
    queryFn: async (): Promise<PermissionCode[]> => {
      const { data, error } = await supabase
        .from("role_permissions")
        .select("permission_code")
        .in("role", roles);

      if (error) throw error;
      return data.map(({ permission_code }) => permission_code).filter(isPermissionCode);
    },
    staleTime: 5 * 60 * 1000,
  });

  const permissionSet = useMemo(
    () => new Set<PermissionCode>(permissionsQuery.data ?? []),
    [permissionsQuery.data],
  );

  return {
    roles,
    isAdmin,
    // Any non-tenant role counts as staff (admin, accountant, collector, readonly).
    isStaff: roles.some((role) => role !== "tenant"),
    can: (code: PermissionCode) => isAdmin || permissionSet.has(code),
    canAny: (codes: readonly PermissionCode[]) =>
      isAdmin || codes.some((code) => permissionSet.has(code)),
    isLoading: rolesQuery.isLoading || (!isAdmin && permissionsQuery.isLoading),
    error: rolesQuery.error ?? permissionsQuery.error,
  };
}
