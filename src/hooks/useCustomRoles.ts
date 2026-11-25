import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "@/integrations/supabase/database.types";

export interface CustomRole {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomRoleWithPermissions extends CustomRole {
  permissions: string[];
}

/** يعيد مُنشئ استعلام جدول الأدوار المخصصة. Fresh builder per call — builders are single-use. */
const rolesTable = () => supabase.from("custom_roles");
/** يعيد مُنشئ استعلام جدول صلاحيات الأدوار المخصصة. */
const permsTable = () => supabase.from("custom_role_permissions");
/** يعيد مُنشئ استعلام مصفوفة صلاحيات الأدوار المدمجة. */
const rolePermsTable = () => supabase.from("role_permissions");

/**
 * يحوّل قائمة رموز الصلاحيات إلى صفوف ربط بالدور المخصص.
 */
function permissionRowsFor(roleId: string, codes: string[]) {
  return codes.map((code) => ({ custom_role_id: roleId, permission_code: code }));
}

/**
 * يميّز غياب جداول الأدوار المخصصة عن أي خطأ آخر.
 *
 * PostgREST answers `PGRST205` for a table its schema cache does not know, and
 * PostgreSQL answers `42P01` for one that does not exist. Neither is a fault to
 * report — on this deployment they are simply the truth: migration 16 was never
 * applied, so the feature has no storage behind it.
 */
function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "PGRST205" || code === "42P01";
}

/**
 * يقرأ الأدوار المخصصة وصلاحياتها، ويعيد null عندما تكون الميزة غير مثبَّتة أصلاً.
 *
 * `null` is deliberately distinct from `[]`. An empty array means "the feature
 * exists and nobody has made a role yet", which the screen answers with an
 * empty-state and a create button. `null` means the tables are not there, and
 * the screen must not offer to write to them — production spent months showing
 * an editor whose every save was going to fail.
 */
export async function fetchCustomRoles(): Promise<CustomRoleWithPermissions[] | null> {
  const { data: roles, error } = await rolesTable().select("*").order("created_at", {
    ascending: false,
  });
  if (error && isMissingTable(error)) return null;
  if (error) throw error;
  const list = (roles ?? []) as CustomRole[];
  const ids = list.map((r) => r.id);

  // Review finding on PR #206: the feature needs *both* tables, and the probe
  // has to happen even when there are no roles yet. Returning `[]` early on an
  // empty `custom_roles` skipped this read entirely, so a deployment with the
  // roles table present and `custom_role_permissions` missing showed the editor
  // again — and the very first role created would insert, then fail saving its
  // permissions. A half-written role is worse than no editor, so both tables
  // are proven before the feature is declared available.
  const permissionRows = permsTable().select("custom_role_id, permission_code");
  const { data: perms, error: e2 } = await (ids.length
    ? permissionRows.in("custom_role_id", ids)
    : permissionRows.limit(1));
  if (e2 && isMissingTable(e2)) return null;
  if (e2) throw e2;
  if (!ids.length) return [];

  const map = new Map<string, string[]>();
  for (const p of (perms ?? []) as { custom_role_id: string; permission_code: string }[]) {
    const arr = map.get(p.custom_role_id) ?? [];
    arr.push(p.permission_code);
    map.set(p.custom_role_id, arr);
  }
  return list.map((r) => ({ ...r, permissions: map.get(r.id) ?? [] }));
}

export function useCustomRoles() {
  return useQuery({
    queryKey: ["custom_roles"],
    queryFn: fetchCustomRoles,
  });
}

export function useCreateCustomRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      code: string;
      name_ar: string;
      name_en: string;
      description?: string;
      permissions: string[];
    }) => {
      const { data, error } = await rolesTable()
        .insert({
          code: input.code,
          name_ar: input.name_ar,
          name_en: input.name_en,
          description: input.description ?? null,
        })
        .select()
        .single();
      if (error) throw error;
      const role = data as CustomRole;
      if (input.permissions.length > 0) {
        const { error: e2 } = await permsTable().insert(
          permissionRowsFor(role.id, input.permissions),
        );
        if (e2) throw e2;
      }
      return role;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["custom_roles"] }),
  });
}

export function useUpdateCustomRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      updates: Partial<Pick<CustomRole, "name_ar" | "name_en" | "description" | "is_active">>;
      permissions?: string[];
    }) => {
      const { error } = await rolesTable()
        .update({ ...input.updates, updated_at: new Date().toISOString() })
        .eq("id", input.id);
      if (error) throw error;
      if (input.permissions) {
        const { error: e1 } = await permsTable().delete().eq("custom_role_id", input.id);
        if (e1) throw e1;
        if (input.permissions.length > 0) {
          const { error: e2 } = await permsTable().insert(
            permissionRowsFor(input.id, input.permissions),
          );
          if (e2) throw e2;
        }
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["custom_roles"] }),
  });
}

export function useDeleteCustomRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await rolesTable().delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["custom_roles"] }),
  });
}

// Built-in role permission matrix editing
export function useRolePermissions() {
  return useQuery({
    queryKey: ["role_permissions"],
    queryFn: async () => {
      const { data, error } = await rolePermsTable().select("role, permission_code");
      if (error) throw error;
      return (data ?? []) as { role: string; permission_code: string }[];
    },
  });
}

export function useToggleRolePermission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { role: string; code: string; enable: boolean }) => {
      if (input.enable) {
        const { error } = await rolePermsTable().insert({
          role: input.role as AppRole,
          permission_code: input.code,
        });
        if (error && !String(error.message).includes("duplicate")) throw error;
      } else {
        const { error } = await rolePermsTable()
          .delete()
          .eq("role", input.role as AppRole)
          .eq("permission_code", input.code);
        if (error) throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["role_permissions"] }),
  });
}
