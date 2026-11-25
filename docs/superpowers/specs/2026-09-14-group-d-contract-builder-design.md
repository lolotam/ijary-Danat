# Group D — contract builder (5-page investment contract PDF, Arabic and English)

Date: 2026-09-14. Branch: `feat/contract-builder` (cut from `main` after PR #200).
Lands as a pull request. No database migration.

Covers user task T9, phase 1: the form, the preview and the PDF. Creating a
tenant or a contract from the builder is a later phase and is out of scope.

## Source of truth

The five sample pages in `contract_sample/01.jpg … 05.jpg` (300 dpi scans of a
signed contract) and `contract_sample/danat logo.png`. Read in full on
2026-09-14. Everything on them is either **fixed text** or one of the
**variables** the user confirmed (below). The fixed clause text is
transcribed verbatim from the scans into the Arabic clause file; the English
clause file is a faithful translation the operator must review before legal
use (the PR body says so). `contract_sample/` is never staged.

## Page anatomy (all five pages)

- Header band: blue rule, logo left, the company name `شركة دانة المستقبل العقارية`
  large right. Footer band: `الجهراء – القيصرية – قطعة 20 – قسيمة 25 – مكتب 9 – تلفاكس: 24567177`
  and a blue rule. Page counter `Page n of 5` bottom right.
- Page 1: title `عقد استثمار`; opening line with the date; first party (fixed
  company + fixed office address); second party persons (list); the
  preamble (`{التمهيد}`) with the property, units, meters, activity and trade
  name; clauses 1, 2, 3.
- Page 2: clauses 4 (money), 5, 6.
- Page 3: clauses 7, 8 (a/b), 9, 10 (a/b).
- Page 4: clauses 11, 12, 13 (a/b/c), 14 (a–e).
- Page 5: clauses 15, 16, 17, 18; signature blocks: first party (company
  name, name/signature lines), second party (one block per person: name,
  name line, signature line).

Signatures and stamps on the scans are not reproduced; the signature lines
are blank.

## Variables (confirmed by the user)

| Group | Field | Notes |
|---|---|---|
| Date | `contract_date` (`YYYY-MM-DD`) | must be a real calendar date; the day name is computed for the Asia/Kuwait calendar day in the document locale (`الثلاثاء` / `Tuesday`) |
| Second party | `persons[]` (1–3) with `full_name`, `nationality`, `civil_id`, `residence_address` | `full_name`/`nationality` ≤ 48, `residence_address` ≤ 72, `civil_id` ≤ 16 |
| Property | `governorate`, `block`, `parcel`, `units[]` (1–6) with `unit_number` and `meter_number` | meters print as `(m1+m2)` after the unit numbers, matching the scan; `meter_number` optional; codes ≤ 16, `governorate`/`block`/`parcel` ≤ 24 |
| Activity | `activity`, `trade_name` | free text ≤ 88 characters |
| Term | `duration_months` (1–600), `notice_months` (default 3) | clause 3 prints years when `duration_months` is divisible by 12, otherwise months |
| Money | `monthly_value` (KWD, 3 decimals), `advance_months` (default 2), `grace_months` (default 2), `increase` optional `{ every_years, percent }`, `late_fee_percent` (default 5), `service_charge_monthly` (default 20) | clause 4; `total_value = monthly_value × duration_months` is derived, never typed; both amounts also in words |
| Locale | `language` ar \| en | which clause file renders |

**Content limits** (persons ≤ 3, units ≤ 6, the character caps above) exist
because the layout is five fixed A4 pages, and page 1 carries the whole
second-party list plus the preamble: past these caps clause 3 spills onto a
sixth page and the `Page n of 5` counter starts lying. Every cap was measured
on Chromium rather than guessed, with word-wrapped filler (a repeated single
character forms one unbreakable run and under-measures the real layout), and
the binding case is **English**, whose translation runs about 10% longer than
the Arabic original. The page body is set at 11.5px inside an 8mm `@page`
margin for the same reason. A real-PDF page-count test renders both languages
at every field's maximum and asserts five pages, counting pages through
`pdfjs` — Chromium compresses the page tree into object streams once the logo
is embedded, so grepping the bytes for `/Type /Page` counts zero on a perfectly
good file.

**Money range.** `monthly_value` is capped at 999,999.999 KWD so the largest
possible total (× 600 months) stays inside the Arabic converter's supported
range; a larger cap would silently drop leading digits from the written total.
Printed amounts are formatted from integer fils, never from a float
multiplication, so `0.100 × 3` prints `0.300` and not `0.30000000000000004`.

**Money precision.** All amounts are integer fils internally
(`Math.round(kwd * 1000)`); the schema requires `multipleOf: 0.001` and
`max: 9_999_999.999`. Words are produced from the fils integer, so
`1250.500` yields `ألف ومائتان وخمسون ديناراً وخمسمائة فلس` and never a
floating-point remainder.

**Arabic number words** follow a grammar table in `numberToWords.ts`:

| count | dinar | thousand | year | month |
|---|---|---|---|---|
| 1 | دينار واحد | ألف | سنة واحدة | شهر واحد |
| 2 | ديناران | ألفان | سنتان | شهران |
| 3–10 | دنانير (after the number: ثلاثة دنانير) | آلاف | سنوات | أشهر |
| 11–99 (by the last two digits) | ديناراً | ألف | سنة | شهراً |
| exact hundreds/thousands/millions (count mod 100 = 0, e.g. 2,500 or 30,000) | دينار | ألف | سنة | شهر |

English: `one Kuwaiti dinar` / `two Kuwaiti dinars`, `one year` / `two years`,
`one month` / `two months`; fils appended as `and five hundred fils`.

## Architecture

All under `src/lib/contractBuilder/` (each file under 500 lines):

| File | Responsibility |
|---|---|
| `schema.ts` | `contractBuilderSchema` (strict, used by the server fn and the download button), `contractBuilderDraftSchema` (lenient: same shape, every string may be empty, numbers may be `NaN`; used by the live preview so a half-filled form still renders), `ContractBuilderValues`, `contractBuilderDefaults` (a draft, not a valid document: empty strings, one empty person, one empty unit, the numeric defaults 3/2/2/5/20) |
| `clauses.ar.ts` | the fixed Arabic text: `OPENING`, `PREAMBLE`, `CLAUSES[1..18]` as functions of the values, header/footer/signature strings |
| `clauses.en.ts` | the English equivalents, same shape |
| `numberToWords.ts` | `amountInWordsAr(fils)`, `amountInWordsEn(fils)`, `durationWordsAr(months)`, `durationWordsEn(months)`, `dayNameAr(isoDate)`, `dayNameEn(isoDate)` |
| `html.ts` | `buildContractHtml(values, locale): string` — a **body fragment** of five `<section class="doc-page">` blocks with `page-break-after: always`, its own `<style>` (`PRINTED_DOCUMENT_CSS` from `src/lib/printedDocument.ts` plus `contractBuilderCss` for the blue bands). Every interpolated value passes through `esc()` (the `&<>"'` map) exactly once, at the interpolation site; clause files never escape. Takes `logoSrc: string` so the server passes the data URI and the browser passes the public URL |
| `logo.server.ts` | `CONTRACT_LOGO_DATA_URI` read once from `public/contract-builder/danat-logo.png` with `readFileSync` — server-only (imported by the server fn only) so Chromium never needs a network fetch; the preview iframe uses `/contract-builder/danat-logo.png` |
| `prefill.ts` | `prefillFromContract({ contract, tenant, units }): { values: Partial<ContractBuilderValues>; notices: PrefillNotice[] }` |

`wrapHtmlForPdf(fragment, { arabic })` (`src/lib/serverPdf.ts`) supplies the
document shell for the PDF; the preview iframe wraps the same fragment in a
minimal `<!doctype html><html dir lang>` shell in the route. The
`html.test.ts` suite renders through the real `wrapHtmlForPdf` so the
fragment/wrapper contract is exercised, not assumed.

### Prefill (`?contract=<uuid>`)

Reads `useContract(id)`, `useTenant(contract.tenant_id)` and
`useContractUnits(id)` (`src/hooks/useContractRelations.ts`). The form is
reset **once**, keyed by contract id, after all three reads succeeded; a
failed read shows the error line and leaves the blank form. Mapping:

- person 1: `tenant.name`, `tenant.nationality`, civil id from the **same
  entity as the name** — `owner_civil_id` when `owner_name` equals `name` or
  `authorized_manager` is empty, else `authorized_manager_civil_id`
  (never pair a manager's id with the owner's name); `residence_address` from
  `commercial_address`.
- property: `governorate` from the first unit's `property.address_ar`;
  `block`/`parcel`/meters blank (not stored).
- units: `unit_number` from `unit.name` (falls back to `unit.code`).
- `activity` from `contract.commercial_activity`; `trade_name` from
  `tenant.commercial_name_ar` (ar) / `commercial_name_en` (en) falling back to
  `commercial_name`.
- `duration_months` from `contract.duration_months` (blank when null);
  `monthly_value` from `contract.monthly_amount`; `contract_date` from
  `start_date`.
- increase: `increase_type = 'percent'` → `{ every_years: increase_after_years,
  percent: increase_value }`; `'fixed'` → left blank plus notice
  `increase_fixed_not_supported`.
- units spanning more than one property → property fields blank plus notice
  `multi_property`.

Notices render as an amber list above the form (i18n keys
`contractBuilder.notice.<code>`).

### Route and form

Route `src/routes/admin.contracts_.builder.tsx` (trailing underscore so the
contracts list route does not wrap it; see `admin.contracts_.$id.closeout.tsx`),
gated on `contracts.read`: a two-column page — `ContractBuilderForm`
(`src/components/admin/contracts/ContractBuilderForm.tsx`, react-hook-form +
Zod resolver on the strict schema, `persons` and `units` field arrays with
add/remove capped at 3/6, language toggle) and `ContractPreview`
(`src/components/admin/contracts/ContractPreview.tsx`: an `<iframe
sandbox="" srcDoc=…>` of the draft build, debounced 300 ms; the empty
`sandbox` attribute means no scripts, no same-origin). Entry points: a
"Contract builder" button in the contracts page header next to the export
buttons, and a per-row "Build contract" action on `ContractsTable` linking
with `?contract=`.

### PDF

Server fn `src/fns/renderContractPdf.ts`: `createServerFn({ method: "POST" })`
with `requireSupabaseAuth`, `inputValidator` on the strict schema plus
`locale`, permission `contracts.read` via `has_permission` (the constant
`contracts.export` exists only in `permissions.ts`; it is not a seeded
permission code, so gating on it would refuse every user — verdict 15 is
therefore applied as `contracts.read`), renders
`wrapHtmlForPdf(buildContractHtml(values, locale, CONTRACT_LOGO_DATA_URI), { arabic: locale === "ar" })`
through `renderHtmlToPdf` and returns
`new Response(pdf, { headers: { "content-type": "application/pdf", "content-disposition": "attachment; filename=…" } })`
— binary, not base64. The page calls it, reads `await response.blob()`,
creates an object URL, clicks a temporary anchor, and revokes the URL in
`finally`; a non-2xx response or a thrown error shows `toast.error` and
re-enables the button in `finally`. Filename:
`contract-<safeFilename(trade_name || persons[0].full_name)>-<contract_date>.pdf`
(`src/lib/safeFilename.ts`).

## Tests

Vitest only (no SQL):

- `numberToWords.test.ts`: fils inputs 0, 1000, 2000, 3000, 11000, 2_500_000,
  30_000_000, 1_250_500, 999_999_000 in both languages against the grammar
  table; `durationWordsAr/En` for 1, 2, 3, 11, 12, 24, 36, 13 months; day
  names for a known date (`2026-09-15` → الثلاثاء / Tuesday), computed for
  the Asia/Kuwait calendar day.
- `schema.test.ts`: a **valid fixture** (`validContractValues()`) passes the
  strict schema; the defaults fail it (they are a draft) and pass the draft
  schema; persons 0 and 4 rejected; units 0 and 7 rejected; `2026-02-30` and
  `2026-13-01` rejected; `monthly_value` 12.3456 rejected, 12.345 accepted;
  increase all-or-none; `total_value` is not an input.
- `html.test.ts` (through the real `wrapHtmlForPdf`): exactly five
  `doc-page` sections; each of the 18 clauses is asserted by a distinctive
  phrase from the scan on its page (a table `[clause, page, phrase]`); the
  date and every person on page 1; money words on page 2; one signature
  block per person on page 5; footer address and fax on all five pages;
  `Page 3 of 5`; the English build contains no Arabic script (`/[؀-ۿ]/`)
  outside the fixed company name and address, the Arabic build no clause
  English; a `full_name` of `<b>x</b>` renders escaped exactly once
  (`&lt;b&gt;` present, `&amp;lt;` absent).
- `html.pdf.test.ts` — gated on `existsSync(resolveChromiumPath())` (skipped
  with a reason otherwise): renders the valid fixture at the content limits
  (3 persons, 6 units, max-length strings) and asserts the PDF has exactly
  five pages (count `/Type /Page` objects that are not `/Pages`).
- `prefill.test.ts`: full mapping; owner vs manager civil-id pairing (both
  branches); fixed increase → blank + notice; two properties → blank + notice;
  null `duration_months` → blank.
- `renderContractPdf.test.ts`: export the schema and assert it directly
  (memory: validators are skipped by the mock); permission refused → 403;
  valid values → `renderHtmlToPdf` called with an `arabic: true` wrapper for
  `ar`; the response is `application/pdf` with a `content-disposition`
  carrying the computed filename.
- Route/component tests (static markup, hooks stubbed at the Supabase
  boundary): language toggle, add-person button disabled at 3 (`disabled=""`),
  preview iframe has `sandbox=""`, notices rendered from prefill.

## Debate — round 1 (Codex astra 6 high, read-only relay; tree verified unchanged)

| # | Finding | Sev | Verdict | Reason |
|---|---------|-----|---------|--------|
| 1 | Interpolated values unescaped → HTML/script injection into the PDF and preview | P1 | accept | `esc()` once at interpolation; sandboxed iframe; escape test. |
| 2 | `contractBuilderDefaults` were a valid document; the "defaults pass" test proved nothing | P2 | accept | Defaults are a draft; `validContractValues()` fixture; both asserted. |
| 3 | Unbounded persons/units/strings overflow the five fixed pages | P1 | accept | Limits in schema; Chromium page-count test at the limits. |
| 4 | Fragment vs full-document contract with `wrapHtmlForPdf` was ambiguous | P2 | accept | Fragment; tests go through the real wrapper. |
| 5 | Logo by public URL is unreachable from headless Chromium in the container | P1 | accept | Server-only data URI module; public URL for the preview. |
| 6 | Prefill could pair the manager's civil id with the owner's name | P2 | accept | Same-entity rule + tests for both branches. |
| 7 | `duration_years` loses non-annual contracts; total typed separately can disagree with monthly × months | P2 | accept | `duration_months` kept, years printed when divisible; total derived. |
| 8 | Multi-property contract prefilled the first property silently | P2 | accept | Blank + `multi_property` notice. |
| 9 | Float money into words | P2 | accept | Integer fils, `multipleOf 0.001`, max. |
| 10 | Arabic dual/plural grammar for dinar/thousand/year/month | P2 | accept | Grammar table + tests. |
| 11 | Prefill ignored contract increases | P2 | accept | Percent imported; fixed → notice. |
| 12 | Date validated by regex only; day name computed in UTC | P2 | accept | Real calendar check; Asia/Kuwait weekday; cross-day test. |
| 13 | Prefill reset on every re-render / before all reads finished | P2 | accept | Reset once per contract id after all three succeed. |
| 14 | Strict schema blocked the preview until the form was complete | P2 | accept | Draft schema for preview, strict for download. |
| 15 | Download should require the export permission | P2 | partial | `contracts.export` is not a seeded code (only 6 `contracts.*` codes exist in migration 03); gating on it would refuse everyone. `contracts.read`, same as the page. |
| 16 | Base64 round-trip doubles the payload | P2 | accept | Binary `Response`. |
| 17 | Download had no error path / leaked the object URL | P2 | accept | `toast.error`, `finally`, `revokeObjectURL`. |
| 18 | "Every clause present" test asserted numbers, not text | P2 | accept | Per-clause distinctive phrase table. |

## Out of scope

Creating tenants/contracts from the builder; storing generated contracts;
attaching the PDF to notifications; editing clause text per contract
(decision: fixed text).
