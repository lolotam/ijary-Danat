# Group D — Contract Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin page that turns a form of confirmed variables into the company's five-page investment contract, live-previewed and downloadable as a correctly shaped Arabic or English PDF.

**Architecture:** Pure builder modules under `src/lib/contractBuilder/` (schema, number words, clause text per language, HTML fragment, prefill) with no I/O; one POST server function renders the fragment through the existing Chromium path and streams the PDF; one route hosts the form and a sandboxed preview iframe.

**Tech Stack:** TanStack Start + React 19, react-hook-form + Zod, Radix/shadcn, `renderHtmlToPdf`/`wrapHtmlForPdf` (`src/lib/serverPdf.ts`), `PRINTED_DOCUMENT_CSS` (`src/lib/printedDocument.ts`), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-group-d-contract-builder-design.md`

## Global Constraints

- Every new file stays under 500–600 lines. Clause text is long: `clauses.ar.ts` and `clauses.en.ts` each hold 18 clauses; if either passes 500 lines split into `clauses.ar.1-9.ts` / `clauses.ar.10-18.ts` re-exported from `clauses.ar.ts`.
- Every function gets a doc comment above it that leads with an Arabic description; English may follow for the *why*.
- No database migration and no new dependency. `contract_sample/` is never staged; the logo lives at `public/contract-builder/danat-logo.png` (already in the worktree, untracked — include it in the delivery).
- Every interpolated value is escaped **once** through `esc()` at the interpolation site in `html.ts`; clause files return plain strings and never escape.
- Money is integer fils internally. Words are computed from fils.
- Mocks only at boundaries (Supabase client, `renderHtmlToPdf`). Never mock a module under `src/lib/contractBuilder`. Tests assert `disabled=""` on buttons, never a class; no empty test bodies. Export every Zod schema used by a server fn and assert it directly (the `createServerFn` mock skips validators).
- Implementers do not commit. The orchestrator commits.
- Gates before handing back: `bun run lint`, `bun run typecheck`, `bun run test`.
- Fallback direction from the user, verbatim: "If any model goes out of quota (like GLM5.3 ), continue and delegate to Codex Astra 6 medium effort."

---

## File structure

| Path | Responsibility |
|---|---|
| `src/lib/contractBuilder/schema.ts` | strict + draft schemas, types, defaults, limits, fils helpers |
| `src/lib/contractBuilder/schema.fixture.ts` | `validContractValues()` for tests |
| `src/lib/contractBuilder/numberToWords.ts` | fils → words (ar/en), duration words, Kuwait weekday, real-date check |
| `src/lib/contractBuilder/clauses.ar.ts`, `clauses.en.ts` | fixed text as functions of values |
| `src/lib/contractBuilder/html.ts` | `esc`, `buildClauseContext`, `buildContractHtml(values, locale, logoSrc)` |
| `src/lib/contractBuilder/logo.server.ts` | `CONTRACT_LOGO_DATA_URI` |
| `src/lib/contractBuilder/prefill.ts` | `prefillFromContract` |
| `src/fns/renderContractPdf.ts` | POST server fn → binary PDF `Response` |
| `src/components/admin/contracts/ContractBuilderForm.tsx`, `ContractPreview.tsx` | form and iframe |
| `src/routes/admin.contracts_.builder.tsx` | page, prefill, download |
| `src/routes/admin.contracts.tsx`, `src/components/admin/contracts/ContractsTable.tsx` | entry points |
| `src/i18n/dictionary.ts` | `contractBuilder.*` keys in both locales |

---

### Task 1: Schema, fixture and number words

**Files:** create `src/lib/contractBuilder/schema.ts`, `schema.fixture.ts`, `numberToWords.ts`; tests `schema.test.ts`, `numberToWords.test.ts`.

**Interfaces (produces):**

```ts
export type ContractLocale = "ar" | "en";
export type ContractPerson = { full_name: string; nationality: string; civil_id: string; residence_address: string };
export type ContractUnitLine = { unit_number: string; meter_number: string };
export type ContractBuilderValues = {
  language: ContractLocale; contract_date: string; persons: ContractPerson[];
  governorate: string; block: string; parcel: string; units: ContractUnitLine[];
  activity: string; trade_name: string; duration_months: number; notice_months: number;
  monthly_value: number; advance_months: number; grace_months: number;
  increase: { every_years: number; percent: number } | null;
  late_fee_percent: number; service_charge_monthly: number;
};
export const contractBuilderSchema: z.ZodType<ContractBuilderValues>;   // strict
export const contractBuilderDraftSchema: z.ZodType<ContractBuilderValues>; // lenient
export const contractBuilderDefaults: ContractBuilderValues;              // a DRAFT
export const CONTRACT_LIMITS = { persons: 3, units: 6, code: 16, name: 48, place: 24, address: 72, longText: 88, months: 600, monthlyMax: 999_999.999 } as const; // every cap measured on Chromium so five pages hold in BOTH languages
export const FIELD_MAX_LENGTH: Record<string, number>; // per-field cap the form's maxLength reads
export function formatKwdFromFils(fils: number): string; // printed amounts never come from a float multiply
export function toFils(kwd: number): number;        // Math.round(kwd * 1000)
export function totalValueFils(v: ContractBuilderValues): number; // toFils(monthly_value) * duration_months
export function validContractValues(overrides?: Partial<ContractBuilderValues>): ContractBuilderValues; // schema.fixture.ts
export function amountInWordsAr(fils: number): string;
export function amountInWordsEn(fils: number): string;
export function durationWordsAr(months: number): string;
export function durationWordsEn(months: number): string;
export function dayNameAr(isoDate: string): string;   // Asia/Kuwait weekday
export function dayNameEn(isoDate: string): string;
export function isRealCalendarDate(isoDate: string): boolean;
```

- [ ] **Step 1: Write the failing tests**

`numberToWords.test.ts` (`test.each` tables):

| fils | ar | en |
|---|---|---|
| 0 | `صفر دينار كويتي` | `zero Kuwaiti dinars` |
| 1000 | `دينار كويتي واحد` | `one Kuwaiti dinar` |
| 2000 | `ديناران كويتيان` | `two Kuwaiti dinars` |
| 3000 | `ثلاثة دنانير كويتية` | `three Kuwaiti dinars` |
| 11000 | `أحد عشر ديناراً كويتياً` | `eleven Kuwaiti dinars` |
| 2_500_000 | `ألفان وخمسمائة دينار كويتي` | `two thousand five hundred Kuwaiti dinars` |
| 30_000_000 | `ثلاثون ألف دينار كويتي` | `thirty thousand Kuwaiti dinars` |
| 1_250_500 | `ألف ومائتان وخمسون ديناراً كويتياً وخمسمائة فلس` | `one thousand two hundred fifty Kuwaiti dinars and five hundred fils` |
| 999_999_000 | starts with `تسعمائة وتسعة وتسعون مليون` | starts with `nine hundred ninety-nine million` |

`durationWordsAr` / `durationWordsEn`:

| months | ar | en |
|---|---|---|
| 1 | `شهر واحد` | `one month` |
| 2 | `شهران` | `two months` |
| 3 | `ثلاثة أشهر` | `three months` |
| 11 | `أحد عشر شهراً` | `eleven months` |
| 12 | `سنة واحدة` | `one year` |
| 13 | `ثلاثة عشر شهراً` | `thirteen months` |
| 24 | `سنتان` | `two years` |
| 36 | `ثلاث سنوات` | `three years` |

Day names: `2026-09-15` → `الثلاثاء` / `Tuesday`. `isRealCalendarDate`: `2026-02-30` false, `2026-13-01` false, `2024-02-29` true, `2026-02-29` false.

`schema.test.ts`: `validContractValues()` passes strict; `contractBuilderDefaults` fails strict and passes draft; persons `[]` and 4 persons rejected; units `[]` and 7 rejected; `contract_date: "2026-02-30"` rejected; `monthly_value: 12.3456` rejected, `12.345` accepted, `10_000_000` rejected; `increase: { every_years: 1 } as never` rejected; `totalValueFils(validContractValues({ monthly_value: 1250.5, duration_months: 12 }))` is `15_006_000`; a 121-character `full_name` rejected.

- [ ] **Step 2: Run** `bun run test -- src/lib/contractBuilder` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement**
  - Strict schema: `z.object` with `.min(1).max(CONTRACT_LIMITS.persons)` arrays, `.min(1).max(120)`/`.max(200)` strings, `contract_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealCalendarDate)`, `monthly_value: z.number().positive().max(9_999_999.999).multipleOf(0.001)`, `duration_months: z.number().int().min(1).max(600)`, `notice_months/advance_months/grace_months: z.number().int().min(0).max(24)`, `late_fee_percent: z.number().min(0).max(100)`, `service_charge_monthly: z.number().min(0).multipleOf(0.001)`, `increase: z.object({ every_years: z.number().int().min(1).max(10), percent: z.number().positive().max(100) }).nullable()`.
  - Draft schema: same object with every string `z.string()` (no min) and every number `z.number().or(z.nan())`, arrays `.max()` only.
  - `isRealCalendarDate`: build `new Date(Date.UTC(y, m - 1, d))` and compare the three parts back.
  - `dayNameAr/En`: `new Intl.DateTimeFormat("ar-KW" | "en-GB", { weekday: "long", timeZone: "Asia/Kuwait" }).format(new Date(`${isoDate}T00:00:00+03:00`))`. Doc comment: Kuwait has no daylight saving, so the fixed offset is exact.
  - `amountInWordsAr`: integer words for 0–999,999,999 (units, tens joined with `و`, hundreds `مائة/مائتان/ثلاثمائة…`, thousands and millions with the dual/plural table in the spec), then the dinar form chosen by the whole-dinar count (1 → `دينار كويتي واحد`, 2 → `ديناران كويتيان`, 3–10 → `<n> دنانير كويتية`, otherwise `<n> ديناراً كويتياً`; 0 → `صفر دينار كويتي`), then `و<fils words> فلس` when fils > 0. English mirrors it (hyphen joins tens and units).
- [ ] **Step 4: Run** `bun run test -- src/lib/contractBuilder && bun run typecheck` — Expected: PASS.

---

### Task 2: Clause text (Arabic and English)

**Files:** create `src/lib/contractBuilder/clauses.ar.ts`, `clauses.en.ts`; test `clauses.test.ts`. Source: `contract_sample/01.jpg … 05.jpg` (open them with the image reader; transcribe verbatim, keep the numbering and the a/b/c sub-items).

**Interfaces (produces):**

```ts
export type ClauseContext = ContractBuilderValues & {
  totalWords: string; monthlyWords: string; durationWords: string; dayName: string;
  unitList: string;    // "3 و 4 (12345+67890)" — unit numbers joined, meters in parentheses joined with +
  personNames: string; // full names joined with " و " / " and "
};
export type ClauseText = { number: number; title: string; body: string[] }; // paragraphs; sub-items as separate strings prefixed "أ-" / "a."
export type ContractCopy = {
  companyName: string; officeAddress: string; footer: string; title: string;
  opening(ctx: ClauseContext): string; firstParty: string; secondParty(ctx: ClauseContext): string[];
  preambleTitle: string; preamble(ctx: ClauseContext): string;
  clauses(ctx: ClauseContext): ClauseText[]; // exactly 18, numbered 1..18
  signatures: { firstParty: string; secondParty: string; name: string; signature: string };
  pageCounter(n: number, of: number): string;
};
export const CONTRACT_COPY_AR: ContractCopy;
export const CONTRACT_COPY_EN: ContractCopy;
```

- [ ] **Step 1: Write the failing test** — `clauses.test.ts`: for both copies, `clauses(ctx)` returns 18 entries numbered 1..18 in order with non-empty bodies; clause 4 includes `ctx.totalWords` and `ctx.monthlyWords`; clause 3 includes `ctx.durationWords`; no returned string contains `<` or `>`; with `increase: null` clause 4 has no increase sentence, with an increase it names the percent.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — transcribe pages 1–5. Clause 4 interpolates `totalWords`, `monthlyWords`, `advance_months`, `grace_months`, `increase` (sentence omitted when null), `late_fee_percent`, `service_charge_monthly`. Clause 3 interpolates `durationWords` and `notice_months`. Every clause is a function of `ctx` even when it uses no variable (uniform shape).
- [ ] **Step 4: Run** `bun run test -- src/lib/contractBuilder/clauses.test.ts` — Expected: PASS. `wc -l` both files under 500 (split per the constraint if not).

---

### Task 3: HTML fragment and the real-PDF page count

**Files:** create `src/lib/contractBuilder/html.ts`, `logo.server.ts`; tests `html.test.ts`, `html.pdf.test.ts`. Read `src/lib/printedDocument.ts` (`PRINTED_DOCUMENT_CSS`, `doc-page`) and `src/lib/invoicePrintHtml.ts` (an existing builder) first.

**Interfaces (produces):**

```ts
export function esc(value: string | number): string;                        // & < > " '
export function buildClauseContext(values: ContractBuilderValues, locale: ContractLocale): ClauseContext;
export function buildContractHtml(values: ContractBuilderValues, locale: ContractLocale, logoSrc: string): string; // body fragment
export const CONTRACT_LOGO_PUBLIC_URL = "/contract-builder/danat-logo.png";
export const CONTRACT_LOGO_DATA_URI: string;                                // logo.server.ts
```

- [ ] **Step 1: Write the failing tests**
  - `html.test.ts` renders `wrapHtmlForPdf(buildContractHtml(validContractValues(), "ar", "data:,"), { arabic: true })` and asserts: starts with `<!DOCTYPE html>` and has `dir="rtl"`; `(html.match(/class="doc-page/g) ?? []).length === 5`; a `test.each` table `[clause, page, phrase]` with one distinctive phrase per clause taken from the scans, asserting the phrase is inside the `page`-th section (split the fragment on `class="doc-page`); page 1 contains the date and each `full_name`; page 5 has `data-testid="signature-block"` once per person; every page contains the fax `24567177`; the page-5 counter string appears once; the English build contains no Arabic script (`/[؀-ۿ]/`) after removing the fixed company name and address, and the Arabic build contains none of the English clause titles; `validContractValues({ persons: [{ ...person, full_name: "<b>x</b>" }] })` → contains `&lt;b&gt;x&lt;/b&gt;` and not `&amp;lt;`.
  - `html.pdf.test.ts`: `const chromium = existsSync(resolveChromiumPath()); (chromium ? test : test.skip)("five pages at the content limits", …, 30_000)` rendering the fixture with 3 persons, 6 units and 120/200-character strings through `renderHtmlToPdf(wrapHtmlForPdf(...))`, then `const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length; expect(pages).toBe(5)`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — `buildContractHtml` emits `<style>${PRINTED_DOCUMENT_CSS}${contractBuilderCss}</style>` then five sections via a `pageShell(n, inner)` helper (header band with `<img src="${logoSrc}">`, footer band, counter); every `ctx`/`values` string passes through `esc` at interpolation; `logo.server.ts` reads `join(process.cwd(), "public/contract-builder/danat-logo.png")` once at module load with `readFileSync` and exports `data:image/png;base64,…` (doc comment: headless Chromium in the container has no route to the app's public URL).
- [ ] **Step 4: Run** `bun run test -- src/lib/contractBuilder && bun run typecheck` — Expected: PASS (the PDF test may be skipped locally; report whether it ran).

---

### Task 4: Prefill

**Files:** create `src/lib/contractBuilder/prefill.ts`; test `prefill.test.ts`. Read `ContractUnitDetail` in `src/hooks/useContractRelations.ts:1-45` and the `tenants`/`contracts` rows in `database.types.ts` (`owner_name`, `owner_civil_id`, `authorized_manager`, `authorized_manager_civil_id`, `commercial_address`, `commercial_name_ar/_en/commercial_name`, `nationality`; `commercial_activity`, `duration_months`, `monthly_amount`, `start_date`, `increase_after_years/type/value`).

**Interfaces (produces):**

```ts
export type PrefillNotice = "multi_property" | "increase_fixed_not_supported";
export function prefillFromContract(
  input: { contract: Tables<"contracts">; tenant: Tables<"tenants">; units: ContractUnitDetail[] },
  locale: ContractLocale,
): { values: Partial<ContractBuilderValues>; notices: PrefillNotice[] };
```

- [ ] **Step 1: Write the failing tests** — builders `makeContract()`, `makeTenant()`, `makeUnit()` returning real row shapes: full mapping; owner branch (`owner_name === name` or empty `authorized_manager` → `owner_civil_id`); manager branch (`authorized_manager` set and `owner_name !== name` → `authorized_manager_civil_id`); `increase_type: "fixed"` → no `increase` key and the notice; units on two properties → no `governorate` key and the notice; `duration_months: null` → key absent; `en` picks `commercial_name_en` and falls back to `commercial_name`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per the spec mapping. Return only keys that have a value, so the form's `reset({ ...contractBuilderDefaults, ...values })` keeps the defaults for the rest.
- [ ] **Step 4: Run** `bun run test -- src/lib/contractBuilder/prefill.test.ts` — Expected: PASS.

---

### Task 5: Server function

**Files:** create `src/fns/renderContractPdf.ts`; test `src/fns/renderContractPdf.test.ts`. Read `src/fns/sendInvoiceToTenant.ts:1-60` (middleware + permission pattern) and `src/lib/reportPdfAttachment.test.ts` (how `@/lib/serverPdf` is mocked).

**Interfaces (produces):**

```ts
export const renderContractPdfInput = z.object({ values: contractBuilderSchema, locale: z.enum(["ar", "en"]) });
export const renderContractPdf = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator(...).handler(async ({ data, context }) => Response);
export function contractPdfFilename(values: ContractBuilderValues): string; // contract-<safeFilename(trade_name || persons[0].full_name)>-<contract_date>.pdf
```

- [ ] **Step 1: Write the failing tests** — `renderContractPdfInput` rejects the defaults and accepts the fixture; `has_permission` false → the thrown `Response` has `status 403`; success: the `renderHtmlToPdf` mock receives HTML containing `dir="rtl"` for `ar` and the logo data URI; the returned `Response` has `content-type: application/pdf`, a `content-disposition` with `contractPdfFilename(...)`, and `await res.arrayBuffer()` equals the mocked buffer; `contractPdfFilename` uses the trade name, falls back to the first person, strips unsafe characters (`safeFilename` from `@/lib/safeFilename`).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — `has_permission` with `_code: "contracts.read"`; `throw new Response("Forbidden", { status: 403 })` on refusal; `const pdf = await renderHtmlToPdf(wrapHtmlForPdf(buildContractHtml(data.values, data.locale, CONTRACT_LOGO_DATA_URI), { arabic: data.locale === "ar" }))`; `return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": \`attachment; filename="${contractPdfFilename(data.values)}"\` } })`.
- [ ] **Step 4: Run** `bun run test -- src/fns/renderContractPdf.test.ts && bun run typecheck` — Expected: PASS.

---

### Task 6: Form, preview, route, entry points, i18n

**Files:** create `src/components/admin/contracts/ContractBuilderForm.tsx`, `ContractPreview.tsx`, `src/routes/admin.contracts_.builder.tsx`; modify `src/routes/admin.contracts.tsx` (header buttons near `:288-310`), `src/components/admin/contracts/ContractsTable.tsx` (row actions), `src/i18n/dictionary.ts`; tests `ContractBuilderForm.test.tsx`, `ContractPreview.test.tsx`, `src/routes/admin.contracts.builder.test.tsx`. Read `src/routes/admin.contracts_.$id.closeout.tsx:1-120` for the route/form/field-array conventions and `src/routes/admin.invoices.tsx:55-75` for `validateSearch`.

**Interfaces (produces):** `ContractBuilderForm({ form, t, notices })`, `ContractPreview({ values, locale })`, route search `{ contract?: string }` (UUID-validated like the invoices route).

- [ ] **Step 1: Write the failing tests**
  - `ContractBuilderForm.test.tsx` (createRoot + real `useForm`): with 3 persons the add-person button has `disabled=""`; with 1 person the remove-person button has `disabled=""`; the language toggle updates `form.getValues("language")`.
  - `ContractPreview.test.tsx` (static markup): `<iframe` with `sandbox=""` and `srcdoc` containing `class="doc-page` and `CONTRACT_LOGO_PUBLIC_URL`.
  - Route test: `?contract=not-a-uuid` is dropped by `validateSearch`; notices render as `<li>` under `data-testid="prefill-notices"`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**
  - Route: `createFileRoute("/admin/contracts_/builder")` with `validateSearch`; `useForm<ContractBuilderValues>({ resolver: zodResolver(contractBuilderSchema), defaultValues: contractBuilderDefaults, mode: "onBlur" })`; prefill effect keyed by `contract.data?.id`: runs `form.reset({ ...contractBuilderDefaults, ...values })` when `contract.isSuccess && tenant.isSuccess && units.isSuccess` and a `useRef<string | null>` of the last reset id differs; `t("common.error")` line on any `isError`.
  - Preview: `contractBuilderDraftSchema.safeParse(form.watch())` debounced 300 ms (state + `setTimeout`), `srcDoc` = `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"></head><body>${fragment}</body></html>` with `buildContractHtml(values, locale, CONTRACT_LOGO_PUBLIC_URL)`.
  - Download button (disabled while pending):

```ts
form.handleSubmit(async (values) => {
  setPending(true);
  let url: string | null = null;
  try {
    const res = await renderContractPdf({ data: { values, locale: values.language } });
    if (!res.ok) throw new Error(String(res.status));
    url = URL.createObjectURL(await res.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = contractPdfFilename(values);
    anchor.click();
  } catch {
    toast.error(t("contractBuilder.downloadFailed"));
  } finally {
    if (url) URL.revokeObjectURL(url);
    setPending(false);
  }
})
```

  - Entry points: header `<Button asChild variant="outline"><Link to="/admin/contracts_/builder">{t("contractBuilder.open")}</Link></Button>` gated on `contracts.read`; `ContractsTable` row action linking with `search={{ contract: row.id }}`.
  - i18n (both locales): `contractBuilder.title`, `.open`, `.buildFromContract`, `.download`, `.downloadFailed`, `.language`, `.persons`, `.addPerson`, `.removePerson`, `.units`, `.addUnit`, `.removeUnit`, `.preview`, a label per schema field (`contractBuilder.field.<key>`), `.notice.multi_property` ("العقد يشمل أكثر من عقار؛ أكمل بيانات العقار يدوياً" / "The contract spans more than one property; fill the property fields by hand"), `.notice.increase_fixed_not_supported` ("زيادة الإيجار بمبلغ ثابت غير مدعومة في نص العقد؛ أدخل النسبة يدوياً" / "A fixed-amount rent increase is not supported by the contract text; enter a percentage by hand").
- [ ] **Step 4: Run** `bun run lint && bun run typecheck && bun run test` — Expected: PASS. `src/routeTree.gen.ts` is regenerated by the tooling (never hand-edit; if it did not regenerate, run `bun run build` once and include the change).

---

### Task 7: Orchestrator gates, guards, review, PR

- [ ] Full gates on the assembled branch; `clean-code-guard`, `test-guard`, `docs-guard`.
- [ ] `requesting-code-review`; PR body states the English clause text is a translation pending operator review.

## Debate — round 1 (Codex astra 6 high, read-only relay; tree verified unchanged)

The 18-row verdict table is in the spec (17 accepted, #15 partial: `contracts.read` instead of the unseeded `contracts.export`). Mapping to tasks: 1 → Task 3 (`esc`) + Task 6 (`sandbox`); 2 → Task 1 fixture; 3 → Task 1 limits + Task 3 PDF test; 4 → Task 3 wrapper test; 5 → Task 3 logo module; 6, 8, 11 → Task 4; 7, 9, 10, 12 → Task 1; 13, 14, 17 → Task 6; 15, 16 → Task 5; 18 → Task 3 phrase table.

## Self-review

- Spec coverage: variables (Task 1), clauses (2), pages/escaping/logo (3), prefill (4), PDF (5), route/preview/download/entry points/i18n (6).
- Placeholders: the per-clause phrase table is filled by the implementer from the scans; the plan fixes the mechanism rather than reproducing five pages of legal text.
- Type consistency: `ContractBuilderValues`, `ClauseContext`, `ContractCopy`, `buildContractHtml(values, locale, logoSrc)`, `renderContractPdfInput`, `contractPdfFilename` are named identically across tasks.
