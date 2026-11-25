/**
 * يعدّ الوحدات التي يطابق نوعها القيمة المعطاة تطابقاً حرفياً.
 *
 * Free-text `units.type` (migration 103). Exact equality only — do not treat
 * catalogue cousins like `commercial_unit` as `commercial`. Used by the
 * property detail Summary card for commercial / shop counts.
 */
export function countUnitsByType(items: ReadonlyArray<{ type: string }>, type: string): number {
  return items.filter((item) => item.type === type).length;
}
