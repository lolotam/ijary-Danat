/**
 * Message bodies for the "Send Company Information" flow — the HTML email body
 * and the WhatsApp text summary.
 *
 * Lives in src/lib rather than inside the server fn so these pure string
 * builders can be unit tested without pulling in the Supabase service-role
 * client or pdfkit. `src/fns/sendCompanyInfo.ts` is the only caller.
 *
 * Unlike the PDF attachment (which is Latin-only — see the font note in
 * `companyInfoPdf.ts`), these bodies render in a real text engine and so carry
 * the tenant's own language and text direction.
 */

import type { Company } from "@/hooks/useCompany";
import type { Locale } from "@/i18n/dictionary";
import { escapeHtml } from "@/lib/html";
import { EMAIL_FONT_STACK } from "@/lib/documentFonts";

export interface MessageLabels {
  subject: string;
  bodyIntro: string;
  waBody: string;
  company: string;
  bank: string;
  email: string;
  whatsapp: string;
  iban: string;
}

export const AR_MESSAGE: MessageLabels = {
  subject: "معلومات الشركة",
  bodyIntro: "تجدون مرفقًا معلومات التواصل والتفاصيل البنكية لشركتنا.",
  waBody: "مرحبًا، إليك معلومات التواصل والتفاصيل البنكية لشركتنا.",
  company: "الشركة",
  bank: "البنك",
  email: "البريد الإلكتروني",
  whatsapp: "واتساب",
  iban: "رقم الآيبان",
};

export const EN_MESSAGE: MessageLabels = {
  subject: "Company information",
  bodyIntro: "Please find attached our company contact and bank details.",
  waBody: "Hello, here are our company contact and bank details.",
  company: "Company",
  bank: "Bank",
  email: "Email",
  whatsapp: "WhatsApp",
  iban: "IBAN",
};

export function messageLabelsFor(locale: Locale): MessageLabels {
  return locale === "ar" ? AR_MESSAGE : EN_MESSAGE;
}

/** Company name in the reader's language, falling back to the other script. */
function companyName(company: Company, locale: Locale): string | null {
  const preferred = locale === "ar" ? company.name_ar : company.name_en;
  return preferred || company.name_en || company.name_ar || null;
}

export function buildEmailBody(
  labels: MessageLabels,
  company: Company,
  portalUrl: string | undefined,
  locale: Locale,
): string {
  // The body carries the locale's own script, so it must carry its direction
  // too — an Arabic body forced to LTR mis-orders punctuation and numbers.
  const dir = locale === "ar" ? "rtl" : "ltr";
  const name = companyName(company, locale);
  const lines = [
    `<div dir="${dir}" style="font-family:${EMAIL_FONT_STACK};color:#0f172a;max-width:560px">`,
    `<h2 style="color:#0f766e;margin:0 0 8px">${escapeHtml(labels.subject)}</h2>`,
    `<p>${escapeHtml(labels.bodyIntro)}</p>`,
    `<table style="border-collapse:collapse;font-size:14px;margin-top:12px">`,
  ];
  if (name) lines.push(row(labels.company, name));
  if (company.email) lines.push(row(labels.email, company.email));
  if (company.whatsapp) lines.push(row(labels.whatsapp, company.whatsapp));
  if (company.bank_name) lines.push(row(labels.bank, company.bank_name));
  // IBAN is always Latin/numeric — pin it LTR even inside an RTL body.
  if (company.iban) lines.push(row(labels.iban, company.iban, true));
  lines.push(`</table>`);
  if (portalUrl)
    lines.push(
      `<p style="margin-top:16px"><a href="${escapeHtml(portalUrl)}">${escapeHtml(portalUrl)}</a></p>`,
    );
  lines.push(`</div>`);
  return lines.join("");
}

/**
 * يفصل نسخة البريد عن واتساب: القالب للإيميل فقط، والتفاصيل المولَّدة لواتساب دائماً.
 *
 * The seed intro says "please find attached". WhatsApp has no attachment
 * support, so using that intro as the WhatsApp body would send a promise
 * and no IBAN. Email still prefers the admin-edited template.
 */
export function resolveCompanyInfoBodies(
  copy: { subject: string | null; body: string | null },
  labels: MessageLabels,
  company: Company,
  portalUrl: string | undefined,
  locale: Locale,
): { emailSubject: string; emailInnerBody: string | null; waBody: string } {
  return {
    emailSubject: copy.subject ?? labels.subject,
    emailInnerBody: copy.body,
    waBody: buildWhatsappBody(labels, company, portalUrl, locale),
  };
}

export function buildWhatsappBody(
  labels: MessageLabels,
  company: Company,
  portalUrl: string | undefined,
  locale: Locale,
): string {
  const parts = [labels.waBody];
  const name = companyName(company, locale);
  if (name) parts.push(`${labels.company}: ${name}`);
  if (company.email) parts.push(`${labels.email}: ${company.email}`);
  if (company.whatsapp) parts.push(`${labels.whatsapp}: ${company.whatsapp}`);
  if (company.bank_name) parts.push(`${labels.bank}: ${company.bank_name}`);
  if (company.iban) parts.push(`${labels.iban}: ${company.iban}`);
  if (portalUrl) parts.push(portalUrl);
  return parts.join("\n");
}

function row(label: string, value: string, ltr = false): string {
  const valueAttrs = ltr
    ? ` dir="ltr" style="padding:6px 0;font-weight:600;text-align:start"`
    : ` style="padding:6px 0;font-weight:600"`;
  return `<tr><td style="padding:6px 16px 6px 0;color:#64748b">${escapeHtml(
    label,
  )}</td><td${valueAttrs}>${escapeHtml(value)}</td></tr>`;
}
