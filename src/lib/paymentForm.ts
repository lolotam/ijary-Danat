import { z } from "zod";

import type { PaymentAccountType, PaymentMethod } from "@/integrations/supabase/database.types";

/**
 * نموذج الدفعة الكاملة: المخطط والقيم الابتدائية، منفصلاً عن الحوار الذي يعرضه.
 *
 * Moved out of the payments route with its dialog (audit M32, plan rows 6.5 and
 * 6.13) so the rule for what a valid manual payment is can be read — and tested
 * — without rendering a screen. It follows the four `lib/*Form.ts` modules that
 * already do this for the other finance dialogs.
 */

/**
 * طرق الدفع الاحتياطية حين تكون قائمة `payment_methods` فارغة.
 *
 * Fallback only: `useListDrivenOptions` prefers the option list, which
 * production populates. Kept in step with the enum so an install with an empty
 * catalog still offers every method the RPC accepts.
 */
export const PAYMENT_METHODS: PaymentMethod[] = [
  "payment_link",
  "bank_transfer",
  "cheque",
  "cash",
  "knet",
  "audit_adjustment",
];

/** نوعا الحساب اللذان تقبلهما الدفعة. */
export const PAYMENT_ACCOUNT_TYPES: PaymentAccountType[] = [
  "commercial_account",
  "personal_account",
];

export const paymentSchema = z.object({
  contractId: z.string().uuid(),
  accountType: z.enum(["commercial_account", "personal_account"]),
  method: z.enum(["payment_link", "bank_transfer", "cheque", "cash", "knet", "audit_adjustment"]),
  paymentDate: z.string().date(),
  reference: z.string().trim().max(200),
  note: z.string().trim().max(1000),
  invoiceIds: z.array(z.string().uuid()).min(1),
});

export type PaymentForm = z.infer<typeof paymentSchema>;

/** قيم نموذج دفعة جديدة، بتاريخ اليوم وقت الاستدعاء لا وقت تحميل الوحدة. */
export const emptyPaymentForm = (): PaymentForm => ({
  contractId: "",
  accountType: "commercial_account",
  method: "bank_transfer",
  paymentDate: new Date().toISOString().slice(0, 10),
  reference: "",
  note: "",
  invoiceIds: [],
});
