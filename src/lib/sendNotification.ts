import { sendNotification, type SendNotificationInput } from "@/fns/sendNotification";
import { supabase } from "@/integrations/supabase/client";

export async function sendNotificationForCurrentSession(input: SendNotificationInput) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return sendNotification({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}
