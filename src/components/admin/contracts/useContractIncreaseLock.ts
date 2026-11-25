import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { contractIncreaseEffectivePeriod } from "@/lib/contractIncrease";

/** الحدّ الأدنى من العقد الذي يحتاجه فحص القفل. */
export interface ContractIncreaseLockSource {
  id: string;
  start_date: string;
  increase_after_years: number | null;
}

/**
 * هل زيادة الإيجار الحالية مقفلة؟ نعم إذا حملت فاتورة في أو بعد فترة سريانها مالاً.
 *
 * Mirrors the guard in `save_contract_with_units` (migration 200) so the form
 * renders the section read-only instead of inviting an edit the RPC would
 * refuse. Only an existing increase can be locked — a contract without one
 * never queries. `coalesce(paid,0) > 0` is `paid.gt.0` here: a null paid never
 * satisfies gt. One nested `or` expression rather than two stacked `.or()`
 * calls, which would duplicate the query key and let one arm silently win
 * (the `useGmailMessages` lesson).
 */
export function useContractIncreaseLock(editing: ContractIncreaseLockSource | null): boolean {
  const query = useQuery({
    queryKey: ["contract-increase-locked", editing?.id ?? null],
    enabled: editing != null && editing.increase_after_years != null,
    queryFn: async (): Promise<number> => {
      if (!editing || editing.increase_after_years == null) return 0;
      const [year, month] = contractIncreaseEffectivePeriod(
        editing.start_date,
        editing.increase_after_years,
      ).split("-");
      const periodFrom = `period_year.gt.${Number(year)},and(period_year.eq.${Number(
        year,
      )},period_month.gte.${Number(month)})`;
      const { count, error } = await supabase
        .from("invoices")
        .select("id", { count: "exact", head: true })
        .eq("contract_id", editing.id)
        .or(`and(or(state.in.(paid,partially_paid),paid.gt.0),or(${periodFrom}))`);
      if (error) throw error;
      return count ?? 0;
    },
  });
  return (query.data ?? 0) > 0;
}
