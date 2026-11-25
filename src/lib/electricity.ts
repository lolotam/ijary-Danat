/**
 * يعرض قراءة عدّاد أو استهلاكاً بالكيلوواط-ساعة بثلاث منازل.
 *
 * Meter readings are not money. Truncating them would hide genuine fractions
 * of a kWh; currency **totals** that used to share this helper go through
 * {@link formatKwd} instead.
 */
export function formatElectricityNumber(amount: number | null) {
  return amount === null ? "—" : amount.toFixed(3);
}

/**
 * يعرض سعر الوحدة (فلس لكل كيلوواط-ساعة) بدقته الكاملة مع رمز العملة.
 *
 * A tariff is a **rate**, not a total, and rates in this system are fractions
 * of a dinar — 0.025 KWD/kWh is a realistic value. The app-wide rule that
 * displayed money is truncated to whole dinars is about amounts a tenant is
 * charged; applying it here would render every tariff in the table as `0 KWD`
 * and make the screen unusable. Kept explicit rather than left as a bare
 * `toFixed` so the exemption is a named decision rather than a call site
 * someone "forgot" to migrate.
 */
export function formatElectricityRate(unitPrice: number | null, currency = "KWD") {
  return unitPrice === null ? "—" : `${unitPrice.toFixed(3)} ${currency}`;
}
