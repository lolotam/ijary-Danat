import { useQuery } from "@tanstack/react-query";

import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/database.types";
import { numberValue } from "@/lib/json";

export interface DepositBucket {
  amount: number;
  count: number;
}
export interface DepositsSummary {
  confirmed: DepositBucket;
  pending: DepositBucket;
  thisMonth: DepositBucket;
  total: DepositBucket;
}

function bucket(value: Json | undefined): DepositBucket {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { amount: numberValue(object.amount), count: numberValue(object.count) };
}

function parse(data: Json): DepositsSummary {
  const value = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return {
    total: bucket(value.total),
    confirmed: bucket(value.confirmed),
    pending: bucket(value.pending),
    thisMonth: bucket(value.this_month),
  };
}

export function useDepositsSummary(
  params: {
    bank?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    status?: string;
  } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ["deposits", "summary", params],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const term = normalizePostgrestSearch(params.search ?? "");
      const result = await supabase.rpc("get_deposits_summary", {
        p_search: term || null,
        p_bank: params.bank ?? null,
        p_status: params.status ?? null,
        p_from: params.dateFrom ?? null,
        p_to: params.dateTo ?? null,
      });
      if (result.error) throw result.error;
      return parse(result.data);
    },
  });
}
