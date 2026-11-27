import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/database.types";

/**
 * يبني ترويسة المصادقة التي تطلبها دوال الخادم من المتصفح.
 *
 * Shared by the inbox hooks and the contacts hooks after they were split: one
 * copy, so a change to how the token is read cannot reach only half of them.
 */
export async function sessionHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Authentication required.");
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * يقرأ معرّف اتصال واتساب النشط للشركة الحالية لتقييد استعلامات الصندوق به.
 */
export async function fetchActiveWhatsAppConnectionId(
  client: SupabaseClient<Database> = supabase,
): Promise<string | null> {
  const { data, error } = await client
    .from("whatsapp_connections")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * يستعلم عن معرّف اتصال واتساب النشط للشركة الحالية عبر React Query.
 */
export function useActiveWhatsAppConnectionId(enabled = true) {
  return useQuery({
    queryKey: ["whatsapp-active-connection-id"],
    enabled,
    staleTime: 30_000,
    queryFn: () => fetchActiveWhatsAppConnectionId(supabase),
  });
}
