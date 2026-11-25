import { evaluateOverdue, type EvaluateOverdueInput } from "@/fns/evaluateOverdue";
import { supabase } from "@/integrations/supabase/client";

export async function evaluateOverdueForCurrentSession(input: EvaluateOverdueInput) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return evaluateOverdue({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}
