import {
  generateElectricityCharges,
  type GenerateElectricityChargesInput,
} from "@/fns/generateElectricityCharges";
import { supabase } from "@/integrations/supabase/client";

export async function generateElectricityChargesForCurrentSession(
  input: GenerateElectricityChargesInput,
) {
  const sessionResponse = await supabase.auth.getSession();
  const session = sessionResponse.data.session;
  if (!session) throw new Error("Authentication required.");

  return generateElectricityCharges({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}
