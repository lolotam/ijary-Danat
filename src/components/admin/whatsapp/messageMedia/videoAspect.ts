/**
 * يشتق نسبة العرض إلى الارتفاع لعنصر فيديو من أبعاده الطبيعية.
 *
 * تُستخدم لضبط `aspect-ratio` بعد حدث onLoadedMetadata؛ قبل ذلك نعرض
 * هيكلاً محايداً 4:3. القيم الصفرية أو غير المنتهية تعود null فيبقى الهيكل.
 */

/**
 * يحسب سلسلة CSS لـ aspect-ratio من العرض والارتفاع.
 *
 * ترجع null إذا كان أي بُعد صفراً أو غير منتهٍ، لتجنب division-by-zero
 * أو نسب غير منطقية تكسر التخطيط.
 */
export function toAspectRatio(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return `${width} / ${height}`;
}
