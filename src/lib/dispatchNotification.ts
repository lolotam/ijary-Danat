import { dispatchNotification, type DispatchNotificationInput } from "@/fns/dispatchNotification";
import { supabase } from "@/integrations/supabase/client";

export async function dispatchNotificationForCurrentSession(input: DispatchNotificationInput) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return dispatchNotification({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}
