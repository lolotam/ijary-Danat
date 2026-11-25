import type { PaymentMethod } from "@/integrations/supabase/database.types";

/**
 * طرق الدفع التي تمر عبر بوابة الدفع، لا يدخلها الموظف يدويًا.
 *
 * These are the instruments MyFatoorah reports back on a settled payment link.
 * Two things follow from that and both matter: they are the ones grouped under a
 * single "Payment link" label for reading, and they are the ones
 * `set_invoice_paid` refuses on the manual path — a hand-typed KNET payment has
 * no gateway transaction behind it and reconciliation could never match it.
 */
export const GATEWAY_PAYMENT_METHODS: readonly PaymentMethod[] = [
  "payment_link",
  "knet",
  "card",
  "applepay",
  "googlepay",
];

/** هل وصلت هذه الدفعة عبر بوابة الدفع؟ */
export function isGatewayMethod(method: string | null | undefined): boolean {
  return method != null && (GATEWAY_PAYMENT_METHODS as readonly string[]).includes(method);
}

/**
 * يصيغ طريقة الدفع للعرض، فيجمع طرق البوابة تحت "رابط دفع" مع إبقاء الأداة.
 *
 * An admin reading the ledger wants to know the money came through the payment
 * link — `knet`, `card` and `applepay` are all the same event to them. But the
 * instrument is what reconciliation against MyFatoorah keys on, so discarding it
 * would trade one group's clarity for another's. "Payment link (KNET)" gives
 * both, and `payment_link` itself has no instrument to name, so it stays bare.
 *
 * Translation happens through the caller's `t`, so this stays a pure function
 * and can be tested without a provider.
 */
export function formatPaymentMethod(
  method: string | null | undefined,
  t: (key: string) => string,
): string {
  if (!method) return "—";
  const label = t(`paymentMethod.${method}`);
  if (method === "payment_link" || !isGatewayMethod(method)) return label;
  return t("paymentMethod.gatewayGroup").replace("{method}", label);
}
