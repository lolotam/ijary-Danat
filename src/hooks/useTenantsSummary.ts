import { useQuery } from "@tanstack/react-query";

import { type ArchiveMode, DEFAULT_ARCHIVE_MODE } from "@/hooks/archiveMode";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/database.types";
import { numberValue } from "@/lib/json";

export interface TenantsSummary {
  active: number;
  arrears: { amount: number; tenants: number };
  archivedCount: number;
  currentCount: number;
  blockedInactive: number;
  total: number;
}

function parse(data: Json): TenantsSummary {
  const value = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const arrearsRaw =
    value.arrears && typeof value.arrears === "object" && !Array.isArray(value.arrears)
      ? value.arrears
      : {};
  return {
    total: numberValue(value.total),
    active: numberValue(value.active),
    blockedInactive: numberValue(value.blocked_inactive),
    arrears: {
      amount: numberValue(arrearsRaw.amount),
      tenants: numberValue(arrearsRaw.tenants),
    },
    archivedCount: numberValue(value.archived_count),
    currentCount: numberValue(value.current_count),
  };
}

export function useTenantsSummary(
  params: {
    category?: string;
    lifecycle?: string;
    search?: string;
    archiveMode?: ArchiveMode;
  } = {},
  enabled = true,
) {
  const archiveMode = params.archiveMode ?? DEFAULT_ARCHIVE_MODE;
  return useQuery({
    queryKey: ["tenants", "summary", { ...params, archiveMode }],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const result = await supabase.rpc("get_tenants_summary", {
        p_search: params.search || null,
        p_category: params.category ?? null,
        p_lifecycle: params.lifecycle ?? null,
        p_archive_mode: archiveMode,
      });
      if (result.error) throw result.error;
      return parse(result.data);
    },
  });
}
