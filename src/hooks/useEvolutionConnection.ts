import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { syncEvolutionAvatars } from "@/fns/evolutionAvatars";
import { runEvolutionHistorySync } from "@/fns/evolutionHistorySync";
import { supabase } from "@/integrations/supabase/client";
import type { WhatsappConnectionStatus } from "@/integrations/supabase/database.types";

/**
 * حِزم React Query لحالة اتصال واتساب QR الخاص بالشركة.
 *
 * The status row is read straight from PostgREST with exactly the columns the
 * `authenticated` grant exposes (migration 333) — `last_qr` is absent from
 * that grant on purpose, so the pairing QR only ever travels through the
 * admin-gated server function.
 */

async function sessionHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Authentication required.");
  return { Authorization: `Bearer ${session.access_token}` };
}

/** حالة اتصال واتساب كما يعرضها صندوق الوارد. */
export interface EvolutionConnectionStatus {
  id: string;
  status: WhatsappConnectionStatus;
  connectedNumber: string | null;
  connectedAt: string | null;
}

const CONNECTION_COLUMNS = "id, status, connected_number, connected_at";

/**
 * يقرأ حالة اتصال واتساب النشط للشركة كما يعرضها صندوق الوارد.
 *
 * The company's ACTIVE `evolution_qr` connection is the one that carries the
 * paired session; a Cloud API row is a different link and says nothing about
 * the QR session.
 */
export function useEvolutionConnection(enabled = true) {
  return useQuery({
    queryKey: ["evolution-connection"],
    enabled,
    queryFn: async (): Promise<EvolutionConnectionStatus | null> => {
      const { data, error } = await supabase
        .from("whatsapp_connections")
        .select(CONNECTION_COLUMNS)
        .eq("method", "evolution_qr")
        .eq("is_active", true)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        id: data.id,
        status: data.status,
        connectedNumber: data.connected_number,
        connectedAt: data.connected_at,
      };
    },
  });
}

/**
 * يحجز مزامنة تاريخ المحادثات في العامل (زر "مزامنة السجل").
 *
 * The sweep runs as a background job now (`whatsapp.history.sync`): the click
 * queues it and gets the job's id back, and the import happens out of the
 * request.
 */
export function useRunEvolutionHistorySync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const headers = await sessionHeaders();
      return runEvolutionHistorySync({ headers });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-chats"] });
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-contacts"] });
    },
  });
}

/**
 * يحجز مزامنة صور الملفات الشخصية في العامل.
 *
 * Separate from the history sync although the card places them side by side:
 * history walks message pages and can take a minute, while this only refreshes
 * pictures, and an admin whose contacts show initials should not have to
 * re-import a year of messages to fix it. The worker job walks the whole
 * directory itself, so there is no cursor to pass between clicks any more.
 */
export function useSyncEvolutionAvatars() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const headers = await sessionHeaders();
      return syncEvolutionAvatars({ headers });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-chats"] });
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-contacts"] });
    },
  });
}
