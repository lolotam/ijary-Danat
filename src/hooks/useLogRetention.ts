import { useMutation, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

/** السجلان اللذان يدعمان الحذف التلقائي. */
export type RetentionLog = "audit" | "notifications";

/** المدد المسموحة لكل سجل بالأيام — مطابقة لقيود الترحيل 242. */
export const RETENTION_DAY_OPTIONS: Record<RetentionLog, readonly number[]> = {
  audit: [7, 14, 21, 28],
  notifications: [7, 14, 21, 28, 30],
};

/** المدة المقترحة عند التفعيل لأول مرة، كما طلبها صاحب المشروع. */
export const DEFAULT_RETENTION_DAYS: Record<RetentionLog, number> = {
  audit: 7,
  notifications: 30,
};

/**
 * يحفظ مدة الاحتفاظ بسجل ويحذف فوراً ما هو أقدم منها، عبر `set_log_retention`.
 *
 * A plain `companies` update is refused by the migration-242 trigger, so this
 * RPC is the only write path; it checks the permission, purges and audits in
 * one transaction. Refreshes the company row (where the window is stored) and
 * the affected log's queries, since rows just disappeared from them.
 */
export function useSetLogRetention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ log, days }: { log: RetentionLog; days: number | null }) => {
      const { data, error } = await supabase.rpc("set_log_retention", {
        p_log: log,
        p_days: days,
      });
      if (error) throw error;
      return data as { log: RetentionLog; days: number | null; deleted: number };
    },
    onSuccess: async (_result, { log }) => {
      await queryClient.invalidateQueries({ queryKey: ["company"] });
      await queryClient.invalidateQueries({
        queryKey: log === "audit" ? ["audit-logs"] : ["notifications"],
      });
      if (log === "audit") {
        await queryClient.invalidateQueries({ queryKey: ["audit-log-filter-options"] });
      }
    },
  });
}
