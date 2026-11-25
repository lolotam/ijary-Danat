import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/database.types";
import { numberValue } from "@/lib/json";

export interface UnitsSummary {
  occupied: number;
  rentPotential: number;
  total: number;
  underMaintenance: number;
  vacant: number;
}

function parse(data: Json): UnitsSummary {
  const value = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return {
    total: numberValue(value.total),
    occupied: numberValue(value.occupied),
    vacant: numberValue(value.vacant),
    underMaintenance: numberValue(value.under_maintenance),
    rentPotential: numberValue(value.rent_potential),
  };
}

export function useUnitsSummary(
  params: {
    electricityMeterOwnership?: string;
    propertyId?: string;
    search?: string;
    status?: string;
    type?: string;
  } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ["units", "summary", params],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const result = await supabase.rpc("get_units_summary", {
        p_search: params.search || null,
        p_property_id: params.propertyId ?? null,
        p_building_id: null,
        p_status: params.status && params.status !== "all" ? params.status : null,
        p_type: params.type && params.type !== "all" ? params.type : null,
        p_meter:
          params.electricityMeterOwnership && params.electricityMeterOwnership !== "all"
            ? params.electricityMeterOwnership
            : null,
      });
      if (result.error) throw result.error;
      return parse(result.data);
    },
  });
}
