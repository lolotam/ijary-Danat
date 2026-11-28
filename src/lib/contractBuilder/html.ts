import { renderBold, stripBoldMarkers } from "./boldMarkers";
import { CONTRACT_COPY_AR } from "./clauses.ar";
import { CONTRACT_COPY_EN } from "./clauses.en";
import type { ClauseContext, ClauseText, ContractCopy } from "./clauses.types";
import type { ContractIssuer } from "./issuer";
import {
  amountInWordsAr,
  amountInWordsEn,
  dayNameAr,
  dayNameEn,
  durationWordsAr,
  durationWordsEn,
  isRealCalendarDate,
} from "./numberToWords";
import { PRINTED_DOCUMENT_CSS } from "@/lib/printedDocument";
import { CAIRO_PUBLIC_FONTS_BASE, PDF_FONT_STACK, cairoFontFace } from "@/lib/documentFonts";
import { toFils, totalValueFils, type ContractBuilderValues, type ContractLocale } from "./schema";
import { formatUnitList, spansSeveralPlots } from "./units";

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * يحوّل الرموز الخاصة إلى كيانات HTML مرة واحدة عند موضع الاستيفاء.
 */
export function esc(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (char) => ESCAPE_MAP[char] ?? char);
}

/**
 * يهرّب النص ثم يحوّل علامات الخط العريض إلى وسوم، بعد التهريب لا قبله.
 *
 * Markers are control characters, so escaping cannot turn them into entities
 * and a value cannot smuggle a tag through them.
 */
function escB(value: string | number): string {
  return renderBold(esc(value));
}

/**
 * يزيل علامات الخط العريض من كل نص في قيم العقد قبل بناء السياق.
 *
 * One entry point: clause helpers and the signature blocks both read the
 * context, and the Zod schemas do not share a string sanitizer.
 */
function stripBoldMarkersDeep<T>(value: T): T {
  if (typeof value === "string") return stripBoldMarkers(value) as T;
  if (Array.isArray(value)) return value.map((item) => stripBoldMarkersDeep(item)) as T;
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = stripBoldMarkersDeep(item);
    }
    return copy as T;
  }
  return value;
}

/**
 * يبني سياق البنود: كلمات المبلغ والمدة واليوم وقائمة الوحدات.
 *
 * Draft preview may pass NaN amounts and an empty date; those become zero /
 * a blank day name so the iframe still paints.
 */
export function buildClauseContext(
  values: ContractBuilderValues,
  locale: ContractLocale,
): ClauseContext {
  const monthly = Number.isFinite(values.monthly_value) ? values.monthly_value : 0;
  const months = Number.isFinite(values.duration_months) ? values.duration_months : 0;
  // Dropped here so the contact fields never enter the context at runtime
  // either, not only in its type (see ClauseContext).
  const { contact_mobile: _m, contact_whatsapp: _w, contact_email: _e, ...printable } = values;
  const safeValues = { ...printable, monthly_value: monthly, duration_months: months };
  const hasDate = isRealCalendarDate(values.contract_date);
  return {
    ...safeValues,
    totalWords:
      locale === "ar"
        ? amountInWordsAr(totalValueFils(safeValues))
        : amountInWordsEn(totalValueFils(safeValues)),
    monthlyWords:
      locale === "ar" ? amountInWordsAr(toFils(monthly)) : amountInWordsEn(toFils(monthly)),
    durationWords: locale === "ar" ? durationWordsAr(months) : durationWordsEn(months),
    dayName: hasDate
      ? locale === "ar"
        ? dayNameAr(values.contract_date)
        : dayNameEn(values.contract_date)
      : "",
    unitList: formatUnitList(values, locale),
    multiPlot: spansSeveralPlots(values),
  };
}

const contractBuilderCss = `
  /* The sample contract is printed to the edge of the sheet; the shared PDF
     base CSS uses a 12mm @page margin, which costs this five-page layout a
     whole page of text. 8mm keeps the bands where the scan has them. */
  @page { size: A4; margin: 8mm; }
  .contract-sheet.doc-page {
    box-sizing: border-box;
    /* Thinner top and bottom bands (owner, 2026-09-29). Side inset stays
       10mm, and the 8mm @page margin plus min-height below stay put so the
       page box and the five-page split do not move. */
    padding: 3mm 10mm 4mm;
    /* Pages 2-5 hold fixed clause text, so their size is chosen to fill the
       sheet: at 12.5px they ended in 50-125mm of blank band. Arabic sets
       denser than the English translation, hence the larger Arabic size
       (EN_CSS below). Measured on Chromium at the content limits. */
    font-size: 15.5px;
    line-height: 1.52;
    /* A4 is 297mm and SERVER_PDF_BASE_CSS sets a 12mm @page margin, so the
       printable box is 281mm at the 8mm @page margin above: a taller sheet
       spills every page in two. */
    min-height: 274mm;
    display: flex;
    flex-direction: column;
    page-break-after: always;
    break-after: page;
  }
  .contract-sheet.doc-page:last-of-type {
    page-break-after: auto;
    break-after: auto;
  }
  /* Page 1 carries the parties and the property block, the only page whose
     length depends on the form. A typical contract takes the roomy size. One
     whose front matter passes PAGE_ONE_DENSE_AT is "dense": page 1 drops to
     the compact size and hands clause 2 to page 2, which takes a compact
     size too (see pageOneIsDense). */
  .contract-sheet.doc-page.contract-sheet--p1 {
    font-size: 13px;
    line-height: 1.52;
  }
  .contract-sheet.doc-page.contract-sheet--p1.contract-sheet--dense {
    font-size: 12px;
    line-height: 1.45;
  }
  .contract-sheet.doc-page.contract-sheet--p2.contract-sheet--dense {
    font-size: 13px;
  }
  .contract-body {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .contract-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 3px solid #1e5aa8;
    /* Logo height and this letterhead size are what set the band; both came
       down so the blue rule sits higher (owner, 2026-09-29). */
    padding-bottom: 2px;
    margin-bottom: 4px;
  }
  .contract-header img {
    width: 90px;
    height: 60px;
    object-fit: contain;
    flex-shrink: 0;
  }
  .contract-company {
    /* Cairo is vendored for this letterhead line (spec item 11); the rest of
       the stack is the document stack so a missing face degrades exactly like
       every other line of the sheet. 26px keeps the line from forcing the
       band taller than the 60px logo. */
    font-family: 'Cairo', 'Tajawal', ${PDF_FONT_STACK};
    font-size: 26px;
    font-weight: 800;
    color: #1e5aa8;
    line-height: 1.2;
  }
  .contract-title {
    text-align: center;
    font-size: 22px;
    font-weight: 800;
    text-decoration: underline;
    margin: 4px 0 6px;
  }
  .contract-clause {
    margin: 0 0 6px;
  }
  .contract-clause h2 {
    margin: 0 0 2px;
    font-size: 13px;
    font-weight: 800;
    text-align: center;
  }
  .contract-clause p {
    margin: 0 0 3px;
    text-align: justify;
  }
  .contract-footer-band {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    text-align: center;
    align-items: baseline;
    column-gap: 24px;
    border-top: 3px solid #1e5aa8;
    margin-top: auto;
    /* Shorter footer band (owner, 2026-09-29). */
    padding-top: 4px;
    font-size: 13px;
    color: #1e5aa8;
  }
  .contract-signatures {
    /* Owner 2026-09-29: names and signatures sit directly after the last
       clause, with room to sign, rather than pinned to the footer. This
       supersedes the earlier "foot of page 5" choice. margin-bottom: auto
       leaves the sheet's spare height below the blocks. The gap is a fixed
       margin, not padding, so it does not collapse into the flex auto margin. */
    margin-top: 28px;
    margin-bottom: auto;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 16px;
    padding-top: 0;
  }
  .contract-signatures .signature-block {
    min-width: 180px;
    flex: 1;
  }
  /* The last row of each block is the signature line; 36px is the pen room. */
  .contract-signatures .signature-block > div:last-child {
    min-height: 36px;
  }
`;

/**
 * يغلّف محتوى صفحة واحدة بالترويسة الزرقاء والتذييل وعداد الصفحات.
 */
function pageShell(
  n: number,
  of: number,
  inner: string,
  copy: ContractCopy,
  issuer: ContractIssuer,
  dense = false,
): string {
  // No logo set, or the server could not fetch it: no <img> at all, rather
  // than a broken image or another company's logo.
  const logo = issuer.logoUrl
    ? `<img src="${esc(issuer.logoUrl)}" alt="${esc(issuer.name)}" />`
    : "";
  return `<section class="doc-page contract-sheet contract-sheet--p${n}${dense ? " contract-sheet--dense" : ""}">
  <header class="contract-header">
    ${logo}
    <div class="contract-company">${esc(issuer.name)}</div>
  </header>
  <div class="contract-body">${inner}</div>
  <footer class="contract-footer-band">
    <span>${esc(copy.footer(issuer))}</span>
    <span>${esc(copy.pageCounter(n, of))}</span>
  </footer>
</section>`;
}

/**
 * يحوّل بنداً إلى HTML بعد تهريب كل فقرة مرة واحدة.
 *
 * Titles are fixed copy. Paragraphs may carry bold markers, which become
 * `<strong>` only after escaping so a value cannot inject a tag.
 */
function renderClause(clause: ClauseText): string {
  const paragraphs = clause.body.map((paragraph) => `<p>${escB(paragraph)}</p>`).join("");
  return `<article class="contract-clause"><h2>${esc(clause.title)}</h2>${paragraphs}</article>`;
}

/**
 * يبني كتلة توقيع الطرف الثاني: كتلة لكل شخص، أو كتلة واحدة للشركة ومفوضها.
 *
 * The company name, the signatory and each person's name are form values, so
 * they are bold; the role labels stay plain.
 */
function renderSecondPartySignatures(ctx: ClauseContext, copy: ContractCopy): string {
  if (ctx.second_party_type === "company") {
    return `<div class="signature-block" data-testid="signature-block">
    <div>${esc(copy.signatures.secondParty)}</div>
    <div><strong>${esc(ctx.company.company_name)}</strong></div>
    <div>${esc(copy.signatures.authorizedSignatory)} <strong>${esc(ctx.company.signatory_name)}</strong></div>
    <div>${esc(copy.signatures.signature)}</div>
  </div>`;
  }
  return ctx.persons
    .map(
      (person) => `<div class="signature-block" data-testid="signature-block">
    <div>${esc(copy.signatures.secondParty)}</div>
    <div><strong>${esc(person.full_name)}</strong></div>
    <div>${esc(copy.signatures.name)}</div>
    <div>${esc(copy.signatures.signature)}</div>
  </div>`,
    )
    .join("");
}

/**
 * يبني صفحة التوقيعات: الطرف الأول ثم كتل الطرف الثاني.
 */
function renderSignatures(ctx: ClauseContext, copy: ContractCopy, issuer: ContractIssuer): string {
  const first = `<div class="signature-block">
    <div>${esc(copy.signatures.firstParty)}</div>
    <div>${esc(issuer.name)}</div>
    <div>${esc(copy.signatures.name)}</div>
    <div>${esc(copy.signatures.signature)}</div>
  </div>`;
  return `<div class="contract-signatures">${first}${renderSecondPartySignatures(ctx, copy)}</div>`;
}

/**
 * يبني مقدمة الصفحة الأولى: العنوان والافتتاح والطرفان والتمهيد.
 *
 * Opening, second-party lines and the preamble carry marked values. The
 * title, first-party letterhead and headings are fixed copy and stay plain.
 */
function renderFrontMatter(ctx: ClauseContext, copy: ContractCopy, issuer: ContractIssuer): string {
  const second = copy
    .secondParty(ctx)
    .map((line) => `<p>${escB(line)}</p>`)
    .join("");
  return `<h1 class="contract-title">${esc(copy.title)}</h1>
<p>${escB(copy.opening(ctx))}</p>
<p>${esc(copy.firstParty(issuer))}</p>
<p>${esc(copy.secondPartyHeading)}</p>
${second}
<h2 class="contract-title">${esc(copy.preambleTitle)}</h2>
<p>${escB(copy.preamble(ctx))}</p>`;
}

/** أحجام النسخة الإنجليزية: الترجمة أطول من العربية فتأخذ خطاً أصغر لتبقى خمس صفحات. */
const EN_CSS = `
  .contract-sheet.doc-page { font-size: 13px; }
  .contract-sheet.doc-page.contract-sheet--p1 { font-size: 12px; }
  .contract-sheet.doc-page.contract-sheet--p1.contract-sheet--dense { font-size: 11.5px; }
  .contract-sheet.doc-page.contract-sheet--p2.contract-sheet--dense { font-size: 11px; }
`;

/**
 * طول نص الصفحة الأولى المتغير بالأحرف، وهو الأساس لاختيار حجم خطها.
 *
 * The parties, the preamble and clause 2 are the only page-1 text that grows
 * with the form; everything else on the page is fixed copy. Bold markers are
 * not characters the reader sees, so they must not push a short contract into
 * the dense size.
 */
function pageOneVariableLength(ctx: ClauseContext, copy: ContractCopy): number {
  const clause2 = copy.clauses(ctx)[1]!.body;
  const parts = [...copy.secondParty(ctx), copy.preamble(ctx), ...clause2].map(stripBoldMarkers);
  return parts.join("").length;
}

/**
 * الحد الذي تنتقل عنده الصفحة الأولى إلى الخط المضغوط، لكل لغة.
 *
 * Set by rendering the worst paragraph shape (three persons, six plots, full
 * unit and PACI numbers) just under each value: Arabic overflowed at 1900 and
 * fits at 1700. A typical contract is 1000-1500 characters, well inside the
 * roomy size. html.pdf.test.ts keeps that just-under case at five pages.
 */
const PAGE_ONE_DENSE_AT: Record<ContractLocale, number> = { ar: 1700, en: 2100 };

/**
 * يقرر هل تحتاج الصفحة الأولى إلى الخط المضغوط لتبقى الوثيقة خمس صفحات.
 */
export function pageOneIsDense(
  ctx: ClauseContext,
  copy: ContractCopy,
  locale: ContractLocale,
): boolean {
  return pageOneVariableLength(ctx, copy) > PAGE_ONE_DENSE_AT[locale];
}

/**
 * يبني مقطع HTML لخمس صفحات A4 من قيم العقد واللغة والشركة صاحبة العقد ومصدر الشعار.
 *
 * Sentinels are stripped here, before any clause reads a string, so a value
 * typed with a bold marker cannot open a tag of its own. The issuer is
 * stripped too: it comes from the company's settings, which staff can edit.
 */
export function buildContractHtml(
  values: ContractBuilderValues,
  locale: ContractLocale,
  issuerInput: ContractIssuer,
): string {
  const copy = locale === "ar" ? CONTRACT_COPY_AR : CONTRACT_COPY_EN;
  const ctx = buildClauseContext(stripBoldMarkersDeep(values), locale);
  const issuer = stripBoldMarkersDeep(issuerInput);
  const all = copy.clauses(ctx);
  // Clause 3 moved off page 1 so the parties block can grow (company mode,
  // multi-plot unit lists); the rest is balanced by measured clause heights.
  const dense = pageOneIsDense(ctx, copy, locale);
  const pageOneClauses = dense ? [0] : [0, 1];
  const pageTwoClauses = dense ? [1, 2, 3, 4] : [2, 3, 4];
  const page1 = `${renderFrontMatter(ctx, copy, issuer)}${pageOneClauses.map((i) => renderClause(all[i]!)).join("")}`;
  const page2 = pageTwoClauses.map((i) => renderClause(all[i]!)).join("");
  const page3 = [5, 6, 7, 8, 9].map((i) => renderClause(all[i]!)).join("");
  const page4 = [10, 11, 12, 13].map((i) => renderClause(all[i]!)).join("");
  const page5 = `${[14, 15, 16, 17].map((i) => renderClause(all[i]!)).join("")}${renderSignatures(ctx, copy, issuer)}`;
  const of = 5;
  // The browser base `/fonts` is what the preview iframe and the served app
  // resolve; wrapHtmlForPdf rewrites it to an absolute file:// URL before the
  // server renders the temp file (decision D6).
  return `<style>${cairoFontFace(CAIRO_PUBLIC_FONTS_BASE)}${PRINTED_DOCUMENT_CSS}${contractBuilderCss}${locale === "en" ? EN_CSS : ""}</style>
${pageShell(1, of, page1, copy, issuer, dense)}
${pageShell(2, of, page2, copy, issuer, dense)}
${pageShell(3, of, page3, copy, issuer)}
${pageShell(4, of, page4, copy, issuer)}
${pageShell(5, of, page5, copy, issuer)}`;
}
