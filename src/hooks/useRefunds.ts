import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { fetchAllPages, keysetAfter, type KeysetKey } from "@/lib/pagedQuery";
import type { PermissionCode } from "@/lib/permissions";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

export type Refund = Tables<"refunds">;

/**
 * The three T13 record types share a shape — tenant, contract, amount, date —
 * so they share one set of hooks parameterised by table rather than three
 * near-identical copies. Only the date column differs.
 */
export const MONEY_RECORD_DATE_COLUMN = {
  refunds: "refund_date",
  partial_payments: "paid_date",
  insurance_payments: "collected_date",
} as const;

export type MoneyRecordTable = keyof typeof MONEY_RECORD_DATE_COLUMN;

/**
 * A row as the shared panel renders it.
 *
 * The three tables have different column sets, and PostgREST's generated types
 * cannot narrow a runtime-chosen table name — so the query is typed loosely
 * here and the panel reads only the fields all three genuinely share.
 */
export type MoneyRecord = {
  id: string;
  amount: number;
  tenant_id: string;
  contract_id: string | null;
  note: string | null;
  invoice_id?: string | null;
  status?: string;
  invoice?: { code: string; period_month: number; period_year: number } | null;
} & Record<string, unknown>;

/** نطاق اختياري يُطبَّق في الاستعلام حتى لا يُقطع تبويب المستأجر بعد 500 صف. */
export type MoneyRecordScope = { contractId: string } | { tenantId: string };

/**
 * يجلب سجلات المال مع نطاق عقد أو مستأجر اختياري يُمرَّر إلى PostgREST.
 *
 * Unscoped calls keep the previous 500-row unfiltered read. Filtering in the
 * component instead would silently truncate the tenant tab once the table
 * grows past that limit.
 */
export function useMoneyRecords(table: MoneyRecordTable, enabled = true, scope?: MoneyRecordScope) {
  return useQuery({
    queryKey: [table, scope ?? null],
    enabled,
    queryFn: async (): Promise<MoneyRecord[]> => {
      const columns =
        table === "partial_payments" ? "*, invoice:invoices(code, period_year, period_month)" : "*";
      let query = supabase
        .from(table)
        .select(columns)
        .order(MONEY_RECORD_DATE_COLUMN[table], { ascending: false })
        .limit(500);
      if (scope && "contractId" in scope) query = query.eq("contract_id", scope.contractId);
      if (scope && "tenantId" in scope) query = query.eq("tenant_id", scope.tenantId);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as unknown as MoneyRecord[];
    },
  });
}

type InsuredContractRow = { id: string; contract_id: string };
const INSURED_CONTRACT_KEYS: KeysetKey<InsuredContractRow>[] = [
  { column: "id", ascending: true, value: (row) => row.id },
];

/**
 * يجلب معرّفات كل العقود التي لها سجل تأمين، كاملةً وليس أول 500 صف فقط.
 *
 * Feeds the insurance picker's one-per-contract filter. `useMoneyRecords` stops
 * at 500 rows ordered by date, so a contract whose insurance is older than that
 * window would look free and the save would hit `unique (contract_id)` with a
 * raw duplicate-key error. Keyed under `insurance_payments` so every insurance
 * mutation's invalidation refreshes it.
 */
export function useInsuredContractIds(enabled: boolean) {
  return useQuery({
    queryKey: ["insurance_payments", "contract-ids"],
    enabled,
    queryFn: async (): Promise<Set<string>> => {
      const { rows } = await fetchAllPages((after: InsuredContractRow | null) => {
        let query = supabase
          .from("insurance_payments")
          .select("id, contract_id")
          .order("id", { ascending: true });
        if (after) query = query.or(keysetAfter(INSURED_CONTRACT_KEYS, after));
        return query;
      });
      return new Set(rows.map((row) => row.contract_id));
    },
  });
}

function invalidateMoneyRecordQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  table: MoneyRecordTable,
) {
  queryClient.invalidateQueries({ queryKey: [table] });
  // Payments page KPI cards (full / partial / net).
  queryClient.invalidateQueries({ queryKey: ["payments", "summary"] });
  void invalidatePortalViews(queryClient);
  // Budget only moves for refunds/insurance; partial never does, but a stale
  // budget beside the panel would still confuse after a refund edit.
  queryClient.invalidateQueries({ queryKey: ["budget"] });
}

export function useCreateMoneyRecord(table: MoneyRecordTable, permission: PermissionCode) {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      if (!permissions.can(permission)) throw new Error("Permission denied.");
      const { data, error } = await supabase
        .from(table)
        // The table name is chosen at runtime, so PostgREST's generated Insert
        // type cannot be narrowed here. Each caller builds the correct shape.
        .insert(values as never)
        .select("*")
        .single();
      if (error) throw error;
      const row = data as unknown as MoneyRecord;
      await logAuditForCurrentSession({
        action: `${table}.create`,
        entityType: table,
        entityId: row.id,
        after: JSON.parse(JSON.stringify(row)),
      });
      return row;
    },
    onSuccess: () => invalidateMoneyRecordQueries(queryClient, table),
  });
}

export function useUpdateMoneyRecord(table: MoneyRecordTable, permission: PermissionCode) {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, values }: { id: string; values: Record<string, unknown> }) => {
      if (!permissions.can(permission)) throw new Error("Permission denied.");
      const { data: before } = await supabase.from(table).select("*").eq("id", id).single();
      const { data, error } = await supabase
        .from(table)
        .update(values as never)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      const row = data as unknown as MoneyRecord;
      await logAuditForCurrentSession({
        action: `${table}.update`,
        entityType: table,
        entityId: id,
        before: before ? JSON.parse(JSON.stringify(before)) : undefined,
        after: JSON.parse(JSON.stringify(row)),
      });
      return row;
    },
    onSuccess: () => invalidateMoneyRecordQueries(queryClient, table),
  });
}

export function useDeleteMoneyRecord(table: MoneyRecordTable, permission: PermissionCode) {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!permissions.can(permission)) throw new Error("Permission denied.");
      const { data: before } = await supabase.from(table).select("*").eq("id", id).single();
      const { error } = await supabase.from(table).delete().eq("id", id);
      if (error) throw error;
      await logAuditForCurrentSession({
        action: `${table}.delete`,
        entityType: table,
        entityId: id,
        before: before ? JSON.parse(JSON.stringify(before)) : undefined,
      });
      return id;
    },
    onSuccess: () => invalidateMoneyRecordQueries(queryClient, table),
  });
}

// archiveRefundTarget / freezeRefundContract / applyRefundPostAction /
// useApplyRefundAction were retired. They were four non-atomic client
// round-trips that could half-apply (production: contract invisible AND still
// billable). The close-out RPC (migration 87) is the only archive path now.
// The refunds.post_action column and refund_post_actions enum stay readable
// for legacy rows — do not drop them.
