import { dictionaries, type Locale } from "@/i18n/dictionary";

/** يرجع ترجمة المفتاح إن وُجد في القاموس، وإلا undefined — بلا رجوع للمفتاح الخام. */
function lookup(locale: Locale, key: string): string | undefined {
  return dictionaries[locale][key];
}

/**
 * يترجم كود إجراء التدقيق إلى عبارة مقروءة، مثل `property.create` ← «إنشاء عقار».
 *
 * A whole-code override (`auditAction.<code>`) wins; otherwise the code is
 * split at its last dot into noun and verb (`user.role.grant` → "user.role" +
 * "grant") and composed from `auditEntity.*` / `auditVerb.*`. Anything that
 * does not resolve is returned as the raw code: an untranslated action must
 * stay visible and searchable, never collapse into a blank or a wrong label.
 */
export function auditActionLabel(action: string, locale: Locale): string {
  const whole = lookup(locale, `auditAction.${action}`);
  if (whole) return whole;
  const lastDot = action.lastIndexOf(".");
  if (lastDot <= 0) return action;
  const entity = lookup(locale, `auditEntity.${action.slice(0, lastDot)}`);
  const verb = lookup(locale, `auditVerb.${action.slice(lastDot + 1)}`);
  return entity && verb ? `${verb} ${entity}` : action;
}

/** يترجم نوع الكيان (`tenant` ← «مستأجر»)، ويرجع الكود نفسه إن لم يُعرف. */
export function auditEntityLabel(entityType: string, locale: Locale): string {
  return lookup(locale, `auditEntity.${entityType}`) ?? entityType;
}

/**
 * يترجم دور المنفّذ: أدوار التطبيق من `roles.*`، وأدوار Postgres من `auditRole.*`.
 *
 * `write_audit` stores the app role when the actor has one and falls back to
 * the JWT role (`service_role`, `authenticated`) or `system` otherwise, so both
 * vocabularies appear in the same column.
 */
export function auditRoleLabel(role: string, locale: Locale): string {
  return lookup(locale, `roles.${role}`) ?? lookup(locale, `auditRole.${role}`) ?? role;
}
