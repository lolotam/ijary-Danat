import { scheduledReportsJob, type ScheduledReportsJobInput } from "@/fns/scheduledReportsJob";
import { supabase } from "@/integrations/supabase/client";

export async function runScheduledReportsForCurrentSession(input: ScheduledReportsJobInput) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return scheduledReportsJob({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}
