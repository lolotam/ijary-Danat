/**
 * حفظ العقود وحذفها: مدخلات دالة الحفظ الذرّية والطفرتان.
 *
 * Split out of `useContracts.ts`, which re-exports everything here — import
 * from `@/hooks/useContracts`, not this file, so test mocks of that path keep
 * intercepting.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { notifyContractLifecycle } from "@/fns/notifyContractLifecycle";
import { type Contract, shouldNotifyContractEnded } from "@/hooks/contractHelpers";
import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type { ContractState, ContractType, Json } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

/** One `contract_units` row as the save RPC's `p_units` expects it. */
export interface ContractUnitInput {
  unit_id: string;
  monthly_amount: number;
}

/** صفّ مصروف إضافي كما يتوقّعه `p_contract.extra_charges` (ترحيل 166). */
export interface ContractExtraChargeInput {
  category_id: string;
  amount: number;
}

/**
 * Every `contracts` field `save_contract_with_units` accepts in `p_contract`
 * (migration 117) — everything except `id`/`code` (defaulted), `unit_id`
 * (deprecated, never written) and `monthly_amount` (trigger-maintained total
 * of `contract_units`, migration 110).
 */
export interface ContractSaveInput {
  tenant_id: string;
  type: ContractType;
  state: ContractState;
  commercial_activity: string | null;
  start_date: string;
  end_date: string;
  duration_months: number;
  end_date_override_reason: string | null;
  due_day: number;
  grace_days: number;
  deposit: number;
  /**
   * Migration 196 — the contract's single rent increase. All three null means
   * no increase; the RPC raises once a post-anniversary invoice carries money.
   */
  increase_after_years: number | null;
  increase_type: "percent" | "fixed" | null;
  increase_value: number | null;
  notes: string | null;
  suppress_tenant_billing_docs?: boolean | null;
  /**
   * Recurring monthly charges, carried inside `p_contract` rather than as a
   * fourth RPC argument — a new parameter would create an overload PostgREST
   * cannot disambiguate by named-argument resolution (migration 166).
   *
   * OMIT the key to leave the contract's existing charges alone; pass `[]` to
   * clear them. The two are different requests and the RPC treats them so.
   */
  extra_charges?: ContractExtraChargeInput[];
}

/**
 * Creates or updates a contract AND its `contract_units` rows atomically via
 * `save_contract_with_units` (migration 117) — replaces the old
 * `useCreateContract`/`useUpdateContract` pair, which wrote `contracts`
 * directly and never touched `contract_units` at all. A direct insert/update
 * here would let a contract exist with zero units, which the invoice
 * generator bills as nothing.
 *
 * `id` omitted means create; `id` present means update. Preserves what the
 * old pair did: a `before` snapshot for the audit row and the ended-contract
 * notification, the create/update audit action split, and the
 * created/ended lifecycle notifications, each wrapped so a notification
 * failure never surfaces as a save failure.
 */
export function useSaveContractWithUnits() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({
      id,
      contract,
      units,
    }: {
      id?: string;
      contract: ContractSaveInput;
      units: ContractUnitInput[];
    }): Promise<Contract> => {
      const requiredPermission = id ? PERMISSIONS.CONTRACTS_UPDATE : PERMISSIONS.CONTRACTS_CREATE;
      if (!permissions.can(requiredPermission)) throw new Error("Permission denied.");
      let before: Contract | null = null;
      if (id) {
        const { data, error } = await supabase.from("contracts").select("*").eq("id", id).single();
        if (error) throw error;
        before = data;
      }
      // Cast at the JSON boundary: ContractSaveInput/ContractUnitInput are
      // plain data shapes (every field is itself JSON-serializable) but lack
      // the index signature TypeScript's structural check wants for `Json`.
      const { data: after, error } = await supabase.rpc("save_contract_with_units", {
        p_contract: contract as unknown as Json,
        p_units: units as unknown as Json,
        p_contract_id: id ?? null,
      });
      if (error) throw error;
      await logAuditForCurrentSession({
        action: id ? "contract.update" : "contract.create",
        entityType: "contract",
        entityId: after.id,
        before: before ? { ...before } : undefined,
        after: { ...after },
      });
      if (before && shouldNotifyContractEnded(before.state, after.state)) {
        try {
          await notifyContractLifecycle({ data: { contractId: after.id, event: "ended" } });
        } catch (notificationError) {
          console.error("notifyContractEnded failed:", notificationError);
        }
      }
      if (!id) {
        try {
          await notifyContractLifecycle({ data: { contractId: after.id, event: "created" } });
        } catch (notificationError) {
          console.error("notifyContractCreated failed:", notificationError);
        }
      }
      return after;
    },
    onSuccess: (contract) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      // A contract may be saved directly in the `active` state, which flips
      // its unit(s) to `occupied` in the database (migration 76/111). Without
      // this the units list keeps showing the old status until a manual
      // refresh.
      queryClient.invalidateQueries({ queryKey: ["units"] });
      queryClient.invalidateQueries({ queryKey: ["contract-units", contract.id] });
      // Without this, reopening the edit dialog right after a save serves
      // useUnitsActiveContracts' cached map from before this save — the
      // realistic failure is a stale ABSENCE of conflict (this contract's own
      // just-saved rows are excluded via excludeContractId anyway), but it's
      // one line to close entirely rather than reason about.
      queryClient.invalidateQueries({ queryKey: ["units-active-contracts"] });
      queryClient.invalidateQueries({ queryKey: ["property-monthly-totals"] });
      queryClient.setQueryData(["contract", contract.id], contract);
    },
  });
}

/**
 * يعيد تحميل الفواتير وعروض البوابة بعد مواءمة جدول فواتير العقد.
 *
 * The save RPC does not touch invoices; the follow-up `syncContractSchedule` /
 * `backfillContractInvoices` call re-prices or creates them (a rent increase,
 * a changed amount). Invalidating inside the save's onSuccess refetched the
 * pre-sync rows and marked them fresh, so the tenant page kept showing 5,000
 * on CON-00015 after its 10% increase had written 5,500. Call this once the
 * reconciliation has finished — succeeded or not, since a partial sync still
 * changed rows.
 */
export function useRefreshContractInvoices() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["invoices"] });
    void queryClient.invalidateQueries({ queryKey: ["invoice-details"] });
    void queryClient.invalidateQueries({ queryKey: ["invoice-month-summary"] });
    void invalidatePortalViews(queryClient);
  };
}

export function useDeleteContract() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!permissions.can(PERMISSIONS.CONTRACTS_DELETE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("contracts")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      if (before.state !== "draft") throw new Error("Only draft contracts can be deleted.");
      const { error } = await supabase.from("contracts").delete().eq("id", id);
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "contract.delete",
        entityType: "contract",
        entityId: id,
        before: { ...before },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
    },
  });
}
