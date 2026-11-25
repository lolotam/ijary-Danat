import { useMutation, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/database.types";

type Contract = Tables<"contracts">;

export type ContractInsuranceOutcome = "created" | "updated" | "unchanged" | "deleted";

export type ContractInsuranceSyncInput = {
  contract: Contract;
  /** مبلغ التأمين قبل هذا الحفظ — الحذف يحدث عند الانتقال من موجب إلى صفر فقط. */
  previousAmount: number;
};

/**
 * هل الخطأ المرفوع هو رفض صلاحية حذف التأمين؟
 *
 * The RPC raises the typed code `insurance_delete_forbidden` (errcode 42501).
 * Mapping that onto an i18n key belongs at the caller — returning a
 * translation key from here would print a raw `contracts.…` string if it
 * ever reached a toast.
 */
export function isInsuranceDeleteForbidden(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes("insurance_delete_forbidden");
}

/**
 * يعكس مبلغ تأمين العقد (`contracts.deposit`) في `insurance_payments`.
 *
 * A follow-up write rather than a trigger on `contracts`: the insert is gated
 * by RLS on `insurance.create`, and a trigger would turn a missing grant into
 * a failed *contract* save. Here the contract lands and only the mirror is
 * refused. Deliberately no client-side permission check — roles are
 * customisable, so the RLS policy is the authority on whether this write is
 * allowed.
 *
 * A positive→zero *transition* deletes the holding via
 * `delete_contract_insurance`, which removes the row and writes its audit
 * entry in one transaction. The delete is not fired on a value of zero:
 * the Insurance panel authors `insurance_payments` independently of
 * `contracts.deposit`, so deleting whenever the field merely *reads* zero
 * would destroy a hand-entered holding on an unrelated save.
 *
 * Reverse sync (insurance_payments → contracts.deposit) is create/update only;
 * delete leaves the deposit.
 *
 * `get_budget_summary` recomputes `insurance_collected` from live rows
 * (migration 56), so a delete retroactively changes a month already reported.
 * That accounting reason used to forbid deletion; the product decision
 * overrode it. Traceability is the audit row, not prevention.
 */
export async function syncContractInsurance({
  contract,
  previousAmount,
}: ContractInsuranceSyncInput): Promise<ContractInsuranceOutcome> {
  const amount = Number(contract.deposit ?? 0);
  const previous = Number(previousAmount);
  const nextIsZero = !Number.isFinite(amount) || amount <= 0;
  const previousWasPositive = Number.isFinite(previous) && previous > 0;

  if (nextIsZero) {
    if (!previousWasPositive) return "unchanged";
    const { data, error } = await supabase.rpc("delete_contract_insurance", {
      p_contract_id: contract.id,
    });
    if (error) throw error;
    return data ? "deleted" : "unchanged";
  }

  const existing = await supabase
    .from("insurance_payments")
    .select("id, amount")
    .eq("contract_id", contract.id)
    .maybeSingle();
  if (existing.error) throw existing.error;

  if (existing.data) {
    if (Number(existing.data.amount) === amount) return "unchanged";
    // Editing the contract's insurance amount corrects the holding rather than
    // stacking a second one — `unique (contract_id)` allows only one.
    // `collected_date` and `note` are left as they were.
    const { error } = await supabase
      .from("insurance_payments")
      .update({ amount })
      .eq("id", existing.data.id);
    if (error) throw error;
    return "updated";
  }

  // insurance_payments holds one deposit per contract regardless of how many
  // units it covers, so the snapshot below is the *primary* unit (lowest
  // line_order) — the same "first unit stands in for the contract" convention
  // as `primaryUnit`. building_id is a snapshot, so the row still reads
  // correctly after the unit moves or the building is renamed.
  const primaryLink = await supabase
    .from("contract_units")
    .select("unit_id")
    .eq("contract_id", contract.id)
    .order("line_order")
    .limit(1)
    .maybeSingle();
  if (primaryLink.error) throw primaryLink.error;
  const primaryUnitId = primaryLink.data?.unit_id ?? null;
  const unit = primaryUnitId
    ? await supabase.from("units").select("building_id").eq("id", primaryUnitId).maybeSingle()
    : { data: null, error: null };
  if (unit.error) throw unit.error;

  const { error } = await supabase.from("insurance_payments").insert({
    contract_id: contract.id,
    tenant_id: contract.tenant_id,
    unit_id: primaryUnitId,
    building_id: unit.data?.building_id ?? null,
    amount,
    // The contract's start, not today. A back-dated contract's insurance
    // belongs to the month it was actually collected, or the budget's
    // `insurance_collected` reports it against the wrong period.
    collected_date: contract.start_date,
  });
  // 23505 = `unique (contract_id)`: a concurrent save already mirrored it.
  if (error && error.code !== "23505") throw error;
  return error ? "unchanged" : "created";
}

/**
 * طفرة تعكس تأمين العقد في تبويب التأمين، بما في ذلك الحذف عند الانتقال إلى صفر.
 */
export function useSyncContractInsurance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: syncContractInsurance,
    onSuccess: () => {
      // Matches useMoneyRecords' `queryKey: [table]` so the Insurance tab
      // refreshes, and the budget KPI that sums these rows.
      queryClient.invalidateQueries({ queryKey: ["insurance_payments"] });
      queryClient.invalidateQueries({ queryKey: ["budget"] });
    },
  });
}
