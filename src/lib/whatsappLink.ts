import { normalizePhoneDigits } from "@/lib/kuwaitPhone";

/**
 * يحوّل رقماً كما هو مخزّن في سجل المستأجر إلى `chat_number` المستخدم في صندوق واتساب.
 *
 * The browser wrapper over the shared rule: a number this rejects only means no
 * chat link is offered beside it, so it answers null where the server wrapper
 * (`toInternationalDigits`) throws.
 */
export function toChatNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const result = normalizePhoneDigits(raw);
  return result.ok ? result.digits : null;
}
