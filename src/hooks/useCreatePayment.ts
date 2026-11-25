import { useMutation } from "@tanstack/react-query";

import { createPaymentForCurrentSession } from "@/lib/myfatoorah";

export function useCreatePayment() {
  return useMutation({ mutationFn: createPaymentForCurrentSession });
}
