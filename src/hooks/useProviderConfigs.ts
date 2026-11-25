import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type { Json, TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";

export function useProviderConfigs(enabled = true) {
  return useQuery({
    queryKey: ["provider-configs"],
    enabled,
    queryFn: async () => {
      const result = await supabase.from("provider_configs").select("*").order("provider");
      if (result.error) throw result.error;
      return result.data;
    },
  });
}

function assertSecretReferences(config: Json) {
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new Error("Provider config must be a JSON object.");
  }
  for (const [key, value] of Object.entries(config)) {
    const isReference = /(_env|_ref)$/i.test(key);
    if (/(secret|password|token|api.?key)/i.test(key) && !isReference) {
      throw new Error("Provider secrets must be stored as environment variable references.");
    }
    if (isReference && (typeof value !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(value))) {
      throw new Error("Environment references must use an uppercase environment variable name.");
    }
  }
}

export function useUpdateProviderConfig() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: TablesUpdate<"provider_configs">;
    }) => {
      if (!permissions.can(PERMISSIONS.SETTINGS_INTEGRATIONS))
        throw new Error("Permission denied.");
      if (updates.config !== undefined) assertSecretReferences(updates.config);
      const before = await supabase.from("provider_configs").select("*").eq("id", id).single();
      if (before.error) throw before.error;
      const result = await supabase
        .from("provider_configs")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();
      if (result.error) throw result.error;
      await logAuditForCurrentSession({
        action: "provider_config.update",
        entityType: "provider_config",
        entityId: id,
        before: before.data,
        after: result.data,
      });
      return result.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["provider-configs"] }),
  });
}
