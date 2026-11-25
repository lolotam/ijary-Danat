/**
 * Bilingual CSV headers. Canonical column keys stay English (they are what the
 * import validators understand); when the UI locale is Arabic, exports and
 * import templates render the Arabic label instead, and imported files with
 * Arabic headers are mapped back to the canonical keys before validation.
 */
const HEADER_LABELS_AR: Record<string, string> = {
  code: "الرمز",
  name: "الاسم",
  name_ar: "الاسم بالعربية",
  name_en: "الاسم بالإنجليزية",
  type: "النوع",
  status: "الحالة",
  area: "المساحة",
  floors: "الطوابق",
  address_ar: "العنوان بالعربية",
  address_en: "العنوان بالإنجليزية",
  location_url: "رابط الموقع",
  description_ar: "الوصف بالعربية",
  description_en: "الوصف بالإنجليزية",
  image_url: "رابط الصورة",
  property_code: "رمز العقار",
  building_code: "رمز المبنى",
  unit_code: "رمز الوحدة",
  category_code: "رمز التصنيف",
  property: "العقار",
  building: "المبنى",
  unit: "الوحدة",
  title: "العنوان",
  description: "الوصف",
  priority: "الأولوية",
  category: "التصنيف",
  category_id: "التصنيف",
  class: "الفئة",
  payee: "المستفيد",
  amount: "المبلغ",
  currency: "العملة",
  property_id: "العقار",
  building_id: "المبنى",
  unit_id: "الوحدة",
  cost_center: "مركز التكلفة",
  start_date: "تاريخ البداية",
  end_date: "تاريخ النهاية",
  recurrence: "التكرار",
  expense_date: "تاريخ المصروف",
  note: "ملاحظة",
  notes: "ملاحظات",
  deposit_date: "تاريخ الإيداع",
  bank_name: "اسم البنك",
  lifecycle: "دورة الحياة",
  nationality: "الجنسية",
  preferred_language: "اللغة المفضلة",
  mobile: "الهاتف",
  whatsapp: "واتساب",
  email: "البريد الإلكتروني",
  commercial_name: "الاسم التجاري",
  commercial_name_ar: "الاسم التجاري (عربي)",
  commercial_name_en: "الاسم التجاري (إنجليزي)",
  authorized_manager: "المدير المفوض",
  authorized_manager_civil_id: "رقم مدني للمفوض",
  owner_civil_id: "رقم مدني للمالك",
  commercial_address: "العنوان التجاري",
  tenant_portal_enabled: "بوابة المستأجر مفعلة",
  reminders_enabled: "التذكيرات مفعلة",
  receipt_visible_to_tenant: "الإيصال مرئي للمستأجر",
  electricity_meter_ownership: "ملكية عداد الكهرباء",
  default_rent: "الإيجار الافتراضي",
  tenant: "المستأجر",
  tenant_code: "رمز المستأجر",
  // Contract columns — without these an Arabic template silently falls back to
  // English headers for half its columns.
  state: "الحالة",
  entry_date: "تاريخ الدخول",
  duration_months: "مدة العقد بالأشهر",
  monthly_amount: "الإيجار الشهري",
  deposit: "التأمين",
  due_day: "يوم الاستحقاق",
  grace_days: "أيام السماح",
  contract_code: "رمز العقد",
  payment_date: "تاريخ الدفع",
  period: "الفترة",
  method: "طريقة الدفع",
  reference: "المرجع",
  issue_date: "تاريخ الإصدار",
  due_date: "تاريخ الاستحقاق",
  total: "الإجمالي",
  paid: "المدفوع",
  balance: "الرصيد",
  units: "عدد الوحدات",
  // Export-only columns derived from the tenant's active contract. Their labels
  // must stay distinct from property_code / unit_code / start_date / end_date —
  // HEADER_KEYS_BY_AR inverts this map, so a duplicate label would make one key
  // unreachable on import.
  connected_property_code: "رمز العقار المرتبط",
  connected_unit_code: "رمز الوحدة المرتبطة",
  connected_property_name_ar: "اسم العقار المرتبط بالعربية",
  connected_property_name_en: "اسم العقار المرتبط بالإنجليزية",
  connected_unit_name_ar: "اسم الوحدة المرتبطة بالعربية",
  connected_unit_name_en: "اسم الوحدة المرتبطة بالإنجليزية",
  active_contract_start_date: "تاريخ بداية العقد الساري",
  active_contract_end_date: "تاريخ نهاية العقد الساري",
  // Contract export columns that were previously missing Arabic labels and
  // silently fell back to English keys on Arabic CSV downloads.
  tenant_name: "اسم المستأجر",
  unit_name: "اسم الوحدة",
  property_name_ar: "اسم العقار بالعربية",
  property_name_en: "اسم العقار بالإنجليزية",
  concession_months: "أشهر الإعفاء",
  end_date_override_reason: "سبب تجاوز تاريخ النهاية",
  created_at: "تاريخ الإنشاء",
  updated_at: "تاريخ التحديث",
  // Multi-unit contract export (one row per unit).
  unit_line_order: "ترتيب الوحدة",
  unit_monthly_amount: "إيجار الوحدة الشهري",
  // Multi-contract tenant export (one row per contract). Labels stay distinct
  // from monthly_amount / start_date / end_date so HEADER_KEYS_BY_AR remains
  // injective — a shared Arabic label would make one key unreachable on import.
  contract_index: "رقم العقد التسلسلي",
  contract_state: "حالة العقد",
  contract_start_date: "بداية العقد",
  contract_end_date: "نهاية العقد",
  // Distinct from monthly_amount ("الإيجار الشهري") deliberately.
  contract_monthly_amount: "إيجار العقد الشهري",
};

const HEADER_KEYS_BY_AR = new Map(
  Object.entries(HEADER_LABELS_AR).map(([key, label]) => [label, key]),
);

export type CsvLocale = "ar" | "en";

export function localizeCsvHeader(key: string, locale: CsvLocale): string {
  return locale === "ar" ? (HEADER_LABELS_AR[key] ?? key) : key;
}

/** Rename row keys to the localized header labels (export direction). */
export function localizeCsvRows(
  rows: Array<Record<string, unknown>>,
  locale: CsvLocale,
): Array<Record<string, unknown>> {
  if (locale !== "ar") return rows;
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [localizeCsvHeader(key, "ar"), value]),
    ),
  );
}

/** Map Arabic (or unknown) headers back to canonical keys (import direction). */
export function canonicalizeCsvRows<T extends Record<string, string>>(rows: T[]): T[] {
  return rows.map(
    (row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          HEADER_KEYS_BY_AR.get(key.trim()) ?? key,
          value,
        ]),
      ) as T,
  );
}
