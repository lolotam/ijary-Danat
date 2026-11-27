import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  beginEvolutionSession,
  disconnectEvolutionSession,
  getEvolutionQrStatus,
} from "@/fns/evolutionSession";
import { syncEvolutionAvatars } from "@/fns/evolutionAvatars";
import { runEvolutionHistorySync } from "@/fns/evolutionHistorySync";
import { WHATSAPP_SESSION_HEALTH_QUERY_KEY } from "@/hooks/useWhatsappSessionHealth";
import { supabase } from "@/integrations/supabase/client";

/**
 * حِزم React Query لجلسة واتساب QR (بطاقة الإعدادات وحوار المسح).
 *
 * The status row is read straight from PostgREST with exactly the columns the
 * `authenticated` grant exposes (migration 179) — webhook_secret and last_qr
 * are absent from that grant on purpose, so the QR only ever travels through
 * the admin-gated server fn, and its query below is never cached (gcTime 0).
 */

async function sessionHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Authentication required.");
  return { Authorization: `Bearer ${session.access_token}` };
}

export interface EvolutionConnectionStatus {
  id: number;
  instance_name: string;
  connected_number: string | null;
  last_connection_state: string | null;
  connected_at: string | null;
}

const CONNECTION_COLUMNS =
  "id, instance_name, connected_number, last_connection_state, connected_at";

/**
 * يقرأ حالة الاقتران المعروضة في بطاقة الإعدادات.
 */
export function useEvolutionConnection(enabled = true) {
  return useQuery({
    queryKey: ["evolution-connection"],
    enabled,
    queryFn: async (): Promise<EvolutionConnectionStatus | null> => {
      const { data, error } = await supabase
        .from("evolution_connections")
        .select(CONNECTION_COLUMNS)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as EvolutionConnectionStatus | null) ?? null;
    },
  });
}

/**
 * يبدأ جلسة الاقتران ويعيد أول رمز QR للحوار.
 */
export function useBeginEvolutionSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const headers = await sessionHeaders();
      return beginEvolutionSession({ headers });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["evolution-connection"] });
      void queryClient.invalidateQueries({ queryKey: WHATSAPP_SESSION_HEALTH_QUERY_KEY });
    },
  });
}

/**
 * استطلاع حالة الاقتران داخل حوار المسح (كل ثانيتين، دون تخزين للرمز).
 *
 * gcTime 0: the QR is a pairing credential; nothing may keep it after the
 * dialog closes. `refreshQr` re-requests a fresh code after the 45s expiry.
 */
export function useEvolutionQrStatus(enabled: boolean) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["evolution-qr-status"],
    enabled,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: enabled ? 2_000 : false,
    queryFn: async () => {
      const headers = await sessionHeaders();
      const status = await getEvolutionQrStatus({ data: { refreshQr: false }, headers });
      if (status.state === "open") {
        void queryClient.invalidateQueries({ queryKey: WHATSAPP_SESSION_HEALTH_QUERY_KEY });
      }
      return status;
    },
  });
}

/**
 * يطلب رمز QR جديداً بعد انتهاء صلاحية الرمز المعروض.
 */
export function useRefreshEvolutionQr() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const headers = await sessionHeaders();
      return getEvolutionQrStatus({ data: { refreshQr: true }, headers });
    },
    onSuccess: (data) => queryClient.setQueryData(["evolution-qr-status"], data),
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

/**
 * يفصل الجلسة من بطاقة الإعدادات.
 */
export function useDisconnectEvolutionSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const headers = await sessionHeaders();
      return disconnectEvolutionSession({ headers });
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["evolution-qr-status"] });
      void queryClient.invalidateQueries({ queryKey: ["evolution-connection"] });
      void queryClient.invalidateQueries({ queryKey: WHATSAPP_SESSION_HEALTH_QUERY_KEY });
    },
  });
}
