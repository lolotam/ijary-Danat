import { z } from "zod";

import type { TenantCategory, TenantRow } from "@/integrations/supabase/database.types";

/**
 * يحول سلسلة فارغة إلى null حتى لا تُكتب قيم فارغة في الأعمدة الاختيارية.
 *
 * Empty boxes mean "unset", not an empty string — the CSV and the detail page
 * both treat null as absent.
 */
export function nullableText(value: string): string | null {
  return value.trim() || null;
}

export const tenantFormSchema = z.object({
  name: z.string().trim().min(1),
  name_en: z.string(),
  owner_civil_id: z.string(),
  category: z.enum(["vip", "uncommitted", "chronically_distressed", "standard", "custom"]),
  nationality: z.string(),
  preferred_language: z.enum(["ar", "en"]),
  mobile: z.string(),
  whatsapp: z.string(),
  email: z.string().refine((value) => !value || z.string().email().safeParse(value).success),
  // Migration 140 split the single commercial name in two. Required by the
  // form (the product decision), not by the database: most tenants are
  // individuals with no trade name and a NOT NULL would need a placeholder
  // invented for every one of them — which would then print on their invoices.
  commercial_name_ar: z.string().trim().min(1),
  commercial_name_en: z.string().trim().min(1),
  authorized_manager: z.string(),
  authorized_manager_civil_id: z.string(),
  commercial_address: z.string(),
  reminders_enabled: z.boolean(),
  notifications_paused: z.boolean(),
  receipt_visible_to_tenant: z.boolean(),
  tenant_portal_enabled: z.boolean(),
  // Portal tab overrides — nullable so "follow the tenant role permission"
  // stays distinct from "always hide". See lib/portalTabs.
  portal_tab_dashboard: z.boolean().nullable(),
  portal_tab_lease: z.boolean().nullable(),
  portal_tab_invoices: z.boolean().nullable(),
  portal_tab_payments: z.boolean().nullable(),
  portal_tab_profile: z.boolean().nullable(),
  portal_tab_shop: z.boolean().nullable(),
  notes: z.string(),
});

export type TenantFormValues = z.infer<typeof tenantFormSchema>;

export const tenantFormDefaults: TenantFormValues = {
  name: "",
  name_en: "",
  owner_civil_id: "",
  category: "standard",
  nationality: "",
  preferred_language: "ar",
  mobile: "",
  whatsapp: "",
  email: "",
  commercial_name_ar: "",
  commercial_name_en: "",
  authorized_manager: "",
  authorized_manager_civil_id: "",
  commercial_address: "",
  reminders_enabled: true,
  notifications_paused: false,
  receipt_visible_to_tenant: false,
  tenant_portal_enabled: false,
  // null = inherit the tenant role permission; a new tenant overrides nothing.
  portal_tab_dashboard: null,
  portal_tab_lease: null,
  portal_tab_invoices: null,
  portal_tab_payments: null,
  portal_tab_profile: null,
  portal_tab_shop: null,
  notes: "",
};

export const tenantCategories: TenantCategory[] = [
  "vip",
  "uncommitted",
  "chronically_distressed",
  "standard",
  "custom",
];

/** Slice of a tenant row the form can reset from — narrower than the list row. */
export type TenantFormSource = Pick<
  TenantRow,
  | "name"
  | "name_en"
  | "owner_civil_id"
  | "category"
  | "nationality"
  | "preferred_language"
  | "mobile"
  | "whatsapp"
  | "email"
  | "commercial_name"
  | "commercial_name_ar"
  | "commercial_name_en"
  | "authorized_manager"
  | "authorized_manager_civil_id"
  | "commercial_address"
  | "reminders_enabled"
  | "notifications_paused"
  | "receipt_visible_to_tenant"
  | "tenant_portal_enabled"
  | "portal_tab_dashboard"
  | "portal_tab_lease"
  | "portal_tab_invoices"
  | "portal_tab_payments"
  | "portal_tab_profile"
  | "portal_tab_shop"
  | "notes"
>;

/**
 * يبني قيم النموذج عند الفتح: إنشاء جديد أو تعبئة صف قائم للتعديل.
 *
 * Extracted so the dialog and its tests share one reset path. A pre-140 row
 * still has `commercial_name` only — that value fills the required Arabic box
 * so edit does not open with a blank required field.
 *
 * `owner_name` and `alternate_contacts` stay on the row (migration 149 retired
 * them unread) and are deliberately not copied here, so a save cannot write
 * them back.
 */
export function resolveTenantFormValues(editing: TenantFormSource | null): TenantFormValues {
  if (!editing) return tenantFormDefaults;
  return {
    name: editing.name,
    name_en: editing.name_en ?? "",
    owner_civil_id: editing.owner_civil_id ?? "",
    category: editing.category,
    nationality: editing.nationality ?? "",
    preferred_language: editing.preferred_language,
    mobile: editing.mobile ?? "",
    whatsapp: editing.whatsapp ?? "",
    email: editing.email ?? "",
    commercial_name_ar: editing.commercial_name_ar ?? editing.commercial_name ?? "",
    commercial_name_en: editing.commercial_name_en ?? "",
    authorized_manager: editing.authorized_manager ?? "",
    authorized_manager_civil_id: editing.authorized_manager_civil_id ?? "",
    commercial_address: editing.commercial_address ?? "",
    reminders_enabled: editing.reminders_enabled,
    notifications_paused: editing.notifications_paused,
    receipt_visible_to_tenant: editing.receipt_visible_to_tenant,
    tenant_portal_enabled: editing.tenant_portal_enabled,
    // ?? null keeps a legacy row with the column absent on "inherit"
    // rather than coercing it to false, which would hide the tab.
    portal_tab_dashboard: editing.portal_tab_dashboard ?? null,
    portal_tab_lease: editing.portal_tab_lease ?? null,
    portal_tab_invoices: editing.portal_tab_invoices ?? null,
    portal_tab_payments: editing.portal_tab_payments ?? null,
    portal_tab_profile: editing.portal_tab_profile ?? null,
    portal_tab_shop: editing.portal_tab_shop ?? null,
    notes: editing.notes ?? "",
  };
}

export type TenantSubmitPayload = {
  company_id: string | null;
  name: string;
  name_en: string | null;
  owner_civil_id: string | null;
  category: TenantCategory;
  nationality: string | null;
  preferred_language: "ar" | "en";
  mobile: string | null;
  whatsapp: string | null;
  email: string | null;
  commercial_name_ar: string | null;
  commercial_name_en: string | null;
  authorized_manager: string | null;
  authorized_manager_civil_id: string | null;
  commercial_address: string | null;
  reminders_enabled: boolean;
  notifications_paused: boolean;
  receipt_visible_to_tenant: boolean;
  tenant_portal_enabled: boolean;
  portal_tab_dashboard: boolean | null;
  portal_tab_lease: boolean | null;
  portal_tab_invoices: boolean | null;
  portal_tab_payments: boolean | null;
  portal_tab_profile: boolean | null;
  portal_tab_shop: boolean | null;
  notes: string | null;
};

/**
 * يبني حمولة الإضافة/التعديل من قيم النموذج دون الأعمدة التي يولّدها الخادم.
 *
 * Built field-by-field (not `{...values}` then override) so a form-only string
 * cannot leak into the insert as the wrong type. The retired `owner_name` and
 * `alternate_contacts` columns are omitted on purpose — writing them again
 * would re-animate fields the form no longer shows.
 */
export function buildTenantSubmitPayload(
  values: TenantFormValues,
  companyId: string | null,
): TenantSubmitPayload {
  return {
    company_id: companyId,
    name: values.name,
    name_en: nullableText(values.name_en),
    owner_civil_id: nullableText(values.owner_civil_id),
    category: values.category,
    nationality: nullableText(values.nationality),
    preferred_language: values.preferred_language,
    mobile: nullableText(values.mobile),
    whatsapp: nullableText(values.whatsapp),
    email: nullableText(values.email),
    commercial_name_ar: nullableText(values.commercial_name_ar),
    commercial_name_en: nullableText(values.commercial_name_en),
    authorized_manager: nullableText(values.authorized_manager),
    authorized_manager_civil_id: nullableText(values.authorized_manager_civil_id),
    commercial_address: nullableText(values.commercial_address),
    reminders_enabled: values.reminders_enabled,
    notifications_paused: values.notifications_paused,
    receipt_visible_to_tenant: values.receipt_visible_to_tenant,
    tenant_portal_enabled: values.tenant_portal_enabled,
    portal_tab_dashboard: values.portal_tab_dashboard,
    portal_tab_lease: values.portal_tab_lease,
    portal_tab_invoices: values.portal_tab_invoices,
    portal_tab_payments: values.portal_tab_payments,
    portal_tab_profile: values.portal_tab_profile,
    portal_tab_shop: values.portal_tab_shop,
    notes: nullableText(values.notes),
  };
}
