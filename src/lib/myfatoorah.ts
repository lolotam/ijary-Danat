import {
  confirmGatewayPayment,
  type ConfirmGatewayPaymentInput,
} from "@/fns/confirmGatewayPayment";
import { createPayment, type CreatePaymentInput } from "@/fns/createPayment";
import { supabase } from "@/integrations/supabase/client";

async function sessionAuthHeaders() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return { Authorization: `Bearer ${session.access_token}` };
}

export async function createPaymentForCurrentSession(input: CreatePaymentInput) {
  return createPayment({ data: input, headers: await sessionAuthHeaders() });
}

export async function confirmPaymentForCurrentSession(input: ConfirmGatewayPaymentInput) {
  return confirmGatewayPayment({ data: input, headers: await sessionAuthHeaders() });
}
