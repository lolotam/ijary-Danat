import { describe, expect, test } from "vitest";

import type { ContractUnitDetail } from "@/hooks/useContractRelations";
import type { Tables } from "@/integrations/supabase/database.types";

import { prefillFromContract } from "./prefill";

/**
 * يبني صف مستأجر بالحد الأدنى من الحقول التي يقرأها التعبئة المسبقة.
 */
function makeTenant(overrides: Partial<Tables<"tenants">> = {}): Tables<"tenants"> {
  return {
    id: "tenant-1",
    name: "شركة الدانة",
    owner_name: "شركة الدانة",
    owner_civil_id: "264010900749",
    authorized_manager: null,
    authorized_manager_civil_id: "299010100001",
    nationality: "كويتي",
    commercial_address: "الجهراء – القيصرية",
    commercial_name: "Danat Shop",
    commercial_name_ar: "محل الدانة",
    commercial_name_en: "Danat Shop EN",
    mobile: "50001234",
    whatsapp: null,
    email: " owner@example.test ",
    ...overrides,
  } as Tables<"tenants">;
}

/**
 * يبني صف عقد بالحد الأدنى من حقول التعبئة المسبقة.
 */
function makeContract(overrides: Partial<Tables<"contracts">> = {}): Tables<"contracts"> {
  return {
    id: "contract-1",
    tenant_id: "tenant-1",
    start_date: "2025-07-01",
    duration_months: 36,
    monthly_amount: 2500,
    commercial_activity: "البيع بالتجزئة",
    increase_type: "percent",
    increase_after_years: 5,
    increase_value: 15,
    ...overrides,
  } as Tables<"contracts">;
}

/**
 * يبني وحدة عقد مع عقارها.
 */
function makeUnit(
  overrides: {
    unit?: Partial<Tables<"units">>;
    property?: Partial<Tables<"properties">> | null;
    monthlyAmount?: number;
  } = {},
): ContractUnitDetail {
  const propertyId = overrides.unit?.property_id ?? overrides.property?.id ?? "prop-1";
  const property =
    overrides.property === null
      ? null
      : ({
          id: propertyId,
          address_ar: "محافظة الجهراء",
          name_ar: "مجمع الدانة",
          name_en: "Danat Complex",
          ...overrides.property,
        } as Tables<"properties">);
  return {
    monthlyAmount: overrides.monthlyAmount ?? 2500,
    property,
    unit: {
      id: "unit-1",
      name: "محل 5",
      name_en: "Shop 5",
      code: "U-5",
      paci_no: "22023211",
      floor: "ground",
      type: "shop_G_Floor",
      property_id: propertyId,
      ...overrides.unit,
    } as Tables<"units">,
  };
}

describe("prefillFromContract", () => {
  test("maps the full owner-side happy path", () => {
    const { values, notices } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant(),
        units: [makeUnit()],
      },
      "ar",
    );
    expect(notices).toEqual([]);
    expect(values.contract_date).toBe("2025-07-01");
    expect(values.persons).toEqual([
      {
        full_name: "شركة الدانة",
        nationality: "كويتي",
        civil_id: "264010900749",
        residence_address: "الجهراء – القيصرية",
      },
    ]);
    expect(values.second_party_type).toBe("individual");
    expect(values.governorate).toBe("محافظة الجهراء");
    expect(values.plots).toEqual([
      { id: "prop-1", name_ar: "مجمع الدانة", name_en: "Danat Complex" },
    ]);
    expect(values.units).toEqual([
      {
        unit_id: "unit-1",
        property_id: "prop-1",
        unit_number: "محل 5",
        unit_number_en: "Shop 5",
        paci_no: "22023211",
      },
    ]);
    expect(values.activity).toBe("البيع بالتجزئة");
    expect(values.trade_name).toBe("محل الدانة");
    expect(values.duration_months).toBe(36);
    expect(values.monthly_value).toBe(2500);
    expect(values.increase).toEqual({ every_years: 5, percent: 15 });
  });

  test("uses owner civil id when owner_name equals name", () => {
    const { values } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant({
          name: "علي أحمد",
          owner_name: "علي أحمد",
          owner_civil_id: "111",
          authorized_manager: "مدير آخر",
          authorized_manager_civil_id: "222",
        }),
        units: [makeUnit()],
      },
      "ar",
    );
    expect(values.persons?.[0]?.civil_id).toBe("111");
    expect(values.persons?.[0]?.full_name).toBe("علي أحمد");
  });

  test("uses owner civil id when authorized_manager is empty", () => {
    const { values } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant({
          name: "المستأجر",
          owner_name: "شخص آخر",
          owner_civil_id: "111",
          authorized_manager: "",
          authorized_manager_civil_id: "222",
        }),
        units: [makeUnit()],
      },
      "ar",
    );
    expect(values.persons?.[0]?.civil_id).toBe("111");
  });

  test("uses manager civil id when the name is not the owner's", () => {
    const { values } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant({
          name: "المدير المفوض",
          owner_name: "المالك",
          owner_civil_id: "111",
          authorized_manager: "المدير المفوض",
          authorized_manager_civil_id: "222",
        }),
        units: [makeUnit()],
      },
      "ar",
    );
    expect(values.persons?.[0]?.civil_id).toBe("222");
    expect(values.persons?.[0]?.full_name).toBe("المدير المفوض");
  });

  test("a company tenant with a manager becomes a company represented by that manager", () => {
    // Migration 149 retired owner_name, so a current tenant with a manager has
    // it null and `name` is the company. Printing that name beside the
    // manager's civil id identifies the wrong person on a signed contract.
    const { values } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant({
          name: "مؤسسة اجمل اختيار",
          owner_name: null,
          owner_civil_id: null,
          authorized_manager: "عبدالعزيز علي",
          authorized_manager_civil_id: "296072300163",
        }),
        units: [makeUnit()],
      },
      "ar",
    );
    expect(values.second_party_type).toBe("company");
    expect(values.persons).toEqual([]);
    expect(values.company).toEqual({
      company_name: "مؤسسة اجمل اختيار",
      company_address: "الجهراء – القيصرية",
      signatory_name: "عبدالعزيز علي",
      signatory_nationality: "كويتي",
      signatory_civil_id: "296072300163",
      signatory_address: "",
    });
  });

  test("falls back to the tenant name when neither an owner nor a manager is recorded", () => {
    const { values } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant({
          name: "مؤسسة اجمل اختيار",
          owner_name: null,
          owner_civil_id: "264010900749",
          authorized_manager: null,
          authorized_manager_civil_id: null,
        }),
        units: [makeUnit()],
      },
      "ar",
    );
    expect(values.persons?.[0]?.full_name).toBe("مؤسسة اجمل اختيار");
    expect(values.persons?.[0]?.civil_id).toBe("264010900749");
  });

  test("fixed increase is omitted with a notice", () => {
    const { values, notices } = prefillFromContract(
      {
        contract: makeContract({
          increase_type: "fixed",
          increase_after_years: 2,
          increase_value: 50,
        }),
        tenant: makeTenant(),
        units: [makeUnit()],
      },
      "ar",
    );
    expect(values).not.toHaveProperty("increase");
    expect(notices).toContain("increase_fixed_not_supported");
  });

  test("units on two properties blank the property fields and notice", () => {
    const { values, notices } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant(),
        units: [
          makeUnit({ property: { id: "prop-a", address_ar: "الجهراء" } }),
          makeUnit({
            unit: { id: "unit-2", name: "محل 6", code: "U-6", property_id: "prop-b" },
            property: { id: "prop-b", address_ar: "العاصمة" },
          }),
        ],
      },
      "ar",
    );
    expect(values).not.toHaveProperty("governorate");
    expect(notices).toContain("multi_property");
  });

  test("null duration_months is omitted", () => {
    const { values } = prefillFromContract(
      {
        contract: makeContract({ duration_months: null }),
        tenant: makeTenant(),
        units: [makeUnit()],
      },
      "ar",
    );
    expect(values).not.toHaveProperty("duration_months");
  });

  test("en picks commercial_name_en and falls back to commercial_name", () => {
    const named = prefillFromContract(
      { contract: makeContract(), tenant: makeTenant(), units: [makeUnit()] },
      "en",
    );
    expect(named.values.trade_name).toBe("Danat Shop EN");

    const fallback = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant({ commercial_name_en: null, commercial_name_ar: null }),
        units: [makeUnit()],
      },
      "en",
    );
    expect(fallback.values.trade_name).toBe("Danat Shop");
  });

  test("unit_number falls back to unit.code when name is empty", () => {
    const { values } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant(),
        units: [makeUnit({ unit: { name: "", code: "U-9" } })],
      },
      "ar",
    );
    expect(values.units?.map((unit) => unit.unit_number)).toEqual(["U-9"]);
  });

  test("a manager whose name is the tenant's own stays an individual", () => {
    const { values } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant({
          name: "المدير المفوض",
          owner_name: "المالك",
          authorized_manager: "المدير المفوض",
        }),
        units: [makeUnit()],
      },
      "ar",
    );
    expect(values.second_party_type).toBe("individual");
  });

  test("roof units are dropped with a notice and never become a plot", () => {
    const { values, notices } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant(),
        units: [
          makeUnit(),
          makeUnit({
            unit: { id: "roof-1", floor: "roof", type: "Roof_Apartment", property_id: "prop-r" },
            property: { id: "prop-r" },
          }),
        ],
      },
      "ar",
    );
    expect(notices).toEqual(["roof_units_excluded"]);
    expect(values.units?.map((unit) => unit.unit_id)).toEqual(["unit-1"]);
    expect(values.plots?.map((plot) => plot.id)).toEqual(["prop-1"]);
  });

  test("units on two plots keep both plots in first-seen order", () => {
    const { values } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant(),
        units: [
          makeUnit({ property: { id: "prop-b" } }),
          makeUnit({ unit: { id: "unit-2", property_id: "prop-a" }, property: { id: "prop-a" } }),
          makeUnit({ unit: { id: "unit-3", property_id: "prop-b" }, property: { id: "prop-b" } }),
        ],
      },
      "ar",
    );
    expect(values.plots?.map((plot) => plot.id)).toEqual(["prop-b", "prop-a"]);
  });

  test("contact details are normalized to E.164 from the tenant record", () => {
    const { values } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant({ mobile: "50001234", whatsapp: "+965 6000 1234" }),
        units: [makeUnit()],
      },
      "ar",
    );
    expect(values.contact_mobile).toBe("+96550001234");
    expect(values.contact_whatsapp).toBe("+96560001234");
    expect(values.contact_email).toBe("owner@example.test");
  });

  test("a number stored with the 00 international prefix becomes +965, not +00965", () => {
    const { values } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant({ mobile: "0096550001234" }),
        units: [makeUnit()],
      },
      "ar",
    );
    expect(values.contact_mobile).toBe("+96550001234");
  });

  test("an unnormalizable or missing number is left for the operator to fix", () => {
    const { values } = prefillFromContract(
      {
        contract: makeContract(),
        tenant: makeTenant({ mobile: "123", whatsapp: null, email: null }),
        units: [makeUnit()],
      },
      "ar",
    );
    expect(values.contact_mobile).toBe("123");
    expect(values.contact_whatsapp).toBe("");
    expect(values.contact_email).toBe("");
  });
});
