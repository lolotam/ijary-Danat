import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { beginGmailOAuth, disconnectGmail } from "@/fns/gmailOAuth";
import { runWorkflowNow } from "@/fns/runWorkflowNow";
import { supabase } from "@/integrations/supabase/client";

async function sessionHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Authentication required.");
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * Status of the connected Gmail mailbox.
 *
 * The selected columns are exactly those the `authenticated` role is granted
 * (db/migrations/53_gmail_connections.sql). `refresh_token` is absent from that
 * grant on purpose, so `select("*")` here would be a permission error rather
 * than a leak — but naming the columns keeps the intent visible at the call
 * site instead of relying on the reader to know the grant.
 */
export interface GmailConnectionStatus {
  id: string;
  email_address: string;
  connected_at: string;
  last_synced_at: string | null;
  last_sync_error: string | null;
}

const CONNECTION_COLUMNS = "id, email_address, connected_at, last_synced_at, last_sync_error";

export function useGmailConnection(enabled = true) {
  return useQuery({
    queryKey: ["gmail-connection"],
    enabled,
    queryFn: async (): Promise<GmailConnectionStatus | null> => {
      const { data, error } = await supabase
        .from("gmail_connections")
        .select(CONNECTION_COLUMNS)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as GmailConnectionStatus | null) ?? null;
    },
  });
}

/**
 * Starts the consent flow.
 *
 * The server mints the signed state and returns Google's URL; the browser
 * navigates to it. It cannot be a plain link: the server call is authenticated
 * by an Authorization header that a browser navigation would not send.
 */
export function useConnectGmail() {
  return useMutation({
    mutationFn: async () => {
      const { url } = await beginGmailOAuth();
      window.location.href = url;
    },
  });
}

export function useDisconnectGmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => disconnectGmail(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["gmail-connection"] }),
  });
}

/**
 * Pulls the connected mailbox into `gmail_messages` immediately (admin "Sync now").
 *
 * Uses the same `gmail-sync` job the cron tick runs, so behaviour and permissions
 * stay one path: catalog `runPermission` is `notifications.read`.
 */
export function useRunGmailSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const headers = await sessionHeaders();
      return runWorkflowNow({ data: { key: "gmail-sync" }, headers });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["gmail-messages"] });
      queryClient.invalidateQueries({ queryKey: ["gmail-message"] });
      queryClient.invalidateQueries({ queryKey: ["gmail-connection"] });
      queryClient.invalidateQueries({ queryKey: ["cron-jobs"] });
    },
  });
}
