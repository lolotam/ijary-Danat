import { z } from "zod";

import { contactSchema, type SubmitContactInquiryInput } from "@/fns/submitContactInquiry";
import { leasingSchema, type SubmitLeasingInquiryInput } from "@/fns/submitLeasingInquiry";
import type { Locale } from "@/i18n/dictionary";
import { composeGeneralRequestMessage } from "@/lib/contactMessageBody";

/**
 * يبني مخطط التحقق لنموذج الاستفسار في الصفحة العامة من مخططَي الخادم نفسيهما.
 *
 * One form feeds two server functions, and it used to carry its own third
 * schema with no length caps (audit M23). A general request then passed the
 * form and was rejected by the server once the appended details pushed the
 * message past 2,000 characters — surfacing as the generic error card, not on
 * the textarea. Deriving from `leasingSchema` gives every shared field the
 * server's caps; the general branch is checked against `contactSchema`'s own
 * `message` rule, applied to the message exactly as it will be sent.
 *
 * The honeypot stays unconstrained here on purpose: a human whose browser
 * autofills the hidden field should reach the server's rejection and see the
 * error card, not a form that silently refuses to submit.
 */
export function landingInquirySchema(locale: Locale) {
  return leasingSchema
    .omit({ locale: true, source: true })
    .extend({
      request_type: z.enum(["leasing", "general"]),
      consent: z.boolean().refine((val) => val === true, "Consent is required"),
      website: z.string().optional(),
    })
    .superRefine((values, ctx) => {
      if (values.request_type !== "general") return;
      const sent = contactSchema.shape.message.safeParse(generalRequestMessage(values, locale));
      if (!sent.success) {
        ctx.addIssue({ code: "custom", path: ["message"], message: sent.error.issues[0].message });
      }
    });
}

export type LandingInquiryValues = z.infer<ReturnType<typeof landingInquirySchema>>;

/**
 * يجمع نص رسالة الطلب العام كما سيُحفظ، مع التفاصيل الملحقة.
 */
function generalRequestMessage(values: LandingInquiryValues, locale: Locale): string {
  return composeGeneralRequestMessage(
    {
      message: values.message,
      companyName: values.company_name,
      businessActivity: values.business_activity,
      preferredSize: values.preferred_size,
      preferredContactMethod: values.preferred_contact_method,
    },
    locale,
  );
}

/**
 * يحوّل قيم النموذج إلى بيانات استفسار تواصل عام ترسل إلى submitContactInquiry.
 *
 * contact_inquiries has no columns for the structured answers, so they are
 * appended to the message rather than dropped.
 */
export function toContactInquiry(
  values: LandingInquiryValues,
  locale: Locale,
  subject: string,
): SubmitContactInquiryInput {
  return {
    name: values.name,
    email: values.email,
    phone: values.phone,
    subject,
    message: generalRequestMessage(values, locale),
    website: values.website,
  };
}

/**
 * يحوّل قيم النموذج إلى بيانات طلب تأجير ترسل إلى submitLeasingInquiry.
 */
export function toLeasingInquiry(
  values: LandingInquiryValues,
  locale: Locale,
): SubmitLeasingInquiryInput {
  return {
    name: values.name,
    company_name: values.company_name,
    business_activity: values.business_activity,
    phone: values.phone,
    email: values.email,
    preferred_size: values.preferred_size,
    preferred_contact_method: values.preferred_contact_method,
    message: values.message,
    locale,
    source: "public_landing",
    website: values.website,
  };
}
