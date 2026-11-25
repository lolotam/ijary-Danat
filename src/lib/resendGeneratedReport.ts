import {
  resendGeneratedReport,
  type ResendGeneratedReportInput,
} from "@/fns/resendGeneratedReport";
import { supabase } from "@/integrations/supabase/client";

export async function resendGeneratedReportForCurrentSession(input: ResendGeneratedReportInput) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return resendGeneratedReport({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}
