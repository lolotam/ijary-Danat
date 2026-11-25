import { z } from "zod";

import { isRealCalendarDate } from "./numberToWords";

export type ContractLocale = "ar" | "en";

export type ContractPerson = {
  full_name: string;
  nationality: string;
  civil_id: string;
  residence_address: string;
};

/** نوع الطرف الثاني: أفراد (حتى ثلاثة أشخاص) أو شركة يمثلها مفوض بالتوقيع. */
export type SecondPartyType = "individual" | "company";

export type ContractCompany = {
  company_name: string;
  company_address: string;
  signatory_name: string;
  signatory_nationality: string;
  signatory_civil_id: string;
  signatory_address: string;
};

/**
 * قسيمة (عقار) مختارة، باسمها وقت الاختيار.
 *
 * The names are a snapshot because the PDF is rendered on the server from the
 * form values alone, with no database read: the clause that groups units by
 * plot needs each plot's printed name in both languages.
 */
export type ContractPlot = {
  id: string;
  name_ar: string;
  name_en: string;
};

export type ContractUnitLine = {
  unit_id: string;
  property_id: string;
  /** اسم الوحدة المطبوع في النسخة العربية، من `units.name`. */
  unit_number: string;
  /** اسم الوحدة في النسخة الإنجليزية، من `units.name_en`؛ الفارغ يرجع إلى العربي. */
  unit_number_en: string;
  /** الرقم الآلي من `units.paci_no`، ويجوز للمشغّل تعديله أو إدخاله يدوياً. */
  paci_no: string;
};

export type ContractBuilderValues = {
  language: ContractLocale;
  contract_date: string;
  second_party_type: SecondPartyType;
  persons: ContractPerson[];
  company: ContractCompany;
  /**
   * بيانات تواصل لإنشاء حساب المستأجر وسجلاته فقط — لا تُطبع في العقد أبداً.
   *
   * `buildContractHtml` never reads these; html.test.ts pins that none of
   * them reaches the rendered document in either language.
   */
  contact_mobile: string;
  contact_whatsapp: string;
  contact_email: string;
  plots: ContractPlot[];
  governorate: string;
  block: string;
  parcel: string;
  units: ContractUnitLine[];
  activity: string;
  trade_name: string;
  duration_months: number;
  notice_months: number;
  monthly_value: number;
  advance_months: number;
  grace_months: number;
  increase: { every_years: number; percent: number } | null;
  late_fee_percent: number;
  service_charge_monthly: number;
};

/**
 * حدود المحتوى: الوثيقة خمس صفحات A4 ثابتة، وكل حد هنا مُقاس بعرض حقيقي
 * على Chromium حتى تبقى خمس صفحات عند امتلاء كل الحقول.
 *
 * `code` covers PACI numbers: unbreakable digit runs that repeat in the
 * preamble and clause 2. `unitName` is a unit's printed label — production
 * names such as "جهة تجارية الدور الأول - 10" run to 27 characters (30 in
 * English), so it cannot share the 16-character code limit. `name` and `address` are person and company
 * fields, `place` the governorate/block/parcel, `longText` the activity and
 * trade name. `plots` is the number of plots the company owns.
 */
export const CONTRACT_LIMITS = {
  persons: 3,
  plots: 10,
  units: 6,
  code: 16,
  unitName: 32,
  name: 48,
  place: 24,
  address: 72,
  longText: 88,
  months: 600,
  /** أقصى قيمة شهرية: مليون دينار ناقص فلساً، فيبقى الإجمالي دون المليار المدعوم في التفقيط. */
  monthlyMax: 999_999.999,
} as const;

/** الرقم المدني الكويتي: اثنتا عشرة خانة بالضبط. */
const CIVIL_ID = /^\d{12}$/;

/** رقم دولي بصيغة E.164: علامة + ثم ثماني إلى خمس عشرة خانة لا تبدأ بصفر. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * أقصى طول لكل حقل نصي، بمفتاح اسم الحقل، حتى تفرض الواجهة نفس حدود المخطط.
 */
export const FIELD_MAX_LENGTH = {
  full_name: CONTRACT_LIMITS.name,
  nationality: CONTRACT_LIMITS.name,
  civil_id: 12,
  residence_address: CONTRACT_LIMITS.address,
  company_name: CONTRACT_LIMITS.name,
  company_address: CONTRACT_LIMITS.address,
  signatory_name: CONTRACT_LIMITS.name,
  signatory_nationality: CONTRACT_LIMITS.name,
  signatory_civil_id: 12,
  signatory_address: CONTRACT_LIMITS.address,
  contact_mobile: 16,
  contact_whatsapp: 16,
  contact_email: 254,
  governorate: CONTRACT_LIMITS.place,
  block: CONTRACT_LIMITS.place,
  parcel: CONTRACT_LIMITS.place,
  unit_number: CONTRACT_LIMITS.unitName,
  unit_number_en: CONTRACT_LIMITS.unitName,
  paci_no: CONTRACT_LIMITS.code,
  activity: CONTRACT_LIMITS.longText,
  trade_name: CONTRACT_LIMITS.longText,
} as const;

export const EMPTY_PERSON: ContractPerson = {
  full_name: "",
  nationality: "",
  civil_id: "",
  residence_address: "",
};

export const EMPTY_COMPANY: ContractCompany = {
  company_name: "",
  company_address: "",
  signatory_name: "",
  signatory_nationality: "",
  signatory_civil_id: "",
  signatory_address: "",
};

/**
 * يقبل عدداً يمثل فلوساً بثلاث خانات فقط، لتفادي بقايا الفاصلة العائمة.
 *
 * The decimal text is authoritative, not the float: 12.345 is exact to three
 * places while 12.3450000001 is not, and a float tolerance cannot tell them
 * apart (both land within 1e-6 of an integer number of fils).
 */
function hasFilsPrecision(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const decimals = String(value).split(".")[1] ?? "";
  return !decimals.includes("e") && decimals.length <= 3;
}

/**
 * يعرض مبلغاً بالفلس كنص دينار بثلاث خانات دون بقايا الفاصلة العائمة.
 *
 * 0.1 × 3 is 0.30000000000000004 in binary floating point; the printed
 * contract must never show that, so every printed amount goes through fils.
 */
export function formatKwdFromFils(fils: number): string {
  const sign = fils < 0 ? "-" : "";
  const abs = Math.abs(Math.round(fils));
  return `${sign}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, "0")}`;
}

/**
 * نص مطبوع إلزامي: يرفض القيمة المكوّنة من مسافات فقط.
 *
 * `.min(1)` counts a pasted run of spaces as filled, which would print a
 * visually blank name or address on a signed contract. A refine rather than
 * `.trim()` so the schema validates without rewriting what was typed.
 */
function requiredText(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0);
}

const personSchema = z.object({
  full_name: requiredText(CONTRACT_LIMITS.name),
  nationality: requiredText(CONTRACT_LIMITS.name),
  civil_id: z.string().regex(CIVIL_ID),
  residence_address: requiredText(CONTRACT_LIMITS.address),
});

const personsSchema = z.array(personSchema).min(1).max(CONTRACT_LIMITS.persons);

const companySchema = z.object({
  company_name: requiredText(CONTRACT_LIMITS.name),
  company_address: requiredText(CONTRACT_LIMITS.address),
  signatory_name: requiredText(CONTRACT_LIMITS.name),
  signatory_nationality: requiredText(CONTRACT_LIMITS.name),
  signatory_civil_id: z.string().regex(CIVIL_ID),
  signatory_address: requiredText(CONTRACT_LIMITS.address),
});

const plotSchema = z.object({
  id: z.string().min(1),
  name_ar: z.string().max(CONTRACT_LIMITS.name),
  name_en: z.string().max(CONTRACT_LIMITS.name),
});

const unitSchema = z.object({
  unit_id: z.string().min(1),
  property_id: z.string().min(1),
  unit_number: requiredText(CONTRACT_LIMITS.unitName),
  unit_number_en: z.string().max(CONTRACT_LIMITS.unitName),
  paci_no: z.string().max(CONTRACT_LIMITS.code),
});

const draftPersonSchema = z.object({
  full_name: z.string(),
  nationality: z.string(),
  civil_id: z.string(),
  residence_address: z.string(),
});

const draftCompanySchema = z.object({
  company_name: z.string(),
  company_address: z.string(),
  signatory_name: z.string(),
  signatory_nationality: z.string(),
  signatory_civil_id: z.string(),
  signatory_address: z.string(),
});

const draftUnitSchema = z.object({
  unit_id: z.string(),
  property_id: z.string(),
  unit_number: z.string(),
  unit_number_en: z.string(),
  paci_no: z.string(),
});

const increaseSchema = z.object({
  every_years: z.number().int().min(1).max(10),
  percent: z.number().positive().max(100),
});

const draftNumber = z.number().or(z.nan());

/**
 * يتحقق من الطرف الثاني بحسب نوعه، ويترك بيانات النوع الآخر دون تحقق.
 *
 * A flat object with a mode switch rather than a Zod union: react-hook-form's
 * field paths and `useFieldArray("persons")` need one stable shape, and an
 * operator flipping the mode back must find what they typed still there. So
 * the inactive branch is carried as an unchecked draft and only the active
 * branch is validated, with each issue reported at its real field path.
 */
function refineSecondParty(
  value: Pick<ContractBuilderValues, "second_party_type" | "persons" | "company">,
  ctx: z.RefinementCtx,
): void {
  const [path, result] =
    value.second_party_type === "individual"
      ? (["persons", personsSchema.safeParse(value.persons)] as const)
      : (["company", companySchema.safeParse(value.company)] as const);
  if (result.success) return;
  for (const issue of result.error.issues) {
    ctx.addIssue({ ...issue, path: [path, ...issue.path] } as z.IssueData);
  }
}

/**
 * يتحقق من أن كل وحدة تتبع قسيمة مختارة، حتى لا تُطبع وحدة من قسيمة أُزيلت.
 */
function refineUnitsBelongToPlots(
  value: Pick<ContractBuilderValues, "plots" | "units">,
  ctx: z.RefinementCtx,
): void {
  const plotIds = new Set(value.plots.map((plot) => plot.id));
  value.units.forEach((unit, index) => {
    if (!plotIds.has(unit.property_id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["units", index, "property_id"] });
    }
  });
}

/**
 * المخطط الصارم: وثيقة جاهزة للتنزيل، ترفض المسودة والقيم الناقصة.
 */
export const contractBuilderSchema = z
  .object({
    language: z.enum(["ar", "en"]),
    contract_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isRealCalendarDate),
    second_party_type: z.enum(["individual", "company"]),
    persons: z.array(draftPersonSchema).max(CONTRACT_LIMITS.persons),
    company: draftCompanySchema,
    contact_mobile: z.string().regex(E164),
    contact_whatsapp: z.string().regex(E164).or(z.literal("")),
    contact_email: z.string().email().max(FIELD_MAX_LENGTH.contact_email),
    plots: z.array(plotSchema).min(1).max(CONTRACT_LIMITS.plots),
    governorate: requiredText(CONTRACT_LIMITS.place),
    block: requiredText(CONTRACT_LIMITS.place),
    parcel: requiredText(CONTRACT_LIMITS.place),
    units: z.array(unitSchema).min(1).max(CONTRACT_LIMITS.units),
    activity: requiredText(CONTRACT_LIMITS.longText),
    trade_name: requiredText(CONTRACT_LIMITS.longText),
    duration_months: z.number().int().min(1).max(CONTRACT_LIMITS.months),
    notice_months: z.number().int().min(0).max(24),
    monthly_value: z.number().positive().max(CONTRACT_LIMITS.monthlyMax).refine(hasFilsPrecision),
    advance_months: z.number().int().min(0).max(24),
    grace_months: z.number().int().min(0).max(24),
    increase: increaseSchema.nullable(),
    late_fee_percent: z.number().min(0).max(100),
    service_charge_monthly: z.number().min(0).refine(hasFilsPrecision),
  })
  .strict()
  .superRefine(refineSecondParty)
  .superRefine(refineUnitsBelongToPlots) satisfies z.ZodType<ContractBuilderValues>;

/**
 * مخطط المسودة: نفس الشكل مع حقول فارغة وأرقام NaN حتى تُرسم المعاينة الحية.
 */
export const contractBuilderDraftSchema: z.ZodType<ContractBuilderValues> = z.object({
  language: z.enum(["ar", "en"]),
  contract_date: z.string(),
  second_party_type: z.enum(["individual", "company"]),
  persons: z.array(draftPersonSchema).max(CONTRACT_LIMITS.persons),
  company: draftCompanySchema,
  contact_mobile: z.string(),
  contact_whatsapp: z.string(),
  contact_email: z.string(),
  // No name limit in the draft: an overlong property name must surface as a
  // strict-schema error in the picker, not blank the live preview.
  plots: z
    .array(z.object({ id: z.string(), name_ar: z.string(), name_en: z.string() }))
    .max(CONTRACT_LIMITS.plots),
  governorate: z.string(),
  block: z.string(),
  parcel: z.string(),
  units: z.array(draftUnitSchema).max(CONTRACT_LIMITS.units),
  activity: z.string(),
  trade_name: z.string(),
  duration_months: draftNumber,
  notice_months: draftNumber,
  monthly_value: draftNumber,
  advance_months: draftNumber,
  grace_months: draftNumber,
  increase: z.object({ every_years: draftNumber, percent: draftNumber }).nullable(),
  late_fee_percent: draftNumber,
  service_charge_monthly: draftNumber,
});

/**
 * قيم ابتدائية للشاشة: مسودة وليست وثيقة صالحة.
 */
export const contractBuilderDefaults: ContractBuilderValues = {
  language: "ar",
  contract_date: "",
  second_party_type: "individual",
  persons: [{ ...EMPTY_PERSON }],
  company: { ...EMPTY_COMPANY },
  contact_mobile: "",
  contact_whatsapp: "",
  contact_email: "",
  plots: [],
  governorate: "",
  block: "",
  parcel: "",
  units: [],
  activity: "",
  trade_name: "",
  duration_months: Number.NaN,
  notice_months: 3,
  monthly_value: Number.NaN,
  advance_months: 2,
  grace_months: 2,
  increase: null,
  late_fee_percent: 5,
  service_charge_monthly: 20,
};

/**
 * يحوّل دنانير كويتية إلى فلوس صحيحة بالتقريب.
 */
export function toFils(kwd: number): number {
  return Math.round(kwd * 1000);
}

/**
 * يحسب إجمالي قيمة العقد بالفلوس: الشهري × مدة الأشهر.
 */
export function totalValueFils(
  values: Pick<ContractBuilderValues, "monthly_value" | "duration_months">,
): number {
  return toFils(values.monthly_value) * values.duration_months;
}
