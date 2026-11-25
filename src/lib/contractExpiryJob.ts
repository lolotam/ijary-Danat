import { contractExpiryJob, type ContractExpiryJobInput } from "@/fns/contractExpiryJob";
import { supabase } from "@/integrations/supabase/client";

export async function runContractExpiryForCurrentSession(input: ContractExpiryJobInput) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return contractExpiryJob({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}
