import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseWhatsappSessionHealth,
  type WhatsappSessionHealth,
} from "@/lib/whatsappSessionBanner";

/** مفتاح استعلام صحة جلسة واتساب في React Query. */
export const WHATSAPP_SESSION_HEALTH_QUERY_KEY = ["whatsapp-session-health"] as const;

/**
 * يستعلم عن صحة جلسة واتساب QR عبر دالة القاعدة الموحّدة لكل الموظفين.
 *
 * Uses `retry: false` so an RPC error quietly hides the banner instead of
 * spamming retries or blocking the admin layout shell.
 */
export function useWhatsappSessionHealth(enabled = true) {
  return useQuery({
    queryKey: WHATSAPP_SESSION_HEALTH_QUERY_KEY,
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<WhatsappSessionHealth | null> => {
      const { data, error } = await supabase.rpc("whatsapp_session_health");
      if (error) throw error;
      return parseWhatsappSessionHealth(data);
    },
  });
}
