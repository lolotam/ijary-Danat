/**
 * القيمة التي تعني "بلا تصفية" في قوائم shadcn المنسدلة.
 *
 * A Radix `<SelectItem>` refuses an empty-string value — it reserves "" for
 * "nothing is selected" and throws if an item claims it. Filter state stores ""
 * for "no filter", so the two need a sentinel between them. It lives here
 * rather than in each bar because every filter bar has to spell it the same
 * way: a second bar picking its own string would still work, right up until
 * someone moved a field between them.
 */
export const ANY_VALUE = "__any__";

/** يحوّل اختيار القائمة إلى قيمة المرشِّح: القيمة الحارسة تعني "بلا تصفية". */
export function fromAnyValue(selected: string): string {
  return selected === ANY_VALUE ? "" : selected;
}
