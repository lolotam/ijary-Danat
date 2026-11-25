/**
 * القاعدة الوحيدة لتطبيع أرقام الهواتف في هذا التطبيق.
 *
 * The rule lived twice — once in the browser (`toChatNumber`, which returns
 * null so a bad number simply renders no link) and once on the server
 * (`toInternationalDigits`, which throws so a send fails loudly). Two copies of
 * one rule drift, and the drift is invisible: a number the chat link accepts
 * but delivery rejects opens a thread nothing can be sent from. Both now wrap
 * this. No server-only imports here — the file has to be safe in the bundle.
 */

/** شكل الجوّال الكويتي: ثماني خانات تبدأ بـ 5 أو 6 أو 9. */
export const KUWAIT_MOBILE = /^[569]\d{7}$/;

/** سبب رفض الرقم، ليصوغ كل مُغلّف رسالته منه. */
export type PhoneRejection = "empty" | "not-international";

export type PhoneNormalization =
  | { ok: true; digits: string }
  | { ok: false; reason: PhoneRejection };

/**
 * يطبّع رقماً إلى أرقام دولية مجردة، مع افتراض الكويت للجوّالات المحلية.
 *
 * A bare 8-digit number starting 5/6/9 is unambiguously a Kuwaiti mobile in
 * this single-country deployment, so it gets 965 prefixed — tenants' numbers
 * are overwhelmingly stored that way, and refusing them silently killed every
 * WhatsApp leg (2026-09-01). Anything else without a + and shorter than 10
 * digits is refused rather than guessed: a 7-digit fragment or a landline
 * could belong to any country.
 */
export function normalizePhoneDigits(value: string): PhoneNormalization {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "empty" };
  if (!trimmed.startsWith("+")) {
    if (KUWAIT_MOBILE.test(digits)) return { ok: true, digits: `965${digits}` };
    if (digits.length < 10) return { ok: false, reason: "not-international" };
  }
  return { ok: true, digits };
}
