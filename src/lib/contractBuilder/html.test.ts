import { describe, expect, test } from "vitest";

import { BOLD_CLOSE, BOLD_OPEN, stripBoldMarkers } from "./boldMarkers";
import { CONTRACT_COPY_AR } from "./clauses.ar";
import { CONTRACT_COPY_EN } from "./clauses.en";
import { buildClauseContext, buildContractHtml, esc, pageOneIsDense } from "./html";
import { wrapHtmlForPdf } from "@/lib/serverPdf";
import { formatKwdFromFils, toFils, type ContractLocale } from "./schema";
import {
  FIXTURE_COMPANY,
  FIXTURE_ISSUER,
  validCompanyContractValues,
  validContractValues,
} from "./schema.fixture";

const PHRASES: Array<[clause: number, page: number, phrase: string]> = [
  [1, 1, "متمماً ومكملاً"],
  [2, 1, "حسب المخطط المرفق"],
  [3, 2, "بمثابة استلام فعلى"],
  [4, 2, "اجمالى قيمة العقد"],
  [5, 2, "محضر استلام رسمى"],
  [6, 3, "كتأمين للعين المستثمرة"],
  [7, 3, "المعاينة التامة النافية للجهالة شرعاً"],
  [8, 3, "النشاط التجارى المرخص"],
  [9, 3, "حكم بشهر افلاسه"],
  [10, 3, "تأمينا شاملا"],
  [11, 4, "اعلانات او لوحات"],
  [12, 4, "حوالة الحق"],
  [13, 4, "براءة ذمة"],
  [14, 4, "الممرات الداخلية"],
  [15, 5, "الفاكسات الموقعة"],
  [16, 5, "ماهية ومضمون"],
  [17, 5, "1978/35"],
  [18, 5, "ثمانية عشر بنداً"],
];

/**
 * يلفّ مقطع العقد بغلاف PDF الحقيقي ويقسم الصفحات على class="doc-page".
 */
function wrappedAr(overrides?: Parameters<typeof validContractValues>[0]): string {
  return wrapHtmlForPdf(buildContractHtml(validContractValues(overrides), "ar", FIXTURE_ISSUER), {
    arabic: true,
  });
}

/**
 * يعيد أجزاء المستند بعد كل class="doc-page — الفهرس 1 هو الصفحة الأولى.
 */
function pagesOf(html: string): string[] {
  return html.split(/class="doc-page/);
}

/**
 * يبني وثيقة من قسيمتين: أسماء القسائم لا تُطبع إلا عند تعددها، فتظهر هنا.
 */
function multiPlotValues(locale: ContractLocale) {
  return validContractValues({
    language: locale,
    plots: [
      { id: "plot-a", name_ar: "مجمع دانة -1", name_en: "Danat -1" },
      { id: "plot-b", name_ar: "مجمع دانة -2", name_en: "Danat -2" },
    ],
    units: [
      {
        unit_id: "u-3",
        property_id: "plot-a",
        unit_number: "3",
        unit_number_en: "Shop 3",
        paci_no: "111",
      },
      {
        unit_id: "u-7",
        property_id: "plot-b",
        unit_number: "7",
        unit_number_en: "Shop 7",
        paci_no: "222",
      },
    ],
  });
}

/**
 * يعد وسوم <strong> في العقد المطبوع لمقارنة النسخة الملوثة بالعلامات مع النظيفة.
 */
function countStrong(html: string): number {
  return html.match(/<strong>/g)?.length ?? 0;
}

/**
 * يبني أثقل وثيقة تبقى بحجم الصفحة الأولى المريح، ليثبت أن العلامات لا تُحتسب.
 *
 * The search grows the activity (printed twice on page one) to the largest
 * length that is still roomy. At that point the stripped text sits exactly on
 * the threshold while the marked text is longer, so counting the markers
 * would flip the result to dense and fail the test.
 */
function justUnderDenseValues(locale: ContractLocale) {
  const copy = locale === "ar" ? CONTRACT_COPY_AR : CONTRACT_COPY_EN;
  const denseAt = (length: number) =>
    pageOneIsDense(
      buildClauseContext(validContractValues({ activity: "x".repeat(length) }), locale),
      copy,
      locale,
    );
  let length = 0;
  while (!denseAt(length)) length += 50;
  while (denseAt(length)) length -= 1;
  return validContractValues({ activity: "x".repeat(length) });
}

/**
 * يستخرج قاعدة CSS واحدة من style المولد للتحقق من طلب المالك دون قراءة الملف.
 */
function cssRule(html: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`));
  expect(match, `missing CSS rule ${selector}`).not.toBeNull();
  return match![0];
}

describe("buildContractHtml", () => {
  test("the real wrapper supplies a full RTL document", () => {
    const html = wrappedAr();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('dir="rtl"');
  });

  test("emits exactly five doc-page sections", () => {
    const html = wrappedAr();
    expect((html.match(/class="doc-page/g) ?? []).length).toBe(5);
  });

  test.each(PHRASES)("clause %s distinctive phrase sits on page %s", (clause, page, phrase) => {
    const pages = pagesOf(wrappedAr());
    expect(pages[page], `clause ${clause} phrase missing from page ${page}`).toContain(phrase);
  });

  test("page 1 contains the date and each full_name", () => {
    const values = validContractValues({
      persons: [
        {
          full_name: "شريك محمد خاتم العجمي",
          nationality: "كويتي",
          civil_id: "1",
          residence_address: "A",
        },
        {
          full_name: "عبدالعزيز علي عباس البو علي",
          nationality: "ايراني",
          civil_id: "2",
          residence_address: "B",
        },
      ],
    });
    const page1 = pagesOf(
      wrapHtmlForPdf(buildContractHtml(values, "ar", FIXTURE_ISSUER), { arabic: true }),
    )[1]!;
    expect(page1).toContain(values.contract_date);
    for (const person of values.persons) {
      expect(page1).toContain(person.full_name);
    }
  });

  test("page 5 has one signature-block per person", () => {
    const values = validContractValues({
      persons: [
        {
          full_name: "A Person",
          nationality: "Kuwaiti",
          civil_id: "1",
          residence_address: "A",
        },
        {
          full_name: "B Person",
          nationality: "Kuwaiti",
          civil_id: "2",
          residence_address: "B",
        },
      ],
    });
    const page5 = pagesOf(
      wrapHtmlForPdf(buildContractHtml(values, "ar", FIXTURE_ISSUER), { arabic: true }),
    )[5]!;
    expect((page5.match(/data-testid="signature-block"/g) ?? []).length).toBe(2);
  });

  test("every page carries the issuing company's name, address and phone", () => {
    const pages = pagesOf(wrappedAr());
    for (let page = 1; page <= 5; page += 1) {
      expect(pages[page]).toContain(FIXTURE_ISSUER.name);
      expect(pages[page]).toContain(FIXTURE_ISSUER.address);
      expect(pages[page]).toContain(FIXTURE_ISSUER.phone);
    }
  });

  test.each([["ar"], ["en"]] as const)(
    "prints the contract's own company as first party, not a fixed one (%s)",
    (locale) => {
      const issuer = {
        name: "Other Co",
        address: "Hawalli office 3",
        phone: "25550000",
        logoUrl: null,
      };
      const html = buildContractHtml(validContractValues({ language: locale }), locale, issuer);
      const page1 = pagesOf(html)[1]!;
      expect(page1).toContain(locale === "ar" ? "السادة/ Other Co" : "Messrs. / Other Co");
      expect(page1).toContain("Hawalli office 3");
      expect(pagesOf(html)[5]).toContain("<div>Other Co</div>");
      expect(html).not.toContain(FIXTURE_ISSUER.name);
      expect(html).not.toContain("24567177");
    },
  );

  test("a company without address or phone prints no empty seat or phone label", () => {
    const issuer = { name: "Bare Co", address: "", phone: "", logoUrl: null };
    const html = buildContractHtml(validContractValues(), "ar", issuer);
    expect(html).not.toContain("الكائن مقرها");
    expect(html).not.toContain("هاتف:");
    expect(html).toContain("أولاً: السادة/ Bare Co. ويشار إليه");
  });

  test("every page header carries the company's own logo, and none when it has none", () => {
    const logo = "data:image/png;base64,QUJD";
    const withLogo = buildContractHtml(validContractValues(), "ar", {
      ...FIXTURE_ISSUER,
      logoUrl: logo,
    });
    const pages = pagesOf(withLogo);
    for (let page = 1; page <= 5; page += 1) {
      expect(pages[page]).toContain(`<img src="${logo}" alt="${FIXTURE_ISSUER.name}" />`);
    }
    expect(withLogo).not.toContain("danat-logo");

    const without = buildContractHtml(validContractValues(), "ar", FIXTURE_ISSUER);
    expect(without).not.toContain("<img");
  });

  test("the page-5 counter string appears once", () => {
    const html = wrappedAr();
    expect((html.match(/Page 5 of 5/g) ?? []).length).toBe(1);
  });

  test("English clauses have no Arabic script outside the fixed letterhead", () => {
    const latin = validContractValues({
      language: "en",
      persons: [
        {
          full_name: "John Smith",
          nationality: "British",
          civil_id: "123456789012",
          residence_address: "Kuwait City",
        },
      ],
      governorate: "Jahra",
      block: "90",
      parcel: "8",
      plots: [{ id: "plot-1", name_ar: "مجمع", name_en: "Complex 1" }],
      units: [
        {
          unit_id: "u-5",
          property_id: "plot-1",
          unit_number: "5",
          unit_number_en: "",
          paci_no: "22023211",
        },
      ],
      activity: "retail of blankets",
      trade_name: "Best Choice",
    });
    let html = wrapHtmlForPdf(buildContractHtml(latin, "en", FIXTURE_ISSUER), {
      arabic: false,
    });
    // The issuer's Arabic legal identity is the only Arabic allowed; the footer
    // holds the address, so it is stripped first.
    html = html
      .split(CONTRACT_COPY_EN.footer(FIXTURE_ISSUER))
      .join("")
      .split(FIXTURE_ISSUER.name)
      .join("")
      .split(FIXTURE_ISSUER.address)
      .join("");
    expect(html).not.toMatch(/[؀-ۿ]/);
  });

  test("Arabic build contains none of the English clause titles", () => {
    const html = wrappedAr();
    for (let n = 1; n <= 18; n += 1) {
      expect(html).not.toContain(`Clause (${n})`);
    }
  });

  test("interpolated names are escaped exactly once", () => {
    const person = validContractValues().persons[0]!;
    const html = wrapHtmlForPdf(
      buildContractHtml(
        validContractValues({ persons: [{ ...person, full_name: "<b>x</b>" }] }),
        "ar",
        FIXTURE_ISSUER,
      ),
      { arabic: true },
    );
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("&amp;lt;");
  });

  test("page 5 has a single company signature block naming the signatory", () => {
    const html = wrapHtmlForPdf(
      buildContractHtml(validCompanyContractValues(), "ar", FIXTURE_ISSUER),
      {
        arabic: true,
      },
    );
    const page5 = pagesOf(html)[5]!;
    const blocks = page5.match(/data-testid="signature-block"[\s\S]*?<\/div>\s*<\/div>/g) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(FIXTURE_COMPANY.company_name);
    expect(blocks[0]).toContain(FIXTURE_COMPANY.signatory_name);
  });

  test.each([
    ["ar", CONTRACT_COPY_AR],
    ["en", CONTRACT_COPY_EN],
  ] as const)("page 1 carries the %s legal capacity statement in both modes", (locale, copy) => {
    for (const values of [validContractValues(), validCompanyContractValues()]) {
      const page1 = pagesOf(
        wrapHtmlForPdf(buildContractHtml(values, locale, FIXTURE_ISSUER), {
          arabic: locale === "ar",
        }),
      )[1]!;
      expect(page1).toContain(copy.capacityStatement);
    }
  });

  test.each([["ar"], ["en"]] as const)(
    "no contact field reaches the %s document in either mode",
    (locale) => {
      // Values chosen to collide with nothing else on the page: no unit,
      // civil id, amount or date contains these digit runs.
      const contact = {
        contact_mobile: "+96599887701",
        contact_whatsapp: "+96566554402",
        contact_email: "nobody-printed@example.test",
      };
      for (const values of [validContractValues(contact), validCompanyContractValues(contact)]) {
        const html = wrapHtmlForPdf(buildContractHtml(values, locale, FIXTURE_ISSUER), {
          arabic: locale === "ar",
        });
        expect(html).not.toContain("99887701");
        expect(html).not.toContain("66554402");
        expect(html).not.toContain("nobody-printed");
      }
    },
  );

  test("units list their PACI numbers in the preamble and clause 2", () => {
    const page1 = pagesOf(wrappedAr())[1]!;
    const text = page1.replace(/<[^>]+>/g, "");
    expect(text.split("الرقم الآلي 22023211").length - 1).toBe(2);
  });

  test.each([
    ["ar", "شريك محمد خاتم العجمي"],
    ["en", "John Smith"],
  ] as const)("filled values print inside <strong> (%s)", (locale, fullName) => {
    const values = validContractValues({
      language: locale,
      persons: [
        {
          full_name: fullName,
          nationality: locale === "ar" ? "كويتي" : "British",
          civil_id: "264010900749",
          residence_address: locale === "ar" ? "النعيم" : "Kuwait City",
        },
      ],
    });
    const html = buildContractHtml(values, locale, FIXTURE_ISSUER);
    expect(html).toContain(`<strong>${esc(fullName)}</strong>`);
    expect(html).toContain(`<strong>${formatKwdFromFils(toFils(values.monthly_value))}</strong>`);
    expect(html).toContain(`<strong>${esc(values.contract_date)}</strong>`);
  });

  test.each([
    ["ar", "أقر الطرفان"],
    ["en", "Both parties acknowledge"],
  ] as const)("fixed copy stays outside <strong> (%s)", (locale, phrase) => {
    const html = buildContractHtml(
      validContractValues({ language: locale }),
      locale,
      FIXTURE_ISSUER,
    );
    expect(html).toContain(phrase);
    const strongContents = [...html.matchAll(/<strong>([\s\S]*?)<\/strong>/g)].map(
      (match) => match[1],
    );
    expect(strongContents.length).toBeGreaterThan(0);
    expect(strongContents.some((content) => content!.includes(phrase))).toBe(false);
  });

  test.each([["ar"], ["en"]] as const)(
    "multi-plot unit lists bold each value, not the fixed copy (%s)",
    (locale) => {
      const html = buildContractHtml(multiPlotValues(locale), locale, FIXTURE_ISSUER);
      if (locale === "ar") {
        expect(html).toContain("<strong>3</strong> (الرقم الآلي <strong>111</strong>)");
        expect(html).toContain("في <strong>مجمع دانة -1</strong>");
        expect(html).toContain("</strong>، و <strong>");
        expect(html).not.toContain("<strong>الرقم الآلي");
      } else {
        expect(html).toContain("<strong>Shop 3</strong> (PACI No. <strong>111</strong>)");
        expect(html).toContain("in <strong>Danat -1</strong>");
        expect(html).toContain("</strong>; and <strong>");
        expect(html).not.toContain("<strong>PACI");
      }
      expect(html).toContain(
        locale === "ar" ? "<strong>مجمع دانة -2</strong>" : "<strong>Danat -2</strong>",
      );
    },
  );

  test.each([["ar"], ["en"]] as const)(
    "a typed marker prints as plain text with no extra <strong> (%s)",
    (locale) => {
      const tainted = `A${BOLD_OPEN}x${BOLD_CLOSE}B`;
      const plots = [
        { id: "plot-a", name_ar: `مجمع${tainted}`, name_en: `Complex${tainted}` },
        { id: "plot-b", name_ar: "مجمع دانة -2", name_en: "Danat -2" },
      ];
      const units = [
        {
          unit_id: "u-1",
          property_id: "plot-a",
          unit_number: `3${tainted}`,
          unit_number_en: "",
          paci_no: `111${tainted}`,
        },
        {
          unit_id: "u-2",
          property_id: "plot-b",
          unit_number: "7",
          unit_number_en: "",
          paci_no: "222",
        },
      ];
      const individual = validContractValues({
        language: locale,
        persons: [
          {
            full_name: `Name${tainted}`,
            nationality: "كويتي",
            civil_id: "264010900749",
            residence_address: "النعيم",
          },
        ],
        plots,
        units,
      });
      const clean = validContractValues({
        language: locale,
        persons: [
          {
            full_name: "NameAxB",
            nationality: "كويتي",
            civil_id: "264010900749",
            residence_address: "النعيم",
          },
        ],
        plots: [
          { id: "plot-a", name_ar: "مجمعAxB", name_en: "ComplexAxB" },
          { id: "plot-b", name_ar: "مجمع دانة -2", name_en: "Danat -2" },
        ],
        units: [
          {
            unit_id: "u-1",
            property_id: "plot-a",
            unit_number: "3AxB",
            unit_number_en: "",
            paci_no: "111AxB",
          },
          {
            unit_id: "u-2",
            property_id: "plot-b",
            unit_number: "7",
            unit_number_en: "",
            paci_no: "222",
          },
        ],
      });
      const taintedHtml = buildContractHtml(individual, locale, FIXTURE_ISSUER);
      expect(taintedHtml).not.toContain(BOLD_OPEN);
      expect(taintedHtml).not.toContain(BOLD_CLOSE);
      expect(taintedHtml).toContain("<strong>NameAxB</strong>");
      expect(taintedHtml).toContain("<strong>111AxB</strong>");
      expect(countStrong(taintedHtml)).toBe(
        countStrong(buildContractHtml(clean, locale, FIXTURE_ISSUER)),
      );
      const companyHtml = buildContractHtml(
        validCompanyContractValues({
          language: locale,
          company: { ...FIXTURE_COMPANY, company_name: `Co${tainted}` },
          plots,
          units,
        }),
        locale,
        FIXTURE_ISSUER,
      );
      expect(companyHtml).not.toContain(BOLD_OPEN);
      expect(companyHtml).not.toContain(BOLD_CLOSE);
      expect(companyHtml).toContain("<strong>CoAxB</strong>");
    },
  );

  test.each([
    ["ar", CONTRACT_COPY_AR],
    ["en", CONTRACT_COPY_EN],
  ] as const)(
    "page one just under the dense threshold keeps the roomy size (%s)",
    (locale, copy) => {
      const values = justUnderDenseValues(locale);
      const ctx = buildClauseContext(values, locale);
      expect(pageOneIsDense(ctx, copy, locale)).toBe(false);
      expect(buildContractHtml(values, locale, FIXTURE_ISSUER)).not.toMatch(
        /contract-sheet--p1 contract-sheet--dense/,
      );
      const measured = [
        ...copy.secondParty(ctx),
        copy.preamble(ctx),
        ...copy.clauses(ctx)[1]!.body,
      ].join("");
      expect(measured.length).toBeGreaterThan(stripBoldMarkers(measured).length);
    },
  );

  test.each([["ar"], ["en"]] as const)(
    "signature blocks bold the names, not the role labels (%s)",
    (locale) => {
      const values = validContractValues({
        language: locale,
        persons: [
          {
            full_name: "Sig Person",
            nationality: "Kuwaiti",
            civil_id: "264010900749",
            residence_address: "Somewhere",
          },
        ],
      });
      const page5 = pagesOf(
        wrapHtmlForPdf(buildContractHtml(values, locale, FIXTURE_ISSUER), {
          arabic: locale === "ar",
        }),
      )[5]!;
      expect(page5).toContain("<strong>Sig Person</strong>");
      const roleLabel = locale === "ar" ? "الاسم :-" : "Name:-";
      const signatureLabel = locale === "ar" ? "التوقيع :-" : "Signature:-";
      for (const label of [roleLabel, signatureLabel]) {
        expect(page5).toContain(label);
        expect(page5).not.toContain(`<strong>${label}`);
        expect(page5).not.toContain(`${label}</strong>`);
      }
    },
  );

  test.each([["ar"], ["en"]] as const)(
    "company signature block bolds the company and signatory names (%s)",
    (locale) => {
      const html = buildContractHtml(
        validCompanyContractValues({ language: locale }),
        locale,
        FIXTURE_ISSUER,
      );
      expect(html).toContain(`<strong>${esc(FIXTURE_COMPANY.company_name)}</strong>`);
      expect(html).toContain(`<strong>${esc(FIXTURE_COMPANY.signatory_name)}</strong>`);
      const signatoryLabel = locale === "ar" ? "المفوض بالتوقيع :-" : "Authorized signatory:-";
      expect(html).toContain(signatoryLabel);
      expect(html).not.toContain(`<strong>${signatoryLabel}`);
    },
  );

  test("signatures sit after the last clause with room below, not pinned to the footer", () => {
    const rule = cssRule(
      buildContractHtml(validContractValues(), "ar", FIXTURE_ISSUER),
      ".contract-signatures",
    );
    expect(rule).toContain("margin-bottom: auto");
    expect(rule).not.toContain("margin-top: auto");
  });

  test("the header logo keeps the owner's 60px height", () => {
    const rule = cssRule(
      buildContractHtml(validContractValues(), "ar", FIXTURE_ISSUER),
      ".contract-header img",
    );
    expect(rule).toContain("height: 60px");
  });
});
