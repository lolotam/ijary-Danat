import { describe, expect, test } from "vitest";

import {
  FIXTURE_COMPANY,
  FIXTURE_PLOT,
  validCompanyContractValues,
  validContractValues,
} from "./schema.fixture";
import {
  contractBuilderDefaults,
  contractBuilderDraftSchema,
  contractBuilderSchema,
  totalValueFils,
} from "./schema";

describe("contractBuilderSchema", () => {
  test("the valid fixture passes the strict schema", () => {
    const parsed = contractBuilderSchema.safeParse(validContractValues());
    expect(parsed.success).toBe(true);
  });

  test("defaults fail the strict schema and pass the draft schema", () => {
    expect(contractBuilderSchema.safeParse(contractBuilderDefaults).success).toBe(false);
    expect(contractBuilderDraftSchema.safeParse(contractBuilderDefaults).success).toBe(true);
  });

  test("rejects 0 and 4 persons", () => {
    expect(contractBuilderSchema.safeParse(validContractValues({ persons: [] })).success).toBe(
      false,
    );
    const four = Array.from({ length: 4 }, (_, i) => ({
      full_name: `Person ${i}`,
      nationality: "Kuwaiti",
      civil_id: "123456789012",
      residence_address: "Kuwait",
    }));
    expect(contractBuilderSchema.safeParse(validContractValues({ persons: four })).success).toBe(
      false,
    );
  });

  test("rejects 0 and 7 units", () => {
    expect(contractBuilderSchema.safeParse(validContractValues({ units: [] })).success).toBe(false);
    const seven = Array.from({ length: 7 }, (_, i) => ({
      unit_id: `unit-${i}`,
      property_id: FIXTURE_PLOT.id,
      unit_number: String(i + 1),
      unit_number_en: "",
      paci_no: "1",
    }));
    expect(contractBuilderSchema.safeParse(validContractValues({ units: seven })).success).toBe(
      false,
    );
  });

  test("a unit whose plot is not selected is rejected at that unit's path", () => {
    const unit = validContractValues().units[0]!;
    const parsed = contractBuilderSchema.safeParse(
      validContractValues({ units: [{ ...unit, property_id: "another-plot" }] }),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "units.0.property_id",
    ]);
  });

  test("rejects a date that is not a real calendar day", () => {
    expect(
      contractBuilderSchema.safeParse(validContractValues({ contract_date: "2026-02-30" })).success,
    ).toBe(false);
  });

  test("monthly_value requires three-decimal fils precision and the documented max", () => {
    expect(
      contractBuilderSchema.safeParse(validContractValues({ monthly_value: 12.3456 })).success,
    ).toBe(false);
    expect(
      contractBuilderSchema.safeParse(validContractValues({ monthly_value: 12.345 })).success,
    ).toBe(true);
    expect(
      contractBuilderSchema.safeParse(validContractValues({ monthly_value: 10_000_000 })).success,
    ).toBe(false);
  });

  test("increase is all-or-none", () => {
    expect(
      contractBuilderSchema.safeParse(
        validContractValues({ increase: { every_years: 1 } as never }),
      ).success,
    ).toBe(false);
  });

  test("total_value is derived, not an input", () => {
    expect(
      totalValueFils(validContractValues({ monthly_value: 1250.5, duration_months: 12 })),
    ).toBe(15_006_000);
    expect(
      contractBuilderSchema.safeParse({ ...validContractValues(), total_value: 90_000 }).success,
    ).toBe(false);
  });

  test("rejects a 121-character full_name", () => {
    expect(
      contractBuilderSchema.safeParse(
        validContractValues({
          persons: [
            {
              full_name: "x".repeat(121),
              nationality: "Kuwaiti",
              civil_id: "123456789012",
              residence_address: "Kuwait",
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });
});

describe("second party modes", () => {
  test("the valid company fixture passes the strict schema", () => {
    expect(contractBuilderSchema.safeParse(validCompanyContractValues()).success).toBe(true);
  });

  test("company mode ignores unfinished person rows left behind by a mode switch", () => {
    const leftover = { full_name: "", nationality: "", civil_id: "", residence_address: "" };
    expect(
      contractBuilderSchema.safeParse(validCompanyContractValues({ persons: [leftover] })).success,
    ).toBe(true);
  });

  test("a missing signatory field is reported at its company path", () => {
    const parsed = contractBuilderSchema.safeParse(
      validCompanyContractValues({ company: { ...FIXTURE_COMPANY, signatory_name: "" } }),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "company.signatory_name",
    ]);
  });

  test.each(["12345678901", "1234567890123", "12345678901a"])(
    "rejects a civil id that is not exactly 12 digits (%s)",
    (civilId) => {
      const person = { ...validContractValues().persons[0]!, civil_id: civilId };
      expect(
        contractBuilderSchema.safeParse(validContractValues({ persons: [person] })).success,
      ).toBe(false);
      expect(
        contractBuilderSchema.safeParse(
          validCompanyContractValues({
            company: { ...FIXTURE_COMPANY, signatory_civil_id: civilId },
          }),
        ).success,
      ).toBe(false);
    },
  );
});

describe("contact fields", () => {
  test.each(["50001234", "96550001234", "+0550001234", ""])(
    "rejects a mobile that is not E.164 (%s)",
    (mobile) => {
      expect(
        contractBuilderSchema.safeParse(validContractValues({ contact_mobile: mobile })).success,
      ).toBe(false);
    },
  );

  test("WhatsApp is optional but must be E.164 when given", () => {
    const parse = (contact_whatsapp: string) =>
      contractBuilderSchema.safeParse(validContractValues({ contact_whatsapp })).success;
    expect(parse("")).toBe(true);
    expect(parse("+96560001234")).toBe(true);
    expect(parse("60001234")).toBe(false);
  });

  test("email is required and must be an address", () => {
    const parse = (contact_email: string) =>
      contractBuilderSchema.safeParse(validContractValues({ contact_email })).success;
    expect(parse("")).toBe(false);
    expect(parse("not-an-email")).toBe(false);
    expect(parse("tenant@example.test")).toBe(true);
  });
});

describe("printed text fields", () => {
  test("a whitespace-only company name or signatory is rejected at its path", () => {
    const parsed = contractBuilderSchema.safeParse(
      validCompanyContractValues({
        company: { ...FIXTURE_COMPANY, company_name: "   ", signatory_name: " " },
      }),
    );
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "company.company_name",
      "company.signatory_name",
    ]);
  });

  test("a whitespace-only person name or trade name is rejected", () => {
    const person = { ...validContractValues().persons[0]!, full_name: "  " };
    expect(
      contractBuilderSchema.safeParse(validContractValues({ persons: [person] })).success,
    ).toBe(false);
    expect(contractBuilderSchema.safeParse(validContractValues({ trade_name: " " })).success).toBe(
      false,
    );
  });

  test("an overlong plot name fails the strict schema but still previews as a draft", () => {
    const plots = [{ ...FIXTURE_PLOT, name_en: "x".repeat(49) }];
    expect(contractBuilderSchema.safeParse(validContractValues({ plots })).success).toBe(false);
    expect(contractBuilderDraftSchema.safeParse(validContractValues({ plots })).success).toBe(true);
  });
});
