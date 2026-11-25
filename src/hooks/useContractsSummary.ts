import { useQuery } from "@tanstack/react-query";

import { type ArchiveMode, DEFAULT_ARCHIVE_MODE } from "@/hooks/archiveMode";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/database.types";
import { numberValue } from "@/lib/json";

export interface ContractsSummary {
  active: number;
  annualAmount: number;
  archivedCount: number;
  currentCount: number;
  ended: number;
  expiring60d: number;
  monthlyAmount: number;
  nextExpiry: string | null;
  total: number;
}

function parse(data: Json): ContractsSummary {
  const value = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return {
    total: numberValue(value.total),
    active: numberValue(value.active),
    expiring60d: numberValue(value.expiring_60d),
    ended: numberValue(value.ended),
    nextExpiry: typeof value.next_expiry === "string" ? value.next_expiry : null,
    monthlyAmount: numberValue(value.monthly_amount),
    annualAmount: numberValue(value.annual_amount),
    archivedCount: numberValue(value.archived_count),
    currentCount: numberValue(value.current_count),
  };
}

export function useContractsSummary(
  params: {
    search?: string;
    state?: string;
    tenantId?: string;
    archiveMode?: ArchiveMode;
  } = {},
  enabled = true,
) {
  const archiveMode = params.archiveMode ?? DEFAULT_ARCHIVE_MODE;
  return useQuery({
    queryKey: ["contracts", "summary", { ...params, archiveMode }],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const result = await supabase.rpc("get_contracts_summary", {
        p_search: params.search || null,
        p_state: params.state && params.state !== "all" ? params.state : null,
        p_tenant_id: params.tenantId ?? null,
        p_archive_mode: archiveMode,
      });
      if (result.error) throw result.error;
      return parse(result.data);
    },
  });
}
