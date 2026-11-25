/**
 * طلبات التأجير الواردة من صفحة الهبوط: القائمة والتحديث والحذف.
 *
 * Split out of `useLandingSettings.ts`, which re-exports everything here — import
 * from `@/hooks/useLandingSettings`, not this file, so test mocks of that path keep
 * intercepting.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { pageRange } from "@/hooks/pagination";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesUpdate } from "@/integrations/supabase/database.types";

export type LeasingInquiry = Tables<"leasing_inquiries">;
export type LeasingInquiryUpdate = TablesUpdate<"leasing_inquiries">;

// 6. Leasing Inquiries Query & Mutation
export interface LeasingInquiryListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: LeasingInquiry["status"];
}

export interface LeasingInquiryListResult {
  items: LeasingInquiry[];
  count: number;
}

export function useLeasingInquiries(
  params: LeasingInquiryListParams | boolean = {},
  enabledArg?: boolean,
) {
  // Back-compat: older call sites passed only `enabled`.
  const normalized: LeasingInquiryListParams = typeof params === "boolean" ? {} : params;
  const enabled = typeof params === "boolean" ? params : (enabledArg ?? true);
  const page = Math.max(1, normalized.page ?? 1);
  const pageSize = Math.max(1, normalized.pageSize ?? 20);
  const search = normalized.search ?? "";
  const status = normalized.status;

  return useQuery({
    queryKey: ["leasing_inquiries", { page, pageSize, search, status: status ?? null }],
    enabled,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<LeasingInquiryListResult> => {
      const { from, to } = pageRange(page, pageSize);
      let query = supabase
        .from("leasing_inquiries")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
      if (status) query = query.eq("status", status);
      const term = normalizePostgrestSearch(search);
      if (term) {
        query = query.or(
          `name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%,message.ilike.%${term}%`,
        );
      }
      const { data, error, count } = await query;
      if (error) throw error;
      return { items: data ?? [], count: count ?? 0 };
    },
  });
}

export function useUpdateLeasingInquiry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: LeasingInquiryUpdate }) => {
      const { data, error } = await supabase
        .from("leasing_inquiries")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leasing_inquiries"] });
    },
  });
}

export function useDeleteLeasingInquiries() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (!ids.length) return;
      const { error } = await supabase.from("leasing_inquiries").delete().in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leasing_inquiries"] });
    },
  });
}
