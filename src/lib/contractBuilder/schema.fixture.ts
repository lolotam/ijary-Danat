import {
  EMPTY_COMPANY,
  type ContractBuilderValues,
  type ContractCompany,
  type ContractPerson,
  type ContractPlot,
  type ContractUnitLine,
} from "./schema";
import type { ContractIssuer } from "./issuer";

const FIXTURE_PERSON: ContractPerson = {
  full_name: "شريك محمد خاتم العجمي",
  nationality: "كويتي",
  civil_id: "264010900749",
  residence_address: "النعيم قطعة 1 شارع 17 مبنى 21",
};

export const FIXTURE_PLOT: ContractPlot = {
  id: "11111111-1111-4111-8111-111111111111",
  name_ar: "مجمع دانة الجهراء التجاري -1",
  name_en: "Danat Jahra Commercial Complex -1",
};

const FIXTURE_UNIT: ContractUnitLine = {
  unit_id: "22222222-2222-4222-8222-222222222222",
  property_id: FIXTURE_PLOT.id,
  unit_number: "5",
  unit_number_en: "",
  paci_no: "22023211",
};

export const FIXTURE_COMPANY: ContractCompany = {
  company_name: "شركة أجمل اختيار للتجارة العامة",
  company_address: "الجهراء – القيصرية – مكتب 4",
  signatory_name: "عبدالعزيز علي عباس البو علي",
  signatory_nationality: "كويتي",
  signatory_civil_id: "285010100123",
  signatory_address: "العيون قطعة 3 شارع 5 منزل 12",
};

/**
 * الشركة صاحبة العقد في الاختبارات؛ أطوالها قريبة من ترويسة حقيقية حتى يبقى قياس الصفحات صادقاً.
 */
export const FIXTURE_ISSUER: ContractIssuer = {
  name: "شركة المثال للاستثمار العقاري",
  address: "الكويت – شرق – قطعة 20 – قسيمة 25 – مكتب 9",
  phone: "22223333",
  logoUrl: null,
};

/** صورة PNG بحجم بكسل واحد، تكفي لاختبار مكان الشعار دون ملف حقيقي. */
const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** الطرف الأول نفسه بشعار مضمَّن، كما يصل إلى مولّد PDF. */
export const FIXTURE_ISSUER_WITH_LOGO: ContractIssuer = {
  ...FIXTURE_ISSUER,
  logoUrl: ONE_PIXEL_PNG,
};

/**
 * يعيد وثيقة أفراد صالحة للمخطط الصارم، مع إمكانية تجاوز أي حقل في الاختبار.
 */
export function validContractValues(
  overrides: Partial<ContractBuilderValues> = {},
): ContractBuilderValues {
  return {
    language: "ar",
    contract_date: "2025-07-01",
    second_party_type: "individual",
    persons: [FIXTURE_PERSON],
    company: { ...EMPTY_COMPANY },
    contact_mobile: "+96550001234",
    contact_whatsapp: "",
    contact_email: "tenant@example.test",
    plots: [FIXTURE_PLOT],
    governorate: "الجهراء",
    block: "90",
    parcel: "8",
    units: [FIXTURE_UNIT],
    activity: "البيع بالتجزئة للبطانيات والشراشف والبياضات",
    trade_name: "مؤسسة اجمل اختيار للبيع بالتجزئة",
    duration_months: 36,
    notice_months: 3,
    monthly_value: 2500,
    advance_months: 2,
    grace_months: 2,
    increase: { every_years: 5, percent: 15 },
    late_fee_percent: 5,
    service_charge_monthly: 20,
    ...overrides,
  };
}

/**
 * يعيد وثيقة شركة صالحة يمثلها مفوض بالتوقيع.
 */
export function validCompanyContractValues(
  overrides: Partial<ContractBuilderValues> = {},
): ContractBuilderValues {
  return validContractValues({
    second_party_type: "company",
    persons: [],
    company: FIXTURE_COMPANY,
    ...overrides,
  });
}
