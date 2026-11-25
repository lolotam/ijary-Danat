import { supabase } from "@/integrations/supabase/client";

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
