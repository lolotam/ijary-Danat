import { reversePayment, type ReversePaymentInput } from "@/fns/reversePayment";
import { supabase } from "@/integrations/supabase/client";

export async function reversePaymentForCurrentSession(input: ReversePaymentInput) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return reversePayment({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}
