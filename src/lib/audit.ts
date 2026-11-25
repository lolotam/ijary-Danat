// Client-safe audit helper. This module imports ONLY the browser Supabase
// client and the `logAudit` server function (a createServerFn, which TanStack
// Start exposes to the client as an RPC stub — never the server-only
// middleware). Do not import server-only modules (auth-middleware, client.server)
// from here.
import { supabase } from "@/integrations/supabase/client";
import { logAudit, type AuditInput } from "@/fns/audit";

/**
 * Writes an audit log row for the currently signed-in browser user by calling
 * the authenticated `logAudit` server function with the user's access token.
 */
export async function logAuditForCurrentSession(input: AuditInput): Promise<{ id: string }> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new Error("Cannot write an audit log without an authenticated session.");
  }

  return logAudit({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}
