import { existsSync } from "node:fs";

import { expect, test } from "vitest";

import { CONTRACT_COPY_AR } from "./clauses.ar";
import { CONTRACT_COPY_EN } from "./clauses.en";
import { buildClauseContext, buildContractHtml, pageOneIsDense } from "./html";
import { CONTRACT_LOGO_DATA_URI } from "./logo.server";
import { CONTRACT_LIMITS, type SecondPartyType } from "./schema";
import { validContractValues } from "./schema.fixture";
import { renderHtmlToPdf, resolveChromiumPath, wrapHtmlForPdf } from "@/lib/serverPdf";

/**
 * يعدّ صفحات ملف PDF عبر pdfjs، لا بالبحث النصي.
 *
 * Chromium compresses the page tree into object streams once the document
 * carries the logo, so grepping for "/Type /Page" counts zero on a perfectly
 * good five-page file.
 */
async function pdfPageCount(pdf: Buffer): Promise<number> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: false,
  }).promise;
  const { numPages } = doc;
  await doc.cleanup();
  return numPages;
}

const chromium = existsSync(resolveChromiumPath());
const run = chromium ? test : test.skip;

/**
 * يملأ حقلاً بكلمات قابلة للكسر بطول الحد الأقصى.
 *
 * Repeated single characters form one unbreakable run and under-measure the
 * real layout, so the fixture fills with short words the way a person types.
 */
function wordFill(length: number, word: string): string {
  return Array.from({ length: Math.ceil(length / (word.length + 1)) }, () => word)
    .join(" ")
    .slice(0, length);
}

/**
 * يبني وثيقة عند حدود المحتوى: 3 أشخاص أو شركة ومفوض، و6 وحدات موزعة على
 * 6 قسائم (أطول صيغة لقائمة الوحدات)، وأقصى طول لكل حقل.
 */
function atLimits(locale: "ar" | "en", mode: SecondPartyType, scale = 1) {
  const word = locale === "ar" ? "محتوى" : "Content";
  const fill = (length: number) => wordFill(Math.floor(length * scale), word);
  const code = "9".repeat(CONTRACT_LIMITS.code);
  const civilId = "9".repeat(12);
  const plots = Array.from({ length: CONTRACT_LIMITS.units }, (_, index) => ({
    id: `plot-${index}`,
    name_ar: fill(CONTRACT_LIMITS.name),
    name_en: fill(CONTRACT_LIMITS.name),
  }));
  return validContractValues({
    language: locale,
    second_party_type: mode,
    persons: Array.from({ length: CONTRACT_LIMITS.persons }, () => ({
      full_name: fill(CONTRACT_LIMITS.name),
      nationality: fill(CONTRACT_LIMITS.name),
      civil_id: civilId,
      residence_address: fill(CONTRACT_LIMITS.address),
    })),
    company: {
      company_name: fill(CONTRACT_LIMITS.name),
      company_address: fill(CONTRACT_LIMITS.address),
      signatory_name: fill(CONTRACT_LIMITS.name),
      signatory_nationality: fill(CONTRACT_LIMITS.name),
      signatory_civil_id: civilId,
      signatory_address: fill(CONTRACT_LIMITS.address),
    },
    plots,
    governorate: fill(CONTRACT_LIMITS.place),
    block: fill(CONTRACT_LIMITS.place),
    parcel: fill(CONTRACT_LIMITS.place),
    units: plots.map((plot, index) => ({
      unit_id: `unit-${index}`,
      property_id: plot.id,
      unit_number: fill(CONTRACT_LIMITS.unitName),
      unit_number_en: fill(CONTRACT_LIMITS.unitName),
      paci_no: code,
    })),
    activity: fill(CONTRACT_LIMITS.longText),
    trade_name: fill(CONTRACT_LIMITS.longText),
    monthly_value: CONTRACT_LIMITS.monthlyMax,
    duration_months: CONTRACT_LIMITS.months,
  });
}

/**
 * يشغّل Chromium ويعيد المحاولة عند فشل التشغيل نفسه فقط، لا عند فشل التوقع.
 *
 * The same spawn flakiness serverPdf.test.ts documents: under a machine
 * running the whole suite the cold start intermittently fails, while alone it
 * takes about three seconds. Only a THROW is retried — the page count that
 * comes back is asserted exactly once, so a genuinely six-page document can
 * never be retried into a pass.
 */
async function renderWithSpawnRetry(html: string, attempts = 3): Promise<Buffer> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await renderHtmlToPdf(html);
    } catch (error) {
      if (attempt >= attempts) throw error;
    }
  }
}

run.each([
  ["ar", "individual"],
  ["ar", "company"],
  ["en", "individual"],
  ["en", "company"],
] as const)(
  "stays five pages at the content limits (%s, %s)",
  { timeout: 180_000 },
  async (locale, mode) => {
    const html = wrapHtmlForPdf(
      buildContractHtml(atLimits(locale, mode), locale, CONTRACT_LOGO_DATA_URI),
      { arabic: locale === "ar" },
    );
    expect(await pdfPageCount(await renderWithSpawnRetry(html))).toBe(5);
  },
);

/**
 * يصغّر حقول وثيقة الحدود حتى يصل نص الصفحة الأولى إلى ما دون عتبة الضغط مباشرة.
 *
 * This is the heaviest page 1 that still takes the roomy size, so it is the
 * case that proves PAGE_ONE_DENSE_AT is set low enough.
 */
function justUnderDenseThreshold(locale: "ar" | "en") {
  const copy = locale === "ar" ? CONTRACT_COPY_AR : CONTRACT_COPY_EN;
  for (let scale = 1; scale > 0; scale -= 0.01) {
    const values = atLimits(locale, "individual", scale);
    if (!pageOneIsDense(buildClauseContext(values, locale), copy, locale)) return values;
  }
  throw new Error("no roomy variant found");
}

run.each([["ar"], ["en"]] as const)(
  "the roomy page 1 still fits just under the dense threshold (%s)",
  { timeout: 180_000 },
  async (locale) => {
    const values = justUnderDenseThreshold(locale);
    const html = buildContractHtml(values, locale, CONTRACT_LOGO_DATA_URI);
    expect(html).not.toMatch(/<section[^>]*contract-sheet--dense/);
    const pdf = await renderWithSpawnRetry(wrapHtmlForPdf(html, { arabic: locale === "ar" }));
    expect(await pdfPageCount(pdf)).toBe(5);
  },
);

test.each([["ar"], ["en"]] as const)(
  "the content-limits document is dense, so the just-under search really shrinks it (%s)",
  (locale) => {
    const copy = locale === "ar" ? CONTRACT_COPY_AR : CONTRACT_COPY_EN;
    const values = atLimits(locale, "individual");
    expect(pageOneIsDense(buildClauseContext(values, locale), copy, locale)).toBe(true);
  },
);
