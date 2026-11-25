import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/database.types";

export function usePermissionsList() {
  return useQuery({
    queryKey: ["permissions"],
    queryFn: async (): Promise<Tables<"permissions">[]> => {
      const { data, error } = await supabase
        .from("permissions")
        .select("*")
        .order("module")
        .order("action");

      if (error) throw error;
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });
}
