import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { partialPaymentEditContextKey } from "@/hooks/usePartialPaymentEditContext";
import type { MoneyRecord } from "@/hooks/useRefunds";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

export type EditPartialPaymentValues = {
  amount: number;
  building_id: string | null;
  contract_id: string;
  invoice_id: string | null;
  note: string | null;
  paid_date: string;
  /** Only written when the row ends up unlinked; a settled row's status follows its invoice. */
  status: string;
  tenant_id: string;
  unit_id: string | null;
};

/**
 * يحوّل صف jsonb الذي يعيده RPC التعديل إلى سجل الحوار.
 *
 * The RPC returns the updated ledger row as jsonb so the client can write the
 * audit row from it, the same way `useUpdateMoneyRecord` writes from the
 * PostgREST UPDATE.
 */
function asMoneyRecord(payload: Json): MoneyRecord {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("edit_partial_payment returned no row");
  }
  const row = payload as Record<string, unknown>;
  if (typeof row.id !== "string") throw new Error("edit_partial_payment returned no row");
  return row as MoneyRecord;
}

/**
 * يعدّل دفعة جزئية عبر RPC الذي يأخذ أقفال العقود قبل لمس الصف.
 *
 * A generic PostgREST UPDATE would take the row lock first and could deadlock
 * against another edit's `sync_status` fan-out. The RPC is the ordering
 * discipline; the trigger still does the money work.
 */
export function useEditPartialPayment() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, values }: { id: string; values: EditPartialPaymentValues }) => {
      if (!permissions.can(PERMISSIONS.PARTIAL_PAYMENTS_UPDATE)) {
        throw new Error("Permission denied.");
      }
      const { data: before } = await supabase
        .from("partial_payments")
        .select("*")
        .eq("id", id)
        .single();
      const { data, error } = await supabase.rpc("edit_partial_payment", {
        p_id: id,
        p_amount: values.amount,
        p_paid_date: values.paid_date,
        p_invoice_id: values.invoice_id,
        p_note: values.note,
        p_tenant_id: values.tenant_id,
        p_contract_id: values.contract_id,
        p_unit_id: values.unit_id,
        p_building_id: values.building_id,
        p_status: values.status,
      });
      if (error) throw error;
      const row = asMoneyRecord(data);
      await logAuditForCurrentSession({
        action: "partial_payments.update",
        entityType: "partial_payments",
        entityId: id,
        before: before ? JSON.parse(JSON.stringify(before)) : undefined,
        after: JSON.parse(JSON.stringify(row)),
      });
      return row;
    },
    onSuccess: (_row, variables) => {
      queryClient.invalidateQueries({ queryKey: ["partial_payments"] });
      // A linked edit deletes and recreates the owned payment, its allocation
      // and its receipt, and moves the invoice's monthly totals — the same
      // caches `useReversePayment` and `useCreatePayment` invalidate. The bare
      // `payments` prefix also covers the KPI summary.
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["receipts"] });
      queryClient.invalidateQueries({ queryKey: ["payment-allocations"] });
      queryClient.invalidateQueries({ queryKey: ["invoice-month-summary"] });
      queryClient.invalidateQueries({ queryKey: ["budget"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void invalidatePortalViews(queryClient);
      queryClient.invalidateQueries({ queryKey: partialPaymentEditContextKey(variables.id) });
    },
  });
}
