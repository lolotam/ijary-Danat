import { applyAllocation, type ApplyAllocationInput } from "@/fns/applyAllocation";
import { supabase } from "@/integrations/supabase/client";

export async function applyAllocationForCurrentSession(input: ApplyAllocationInput) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return applyAllocation({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}
