import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { useAuth } from "@/auth/AuthProvider";
import { revokeUserRole } from "@/fns/revokeUserRole";
import { setUserActive as setUserActiveFn } from "@/fns/setUserActive";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { pageRange } from "@/hooks/pagination";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole, Tables } from "@/integrations/supabase/database.types";
import { fetchInChunks } from "@/lib/idChunks";
import { logAuditForCurrentSession } from "@/lib/audit";
import { fetchAllOffsetPages } from "@/lib/pagedQuery";
import { CONTRACTED_TENANTS_KEY } from "@/hooks/useContractedTenants";

export interface UserWithRoles extends Tables<"profiles"> {
  roles: AppRole[];
}

export type UserListScope = "managerial" | "tenant" | "all";

export interface UserListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  /**
   * Settings tabs: managerial = any non-tenant role; tenant = tenant role or
   * a linked `profiles.tenant_id`. `all` returns every profile.
   */
  scope?: UserListScope;
}

export interface UserListResult {
  items: UserWithRoles[];
  count: number;
}

const MANAGERIAL_ROLES: AppRole[] = ["admin", "accountant", "collector", "readonly"];

export function useUsersWithRoles(params: UserListParams | boolean = {}, enabledArg?: boolean) {
  // Back-compat: older call sites passed only `enabled` as the first argument.
  const normalized: UserListParams = typeof params === "boolean" ? {} : params;
  const enabled = typeof params === "boolean" ? params : (enabledArg ?? true);
  const page = Math.max(1, normalized.page ?? 1);
  const pageSize = Math.max(1, normalized.pageSize ?? 20);
  const search = normalized.search ?? "";
  const scope: UserListScope = normalized.scope ?? "all";

  return useQuery({
    queryKey: ["users-with-roles", { page, pageSize, search, scope }],
    enabled,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<UserListResult> => {
      const { from, to } = pageRange(page, pageSize);
      let profileFilterIds: string[] | null = null;

      if (scope === "managerial") {
        const { data: assignments, error } = await supabase
          .from("user_roles")
          .select("user_id")
          .in("role", MANAGERIAL_ROLES);
        if (error) throw error;
        profileFilterIds = [...new Set((assignments ?? []).map((row) => row.user_id))];
        if (!profileFilterIds.length) return { items: [], count: 0 };
      } else if (scope === "tenant") {
        const { data: assignments, error } = await supabase
          .from("user_roles")
          .select("user_id")
          .eq("role", "tenant");
        if (error) throw error;
        profileFilterIds = [...new Set((assignments ?? []).map((row) => row.user_id))];
      }

      let query = supabase
        .from("profiles")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);

      if (scope === "managerial" && profileFilterIds) {
        query = query.in("id", profileFilterIds);
      } else if (scope === "tenant") {
        // Match the previous client filter: tenant role OR linked portal tenant.
        const roleIds = profileFilterIds ?? [];
        if (roleIds.length) {
          query = query.or(`id.in.(${roleIds.join(",")}),tenant_id.not.is.null`);
        } else {
          query = query.not("tenant_id", "is", null);
        }
      }

      const term = normalizePostgrestSearch(search);
      if (term) {
        query = query.or(
          `display_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%,username.ilike.%${term}%`,
        );
      }

      const { data: profiles, error: profilesError, count } = await query;
      if (profilesError) throw profilesError;
      if (!profiles.length) return { items: [], count: count ?? 0 };

      const { data: roleRows, error: rolesError } = await supabase
        .from("user_roles")
        .select("*")
        .in(
          "user_id",
          profiles.map((profile) => profile.id),
        );
      if (rolesError) throw rolesError;

      const rolesByUser = new Map<string, AppRole[]>();
      for (const assignment of roleRows ?? []) {
        const roles = rolesByUser.get(assignment.user_id) ?? [];
        roles.push(assignment.role);
        rolesByUser.set(assignment.user_id, roles);
      }

      return {
        items: profiles.map((profile) => ({
          ...profile,
          roles: (rolesByUser.get(profile.id) ?? []).sort(),
        })),
        count: count ?? 0,
      };
    },
  });
}

/**
 * يجلب كل حسابات نطاق المستأجرين في استعلام واحد، بلا بحثٍ على الخادم.
 *
 * The tenants tab filters client-side. The server search only covers
 * `profiles` columns, so a tenant's name or DANA code never matched its
 * users — and the tab also has no pager, which means a paged query would
 * silently cap what it shows. Every tenant-scope user is therefore fetched
 * once (via `fetchAllOffsetPages`, never a bare row cap) and the caller
 * filters over the whole list, including the tenant name_en and code the
 * `tenantNames` map supplies.
 */
export function useAllTenantUsers(enabled = true) {
  return useQuery({
    // Child of the ["users-with-roles"] prefix every mutation on this page
    // invalidates, so create/edit/delete refresh this list too.
    queryKey: ["users-with-roles", "tenant-all"],
    enabled,
    queryFn: async (): Promise<UserWithRoles[]> => {
      const { data: assignments, error } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "tenant");
      if (error) throw error;
      const roleIds = [...new Set((assignments ?? []).map((row) => row.user_id))];

      const { rows: profiles } = await fetchAllOffsetPages(async (from, to) => {
        let query = supabase
          .from("profiles")
          .select("*", { count: "exact" })
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to);
        // Same tenant-scope predicate as useUsersWithRoles: the tenant role
        // OR a linked `profiles.tenant_id` — an account can hold either
        // without the other while a revoke is half-done.
        if (roleIds.length) {
          query = query.or(`id.in.(${roleIds.join(",")}),tenant_id.not.is.null`);
        } else {
          query = query.not("tenant_id", "is", null);
        }
        const { data, error: pageError, count } = await query;
        if (pageError) throw pageError;
        return { rows: data ?? [], count: count ?? 0 };
      });

      if (!profiles.length) return [];

      // Chunked: the id list travels in the URL, and one `in()` over every
      // tenant user would push it past the gateway's length limit.
      const roleRows = await fetchInChunks(
        profiles.map((profile) => profile.id),
        (chunk) => supabase.from("user_roles").select("*").in("user_id", chunk),
      );

      const rolesByUser = new Map<string, AppRole[]>();
      for (const assignment of roleRows) {
        const roles = rolesByUser.get(assignment.user_id) ?? [];
        roles.push(assignment.role);
        rolesByUser.set(assignment.user_id, roles);
      }

      return profiles.map((profile) => ({
        ...profile,
        roles: (rolesByUser.get(profile.id) ?? []).sort(),
      }));
    },
  });
}

export function useGrantRole() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: AppRole }) => {
      if (!user) throw new Error("Authentication required.");

      const { data, error } = await supabase
        .from("user_roles")
        .insert({ user_id: userId, role, granted_by: user.id })
        .select("*")
        .single();
      if (error) throw error;

      await logAuditForCurrentSession({
        action: "user.role.grant",
        entityType: "user",
        entityId: userId,
        after: { role },
      });

      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users-with-roles"] }),
  });
}

/**
 * Revokes a role. Revoking `tenant` also clears `profiles.tenant_id` and the
 * user's `user_tenants` rows — see src/fns/revokeUserRole.ts for why that
 * happens server-side.
 *
 * Both query keys are invalidated. `user-tenants` backs the "Linked tenants"
 * count, and leaving it stale would keep showing the old number even once the
 * database is right.
 */
export function useRevokeRole() {
  const queryClient = useQueryClient();
  const revoke = useServerFn(revokeUserRole);

  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: AppRole }) => {
      const result = (await revoke({ data: { userId, role } })) as
        | { revoked?: boolean; clearedTenantLink?: boolean; removedAssignments?: number }
        | undefined;
      if (!result?.revoked) throw new Error("The server did not confirm the role was revoked.");
      return {
        clearedTenantLink: Boolean(result.clearedTenantLink),
        removedAssignments: result.removedAssignments ?? 0,
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users-with-roles"] });
      queryClient.invalidateQueries({ queryKey: ["user-tenants"] });
      // Revoking `tenant` clears the portal link, so that tenant is pickable again.
      queryClient.invalidateQueries({ queryKey: CONTRACTED_TENANTS_KEY });
    },
  });
}

/**
 * Links a profile to a tenant record. Granting the `tenant` role alone leaves
 * `profiles.tenant_id` null, and the portal resolves a user's tenant from that
 * column — so without this the user gets the role but no portal to sign in to.
 */
/**
 * يتحقق هل يملك المستأجر حساب بوابة لمستخدم آخر.
 *
 * Asked before granting the `tenant` role: the role is committed before the
 * link, so a link refused by migration 224 afterwards would leave a tenant role
 * with no tenant behind it.
 */
export async function tenantHasOtherAccount(tenantId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("tenant_id", tenantId)
    .neq("id", userId)
    .limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}

export function useSetUserTenant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ userId, tenantId }: { userId: string; tenantId: string | null }) => {
      const { data: before } = await supabase
        .from("profiles")
        .select("tenant_id")
        .eq("id", userId)
        .single();
      const { data, error } = await supabase
        .from("profiles")
        .update({ tenant_id: tenantId })
        .eq("id", userId)
        .select("*")
        .single();
      if (error) throw error;

      await logAuditForCurrentSession({
        action: "user.tenant.update",
        entityType: "user",
        entityId: userId,
        before: { tenant_id: before?.tenant_id ?? null },
        after: { tenant_id: tenantId },
      });

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users-with-roles"] });
      queryClient.invalidateQueries({ queryKey: CONTRACTED_TENANTS_KEY });
    },
  });
}

/**
 * يوقف حساب مستخدم أو يعيد تفعيله عبر دالة خادم تملك صلاحية الخدمة.
 *
 * The write moved off the browser: only the server function can reach the
 * GoTrue Admin API to set `banned_until`, which is what actually stops token
 * issuance — the old direct `profiles` update was enforced by nothing. The
 * audit row is written inside the server function too, so it is not written
 * twice here.
 */
export function useSetUserActive() {
  const queryClient = useQueryClient();
  const setUserActive = useServerFn(setUserActiveFn);

  return useMutation({
    mutationFn: async ({ userId, isActive }: { userId: string; isActive: boolean }) => {
      const result = (await setUserActive({ data: { userId, isActive } })) as
        | { ok?: boolean; error?: string }
        | undefined;
      if (!result?.ok) {
        throw new Error(result?.error ?? "The server did not confirm the status update.");
      }
      return { userId, isActive };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users-with-roles"] }),
  });
}
