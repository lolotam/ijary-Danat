import { escapeHtml } from "@/lib/html";
import { EMAIL_FONT_STACK } from "@/lib/documentFonts";
import { BRAND, button, wrapLayout, type EmailLocale, type TemplateResult } from "./layout";

/**
 * رسائل بيانات الدخول: حساب بوابة المستأجر وحساب نظام الإدارة.
 */

/**
 * The account details a new user needs. `displayName`, `email` and `mobile` are
 * optional: a row is omitted entirely rather than printed blank, so a managerial
 * user with no phone on file does not get an empty "WhatsApp:" line.
 */
export interface CredentialFields {
  displayName?: string | null;
  username: string;
  password: string;
  email?: string | null;
  mobile?: string | null;
}

function credentialLabels(locale: EmailLocale) {
  return locale === "ar"
    ? {
        displayName: "الاسم",
        username: "اسم المستخدم",
        password: "كلمة المرور",
        email: "البريد الإلكتروني",
        mobile: "واتساب",
      }
    : {
        displayName: "Name",
        username: "Username",
        password: "Password",
        email: "Email",
        mobile: "WhatsApp",
      };
}

/** The fields in display order, dropping the ones with no value. */
function credentialEntries(
  locale: EmailLocale,
  fields: CredentialFields,
): Array<[label: string, value: string]> {
  const labels = credentialLabels(locale);
  const ordered: Array<[string, string | null | undefined]> = [
    [labels.displayName, fields.displayName],
    [labels.username, fields.username],
    [labels.password, fields.password],
    [labels.email, fields.email],
    [labels.mobile, fields.mobile],
  ];
  return ordered
    .filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()))
    .map(([label, value]) => [label, value.trim()]);
}

/**
 * Renders the sign-in details block. The values stay LTR regardless of locale —
 * emails, usernames, passwords and phone numbers are latin/mixed and reorder
 * unreadably when a mail client lays them out RTL.
 */
function credentialBox(locale: EmailLocale, fields: CredentialFields): string {
  // Stacked rows + word-break so long usernames/passwords/emails do not force
  // horizontal scroll on narrow phones (the previous single-line rows did).
  const row = (label: string, value: string) =>
    `<div style="margin:0 0 10px 0;">
      <div style="font-family:${EMAIL_FONT_STACK};font-size:12px;font-weight:700;color:${BRAND.muted};line-height:1.4;"><strong>${escapeHtml(label)}:</strong></div>
      <div style="font-family:Consolas,Menlo,monospace;font-size:14px;line-height:1.6;word-break:break-word;overflow-wrap:anywhere;"><span dir="ltr">${escapeHtml(value)}</span></div>
    </div>`;
  return `<div style="background:${BRAND.bg};border:1px dashed ${BRAND.accent};padding:16px;border-radius:10px;margin:18px 0;max-width:100%;box-sizing:border-box;">
    ${credentialEntries(locale, fields)
      .map(([label, value]) => row(label, value))
      .join("\n    ")}
  </div>`;
}

/** Plain-text counterpart of `credentialBox`, for the text/plain MIME part. */
function credentialText(locale: EmailLocale, fields: CredentialFields, url: string): string {
  const heading = locale === "ar" ? "بيانات الدخول:" : "Credentials:";
  return [
    heading,
    ...credentialEntries(locale, fields).map(([label, value]) => `${label}: ${value}`),
    url,
  ].join("\n");
}

export function tenantCredentialsTemplate(params: {
  locale: EmailLocale;
  tenantName: string;
  portalUrl: string;
  /**
   * Already-rendered intro markup from `notification_templates.body_*`. When
   * present it replaces the built-in opening paragraphs; the branded shell, the
   * credentials box and the button stay under code's control so an edit in
   * Settings cannot break the layout. Absent means the template row is missing
   * or inactive, and the built-in copy is used.
   */
  intro?: string | null;
  /** Rendered `subject_*` from the same row; falls back to the built-in. */
  subject?: string | null;
  fields: CredentialFields;
}): TemplateResult {
  const { locale, tenantName, portalUrl, intro, subject, fields } = params;
  const isAr = locale === "ar";
  const fallbackSubject = isAr
    ? `بيانات دخول بوابة المستأجر — ${tenantName}`
    : `Your tenant portal credentials — ${tenantName}`;
  const title = isAr ? "بيانات الدخول إلى بوابة المستأجر" : "Tenant Portal Access";
  const opening =
    intro?.trim() ||
    (isAr
      ? `
      <p>مرحباً ${escapeHtml(tenantName)}،</p>
      <p>تم إنشاء حسابك في بوابة المستأجر الخاصة بشركة دانة المستقبل العقارية. يمكنك من خلال البوابة متابعة عقدك، فواتيرك، ومدفوعاتك.</p>`
      : `
      <p>Hello ${escapeHtml(tenantName)},</p>
      <p>An account has been created for you on the Danat Al Mustaqbal tenant portal. From the portal you can review your contract, invoices, and payment history.</p>`);
  const body = isAr
    ? `
      ${opening}
      ${credentialBox(locale, fields)}
      <p>يرجى تسجيل الدخول وتغيير كلمة المرور فور الدخول لأول مرة.</p>
      ${button(locale, portalUrl, "الدخول إلى البوابة")}
      <p style="color:${BRAND.muted};font-size:13px;">إذا لم تطلب هذا الحساب، يرجى تجاهل هذه الرسالة.</p>`
    : `
      ${opening}
      ${credentialBox(locale, fields)}
      <p>Please sign in and change your password immediately after first login.</p>
      ${button(locale, portalUrl, "Open portal")}
      <p style="color:${BRAND.muted};font-size:13px;">If you did not request this account you can ignore this email.</p>`;
  const text = credentialText(locale, fields, portalUrl);
  return {
    subject: subject?.trim() || fallbackSubject,
    html: wrapLayout(locale, title, body),
    text,
  };
}

export function welcomeManagerialTemplate(params: {
  locale: EmailLocale;
  displayName: string;
  loginUrl: string;
  /** See `tenantCredentialsTemplate` — editable intro from the DB template. */
  intro?: string | null;
  subject?: string | null;
  fields: CredentialFields;
}): TemplateResult {
  const { locale, displayName, loginUrl, intro, subject, fields } = params;
  const isAr = locale === "ar";
  const fallbackSubject = isAr ? `مرحباً بك في نظام الإدارة` : `Welcome to the management console`;
  const title = isAr ? "بيانات دخول المدير" : "Management Console Access";
  const opening =
    intro?.trim() ||
    (isAr
      ? `<p>مرحباً ${escapeHtml(displayName)}،</p>
       <p>تم إنشاء حسابك في نظام إدارة الإيجارات.</p>`
      : `<p>Hello ${escapeHtml(displayName)},</p>
       <p>Your management console account has been created.</p>`);
  const body = isAr
    ? `${opening}
       ${credentialBox(locale, fields)}
       ${button(locale, loginUrl, "تسجيل الدخول")}`
    : `${opening}
       ${credentialBox(locale, fields)}
       ${button(locale, loginUrl, "Sign in")}`;
  const text = credentialText(locale, fields, loginUrl);
  return {
    subject: subject?.trim() || fallbackSubject,
    html: wrapLayout(locale, title, body),
    text,
  };
}
