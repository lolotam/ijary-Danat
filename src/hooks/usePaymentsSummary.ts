import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/database.types";
import { numberValue } from "@/lib/json";
import { FINANCE_QUERY_OPTIONS } from "@/hooks/financeQueryOptions";

export interface MoneyBucket {
  count: number;
  total: number;
}
export interface PaymentsSummary {
  full: MoneyBucket;
  insurance: MoneyBucket;
  net: number;
  partial: MoneyBucket;
  refunds: MoneyBucket;
}

function bucket(value: Json | undefined): MoneyBucket {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { total: numberValue(object.total), count: numberValue(object.count) };
}

function parse(data: Json): PaymentsSummary {
  const value = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return {
    full: bucket(value.full),
    partial: bucket(value.partial),
    insurance: bucket(value.insurance),
    refunds: bucket(value.refunds),
    net: numberValue(value.net),
  };
}

export function usePaymentsSummary(
  params: { method?: string; search?: string; status?: string; tenantId?: string } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ["payments", "summary", params],
    enabled,
    staleTime: 30_000,
    ...FINANCE_QUERY_OPTIONS,
    queryFn: async () => {
      const result = await supabase.rpc("get_payments_summary", {
        p_search: params.search || null,
        p_method: params.method ?? null,
        p_status: params.status ?? null,
        p_tenant_id: params.tenantId ?? null,
      });
      if (result.error) throw result.error;
      return parse(result.data);
    },
  });
}
