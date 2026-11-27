import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type {
  NotificationAudience,
  NotificationChannel,
  NotificationState,
  NotificationType,
  Tables,
} from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { dispatchNotificationForCurrentSession } from "@/lib/dispatchNotification";
import { PERMISSIONS } from "@/lib/permissions";

export interface NotificationFilters {
  audience?: NotificationAudience;
  channel?: NotificationChannel;
  from?: string;
  page?: number;
  pageSize?: number;
  recipient?: string;
  search?: string;
  sender?: string;
  state?: NotificationState;
  tenantId?: string;
  to?: string;
  type?: NotificationType;
}

export interface NotificationWithRelations extends Tables<"notifications"> {
  contract: Pick<Tables<"contracts">, "id" | "code"> | null;
  invoice: Pick<Tables<"invoices">, "id" | "code"> | null;
  tenant: Pick<
    Tables<"tenants">,
    "id" | "code" | "name" | "reminders_enabled" | "email" | "whatsapp"
  > | null;
}

/** يجلب صفحة من سجل الإشعارات مع المستأجر والفاتورة والعقد المرتبطة بكل صف. */
async function fetchNotificationsPage(filters: NotificationFilters) {
  const { page = 1, pageSize = 20 } = filters;
  let tenantIds: string[] | null = filters.tenantId ? [filters.tenantId] : null;
  const term = normalizePostgrestSearch(filters.search ?? "");
  if (term && !tenantIds) {
    const tenants = await supabase
      .from("tenants")
      .select("id")
      .or(`code.ilike.%${term}%,name.ilike.%${term}%`)
      .limit(100);
    if (tenants.error) throw tenants.error;
    tenantIds = tenants.data.map((tenant) => tenant.id);
    if (!tenantIds.length) return { items: [] as NotificationWithRelations[], count: 0 };
  }
  const from = (page - 1) * pageSize;
  let query = supabase
    .from("notifications")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);
  if (tenantIds) query = query.in("tenant_id", tenantIds);
  if (filters.type) query = query.eq("type", filters.type);
  if (filters.channel) query = query.eq("channel", filters.channel);
  if (filters.state) query = query.eq("state", filters.state);
  if (filters.audience) query = query.eq("audience", filters.audience);
  if (filters.recipient) query = query.ilike("recipient_address", `%${filters.recipient}%`);
  if (filters.sender) query = query.ilike("sender_address", `%${filters.sender}%`);
  if (filters.from) query = query.gte("created_at", `${filters.from}T00:00:00.000Z`);
  if (filters.to) query = query.lte("created_at", `${filters.to}T23:59:59.999Z`);
  const result = await query;
  if (result.error) throw result.error;
  const tenantSet = [
    ...new Set(result.data.flatMap((item) => (item.tenant_id ? [item.tenant_id] : []))),
  ];
  const invoiceSet = [
    ...new Set(result.data.flatMap((item) => (item.invoice_id ? [item.invoice_id] : []))),
  ];
  const contractSet = [
    ...new Set(result.data.flatMap((item) => (item.contract_id ? [item.contract_id] : []))),
  ];
  const [tenants, invoices, contracts] = await Promise.all([
    tenantSet.length
      ? supabase
          .from("tenants")
          .select("id,code,name,reminders_enabled,email,whatsapp")
          .in("id", tenantSet)
      : Promise.resolve({ data: [], error: null }),
    invoiceSet.length
      ? supabase.from("invoices").select("id,code").in("id", invoiceSet)
      : Promise.resolve({ data: [], error: null }),
    contractSet.length
      ? supabase.from("contracts").select("id,code").in("id", contractSet)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (tenants.error) throw tenants.error;
  if (invoices.error) throw invoices.error;
  if (contracts.error) throw contracts.error;
  const tenantMap = new Map(tenants.data.map((item) => [item.id, item]));
  const invoiceMap = new Map(invoices.data.map((item) => [item.id, item]));
  const contractMap = new Map(contracts.data.map((item) => [item.id, item]));
  return {
    items: result.data.map((item) => ({
      ...item,
      tenant: item.tenant_id ? (tenantMap.get(item.tenant_id) ?? null) : null,
      invoice: item.invoice_id ? (invoiceMap.get(item.invoice_id) ?? null) : null,
      contract: item.contract_id ? (contractMap.get(item.contract_id) ?? null) : null,
    })),
    count: result.count ?? 0,
  };
}

/**
 * يجلب صفحة من سجل الإشعارات، ويجلب الصفحة التالية مسبقاً في الخلفية.
 *
 * One page costs two to three sequential round trips (tenant search, the page,
 * then the joined rows), which is the latency an admin feels on "next". The
 * prefetch pays it while the current page is still being read.
 */
export function useNotifications(filters: NotificationFilters = {}, enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["notifications", filters],
    enabled,
    queryFn: () => fetchNotificationsPage(filters),
    placeholderData: (previous) => previous,
  });

  const { page = 1, pageSize = 20 } = filters;
  const count = query.data?.count ?? 0;
  useEffect(() => {
    if (!enabled || page * pageSize >= count) return;
    const next = { ...filters, page: page + 1 };
    void queryClient.prefetchQuery({
      queryKey: ["notifications", next],
      queryFn: () => fetchNotificationsPage(next),
    });
  }, [enabled, filters, page, pageSize, count, queryClient]);

  return query;
}

export function useRetryNotification() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (notification: Tables<"notifications">) => {
      if (!permissions.can(PERMISSIONS.NOTIFICATIONS_SEND)) throw new Error("Permission denied.");
      // error_code is cleared with failure_reason: a retried row must not carry
      // the code that parked it, or a later unrelated failure would be judged
      // against a stale partner error and re-parked for the wrong reason.
      //
      // The state predicate mirrors the three states NotificationLogTable offers
      // Retry for. A hidden button is not an access control: without it any
      // admin holding notifications.send could reset a `sent` row and re-deliver
      // its FROZEN payload recipients — which, for a multi-recipient scheduled
      // report, means re-mailing an address the schedule corrected long ago.
      // Keep this list and the table's in sync; `needs_review` is deliberately
      // retryable, so narrowing this to failed/skipped would silently strand
      // every row the drain job parks for a human decision.
      // skip_reason is cleared too: migration 328 only allows it on `skipped`
      // rows, so a re-queued row that kept it would be refused.
      const reset = await supabase
        .from("notifications")
        .update({ state: "queued", failure_reason: null, error_code: null, skip_reason: null })
        .eq("id", notification.id)
        .in("state", ["failed", "skipped", "needs_review"])
        .select("id")
        .maybeSingle();
      if (reset.error) throw reset.error;
      if (!reset.data) {
        throw new Error("Only failed, skipped or needs-review notifications can be retried.");
      }
      return dispatchNotificationForCurrentSession({ notificationId: notification.id });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useDeleteNotification() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (notification: Tables<"notifications">) => {
      if (!permissions.can(PERMISSIONS.NOTIFICATIONS_DELETE)) throw new Error("Permission denied.");
      const result = await supabase
        .from("notifications")
        .delete()
        .eq("id", notification.id)
        .select("id")
        .single();
      if (result.error) throw result.error;
      await logAuditForCurrentSession({
        action: "notification.delete",
        entityType: "notification",
        entityId: notification.id,
        before: notification,
      });
      return result.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useCancelNotification() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (notification: Tables<"notifications">) => {
      if (!permissions.can(PERMISSIONS.NOTIFICATIONS_UPDATE)) throw new Error("Permission denied.");
      const result = await supabase
        .from("notifications")
        .update({ state: "cancelled", failure_reason: "Cancelled by an administrator." })
        .eq("id", notification.id)
        .select("*")
        .single();
      if (result.error) throw result.error;
      await logAuditForCurrentSession({
        action: "notification.cancel",
        entityType: "notification",
        entityId: notification.id,
        before: notification,
        after: result.data,
      });
      return result.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}
