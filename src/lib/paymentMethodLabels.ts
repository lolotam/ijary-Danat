import type { Locale } from "@/i18n/dictionary";

const METHOD_LABELS_AR: Record<string, string> = {
  cash: "نقدًا",
  bank_transfer: "تحويل بنكي",
  card: "بطاقة بنكية",
  cheque: "شيك",
  knet: "كي نت",
  applepay: "Apple Pay",
  googlepay: "Google Pay",
  payment_link: "رابط دفع",
};

const METHOD_LABELS_EN: Record<string, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  card: "Card",
  cheque: "Cheque",
  knet: "KNET",
  applepay: "Apple Pay",
  googlepay: "Google Pay",
  payment_link: "Payment link",
};

/**
 * يترجم طريقة الدفع المخزّنة إلى تسمية يقرأها المستأجر.
 *
 * Lives here so the invoice document and the receipt cannot drift: both papers
 * name the same instrument with the same words.
 */
export function paymentMethodLabel(method: string, locale: Locale): string {
  const table = locale === "ar" ? METHOD_LABELS_AR : METHOD_LABELS_EN;
  return table[method] ?? method;
}
