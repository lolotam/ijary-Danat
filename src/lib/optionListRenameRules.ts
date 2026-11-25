import { ENUM_BACKED_OPTION_LISTS } from "@/lib/enumBackedOptionLists";
import { isCodeBoundValue } from "@/lib/unitFloorTypeBinding";

/**
 * قوائم ترفض قاعدة البيانات إعادة تسمية قيمها كلياً.
 *
 * Mirrors the refused-code list in `rename_option_list_value` (migration 239):
 * enum-backed lists store Postgres enum members, `tenant_categories` backs the
 * `tenants.category` enum, and `manual_payment_reasons` shares its column with
 * payment-method values, so a string cascade could rewrite the wrong rows.
 * optionListRenameRules.test.ts fails when this and the SQL disagree.
 */
export const RENAME_REFUSED_LISTS: readonly string[] = [
  ...Object.keys(ENUM_BACKED_OPTION_LISTS),
  "tenant_categories",
  "manual_payment_reasons",
];

/** سبب قفل قيمة عنصر القائمة عن التعديل، أو null إن كانت قابلة لإعادة التسمية. */
export type ValueRenameLock = "refusedList" | "codeBound" | null;

/**
 * يحدد لماذا لا يجوز تغيير القيمة المخزنة لعنصر قائمة من شاشة الإعدادات.
 *
 * The editor locks the field for exactly the cases the server refuses, so an
 * admin is never offered a rename that can only fail after the preview.
 */
export function valueRenameLock(listCode: string, value: string): ValueRenameLock {
  if (RENAME_REFUSED_LISTS.includes(listCode)) return "refusedList";
  if (isCodeBoundValue(listCode, value)) return "codeBound";
  return null;
}
