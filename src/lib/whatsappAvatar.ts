/**
 * صلاحية روابط صور واتساب الشخصية.
 *
 * WhatsApp serves profile pictures from `pps.whatsapp.net` with the expiry
 * stamped into the URL itself: `oe=<unix seconds in hex>`. Two URLs read off
 * production expired 7 and 10 days after they were issued. Storing such a link
 * therefore stores something that dies on its own, and the only way to tell
 * without fetching it is to read that parameter — which is what this does.
 */

/** هامش أمان: يُعدّ الرابط منتهياً قبل لحظة انتهائه بقليل. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * يقرأ لحظة انتهاء الرابط من المعامل `oe`، أو null إن لم يحملها.
 *
 * A URL with no `oe` is not treated as expired: other hosts (and future
 * WhatsApp URL shapes) simply carry no expiry we can read, and guessing
 * "expired" there would throw away a picture that still loads.
 */
export function avatarUrlExpiry(url: string): Date | null {
  const match = /[?&]oe=([0-9a-f]+)/i.exec(url);
  if (!match) return null;
  const seconds = Number.parseInt(match[1], 16);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/**
 * هل انتهت صلاحية رابط الصورة المخزّن؟
 *
 * Used in two places for the same reason: the UI skips straight to initials
 * rather than requesting an image it knows will 403, and the backfill treats
 * an expired link as no link so the next message replaces it.
 */
export function isAvatarUrlExpired(
  url: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!url) return false;
  const expiry = avatarUrlExpiry(url);
  if (!expiry) return false;
  return expiry.getTime() - EXPIRY_MARGIN_MS <= now.getTime();
}
