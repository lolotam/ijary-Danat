import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/database.types";

export interface BudgetCategory {
  amount: number;
  category_id: string | null;
  code: string;
  name_ar: string;
  name_en: string;
}
export interface BudgetMonth {
  collections: number;
  expenses: number;
  month: string;
}
export interface BudgetSummary {
  categories: BudgetCategory[];
  collections: number;
  /**
   * Always 0 from get_budget_summary (migration 97+). Bank deposits are a
   * readonly ledger on /admin/deposits — not budget math. Key kept for parse
   * stability with older responses.
   */
  deposits: number;
  expenses: number;
  /** T13 — money returned to tenants. Deducted from `net`. */
  refunds: number;
  /** T13 — insurance held for tenants. A holding, so it does not move `net`. */
  insurance_collected: number;
  months: BudgetMonth[];
  net: number;
}

function numberValue(value: Json | undefined): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function parseBudget(data: Json): BudgetSummary {
  const value = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const categories = Array.isArray(value.categories) ? value.categories : [];
  const months = Array.isArray(value.months) ? value.months : [];
  return {
    collections: numberValue(value.collections),
    deposits: numberValue(value.deposits),
    expenses: numberValue(value.expenses),
    refunds: numberValue(value.refunds),
    insurance_collected: numberValue(value.insurance_collected),
    net: numberValue(value.net),
    categories: categories.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      return [
        {
          amount: numberValue(item.amount),
          category_id: typeof item.category_id === "string" ? item.category_id : null,
          code: typeof item.code === "string" ? item.code : "",
          name_ar: typeof item.name_ar === "string" ? item.name_ar : "",
          name_en: typeof item.name_en === "string" ? item.name_en : "",
        },
      ];
    }),
    months: months.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      return [
        {
          month: typeof item.month === "string" ? item.month : "",
          collections: numberValue(item.collections),
          expenses: numberValue(item.expenses),
        },
      ];
    }),
  };
}

export function useBudget(
  params: { buildingId?: string; from: string; propertyId?: string; to: string },
  enabled = true,
) {
  return useQuery({
    queryKey: ["budget", params],
    enabled: enabled && Boolean(params.from && params.to),
    queryFn: async () => {
      const result = await supabase.rpc("get_budget_summary", {
        p_building_id: params.buildingId ?? null,
        p_from: params.from,
        p_property_id: params.propertyId ?? null,
        p_to: params.to,
      });
      if (result.error) throw result.error;
      return parseBudget(result.data);
    },
  });
}
