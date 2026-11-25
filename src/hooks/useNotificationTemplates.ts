import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type { TablesInsert, TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { LEGACY_TEMPLATE_CODES } from "@/lib/legacyTemplateCodes";
import { PERMISSIONS } from "@/lib/permissions";

export function useNotificationTemplates(enabled = true) {
  return useQuery({
    queryKey: ["notification-templates"],
    enabled,
    queryFn: async () => {
      const result = await supabase
        .from("notification_templates")
        .select("*")
        .notIn("code", LEGACY_TEMPLATE_CODES)
        .order("type");
      if (result.error) throw result.error;
      return result.data;
    },
  });
}

export function useCreateNotificationTemplate() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: TablesInsert<"notification_templates">) => {
      if (!permissions.can(PERMISSIONS.NOTIFICATIONS_CREATE)) throw new Error("Permission denied.");
      const result = await supabase
        .from("notification_templates")
        .insert(values)
        .select("*")
        .single();
      if (result.error) throw result.error;
      await logAuditForCurrentSession({
        action: "notification_template.create",
        entityType: "notification_template",
        entityId: result.data.id,
        after: result.data,
      });
      return result.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notification-templates"] }),
  });
}

export function useUpdateNotificationTemplate() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: TablesUpdate<"notification_templates">;
    }) => {
      if (!permissions.can(PERMISSIONS.NOTIFICATIONS_UPDATE)) throw new Error("Permission denied.");
      const before = await supabase
        .from("notification_templates")
        .select("*")
        .eq("id", id)
        .single();
      if (before.error) throw before.error;
      const result = await supabase
        .from("notification_templates")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (result.error) throw result.error;
      await logAuditForCurrentSession({
        action: "notification_template.update",
        entityType: "notification_template",
        entityId: id,
        before: before.data,
        after: result.data,
      });
      return result.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notification-templates"] }),
  });
}

export function useDeleteNotificationTemplate() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!permissions.can(PERMISSIONS.NOTIFICATIONS_DELETE)) throw new Error("Permission denied.");
      const before = await supabase
        .from("notification_templates")
        .select("*")
        .eq("id", id)
        .single();
      if (before.error) throw before.error;
      const result = await supabase.from("notification_templates").delete().eq("id", id);
      if (result.error) throw result.error;
      await logAuditForCurrentSession({
        action: "notification_template.delete",
        entityType: "notification_template",
        entityId: id,
        before: before.data,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notification-templates"] }),
  });
}
