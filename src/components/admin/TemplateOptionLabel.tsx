import { t as translate } from "@/i18n/dictionary";
import type { LocaleCode, NotificationType } from "@/integrations/supabase/database.types";

/**
 * يعرض رمز القالب ونوعه بلغة الرسالة المختارة، مع عزل اتجاه النص.
 *
 * `useI18n().t` is bound to the ADMIN UI locale, but the admin is choosing what
 * the TENANT receives — so the type name follows the dialog's language selector
 * via the locale-explicit translator instead.
 *
 * `<bdi>` because a Latin hyphenated code followed by Arabic text in parentheses
 * reorders visually inside the RTL dialog.
 */
export function TemplateOptionLabel({
  code,
  type,
  locale,
}: {
  code: string;
  type: NotificationType;
  locale: LocaleCode;
}) {
  return (
    <span>
      <bdi dir="ltr">{code}</bdi> (<bdi>{translate(locale, `notificationType.${type}`)}</bdi>)
    </span>
  );
}
