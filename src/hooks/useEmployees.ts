import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { pageRange } from "@/hooks/pagination";
import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";

export type Employee = Tables<"employees">;
export type Salary = Tables<"salaries">;

export interface SalaryWithEmployee extends Salary {
  employee: Pick<Employee, "code" | "name" | "name_en"> | null;
}

export interface EmployeeListParams {
  includeInactive?: boolean;
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface EmployeeListResult {
  items: Employee[];
  count: number;
}

export function useEmployees(params: EmployeeListParams | boolean = {}, enabled = true) {
  // Back-compat: older call sites passed `includeInactive` as the first boolean.
  const normalized: EmployeeListParams =
    typeof params === "boolean" ? { includeInactive: params } : params;
  const includeInactive = normalized.includeInactive ?? true;
  const page = Math.max(1, normalized.page ?? 1);
  const pageSize = Math.max(1, normalized.pageSize ?? 20);
  const search = normalized.search ?? "";

  return useQuery({
    queryKey: ["employees", { includeInactive, page, pageSize, search }],
    enabled,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<EmployeeListResult> => {
      const { from, to } = pageRange(page, pageSize);
      let query = supabase
        .from("employees")
        .select("*", { count: "exact" })
        .order("code", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
      if (!includeInactive) query = query.eq("is_active", true);
      const term = normalizePostgrestSearch(search);
      if (term) {
        query = query.or(
          `code.ilike.%${term}%,name.ilike.%${term}%,name_en.ilike.%${term}%,mobile.ilike.%${term}%,email.ilike.%${term}%`,
        );
      }
      const { data, error, count } = await query;
      if (error) throw error;
      return { items: data ?? [], count: count ?? 0 };
    },
  });
}

export function useCreateEmployee() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (values: TablesInsert<"employees">) => {
      if (!permissions.can(PERMISSIONS.EMPLOYEES_CREATE)) throw new Error("Permission denied.");
      const { data, error } = await supabase.from("employees").insert(values).select("*").single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "employee.create",
        entityType: "employee",
        entityId: data.id,
        after: { ...data },
      });
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["employees"] }),
  });
}

export function useUpdateEmployee() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: TablesUpdate<"employees"> }) => {
      if (!permissions.can(PERMISSIONS.EMPLOYEES_UPDATE)) throw new Error("Permission denied.");
      const { data, error } = await supabase
        .from("employees")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "employee.update",
        entityType: "employee",
        entityId: id,
        after: { ...data },
      });
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["employees"] }),
  });
}

export function useDeleteEmployee() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!permissions.can(PERMISSIONS.EMPLOYEES_DELETE)) throw new Error("Permission denied.");
      const { error } = await supabase.from("employees").delete().eq("id", id);
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "employee.delete",
        entityType: "employee",
        entityId: id,
      });
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["employees"] });
      // Deleting an employee cascades their salary rows.
      queryClient.invalidateQueries({ queryKey: ["salaries"] });
    },
  });
}

export function useSalaries(year: number, month: number, enabled = true) {
  return useQuery({
    queryKey: ["salaries", { year, month }],
    enabled,
    queryFn: async (): Promise<SalaryWithEmployee[]> => {
      const { data, error } = await supabase
        .from("salaries")
        .select("*")
        .eq("year", year)
        .eq("month", month);
      if (error) throw error;
      const rows = data ?? [];
      if (!rows.length) return [];
      const employeeIds = [...new Set(rows.map((row) => row.employee_id))];
      const { data: employees, error: employeeError } = await supabase
        .from("employees")
        .select("id,code,name,name_en")
        .in("id", employeeIds);
      if (employeeError) throw employeeError;
      const byId = new Map((employees ?? []).map((employee) => [employee.id, employee]));
      return rows
        .map((row) => ({ ...row, employee: byId.get(row.employee_id) ?? null }))
        .sort((a, b) => (a.employee?.code ?? "").localeCompare(b.employee?.code ?? ""));
    },
  });
}

/**
 * Marks a salary delivered (or undoes it).
 *
 * `delivered` is a flag, not a payment: it creates no `payments` row and no
 * allocation. Salaries are an outgoing cost like an expense, not a tenant
 * collection, so they never enter the allocation machinery.
 */
export function useSetSalaryDelivered() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, delivered }: { id: string; delivered: boolean }) => {
      if (!permissions.can(PERMISSIONS.SALARIES_UPDATE)) throw new Error("Permission denied.");
      const { data, error } = await supabase
        .from("salaries")
        .update({
          delivered,
          delivered_at: delivered ? new Date().toISOString() : null,
        })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: delivered ? "salary.deliver" : "salary.undeliver",
        entityType: "salary",
        entityId: id,
        after: { ...data },
      });
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["salaries"] }),
  });
}

/**
 * ينشئ صفوف رواتب الشهر عند الطلب من زر الإدارة.
 *
 * The `salaries` cron job also runs this on the 1st of each month in
 * production (`/etc/cron.d/danat-ermp`); the button covers a month generated
 * early or re-run by hand. Pressing it twice, or after the cron run, is
 * harmless: the RPC inserts with `on conflict do nothing` against
 * unique (employee_id, year, month).
 */
export function useGenerateSalaries() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ year, month }: { year: number; month: number }) => {
      if (!permissions.can(PERMISSIONS.SALARIES_CREATE)) throw new Error("Permission denied.");
      const { data, error } = await supabase.rpc("generate_salaries_for_month", {
        p_year: year,
        p_month: month,
      });
      if (error) throw error;
      return data ?? [];
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["salaries"] }),
  });
}
