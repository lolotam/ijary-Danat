import { z } from "zod";

import type { Company, CompanyUpdate } from "@/hooks/useCompany";

const nullableFields = [
  "logo_url",
  "favicon_url",
  "email",
  "phone",
  "whatsapp",
  "address_ar",
  "address_en",
  "map_url",
  "iban",
  "bank_name",
  "bank_logo_url",
  "facebook_url",
  "instagram_url",
  "invoice_footer_ar",
  "invoice_footer_en",
  "brand_primary",
  "brand_accent",
  "announcement_ar",
  "announcement_en",
] as const;

/**
 * يبني مخطط Zod لنموذج إعدادات الشركة برسائل خطأ مترجمة.
 */
export function makeSettingsSchema(messages: {
  required: string;
  invalidEmail: string;
  invalidUrl: string;
}) {
  const optionalUrl = z
    .string()
    .trim()
    .refine((value) => !value || /^https?:\/\/.+/i.test(value), messages.invalidUrl);

  return z.object({
    name_ar: z.string().trim().min(1, messages.required),
    name_en: z.string().trim().min(1, messages.required),
    logo_url: optionalUrl,
    favicon_url: optionalUrl,
    email: z
      .string()
      .trim()
      .refine(
        (value) => !value || z.string().email().safeParse(value).success,
        messages.invalidEmail,
      ),
    phone: z.string(),
    whatsapp: z.string(),
    address_ar: z.string(),
    address_en: z.string(),
    map_url: optionalUrl,
    iban: z.string(),
    bank_name: z.string(),
    bank_logo_url: optionalUrl,
    facebook_url: optionalUrl,
    instagram_url: optionalUrl,
    invoice_footer_ar: z.string(),
    invoice_footer_en: z.string(),
    brand_primary: z.string(),
    brand_accent: z.string(),
    default_locale: z.enum(["ar", "en"]),
    timezone: z.string().trim().min(1, messages.required),
    currency: z.string().trim().min(1, messages.required),
    announcement_enabled: z.boolean(),
    announcement_ar: z.string(),
    announcement_en: z.string(),
    portal_apple_pay_enabled: z.boolean(),
    portal_google_pay_enabled: z.boolean(),
  });
}

export type SettingsFormValues = z.infer<ReturnType<typeof makeSettingsSchema>>;

export const emptyValues: SettingsFormValues = {
  name_ar: "",
  name_en: "",
  logo_url: "",
  favicon_url: "",
  email: "",
  phone: "",
  whatsapp: "",
  address_ar: "",
  address_en: "",
  map_url: "",
  iban: "",
  bank_name: "",
  bank_logo_url: "",
  facebook_url: "",
  instagram_url: "",
  invoice_footer_ar: "",
  invoice_footer_en: "",
  brand_primary: "",
  brand_accent: "",
  default_locale: "ar",
  timezone: "Asia/Kuwait",
  currency: "KWD",
  announcement_enabled: false,
  announcement_ar: "",
  announcement_en: "",
  // Both on, matching the column defaults in migration 145 — an empty form must
  // not read as "the admin switched these off".
  portal_apple_pay_enabled: true,
  portal_google_pay_enabled: true,
};

/**
 * يحوّل صف الشركة من قاعدة البيانات إلى قيم نموذج الإعدادات (فراغ بدل null).
 */
export function companyFormValues(company: Company): SettingsFormValues {
  return {
    ...emptyValues,
    ...company,
    logo_url: company.logo_url ?? "",
    favicon_url: company.favicon_url ?? "",
    email: company.email ?? "",
    phone: company.phone ?? "",
    whatsapp: company.whatsapp ?? "",
    address_ar: company.address_ar ?? "",
    address_en: company.address_en ?? "",
    map_url: company.map_url ?? "",
    iban: company.iban ?? "",
    bank_name: company.bank_name ?? "",
    bank_logo_url: company.bank_logo_url ?? "",
    facebook_url: company.facebook_url ?? "",
    instagram_url: company.instagram_url ?? "",
    invoice_footer_ar: company.invoice_footer_ar ?? "",
    invoice_footer_en: company.invoice_footer_en ?? "",
    brand_primary: company.brand_primary ?? "",
    brand_accent: company.brand_accent ?? "",
    announcement_enabled: company.announcement_enabled ?? false,
    announcement_ar: company.announcement_ar ?? "",
    announcement_en: company.announcement_en ?? "",
    portal_apple_pay_enabled: company.portal_apple_pay_enabled ?? true,
    portal_google_pay_enabled: company.portal_google_pay_enabled ?? true,
  };
}

/**
 * يجهّز حقول النموذج للتحديث: السلاسل الفارغة تصبح null للأعمدة الاختيارية.
 */
export function companyUpdate(values: SettingsFormValues): CompanyUpdate {
  const updates = { ...values } as Record<string, string | number | boolean | null>;
  for (const field of nullableFields) updates[field] = values[field].trim() || null;
  return updates;
}
