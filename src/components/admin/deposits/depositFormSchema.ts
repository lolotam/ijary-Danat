import { z } from "zod";

export const depositStatuses = ["pending", "confirmed", "cancelled"] as const;
export const depositTypes = ["cash", "cheque"] as const;

/**
 * قيمة عنصر «بدون» في قوائم العقد والفاتورة.
 *
 * Radix's Select rejects an empty-string item value, so "no link" needs a
 * sentinel that cannot collide with a UUID.
 */
export const UNLINKED = "__none__";

export const depositFormSchema = z.object({
  contract_id: z.string().uuid().nullable(),
  invoice_id: z.string().uuid().nullable(),
  deposit_date: z.string().date(),
  bank_name: z.string().trim().min(1),
  amount: z.coerce.number().finite().positive(),
  // Pinned rather than merely defaulted. The field is disabled in the UI, but a
  // stale form state or a hand-edited request must not slip another currency
  // past — `deposits_currency_kwd` would reject it anyway, as an opaque 23514.
  currency: z.literal("KWD"),
  deposit_type: z.enum(depositTypes),
  status: z.enum(depositStatuses),
  note: z.string(),
});
export type DepositForm = z.infer<typeof depositFormSchema>;

/**
 * القيم الابتدائية لإيداع جديد.
 */
export function emptyDeposit(): DepositForm {
  return {
    contract_id: null,
    invoice_id: null,
    deposit_date: new Date().toISOString().slice(0, 10),
    bank_name: "",
    amount: 0,
    currency: "KWD",
    deposit_type: "cash",
    status: "confirmed",
    note: "",
  };
}
