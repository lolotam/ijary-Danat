import { describe, expect, test } from "vitest";

import { stripBoldMarkers } from "./boldMarkers";
import { CONTRACT_COPY_AR } from "./clauses.ar";
import { CONTRACT_COPY_EN } from "./clauses.en";
import type { ClauseContext, ContractCopy } from "./clauses.types";
import {
  amountInWordsAr,
  amountInWordsEn,
  dayNameAr,
  dayNameEn,
  durationWordsAr,
  durationWordsEn,
} from "./numberToWords";
import { toFils, totalValueFils, type ContractBuilderValues } from "./schema";
import {
  FIXTURE_COMPANY,
  FIXTURE_ISSUER,
  validCompanyContractValues,
  validContractValues,
} from "./schema.fixture";
import { formatUnitList, spansSeveralPlots } from "./units";

/**
 * يبني سياق البنود من وثيقة صالحة، بالكلمات المناسبة للّغة.
 */
function makeCtx(
  locale: "ar" | "en",
  overrides: Partial<ContractBuilderValues> = {},
): ClauseContext {
  const values = validContractValues(overrides);
  return {
    ...values,
    totalWords:
      locale === "ar"
        ? amountInWordsAr(totalValueFils(values))
        : amountInWordsEn(totalValueFils(values)),
    monthlyWords:
      locale === "ar"
        ? amountInWordsAr(toFils(values.monthly_value))
        : amountInWordsEn(toFils(values.monthly_value)),
    durationWords:
      locale === "ar"
        ? durationWordsAr(values.duration_months)
        : durationWordsEn(values.duration_months),
    dayName: locale === "ar" ? dayNameAr(values.contract_date) : dayNameEn(values.contract_date),
    unitList: formatUnitList(values, locale),
    multiPlot: spansSeveralPlots(values),
  };
}

/** يجمع نصوص النسخة لضمان بقاء الهروب من HTML مسؤولية القالب وحده. */
function allStrings(copy: ContractCopy, ctx: ClauseContext): string[] {
  return [
    copy.footer(FIXTURE_ISSUER),
    copy.title,
    copy.opening(ctx),
    copy.firstParty(FIXTURE_ISSUER),
    copy.secondPartyHeading,
    ...copy.secondParty(ctx),
    copy.preambleTitle,
    copy.preamble(ctx),
    ...copy.clauses(ctx).flatMap((c) => [c.title, ...c.body]),
    copy.signatures.firstParty,
    copy.signatures.secondParty,
    copy.signatures.authorizedSignatory,
    copy.signatures.name,
    copy.signatures.signature,
    copy.pageCounter(1, 5),
  ];
}

describe.each([
  ["ar", CONTRACT_COPY_AR],
  ["en", CONTRACT_COPY_EN],
] as const)("CONTRACT_COPY_%s", (locale, copy) => {
  test("keeps block 90 and plot 8 correctly paired in the preamble and clause 2", () => {
    const ctx = makeCtx(locale, { block: "90", parcel: "8" });
    const expected = locale === "ar" ? ["قطعة (90)", "قسيمة (8)"] : ["Block (90)", "Plot (8)"];
    for (const text of [copy.preamble(ctx), copy.clauses(ctx)[1]!.body.join(" ")]) {
      for (const phrase of expected) expect(stripBoldMarkers(text)).toContain(phrase);
    }
  });

  test("returns 18 clauses numbered 1..18 with non-empty bodies", () => {
    const ctx = makeCtx(locale);
    const clauses = copy.clauses(ctx);
    expect(clauses).toHaveLength(18);
    expect(clauses.map((c) => c.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    for (const clause of clauses) {
      expect(clause.body.length).toBeGreaterThan(0);
      expect(clause.body.every((p) => p.length > 0)).toBe(true);
    }
  });

  test("clause 4 interpolates total and monthly words", () => {
    const ctx = makeCtx(locale);
    const body = copy.clauses(ctx)[3]!.body.join("\n");
    expect(body).toContain(ctx.totalWords);
    expect(body).toContain(ctx.monthlyWords);
  });

  test("clause 3 interpolates duration words", () => {
    const ctx = makeCtx(locale);
    const body = copy.clauses(ctx)[2]!.body.join("\n");
    expect(body).toContain(ctx.durationWords);
  });

  test("returned strings contain no HTML brackets", () => {
    const ctx = makeCtx(locale);
    for (const value of allStrings(copy, ctx)) {
      expect(value).not.toMatch(/[<>]/);
    }
  });

  test("clause 4 omits the increase sentence when increase is null", () => {
    const ctx = makeCtx(locale, { increase: null });
    const body = copy.clauses(ctx)[3]!.body.join("\n");
    expect(body).not.toMatch(/15\s*%/);
    expect(body).not.toContain("متغيرة");
    expect(body.toLowerCase()).not.toContain("variable");
  });

  test("clause 4 names the percent when an increase is set", () => {
    const ctx = makeCtx(locale, { increase: { every_years: 5, percent: 15 } });
    const body = copy.clauses(ctx)[3]!.body.join("\n");
    expect(body).toMatch(/15/);
  });
});

const TWO_PERSONS = [
  {
    full_name: "شريك محمد خاتم العجمي",
    nationality: "كويتي",
    civil_id: "264010900749",
    residence_address: "النعيم",
  },
  {
    full_name: "عبدالعزيز علي عباس",
    nationality: "ايراني",
    civil_id: "285010100123",
    residence_address: "العيون",
  },
];

describe("secondParty", () => {
  test("Arabic individuals: one ordinal line per person, then the capacity statement", () => {
    const lines = CONTRACT_COPY_AR.secondParty(makeCtx("ar", { persons: TWO_PERSONS }));
    expect(lines.map(stripBoldMarkers)).toEqual([
      "الطرف الثاني (شخص أول): السيد / شريك محمد خاتم العجمي، الجنسية: كويتي، بالرقم المدني: (264010900749)، والمقيم في: النعيم.",
      "الطرف الثاني (شخص ثانٍ): السيد / عبدالعزيز علي عباس، الجنسية: ايراني، بالرقم المدني: (285010100123)، والمقيم في: العيون.",
      "أقر الطرفان بأهليتهما القانونية للتعاقد والتصرف، وبخلو إرادتيهما من العيوب المبطلة للتصرفات، واتفقا على ما يلي:",
    ]);
  });

  test("a single person carries no ordinal", () => {
    const [line] = CONTRACT_COPY_AR.secondParty(makeCtx("ar"));
    expect(line!.startsWith("الطرف الثاني: السيد / ")).toBe(true);
    const [lineEn] = CONTRACT_COPY_EN.secondParty(makeCtx("en"));
    expect(lineEn!.startsWith("Second Party: Mr. / ")).toBe(true);
  });

  test("Arabic company: company, seat and authorized signatory in one line", () => {
    const ctx = { ...makeCtx("ar"), ...validCompanyContractValues() };
    const c = FIXTURE_COMPANY;
    expect(CONTRACT_COPY_AR.secondParty(ctx).map(stripBoldMarkers)).toEqual([
      `الطرف الثاني: شركة / ${c.company_name}، الكائن مقرها في: ${c.company_address}، ويمثلها قانوناً المفوض بالتوقيع السيد / ${c.signatory_name}، الجنسية: ${c.signatory_nationality}، بالرقم المدني: (${c.signatory_civil_id})، والمقيم في: ${c.signatory_address}.`,
      CONTRACT_COPY_AR.capacityStatement,
    ]);
  });

  test("company mode prints no person, even if person rows are left over", () => {
    const ctx = { ...makeCtx("en", { persons: TWO_PERSONS }), ...validCompanyContractValues() };
    ctx.persons = TWO_PERSONS;
    const text = stripBoldMarkers(CONTRACT_COPY_EN.secondParty(ctx).join(" "));
    expect(text).toContain(`Company / ${FIXTURE_COMPANY.company_name}`);
    expect(text).not.toContain(TWO_PERSONS[0]!.full_name);
  });

  test.each([
    ["ar", CONTRACT_COPY_AR],
    ["en", CONTRACT_COPY_EN],
  ] as const)("both modes end with the %s capacity statement", (locale, copy) => {
    const individual = copy.secondParty(makeCtx(locale, { persons: TWO_PERSONS }));
    const company = copy.secondParty({ ...makeCtx(locale), ...validCompanyContractValues() });
    expect(individual.at(-1)).toBe(copy.capacityStatement);
    expect(company.at(-1)).toBe(copy.capacityStatement);
  });
});

describe("multi-plot wording", () => {
  const plots = [
    { id: "a", name_ar: "مجمع -1", name_en: "Complex -1" },
    { id: "b", name_ar: "مجمع -2", name_en: "Complex -2" },
  ];
  const units = [
    { unit_id: "1", property_id: "a", unit_number: "5", unit_number_en: "", paci_no: "" },
    { unit_id: "2", property_id: "b", unit_number: "7", unit_number_en: "", paci_no: "" },
  ];

  test.each([
    ["ar", CONTRACT_COPY_AR, "القسيمة المشار إليها", "قسائم (8 و 9)"],
    ["en", CONTRACT_COPY_EN, "the said plot", "Plots (8 و 9)"],
  ] as const)(
    "%s: units on two plots drop the singular plot reference from both clauses",
    (locale, copy, singular, plural) => {
      const ctx = makeCtx(locale, { plots, units, parcel: "8 و 9" });
      const preamble = copy.preamble(ctx);
      const clause2 = copy.clauses(ctx)[1]!.body.join(" ");
      expect(preamble).not.toContain(singular);
      expect(stripBoldMarkers(preamble)).toContain(plural);
      expect(stripBoldMarkers(clause2)).toContain(plural);
    },
  );

  test.each([
    ["ar", CONTRACT_COPY_AR, "القسيمة المشار إليها"],
    ["en", CONTRACT_COPY_EN, "the said plot"],
  ] as const)("%s: a single plot keeps the scan's singular wording", (locale, copy, singular) => {
    expect(copy.preamble(makeCtx(locale))).toContain(singular);
  });
});
