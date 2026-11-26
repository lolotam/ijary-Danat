import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";

export type Company = Tables<"companies">;
export type CompanyUpdate = TablesUpdate<"companies">;

export function useCompany(enabled = true) {
  return useQuery({
    queryKey: ["company"],
    enabled,
    queryFn: async (): Promise<Company | null> => {
      const { data, error } = await supabase.from("companies").select("*").maybeSingle();

      if (error) throw error;
      return data;
    },
  });
}

export function useUpdateCompany() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: CompanyUpdate }) => {
      const { data: before, error: beforeError } = await supabase
        .from("companies")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;

      const { data: after, error } = await supabase
        .from("companies")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;

      await logAuditForCurrentSession({
        action: "company.update",
        entityType: "company",
        entityId: id,
        before,
        after,
      });

      return after;
    },
    onSuccess: (company) => {
      queryClient.setQueryData(["company"], company);
    },
  });
}
