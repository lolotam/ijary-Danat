import { runReportSchedule, type RunReportScheduleInput } from "@/fns/runReportSchedule";
import { supabase } from "@/integrations/supabase/client";

export async function runReportScheduleForCurrentSession(input: RunReportScheduleInput) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return runReportSchedule({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}
