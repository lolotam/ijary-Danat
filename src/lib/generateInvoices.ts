import { generateInvoices, type GenerateInvoicesInput } from "@/fns/generateInvoices";
import { supabase } from "@/integrations/supabase/client";

export async function generateInvoicesForCurrentSession(input: GenerateInvoicesInput) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return generateInvoices({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}
