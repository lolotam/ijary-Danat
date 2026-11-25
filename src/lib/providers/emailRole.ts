export type EmailRole = "primary" | "fallback";

/**
 * يحدّد صفّ المزوّد الذي يجب ترقيته ليصبح الافتراضي عند تغيير دور بطاقة بريد.
 *
 * Only `is_primary = true` is ever written: migration 225's trigger demotes
 * the other email row, so exactly one default survives any single update.
 * Choosing "fallback" on one card therefore means promoting the other card,
 * and with no other email row there is nothing to promote (null).
 */
export function emailRolePromotionTarget(
  emailProviderIds: string[],
  cardId: string,
  role: EmailRole,
): string | null {
  if (role === "primary") return cardId;
  return emailProviderIds.find((id) => id !== cardId) ?? null;
}
