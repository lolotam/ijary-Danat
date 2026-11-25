import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/database.types";
import { numberValue } from "@/lib/json";

export interface ExpenseBucket {
  amount: number;
  count: number;
}
export interface ExpensesSummary {
  approved: ExpenseBucket;
  pending: ExpenseBucket;
  thisMonth: ExpenseBucket;
  total: ExpenseBucket;
}

// Structurally identical to usePaymentsSummary's `bucket`; only the money key
// differs (`amount` here, `total` there) because the SQL keys differ.
function bucket(value: Json | undefined): ExpenseBucket {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { amount: numberValue(object.amount), count: numberValue(object.count) };
}

function parse(data: Json): ExpensesSummary {
  const value = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return {
    total: bucket(value.total),
    approved: bucket(value.approved),
    pending: bucket(value.pending),
    thisMonth: bucket(value.this_month),
  };
}

export function useExpensesSummary(
  params: {
    categoryId?: string;
    dateFrom?: string;
    dateTo?: string;
    propertyId?: string;
    search?: string;
    status?: string;
  } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ["expenses", "summary", params],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const result = await supabase.rpc("get_expenses_summary", {
        p_search: params.search || null,
        p_class: null,
        p_category_id: params.categoryId ?? null,
        p_property_id: params.propertyId ?? null,
        p_status: params.status ?? null,
        p_from: params.dateFrom ?? null,
        p_to: params.dateTo ?? null,
      });
      if (result.error) throw result.error;
      return parse(result.data);
    },
  });
}
