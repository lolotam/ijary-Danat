import { cancelContractCloseout, type CancelCloseoutInput } from "@/fns/cancelContractCloseout";
import { closeOutContract, type CloseoutInput } from "@/fns/closeOutContract";
import { previewContractCloseout, type PreviewCloseoutInput } from "@/fns/previewContractCloseout";
import { restoreContract, type RestoreInput } from "@/fns/restoreContract";
import { reverseRefund, type ReverseRefundInput } from "@/fns/reverseRefund";
import { setInvoiceDispute, type DisputeInput } from "@/fns/setInvoiceDispute";
import { voidRefund, type VoidRefundInput } from "@/fns/voidRefund";
import { writeOffInvoice, type WriteOffInput } from "@/fns/writeOffInvoice";
import { supabase } from "@/integrations/supabase/client";

async function withSessionAuth<T>(
  call: (headers: { Authorization: string }) => Promise<T>,
): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return call({ Authorization: `Bearer ${session.access_token}` });
}

export async function closeOutContractForCurrentSession(input: CloseoutInput) {
  return withSessionAuth((headers) => closeOutContract({ data: input, headers }));
}

export async function cancelContractCloseoutForCurrentSession(input: CancelCloseoutInput) {
  return withSessionAuth((headers) => cancelContractCloseout({ data: input, headers }));
}

export async function restoreContractForCurrentSession(input: RestoreInput) {
  return withSessionAuth((headers) => restoreContract({ data: input, headers }));
}

export async function previewContractCloseoutForCurrentSession(input: PreviewCloseoutInput) {
  return withSessionAuth((headers) => previewContractCloseout({ data: input, headers }));
}

export async function reverseRefundForCurrentSession(input: ReverseRefundInput) {
  return withSessionAuth((headers) => reverseRefund({ data: input, headers }));
}

export async function voidRefundForCurrentSession(input: VoidRefundInput) {
  return withSessionAuth((headers) => voidRefund({ data: input, headers }));
}

export async function writeOffInvoiceForCurrentSession(input: WriteOffInput) {
  return withSessionAuth((headers) => writeOffInvoice({ data: input, headers }));
}

export async function setInvoiceDisputeForCurrentSession(input: DisputeInput) {
  return withSessionAuth((headers) => setInvoiceDispute({ data: input, headers }));
}
