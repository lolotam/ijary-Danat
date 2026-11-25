/**
 * Composes the message body stored for a "General request" submitted through the
 * landing form.
 *
 * The landing form is one form serving two destinations. A leasing request goes
 * to `leasing_inquiries`, which has a column for every field. A general request
 * goes to `contact_inquiries`, which has only name / phone / email / subject /
 * message (`db/migrations/10_contact_inquiries.sql`). Before this helper existed
 * the general branch simply dropped company name, business activity, preferred
 * size, and preferred contact method — a visitor filled them in, saw a success
 * screen, and the data reached no table.
 *
 * Rather than widen `contact_inquiries` for a free-text side channel, the extra
 * answers are appended to the message under localized labels. Nothing the
 * visitor typed is lost, and the Inbox renders it as written.
 *
 * Lives in src/lib so it can be unit tested without loading the route.
 */

import type { Locale } from "@/i18n/dictionary";

export interface GeneralRequestDetails {
  message?: string | null;
  companyName?: string | null;
  businessActivity?: string | null;
  preferredSize?: string | null;
  preferredContactMethod?: string | null;
}

interface DetailLabels {
  companyName: string;
  businessActivity: string;
  preferredSize: string;
  preferredContactMethod: string;
  contactMethod: Record<string, string>;
}

const AR_LABELS: DetailLabels = {
  companyName: "الشركة",
  businessActivity: "النشاط التجاري",
  preferredSize: "المساحة المطلوبة",
  preferredContactMethod: "طريقة التواصل المفضلة",
  contactMethod: { phone: "هاتف", email: "بريد إلكتروني", whatsapp: "واتساب" },
};

const EN_LABELS: DetailLabels = {
  companyName: "Company",
  businessActivity: "Business activity",
  preferredSize: "Preferred size",
  preferredContactMethod: "Preferred contact method",
  contactMethod: { phone: "Phone", email: "Email", whatsapp: "WhatsApp" },
};

export function detailLabelsFor(locale: Locale): DetailLabels {
  return locale === "ar" ? AR_LABELS : EN_LABELS;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Builds the stored message. The visitor's own text comes first; the structured
 * answers follow as `Label: value` lines, and are omitted entirely when blank so
 * a bare message never gains a trailing separator.
 *
 * react-hook-form keeps values for fields that have been unmounted, so a visitor
 * who fills the leasing-only fields and then switches to "General request" still
 * has them in form state. Appending them here is what makes "nothing is
 * discarded" literally true rather than approximately true.
 */
export function composeGeneralRequestMessage(
  details: GeneralRequestDetails,
  locale: Locale,
): string {
  const labels = detailLabelsFor(locale);
  const contactMethod = clean(details.preferredContactMethod);

  const lines = [
    [labels.companyName, clean(details.companyName)],
    [labels.businessActivity, clean(details.businessActivity)],
    [labels.preferredSize, clean(details.preferredSize)],
    [
      labels.preferredContactMethod,
      contactMethod ? (labels.contactMethod[contactMethod] ?? contactMethod) : null,
    ],
  ]
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([label, value]) => `${label}: ${value}`);

  const message = clean(details.message);
  if (!lines.length) return message ?? "";
  return message ? `${message}\n\n${lines.join("\n")}` : lines.join("\n");
}
