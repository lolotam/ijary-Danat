import { describe, expect, it } from "vitest";

import {
  ALWAYS_ON_PERMISSIONS,
  MODULE_KEYS,
  PERMISSION_LESS_SECTIONS,
  PERMISSION_SECTION,
  sectionOfPermission,
  type ModuleKey,
} from "@/company/modules";
import { PERMISSION_CODES, type PermissionCode } from "@/lib/permissions";

/**
 * خريطة رمز الصلاحية → القسم الذي يفتحه ويقفله: اختباران يجيبان عن سؤالين.
 *
 * الأول: كل رمز في كتالوج `src/lib/permissions.ts` يقع في واحد من اثنين — قسمٌ
 * يتبعه، أو رمزٌ دائم — ولا رمز في الاثنين ولا رمز خارجهما. الثاني: كل قسم
 * إما له صلاحيةٌ واحدة على الأقل، أو هو موثّقٌ في `PERMISSION_LESS_SECTIONS`
 * لأنّه بلا رموز خاصة به. الثالث: كل رمزٍ يستقرّ في قسم وحدةٍ بعينها، فخطأٌ
 * في توزيع رمزٍ على قسمٍ لا يمرّ.
 *
 * جانبُ SQL ليس في هذا الملف: جدولَ `permissions` تزرعه الهجرات وحدها
 * (03، 04، 09، 16، 19، 39، 46، 56، 57، 83، 176، 230)، ولا ثابتَ بنصوصها في
 * TS ليُقارن به هنا؛ فأيَّ رمزٍ زُرع في SQL ويغيب عن كتالوج `permissions.ts`
 * يُبلَّغ به في تقرير المهمة بدل تحليل SQL داخل اختبار وحدة.
 * فالمقارنةُ هنا بين الكتالوج والخريطة، لا بين الـSQL.
 */

/**
 * خريطة وحدة الصلاحية → القسم الذي تبعه رموزها.
 *
 * These are the expected values, written from the rule rather than from the
 * production map: a permission code sits with the section of its permission
 * module, unless that module is borrowed by another section (`buildings` under
 * properties) or is always-on and belongs to no section at all (`company`).
 *
 * The table is per module, not per code, so every code in the catalogue is
 * checked by one rule and a new permission module nobody classified fails here
 * instead of passing silently.
 */
const EXPECTED_SECTION_BY_MODULE: Readonly<Record<string, ModuleKey | null>> = {
  // وحدات تتبع قسماً آخر
  buildings: "properties",
  insurance: "contracts",
  refunds: "payments",
  partial_payments: "payments",
  receipts: "payments",
  salaries: "employees",
  payment_links: "online_payments",

  // وحدات دائمة: لا يتبعها قسم، فقفلُ قسمٍ لا يمنعها
  notifications: null,
  company: null,
  users: null,
  portal: null,
  landing_page: null,
  settings: null,
  workflows: null,

  // وحدات تتبع قسمها
  tenants: "tenants",
  contracts: "contracts",
  invoices: "invoices",
  payments: "payments",
  deposits: "deposits",
  expenses: "expenses",
  electricity: "electricity",
  maintenance: "maintenance",
  reports: "reports",
  properties: "properties",
  units: "units",
  audit: "audit",
  employees: "employees",
  inbox: "inbox",
};

/** يرجع الوحدة التي تحمل رمز الصلاحية: الجزء قبل النقطة. */
function permissionModuleOf(code: PermissionCode): string {
  return code.slice(0, code.indexOf("."));
}

/** يرجع رموز الصلاحيات المرتبطة بقسمٍ واحد. */
function codesOfSection(section: ModuleKey): string[] {
  return Object.entries(PERMISSION_SECTION)
    .filter(([, value]) => value === section)
    .map(([code]) => code);
}

describe("every permission code lands in exactly one of the two maps", () => {
  it.each(PERMISSION_CODES)(
    "%s is either bound to a section or marked always-on — never both, never neither",
    (code) => {
      const boundToSection = Object.hasOwn(PERMISSION_SECTION, code);
      const alwaysOn = ALWAYS_ON_PERMISSIONS.has(code);
      const placement =
        boundToSection && alwaysOn ? "both" : boundToSection || alwaysOn ? "one" : "neither";
      expect(placement).toBe("one");
    },
  );

  it("no code is bound to a section and always-on at the same time", () => {
    const overlap = [...ALWAYS_ON_PERMISSIONS].filter((code) =>
      Object.hasOwn(PERMISSION_SECTION, code),
    );
    expect(overlap).toEqual([]);
  });
});

describe("sectionOfPermission resolves the section the permission module belongs to", () => {
  it.each(PERMISSION_CODES)("%s resolves to the section of its permission module", (code) => {
    const module = permissionModuleOf(code);
    expect(
      Object.hasOwn(EXPECTED_SECTION_BY_MODULE, module),
      `permission module "${module}" is not classified in the expectation table`,
    ).toBe(true);
    expect(sectionOfPermission(code)).toBe(EXPECTED_SECTION_BY_MODULE[module]);
  });
});

describe("every section either holds a permission or is documented as permission-less", () => {
  it.each(MODULE_KEYS)(
    "section %s holds a permission or is listed as permission-less",
    (section) => {
      const codes = codesOfSection(section);
      if (codes.length === 0) {
        // A section with no permission of its own is switched off by its own
        // switch alone: the key hides the nav entry, refuses the route and skips
        // its jobs — no code falls with it.
        expect(PERMISSION_LESS_SECTIONS.has(section)).toBe(true);
      } else {
        expect(PERMISSION_LESS_SECTIONS.has(section)).toBe(false);
      }
    },
  );
});
