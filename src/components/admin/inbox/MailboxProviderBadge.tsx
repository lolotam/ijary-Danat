import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/i18n/provider";
import type { MailboxProvider } from "@/hooks/useGmailMessages";

/**
 * يحدّد المزوّد من قيمة العمود: الفارغ يعني Gmail، وغير المعروف يعيد null.
 *
 * Rows written before migration 158 carry the column's `'gmail'` default, so an
 * unrecognised value can only come from a future provider this build predates.
 * Rendering it as Gmail would be a lie; rendering nothing is honest, so the
 * badge is omitted rather than guessed.
 */
export function mailboxProviderOf(value: string | null | undefined): MailboxProvider | null {
  if (value === "resend") return "resend";
  if (value === "gmail" || value == null) return "gmail";
  return null;
}

/**
 * شارة تُظهر المزوّد الذي حمل الرسالة.
 *
 * Provenance is worth showing because the two providers fail differently: a
 * Gmail message can be trashed through the Gmail API, a Resend one cannot, and
 * a bounce is only reported for Resend. Without the badge those differences
 * look arbitrary to whoever is reading the inbox.
 */
export function MailboxProviderBadge({ provider }: { provider: string | null | undefined }) {
  const { t } = useI18n();
  const resolved = mailboxProviderOf(provider);
  if (!resolved) return null;
  return (
    <Badge variant={resolved === "resend" ? "secondary" : "outline"} className="shrink-0">
      {resolved === "resend" ? t("inbox.providerResend") : t("inbox.providerGmail")}
    </Badge>
  );
}
