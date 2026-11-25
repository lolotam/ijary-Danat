/**
 * اسم ملف واحد لكل ورقة مالية يستلمها المستأجر: رمز الإيصال حين يوجد.
 *
 * The tenant receives the same money three ways — a PDF downloaded from the
 * admin table, a PDF downloaded from their portal, and a PDF attached to the
 * WhatsApp or email notification — and every one of them must arrive under the
 * receipt number they can quote back. Naming the invoice paper after its own
 * `INV-…` code produced a second, unrelated number for the same money, which is
 * what this file exists to stop. Scheduled weekly and monthly report PDFs are
 * deliberately outside this rule: they are not receipts and keep their own
 * descriptive names.
 */

import { safeFilename } from "@/lib/safeFilename";

/**
 * يبني اسم ملف PDF من رمز الإيصال، ويرجع إلى الرمز البديل عند غيابه.
 *
 * The receipt row is absent in two real cases, and neither may lose the reader
 * their document: the receipt trigger has not fired yet for a just-made
 * payment, and portal RLS hides a receipt that is not `visible_to_tenant`. The
 * invoice or payment code stands in there, exactly as the printed document's
 * own heading already does.
 */
export function receiptDocumentFilename(
  receiptCode: string | null | undefined,
  fallbackCode: string,
): string {
  const code = receiptCode?.trim() || fallbackCode;
  return `${safeFilename(code)}.pdf`;
}
