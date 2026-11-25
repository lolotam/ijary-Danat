/**
 * يقرّب مبلغاً إلى أقرب فلس (ثلاث خانات عشرية)، كما يخزّنه `numeric(14,3)` في قاعدة البيانات.
 *
 * Every sum JavaScript computes over money has to land on the value Postgres
 * would store, or a screen and the function behind it disagree about the same
 * invoice — a 33.333% discount on 300 leaves 0.0000000001 of rent in floating
 * point, which Postgres rounds away and JavaScript does not. The rule used to
 * be written out in eight places under four names; one rule, one home, so a
 * change to it (banker's rounding, integer fils) cannot miss a copy.
 *
 * Lives here rather than in `money.ts` deliberately: that module is the
 * display boundary and truncates for humans, while this keeps full precision
 * for arithmetic.
 */
export function roundToFils(value: number): number {
  return Math.round(value * 1000) / 1000;
}
