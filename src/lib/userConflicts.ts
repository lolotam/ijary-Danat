/**
 * أنواع التعارض التي تمنع إنشاء حساب مستخدم أو حفظه.
 *
 * Each maps to one `users.conflict.*` message pair and names the field the
 * admin has to change — the whole point is that the toast says *which* value
 * clashed and what to do about it, in the admin's own language.
 */
export type UserConflictKind =
  | "username"
  | "email"
  | "phone-account"
  | "phone-tenant"
  | "phone-too-short"
  | "tenant-account";

export type UserConflict = {
  kind: UserConflictKind;
  /** The value that clashed, echoed back so the admin sees what they typed. */
  value?: string;
  /** Who already holds it — a display name, a tenant name, or absent. */
  owner?: string | null;
};

const MARKER = /^\[user-conflict:([^\]\s]+)\] /;

/**
 * يرمّز التعارض داخل نص الخطأ بحيث تقرؤه الواجهة وتترجمه.
 *
 * Server-function errors reach the browser as plain `Error`s with only their
 * message intact, so the code rides in a URI-encoded JSON prefix. The English sentence
 * after it is what logs, audit rows and any caller that does not decode the
 * prefix still show — so an unaware call site degrades to readable English,
 * never to a raw constraint name.
 */
export function userConflictMessage(conflict: UserConflict, english: string): string {
  // URI-encoded so a `}`, `]` or space inside a free-text name can never end
  // the tag early.
  return `[user-conflict:${encodeURIComponent(JSON.stringify(conflict))}] ${english}`;
}

/** يستخرج التعارض من رسالة الخطأ إن وُجد، وإلا يعيد null. */
export function parseUserConflict(message: string): UserConflict | null {
  const match = MARKER.exec(message);
  if (!match) return null;
  try {
    return JSON.parse(decodeURIComponent(match[1])) as UserConflict;
  } catch {
    // A message that merely looks like the prefix is shown as-is by the caller.
    return null;
  }
}

/**
 * يختار نص الرسالة المترجم لنوع التعارض.
 *
 * Literal `t("…")` calls rather than a built key, so `dictionary.test.ts`
 * proves every one of them exists in both locales.
 */
function conflictTemplate(conflict: UserConflict, t: (key: string) => string): string {
  const known = Boolean(conflict.owner);
  switch (conflict.kind) {
    case "username":
      return known ? t("users.conflict.username") : t("users.conflict.usernameNoOwner");
    case "email":
      return known ? t("users.conflict.email") : t("users.conflict.emailNoOwner");
    case "phone-account":
      return t("users.conflict.phoneAccount");
    case "phone-tenant":
      return t("users.conflict.phoneTenant");
    case "phone-too-short":
      return t("users.conflict.phoneTooShort");
    case "tenant-account":
      return t("users.conflict.tenantAccount");
  }
}

/**
 * يحوّل خطأ إنشاء/تعديل المستخدم إلى رسالة مترجمة تشرح التعارض وما يجب تغييره.
 *
 * Anything that is not a tagged conflict is returned unchanged, so an error
 * this module does not know about still reaches the admin as it was thrown.
 */
export function describeUserError(message: string, t: (key: string) => string): string {
  const conflict = parseUserConflict(message);
  if (!conflict) return message;
  // One pass over the template with a function replacer: inserted text is
  // never re-scanned, so a value containing "{owner}" or "$&" stays literal.
  const fields: Record<string, string> = {
    value: conflict.value ?? "",
    owner: conflict.owner ?? "",
  };
  return conflictTemplate(conflict, t).replace(
    /\{(value|owner)\}/g,
    (_, field: string) => fields[field],
  );
}
