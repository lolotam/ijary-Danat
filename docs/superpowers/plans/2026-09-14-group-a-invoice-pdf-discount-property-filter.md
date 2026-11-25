# Group A — invoice PDF on manual send, discount only when real, property filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The manual Send-invoice action attaches the printed invoice PDF to both the email and the WhatsApp message; every invoice document, email and WhatsApp text shows a discount row only when the invoice carries one; `/admin/invoices` gains a building filter next to the add-year button that scopes every card by pro-rated rent lines.

**Architecture:** One new server-side renderer (`invoiceDocumentPdf.ts`) reuses the shared invoice sheet and the receipt attachment plumbing. One predicate (`hasDiscount`) gates every discount surface; `renderTemplate` gains mustache sections so the admin-edited body can hide rows, and a migration wraps the live rows. One new SQL RPC (`get_invoice_month_summary`) replaces the client-side aggregation and applies the rent-line share when a property is given; the route threads `property` through the URL.

**Tech Stack:** TanStack Start + React 19, react-query, Zod-free hand-rolled search validation on this route, Postgres plpgsql migrations in `db/migrations/`, Vitest, SQL suite in `src/db/*.sqltest.ts` (`TEST_DB_PORT=55329 bun run test:sql`).

**Spec:** `docs/superpowers/specs/2026-09-14-group-a-invoice-pdf-discount-property-filter-design.md`

## Global Constraints

- Every new file stays under 500–600 lines. `admin.invoices.tsx` is 484 lines; keep the route change to search/param threading and prop wiring.
- Every function gets a doc comment above it that leads with an Arabic description; English may follow for the *why*.
- Migrations are `201_invoice_template_discount_section.sql` and `202_invoice_month_summary_rpc.sql`. Every `create or replace function` is followed by `revoke execute ... from public, anon;` and `grant execute ... to authenticated, service_role;`.
- `database.types.ts` is hand-maintained: add the RPC entry by hand; never run or paste `gen:types` output.
- Mocks only at boundaries (Supabase client, `renderAndStorePdf`, network). Tests assert `disabled=""` on buttons, never a class; no test mocks the module under test; no empty test bodies.
- The tenant-detail Discount column is not touched (decision).
- Implementers do not commit. The orchestrator commits. Do not stage `contract_sample/`.
- Gates before handing back: `bun run lint`, `bun run typecheck`, `bun run test`, and `TEST_DB_PORT=55329 bun run test:sql` for any task touching `db/migrations` or `src/db`.
- Fallback direction from the user, verbatim: "If any model goes out of quota (like GLM5.3 ), continue and delegate to Codex Astra 6 medium effort."

---

## File structure

| Path | Responsibility |
|---|---|
| `db/migrations/201_invoice_template_discount_section.sql` | wrap the live invoice-document rows in a `{{#has_discount}}` section |
| `db/migrations/202_invoice_month_summary_rpc.sql` | `get_invoice_month_summary(integer, uuid)` |
| `src/db/invoiceTemplateDiscountSection.sqltest.ts` | Task 5 tests |
| `src/db/invoiceMonthSummary.sqltest.ts` | Task 7 tests |
| `src/lib/invoiceDocumentPdf.ts` | new: render + store the invoice sheet PDF for a send |
| `src/lib/invoiceDiscountBadge.ts` | add `hasDiscount` |
| `src/lib/templateRender.ts` | sections in `renderTemplate`; cell separators in `stripMarkup` |
| `src/hooks/useInvoices.ts` | `useMonthlyInvoiceSummary(year, propertyId, enabled)` via RPC |
| `src/routes/admin.invoices.tsx` | `property` search param, threading, single source for the property filter |
| `src/components/admin/invoices/MonthlyInvoicesOverview.tsx`, `ClassicInvoicesOverview.tsx`, `AnnualKpiRibbon.tsx` | property select after add-year; building chip in the ribbon |

---

### Task 1: `hasDiscount` predicate and the printable invoice sheet

**Files:**
- Modify: `src/lib/invoiceDiscountBadge.ts`, `src/lib/invoiceDiscountColumn.ts:37`, `src/lib/paymentReceiptHtml.ts:128-158`, `src/lib/invoicePrintHtml.ts:124-127`
- Test: `src/lib/invoiceDiscountBadge.test.ts`, `src/lib/invoicePrintHtml.test.ts:85-109`

**Interfaces:**
- Produces: `export function hasDiscount(value: number | string | null | undefined): boolean` in `src/lib/invoiceDiscountBadge.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/invoiceDiscountBadge.test.ts`:

```ts
import { hasDiscount } from "@/lib/invoiceDiscountBadge";

describe("hasDiscount", () => {
  test.each([
    [null, false],
    [undefined, false],
    [0, false],
    ["0", false],
    ["0.000", false],
    [0.001, true],
    [12, true],
    ["12.500", true],
  ])("%s -> %s", (value, expected) => {
    expect(hasDiscount(value as never)).toBe(expected);
  });
});
```

In `src/lib/invoicePrintHtml.test.ts`, change the two zero-discount expectations: remove `["Discount", "0 KWD"]` from the English row list at `:85-95` and `"الخصم"` from the Arabic label list at `:97-109`, and add:

```ts
  test("shows the discount row only when the invoice carries one", () => {
    const withDiscount = { ...invoice(), discount: 50 };
    const rows = amountRows(buildInvoicePrintHtml(withDiscount, company, "en", breakdownFor(withDiscount)));
    expect(rows.map(([label]) => label)).toContain("Discount");
    const without = amountRows(buildInvoicePrintHtml(invoice(), company, "en", breakdownFor(invoice())));
    expect(without.map(([label]) => label)).not.toContain("Discount");
  });
```

(`breakdownFor` in that file builds the snapshot from the invoice; check it copies `discount` through — if it does not, pass a breakdown whose `invoice.discount` is 50.)

- [ ] **Step 2: Run** `bun run test -- src/lib/invoiceDiscountBadge.test.ts src/lib/invoicePrintHtml.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/invoiceDiscountBadge.ts`:

```ts
/**
 * هل تحمل الفاتورة خصماً فعلياً؟ الصفر والفراغ لا يُعدّان خصماً.
 *
 * One predicate for every surface that prints a discount row or badge: the
 * tenant who reads "الخصم 0 KWD" assumes someone else got one, so the row is
 * withheld unless money was actually taken off.
 */
export function hasDiscount(value: number | string | null | undefined): boolean {
  if (value == null) return false;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0;
}
```

Replace the guard in `invoiceDiscountBadgeText` and in `invoiceDiscountColumn.ts:37` with `if (!hasDiscount(discount)) return null;`. In `paymentReceiptHtml.ts:156-158` use `allocations.some((a) => hasDiscount(a.invoice?.discount))` and rewrite the doc comment at 128-134 to say the invoice sheet follows the same rule since this change. In `invoicePrintHtml.ts` wrap the discount `<tr>` in `${hasDiscount(breakdown.invoice.discount) ? \`<tr>…</tr>\` : ""}`.

- [ ] **Step 4: Run** both test files and `bun run test -- src/lib/receiptConsistency.test.ts` — Expected: PASS.

---

### Task 2: Template sections and WhatsApp cell separators

**Files:**
- Modify: `src/lib/templateRender.ts`
- Test: `src/lib/templateRender.test.ts`

**Interfaces:**
- Produces: `renderTemplate` honours `{{#key}}…{{/key}}` (shown when the variable is a non-empty string) and `{{^key}}…{{/key}}` (shown when absent/empty); `stripMarkup` separates cells with a space and rows with a newline.

- [ ] **Step 1: Write the failing tests**

```ts
describe("renderTemplate sections", () => {
  test("a section renders only when its variable is non-empty", () => {
    expect(renderTemplate("A{{#d}} [{{d}}]{{/d}} Z", { d: "5 KWD" })).toBe("A [5 KWD] Z");
    expect(renderTemplate("A{{#d}} [{{d}}]{{/d}} Z", { d: "" })).toBe("A Z");
    expect(renderTemplate("A{{#d}} [{{d}}]{{/d}} Z", {})).toBe("A Z");
  });
  test("an inverted section renders only when the variable is empty", () => {
    expect(renderTemplate("{{^d}}none{{/d}}{{#d}}{{d}}{{/d}}", { d: "" })).toBe("none");
    expect(renderTemplate("{{^d}}none{{/d}}{{#d}}{{d}}{{/d}}", { d: "x" })).toBe("x");
  });
  test("sections nest and span lines", () => {
    expect(renderTemplate("{{#a}}1{{#b}}2{{/b}}3{{/a}}", { a: "y", b: "" })).toBe("13");
  });
  test("an unmatched section tag is left verbatim, like an unknown variable", () => {
    expect(renderTemplate("x {{#d}} y", { d: "1" })).toBe("x {{#d}} y");
  });
});

describe("stripMarkup table cells", () => {
  test("cells are separated by a space and rows by a newline", () => {
    const html = "<table><tr><td>رقم الفاتورة</td><td>INV-1</td></tr><tr><td>الفترة</td><td>8/2026</td></tr></table>";
    expect(stripMarkup(html)).toBe("رقم الفاتورة INV-1\nالفترة 8/2026");
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
/**
 * يحلّ أقسام {{#key}}…{{/key}} و{{^key}}…{{/key}} قبل استبدال المتغيّرات.
 *
 * Mustache-shaped on purpose: admins already know `{{var}}`, and a section is
 * the only way an authored body can drop a row (the discount rows) when the
 * value is empty. Innermost sections resolve first so nesting works; a tag
 * with no closing partner is left verbatim, the same policy as an unknown
 * variable, so a typo is visible rather than silently swallowed.
 */
function renderSections(value: string, variables: Record<string, string>): string {
  // Innermost section = one whose body holds no other section tag, opener OR
  // closer. A crossed closer ({{#a}}A{{/b}}B{{/a}}) therefore never matches
  // and every tag survives verbatim.
  const section = /{{([#^])\s*([a-zA-Z0-9_]+)\s*}}((?:(?!{{[#^/]\s*[a-zA-Z0-9_]+\s*}}).)*){{\/\s*\2\s*}}/s;
  let output = value;
  for (;;) {
    const match = section.exec(output);
    if (!match) return output;
    const [, kind, key, inner] = match;
    const present = Object.hasOwn(variables, key) && variables[key] !== "";
    const keep = kind === "#" ? present : !present;
    // Callback, never a replacement string: "$&" in authored text would
    // re-insert the match and the loop would spin forever.
    output = output.slice(0, match.index) + (keep ? inner : "") + output.slice(match.index + match[0].length);
  }
}

/**
 * نصّ القالب المرئي فقط: الأقسام المخفية تُزال بالدلالة نفسها قبل فحص المتغيّرات.
 */
export function visibleTemplateSource(value: string, variables: Record<string, string>): string {
  return renderSections(value, variables);
}
```

Call `renderSections` first inside `renderTemplate` (before the scalar replace). Find `findMissingPlaceholders` (grep `src/lib` and `src/fns`) and make it scan `visibleTemplateSource(source, variables)` instead of the raw source; add a test: with `discount: ""` and a wrapped body, `discount`/`subtotal` are not reported, while an unknown `{{foo}}` inside a shown section still is. Add to the section tests: `"$& is inserted literally and the call terminates"` (`renderTemplate("{{#a}}$&{{/a}}", { a: "y" })` → `"$&"`), `"a crossed closer leaves every tag verbatim"`, and give the nesting test an actual `\n` inside the section. In `stripMarkup`, add before the block-tag rule:

```ts
    .replace(/<\/\s*(td|th)\s*>/gi, " ")
    .replace(/<\/\s*tr\s*>/gi, "\n")
```

and keep the later whitespace collapsing (`[ \t]+\n` → `\n`) so a trailing cell space does not linger.

- [ ] **Step 4: Run** `bun run test -- src/lib/templateRender.test.ts` — Expected: PASS.

---

### Task 3: Built-in email template omits the two rows when there is no discount

**Files:**
- Modify: `src/lib/emailTemplates.ts:315-400`
- Test: `src/lib/emailTemplates.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("invoiceDocumentTemplate discount rows", () => {
  const base = {
    locale: "en" as const, tenantName: "T", unitName: "U", propertyName: "P",
    invoiceNumber: "INV-1", period: "8/2026", issueDate: "2026-08-01", dueDate: "2026-08-01",
    subtotal: "500 KWD", paid: "0 KWD", total: "500 KWD",
  };
  test("omits Subtotal and Discount when discount is null", () => {
    const html = invoiceDocumentTemplate({ ...base, discount: null }).html;
    expect(html).not.toContain(">Discount<");
    expect(html).not.toContain(">Subtotal<");
    expect(html).toContain(">Total due<");
  });
  test("keeps both rows when a discount exists", () => {
    const html = invoiceDocumentTemplate({ ...base, discount: "50 KWD" }).html;
    expect(html).toContain(">Discount<");
    expect(html).toContain(">Subtotal<");
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL (type error / rows present).

- [ ] **Step 3: Implement**

Change the param type to `discount: string | null` and build `totals` as:

```ts
  const totals: Array<[string, string, boolean]> = [
    ...(discount != null
      ? ([
          [isAr ? "الإجمالي قبل الخصم" : "Subtotal", subtotal, false],
          [isAr ? "الخصم" : "Discount", discount, false],
        ] as Array<[string, string, boolean]>)
      : []),
    [isAr ? "المدفوع" : "Paid", paid, false],
    [isAr ? "الإجمالي المستحق" : "Total due", total, true],
  ];
```

- [ ] **Step 4: Run** `bun run test -- src/lib/emailTemplates.test.ts src/lib/templateFidelity.test.ts` — Expected: PASS.

---

### Task 4: `renderInvoiceDocumentPdf` and the send that attaches it

**Files:**
- Create: `src/lib/invoiceDocumentPdf.ts`
- Modify: `src/fns/sendInvoiceToTenant.ts:137-201`
- Test: `src/lib/invoiceDocumentPdf.test.ts` (create), `src/fns/sendInvoiceToTenant.test.ts`

**Interfaces:**
- Produces: `renderInvoiceDocumentPdf(input: { invoice: Tables<"invoices">; locale: "ar" | "en" }): Promise<(StoredPdf & { displayName: string }) | null>`.

- [ ] **Step 1: Write the failing tests**

`src/lib/invoiceDocumentPdf.test.ts` — mock `@/integrations/supabase/client.server` (`supabaseAdmin.from(...)` for `companies`, and `rpc` for `get_invoice_payment_breakdown`), mock `@/lib/invoiceRelations` (`loadInvoicesWithRelations` returning one enriched invoice), and mock `@/lib/reportPdfAttachment` (`renderAndStorePdf`). Cases: (a) everything resolves → returns `{ bucket: "report-documents", path, displayName: "INV-1.pdf" }` and `renderAndStorePdf` was called with `prefix: "invoice-documents"`, `discriminator: invoice.id`, `name: "INV-1"`, `arabic: true`; (b) the breakdown RPC returns `{ error }` → returns `null`, `renderAndStorePdf` not called, `console.error` called once (spy). Mirror the mocking style of `src/lib/paymentReceiptPdf.test.ts`.

In `src/fns/sendInvoiceToTenant.test.ts`, mock `@/lib/invoiceDocumentPdf` with a `vi.fn()` and add:

```ts
  test("both channels carry the PDF attachment keys when the render succeeds", async () => {
    renderPdf.mockResolvedValue({ bucket: "report-documents", path: "invoice-documents/INV-1-x.pdf", displayName: "INV-1.pdf" });
    const result = await callSend({ channels: ["email", "whatsapp"] });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.map(([a]) => a.channel).sort()).toEqual(["email", "whatsapp"]);
    expect(result.queued).toHaveLength(2);
    for (const [args] of enqueue.mock.calls) {
      expect(args.payload).toMatchObject({
        attachment_bucket: "report-documents",
        attachment_paths: ["invoice-documents/INV-1-x.pdf"],
        attachment_names: ["INV-1.pdf"],
      });
    }
  });
  test("a failed render sends text only, with no attachment keys", async () => {
    renderPdf.mockResolvedValue(null);
    await callSend({ channels: ["email", "whatsapp"] });
    expect(enqueue).toHaveBeenCalledTimes(2);
    for (const [args] of enqueue.mock.calls) expect(args.payload).not.toHaveProperty("attachment_paths");
  });
  test("a zero-discount invoice renders the stored body without the discount rows", async () => {
    renderPdf.mockResolvedValue(null);
    templateRow.mockResolvedValue({ data: { body_ar: "<p>{{invoice_number}}</p>{{#has_discount}}<p>الخصم {{discount}}</p>{{/has_discount}}", body_en: null, subject_ar: "s", subject_en: null, channel: "both", is_active: true }, error: null });
    await callSend({ channels: ["whatsapp"] });
    const [args] = enqueue.mock.calls[0];
    expect(args.body).toBe("INV-1");
    expect(args.body).not.toContain("الخصم");
  });
```

`callSend` is the file's existing helper that invokes the handler with `context`; `templateRow` is the file's existing mock of the `notification_templates` read — keep `loadTemplateCopy` and `renderTemplate` real so the stored-body → section → WhatsApp text path is exercised end to end. Adjust the template row shape to whatever `loadTemplateCopy` selects (read `src/fns/loadTemplateCopy.ts`).

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/invoiceDocumentPdf.ts`:

```ts
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Tables } from "@/integrations/supabase/database.types";
import { t, type Locale } from "@/i18n/dictionary";
import { buildInvoiceDocument } from "@/lib/invoiceDocument";
import { parseInvoicePaymentBreakdown } from "@/lib/invoicePaymentBreakdown";
import { loadInvoicesWithRelations } from "@/lib/invoiceRelations";
import { receiptDocumentFilename } from "@/lib/receiptDocumentFilename";
import { renderAndStorePdf, type StoredPdf } from "@/lib/reportPdfAttachment";

/** Path prefix inside `report-documents`; migration 109's policy matches the bucket, not the path. */
const INVOICE_PREFIX = "invoice-documents";

/**
 * يبني ورقة الفاتورة نفسها التي يطبعها المكتب ويخزّنها كـ PDF لإرفاقها بالإرسال اليدوي.
 *
 * Same sheet as the admin print and the portal download (`buildInvoiceDocument`),
 * stored through the receipt path's `renderAndStorePdf`, so the dispatcher
 * attaches it on email and, under Evolution, as a WhatsApp document. Never
 * throws: a send without its attachment is a degradation, a send that never
 * goes out is an outage. Every failure is logged with the invoice code.
 */
export async function renderInvoiceDocumentPdf(input: {
  invoice: Tables<"invoices">;
  locale: Locale;
}): Promise<(StoredPdf & { displayName: string }) | null> {
  const { invoice, locale } = input;
  try {
    const [enriched] = await loadInvoicesWithRelations(supabaseAdmin, [invoice]);
    const breakdown = await supabaseAdmin.rpc("get_invoice_payment_breakdown", { p_invoice_id: invoice.id });
    if (breakdown.error) throw new Error(breakdown.error.message);
    const company = await supabaseAdmin.from("companies").select("*").order("created_at").limit(1).maybeSingle();
    if (company.error) throw new Error(company.error.message);
    const document = buildInvoiceDocument(
      enriched,
      company.data ?? null,
      locale,
      t(locale, "invoices.printInvoice"),
      parseInvoicePaymentBreakdown(breakdown.data),
    );
    const stored = await renderAndStorePdf({
      arabic: true,
      discriminator: invoice.id,
      html: document.html,
      name: invoice.code,
      prefix: INVOICE_PREFIX,
    });
    return stored ? { ...stored, displayName: receiptDocumentFilename(null, invoice.code) } : null;
  } catch (error) {
    console.error("[invoiceDocumentPdf] render failed", invoice.code, error instanceof Error ? error.message : error);
    return null;
  }
}
```

`sendInvoiceToTenant.ts`: import `hasDiscount`, `attachmentPayload`, `renderInvoiceDocumentPdf`. Set `const discounted = hasDiscount(invoice.discount);` and in `variables` use `subtotal: discounted ? formatKwd(invoice.subtotal, locale) : ""`, `discount: discounted ? formatKwd(invoice.discount, locale) : ""`; pass `discount: discounted ? formatKwd(invoice.discount, locale) : null` to `invoiceDocumentTemplate`. Before the loop: `const pdf = await renderInvoiceDocumentPdf({ invoice, locale }); const attachments = attachmentPayload(pdf, pdf ? [pdf.displayName] : undefined);` and spread `...attachments` into each `payload`. Update the file header comment (it says WhatsApp carries a text summary only).

- [ ] **Step 4: Run** `bun run test -- src/lib/invoiceDocumentPdf.test.ts src/fns/sendInvoiceToTenant.test.ts && bun run typecheck` — Expected: PASS.

---

### Task 5: Migration 201 — wrap the live invoice-document rows in a discount section

**Files:**
- Create: `db/migrations/201_invoice_template_discount_section.sql`
- Modify: `src/lib/__fixtures__/seededBodies.ts` (invoice-document ar + en), `src/components/admin/TemplateEditorDialog.tsx:326-339`, `src/i18n/dictionary.ts` (key `templates.sectionsHint` in both locales)
- Test: `src/db/invoiceTemplateDiscountSection.sqltest.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

const MIGRATION = readFileSync("db/migrations/201_invoice_template_discount_section.sql", "utf8");

/**
 * Migration 201 — the invoice-document body hides its subtotal/discount rows
 * behind a {{#has_discount}} section, wrapped by exact-markup replacement so an
 * admin-edited body keeps every other edit.
 */
import { SEEDED_BODIES_PRE_201 } from "@/lib/__fixtures__/seededBodies"; // export the pre-201 invoice-document bodies under this name

describe("migration 201", () => {
  // The suite's global setup has already applied 201, so the live row is
  // wrapped before any test runs. Install the known pre-201 body inside the
  // rollback transaction, transform it, then prove a second run is a no-op.
  test("wraps both rows once in each locale, then a second run changes nothing", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.notification_templates set body_ar = $1, body_en = $2 where code = 'invoice-document'`,
        [SEEDED_BODIES_PRE_201["invoice-document"].ar, SEEDED_BODIES_PRE_201["invoice-document"].en],
      );
      await client.query(MIGRATION);
      const first = await client.query<{ body_ar: string; body_en: string }>(
        `select body_ar, body_en from public.notification_templates where code = 'invoice-document'`,
      );
      await client.query(MIGRATION);
      const second = await client.query<{ body_ar: string; body_en: string }>(
        `select body_ar, body_en from public.notification_templates where code = 'invoice-document'`,
      );
      expect(second.rows[0]).toEqual(first.rows[0]);
      for (const col of ["body_ar", "body_en"] as const) {
        const body = first.rows[0][col];
        const original = SEEDED_BODIES_PRE_201["invoice-document"][col === "body_ar" ? "ar" : "en"];
        expect(body.split("{{#has_discount}}").length - 1).toBe(1);
        expect(body.split("{{/has_discount}}").length - 1).toBe(1);
        expect(body.indexOf("{{#has_discount}}")).toBeLessThan(body.indexOf("{{subtotal}}"));
        expect(body.indexOf("{{discount}}")).toBeLessThan(body.indexOf("{{/has_discount}}"));
        expect(body.replace("{{#has_discount}}", "").replace("{{/has_discount}}", "")).toBe(original);
      }
    });
  });

  test("a body whose markup drifted from the literals aborts instead of passing silently", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.notification_templates set body_ar = '<p>{{subtotal}} {{discount}}</p>' where code = 'invoice-document'`,
      );
      const message = await captureRaise(client, () => client.query(MIGRATION));
      expect(message).toMatch(/invoice-document body could not be wrapped/);
    });
  });
});
```

- [ ] **Step 2: Run** `TEST_DB_PORT=55329 bun run test:sql -- src/db/invoiceTemplateDiscountSection.sqltest.ts` — Expected: FAIL (file missing).

- [ ] **Step 3: Write the migration**

```sql
-- 201_invoice_template_discount_section.sql
--
-- صفّا «الإجمالي قبل الخصم» و«الخصم» في قالب نسخة الفاتورة يظهران فقط عند وجود خصم.
--
-- The stored body is admin-editable and has been edited since migration 70
-- seeded it, so this is an exact-markup wrap of the two known rows, not a
-- re-seed: everything else the admin wrote survives. `renderTemplate` renders
-- a {{#has_discount}} section only when the sender passes a non-empty value.
-- Idempotent through the position() guard.

update public.notification_templates
   set body_ar = replace(body_ar,
        '<tr><td style="padding:8px 12px;color:#6b6b6b;">الإجمالي قبل الخصم</td>',
        '{{#has_discount}}<tr><td style="padding:8px 12px;color:#6b6b6b;">الإجمالي قبل الخصم</td>')
 where code = 'invoice-document' and position('{{#has_discount}}' in body_ar) = 0;

update public.notification_templates
   set body_ar = replace(body_ar,
        '{{discount}}</td></tr>',
        '{{discount}}</td></tr>{{/has_discount}}')
 where code = 'invoice-document'
   and position('{{#has_discount}}' in body_ar) > 0 and position('{{/has_discount}}' in body_ar) = 0;

update public.notification_templates
   set body_en = replace(body_en,
        '<tr><td style="padding:8px 12px;color:#6b6b6b;">Subtotal</td>',
        '{{#has_discount}}<tr><td style="padding:8px 12px;color:#6b6b6b;">Subtotal</td>')
 where code = 'invoice-document' and position('{{#has_discount}}' in body_en) = 0;

update public.notification_templates
   set body_en = replace(body_en,
        '{{discount}}</td></tr>',
        '{{discount}}</td></tr>{{/has_discount}}')
 where code = 'invoice-document'
   and position('{{#has_discount}}' in body_en) > 0 and position('{{/has_discount}}' in body_en) = 0;

-- Verified, not assumed: a body whose markup drifted from the literals above
-- would leave replace() a no-op and this migration "succeeding" over an
-- unwrapped row. Exactly one opener, exactly one closer, in the right order,
-- in both locales — or abort.
do $$
declare
  v record;
begin
  for v in
    select body_ar as body, 'ar' as loc from public.notification_templates where code = 'invoice-document'
    union all
    select body_en, 'en' from public.notification_templates where code = 'invoice-document'
  loop
    if (length(v.body) - length(replace(v.body, '{{#has_discount}}', ''))) / 13 <> 1
       or (length(v.body) - length(replace(v.body, '{{/has_discount}}', ''))) / 13 <> 1
       or position('{{#has_discount}}' in v.body) > position('{{subtotal}}' in v.body)
       or position('{{discount}}' in v.body) > position('{{/has_discount}}' in v.body) then
      raise exception 'invoice-document body (%) could not be wrapped in a discount section', v.loc;
    end if;
  end loop;
end $$;
```

(`{{#has_discount}}` and `{{/has_discount}}` are 13 characters each.) The literals match `db/migrations/70_seed_template_bodies.sql:132-133,151-152`, and the live production body was checked on 2026-09-14 to still contain them. In `seededBodies.ts`, keep the current (pre-201) invoice-document bodies exported as `SEEDED_BODIES_PRE_201` for the sqltest and update the main fixture's invoice-document entry to the wrapped shape.

**Release note for the orchestrator:** 201 is applied to production only **after** the merged bundle (with the section-aware renderer) is live; see the spec's release ordering. Add `templates.sectionsHint` ("يمكن إخفاء جزء عند غياب القيمة: {{#has_discount}} … {{/has_discount}}" / "Hide a part when a value is empty: {{#has_discount}} … {{/has_discount}}") and render it as a second `<p className="text-xs text-muted-foreground">` under the placeholder chips in `TemplateEditorDialog.tsx`.

- [ ] **Step 4: Run** `TEST_DB_PORT=55329 bun run test:db && TEST_DB_PORT=55329 bun run test:sql -- src/db/invoiceTemplateDiscountSection.sqltest.ts && bun run test -- src/lib/templateFidelity.test.ts` — Expected: PASS.

---

### Task 6: Migration 202 — `get_invoice_month_summary`

**Files:**
- Create: `db/migrations/202_invoice_month_summary_rpc.sql`
- Test: `src/db/invoiceMonthSummary.sqltest.ts`

**Interfaces:**
- Produces: `public.get_invoice_month_summary(p_year integer, p_property_id uuid default null) returns table (month integer, count bigint, total numeric, paid numeric, outstanding numeric, overdue bigint)`; always 12 rows.

- [ ] **Step 1: Write the failing test**

Use `seedContract` twice with `units: [{ monthlyAmount: 300 }]` (fixture A) and `[{ monthlyAmount: 200 }]` (fixture B), and a third contract with `units: [{ monthlyAmount: 300 }, { monthlyAmount: 200 }]` (fixture S, which `seedContract` puts in its own property C). Move **both** of S's units: `update public.units set property_id = A.propertyId where id = S.unitIds[0]` and `... = B.propertyId where id = S.unitIds[1]`. Generate 2029 for all three with `generate_invoices_for_year(id, 2029, false)`. Assertions for `select * from public.get_invoice_month_summary(2029, $property)`:

- null property: 12 rows, `count` = 3 and `total` = 1000 every month.
- property A (its own 300 + S's 300-unit line, share 300/500): `count` = 2, `total` = 300 + 500 × 0.6 = 600.
- property B (its own 200 + S's 200-unit line, share 0.4): `count` = 2, `total` = 200 + 500 × 0.4 = 400.
- `balance` is a generated column, so pay S's January invoice through the real path: `select public.set_invoice_paid(<S January id>, true, 'cash', null)` is all-or-nothing; instead insert a confirmed `payments` row and a `payment_allocations` row of 250 the way `src/db/moduleSummaries.sqltest.ts` seeds money (copy its helper). Then property B January: `paid` = 250 × 0.4 = 100, `outstanding` = 200 (its own unpaid) + 250 × 0.4 = 300; property A January: `paid` = 150, `outstanding` = 300 + 150 = 450.
- A zero-priced touch: add a fourth contract with `units: [{ monthlyAmount: 0.001 }]`… `contract_units.monthly_amount` must be > 0, so instead insert an `invoice_items` rent line of `amount = 0` for a unit in property C on one of S's invoices (`insert into public.invoice_items (invoice_id, line, unit_id, description_ar, description_en, quantity, unit_price, discount_percent, amount, is_concession) values (...)`), and assert property C: `count` = 1 for that month, `total` = 0.
- Thirds: a contract with three units of 1 each (three properties) → each property's `total` for a month is `0.333`; the three sum to `0.999`, and the null-property total is `3` — pins the precision contract.
- A property with no invoices: 12 rows of zeros.
- `has_function_privilege('anon', 'public.get_invoice_month_summary(integer, uuid)', 'EXECUTE')` is false; `authenticated` true.
- Under `actAs(client, "authenticated", <user without invoices.read>)` the call raises `Permission denied` (use `captureRaise`). Copy the user-seeding helper from `src/db/moduleSummaries.sqltest.ts`.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Write the migration**

```sql
-- 202_invoice_month_summary_rpc.sql
--
-- ملخّص الفواتير الشهري لسنة، اختيارياً لمبنى واحد بحصّة بنود الإيجار.
--
-- /admin/invoices summed a bare select in the browser and could not be scoped
-- to a building: a consolidated invoice covers units in several buildings and
-- invoices.unit_id is NULL for it (112). A building's share of such an invoice
-- is its rent lines over all rent lines (invoice_items with a unit, excluding
-- extra-charge and concession lines); total, paid and balance follow that
-- share, count and overdue count the invoices the building touches.

create or replace function public.get_invoice_month_summary(
  p_year integer,
  p_property_id uuid default null
)
returns table (
  month integer, count bigint, total numeric, paid numeric,
  outstanding numeric, overdue bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'invoices.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  with rent as (
    -- Rent lines only: a unit, not an extra charge, not a concession line.
    select ii.invoice_id, u.property_id, ii.amount
      from public.invoice_items ii
      join public.units u on u.id = ii.unit_id
     where not ii.is_extra_charge and not ii.is_concession
  ),
  shares as (
    select i.id, i.period_month, i.total, i.paid, i.balance, i.state,
           -- touches: at least one rent line in the building, whatever its amount
           (p_property_id is null
              or exists (select 1 from rent r where r.invoice_id = i.id and r.property_id = p_property_id)) as touches,
           case
             when p_property_id is null then 1::numeric
             else coalesce(
               (select sum(r.amount) from rent r where r.invoice_id = i.id and r.property_id = p_property_id)
               / nullif((select sum(r.amount) from rent r where r.invoice_id = i.id), 0),
               0)
           end as share
      from public.invoices i
     where i.period_year = p_year
  )
  select m.month,
         count(s.id) filter (where s.touches),
         round(coalesce(sum(s.total * s.share), 0), 3),
         round(coalesce(sum(s.paid * s.share), 0), 3),
         round(coalesce(sum(s.balance * s.share), 0), 3),
         count(s.id) filter (where s.touches and s.state = 'overdue')
    from generate_series(1, 12) as m(month)
    left join shares s on s.period_month = m.month
   group by m.month
   order by m.month;
end;
$$;

revoke execute on function public.get_invoice_month_summary(integer, uuid) from public, anon;
grant execute on function public.get_invoice_month_summary(integer, uuid) to authenticated, service_role;
```

Check the real column names `is_extra_charge` / `is_concession` on `invoice_items` (migration 169) and that `invoice_items.amount` is the line amount.

- [ ] **Step 4: Run** `TEST_DB_PORT=55329 bun run test:db && TEST_DB_PORT=55329 bun run test:sql` — Expected: PASS.

---

### Task 7: Summary hook calls the RPC; types

**Files:**
- Modify: `src/hooks/useInvoices.ts:268-293`, `src/integrations/supabase/database.types.ts` (Functions)
- Test: `src/hooks/useInvoices.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("useMonthlyInvoiceSummary", () => {
  test("asks the RPC for the year and property and maps the rows", async () => {
    rpc.mockResolvedValue({ data: [{ month: 1, count: 2, total: "500", paid: "100", outstanding: "400", overdue: 1 }], error: null });
    const rows = await monthlyInvoiceSummaryQuery(2029, "prop-1")();
    expect(rpc).toHaveBeenCalledWith("get_invoice_month_summary", { p_year: 2029, p_property_id: "prop-1" });
    expect(rows[0]).toEqual({ month: 1, count: 2, total: 500, paid: 100, outstanding: 400, overdue: 1 });
  });
});
```

Export the query function (`monthlyInvoiceSummaryQuery(year, propertyId)`) from the hook module so it is testable without React, the way `fetchPropertyUnitIds` is; add `rpc` to the file's Supabase mock.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
/**
 * استعلام ملخّص الشهور عبر RPC؛ الأرقام تعود نصّاً من PostgREST فتُحوَّل هنا.
 */
export function monthlyInvoiceSummaryQuery(year: number, propertyId: string | null) {
  return async (): Promise<MonthSummaryItem[]> => {
    const { data, error } = await supabase.rpc("get_invoice_month_summary", {
      p_year: year,
      p_property_id: propertyId,
    });
    if (error) throw error;
    return (data ?? []).map((row) => ({
      month: Number(row.month), count: Number(row.count), total: Number(row.total),
      paid: Number(row.paid), outstanding: Number(row.outstanding), overdue: Number(row.overdue),
    }));
  };
}

export function useMonthlyInvoiceSummary(year: number, propertyId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["invoice-month-summary", year, propertyId],
    enabled,
    ...FINANCE_QUERY_OPTIONS,
    queryFn: monthlyInvoiceSummaryQuery(year, propertyId),
  });
}
```

Import `MonthSummaryItem` from `@/components/admin/invoices/AnnualKpiRibbon` (or move the type to `src/lib/invoiceMonthSummary.ts` if that import direction is awkward; keep one definition). `database.types.ts` Functions:

```ts
      get_invoice_month_summary: {
        Args: { p_year: number; p_property_id?: string | null };
        Returns: Array<{ month: number; count: number; total: number; paid: number; outstanding: number; overdue: number }>;
      };
```

- [ ] **Step 4: Run** `bun run test -- src/hooks/useInvoices.test.ts && bun run typecheck` — Expected: PASS.

---

### Task 8: Route param, property select in both toolbars, ribbon chip

**Files:**
- Modify: `src/routes/admin.invoices.tsx` (validateSearch, state, nav helpers, props), `MonthlyInvoicesOverview.tsx:189-281`, `ClassicInvoicesOverview.tsx:79-127`, `AnnualKpiRibbon.tsx:77-83`
- Test: `MonthlyInvoicesOverview.test.tsx`, `ClassicInvoicesOverview.test.tsx`, `src/routes/admin.invoices.test.ts` (create; validateSearch only)

- [ ] **Step 1: Write the failing tests**

Both overview tests: add `propertyId: ""`, `propertyOptions: [{ value: "p1", label: "PROP-001 — A" }]`, `onSelectProperty: vi.fn()` to the props factory and assert the markup contains `PROP-001 — A` and that the property trigger's markup appears **after** the add-year trigger text (`indexOf`). `admin.invoices.test.ts`: import `Route` and assert `Route.options.validateSearch({ property: "0b8c7f1e-1111-2222-3333-444455556666" }).property` equals the value and `validateSearch({ property: "x" }).property` is `undefined`. `AnnualKpiRibbon`: with `propertyLabel="PROP-001 — A"` the markup contains it next to the year chip.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

Route:

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// in validateSearch:
property: typeof search.property === "string" && UUID.test(search.property) ? search.property : undefined,
```

Replace `const [propertyId, setPropertyId] = useState("all")` with `const propertyId = search.property;` (`string | undefined` — the hook vocabulary) and

```ts
/**
 * يحفظ المبنى المختار في عنوان الصفحة؛ الفراغ أو "all" يعنيان لا تصفية.
 */
const setProperty = (id: string) =>
  navigate({
    to: "/admin/invoices",
    search: { year, ...(month ? { month } : {}), ...(id && id !== "all" ? { property: id } : {}) },
  });
```

Thread `...(propertyId ? { property: propertyId } : {})` into `goToYear`, `goToMonth` (remove `setPropertyId("all")`), `backToMonths`. Add

```ts
// A property change — including browser Back/Forward — restarts paging and
// drops a unit that may belong to another building, the resets the old
// local handler did by hand.
useEffect(() => { setPage(1); setUnitId("all"); }, [propertyId]);
```

Enable `useProperties` with `canRead && permissions.can(PERMISSIONS.PROPERTIES_READ)`. Compute

```ts
const propertyOptions = propertyFilterOptions(filterProperties.data?.items ?? [], locale);
const propertyLabel = propertyId
  ? (propertyOptions.find((option) => option.value === propertyId)?.label ?? propertyId.slice(0, 8))
  : undefined;
```

Pass `propertyId: propertyId ?? ""`, `propertyOptions`, `propertyLabel`, `onSelectProperty: setProperty` to both overviews; call `useMonthlyInvoiceSummary(year, propertyId ?? null, canRead)`; the month table's `useInvoices` gets `propertyId` directly; the month-detail `SelectFilter` gets `value={propertyId ?? "all"}` and `onValueChange={setProperty}`. `MonthlyInvoicesOverview` forwards `propertyLabel` to `AnnualKpiRibbon`; `ClassicInvoicesOverview` renders it as a chip (`rounded-md bg-muted px-2 py-0.5 text-xs font-mono`) right after its year select. Both toolbars: after the add-year `</Popover>` render

```tsx
          <FilterSelect
            id="invoices-property"
            label={t("filters.property")}
            anyLabel={t("filters.allProperties")}
            value={propertyId}
            options={propertyOptions}
            onChange={onSelectProperty}
            className="w-[16rem]"
          />
```

`AnnualKpiRibbon`: new optional prop `propertyLabel?: string`; when set, render a second chip after the year chip with the same classes.

- [ ] **Step 4: Run** `bun run test && bun run typecheck && bun run lint` — Expected: PASS.

---

### Task 9: Orchestrator gates, guards, docs

- [ ] `bun run lint && bun run typecheck && bun run test && TEST_DB_PORT=55329 bun run test:sql` green on the assembled branch.
- [ ] `clean-code-guard`, `test-guard`, `docs-guard` (migration headers, `sendInvoiceToTenant` header comment, editor hint).
- [ ] `graphify update .`

## Debate — round 1 (Codex astra 6 high, `gpt-6-astra --effort high`, relay `--read-only`; tree verified unchanged against the baseline at 2c491c8)

| # | Finding | Sev | Verdict | Reason |
|---|---------|-----|---------|--------|
| 1 | `replace(whole, inner)` interprets `$&` and loops forever | P1 | accept | Splice by index instead of `String.replace`; `$&` test added (Task 2). |
| 2 | Applying 201 before the deploy shows raw section tags to tenants | P1 | accept | Release ordering split: 202 before the merge, 201 after the merged bundle is verified live. Spec header, Task 5 note. |
| 3 | 201 can silently no-op on a drifted body | P1 | accept | `do` block validates exactly one opener/closer in order per locale or raises; drifted-body test added (Task 5). |
| 4 | The migration test's `before` is already wrapped by global setup | P1 | accept | The test installs the pre-201 body inside the transaction (`SEEDED_BODIES_PRE_201`) and proves the second run is a no-op (Task 5). |
| 5 | Fixture errors: generated `balance`, half-moved shared contract, wrong outstanding | P1 | accept | Both shared units moved; money seeded through payments/allocations; complete per-property totals asserted (Task 6). |
| 6 | Three "all" sentinels mixed (`""`, `"all"`, `null`) | P2 | accept | Normalised at the boundaries: URL id-or-absent, hook `string \| undefined`, each select its own vocabulary (Task 8, spec). |
| 7 | URL property change skips page/unit resets | P2 | accept | `useEffect` on `propertyId` resets `page` and `unitId`, covering Back/Forward (Task 8). |
| 8 | Loose UUID regex | P2 | accept | 8-4-4-4-12 structure; malformed 36-char case tested (Task 8). |
| 9 | Counts depend on monetary share; zero-priced touches vanish | P2 | accept | Separate `touches` flag for count/overdue; zero-amount rent line tested (Task 6, spec). |
| 10 | No precision contract for fractional shares | P2 | accept | Unrounded shares, rounded once per month to 3 dp; thirds test pins 0.333 × 3 vs 3 (Task 6, spec). |
| 11 | `findMissingPlaceholders` still flags hidden variables | P2 | accept | Scans `visibleTemplateSource` (same section semantics); test added (Task 2). |
| 12 | Crossed/unmatched closers swallowed | P2 | accept | Section body may contain no section tag, opener or closer; crossed-closer test; real newline in the nesting test (Task 2). |
| 13 | Attachment tests pass on zero enqueue calls; template mocked away | P2 | accept | Exactly-two-calls and per-channel assertions; `loadTemplateCopy`/`renderTemplate` kept real with a wrapped stored body (Task 4). |
| 14 | Building chip has no wiring path | P2 | accept | Route computes `propertyLabel` with an id-prefix fallback and passes it to both overviews; classic gets a chip beside its year select (Task 8, spec). |

## Review — superpowers:requesting-code-review (Claude general-purpose subagent, range 214e0bc..ef9c0da)

Verdict: "With fixes". One critical finding.

| # | Finding | Sev | Verdict | Reason |
|---|---------|-----|---------|--------|
| 1 | Migration 201 mutates outside a transaction; the verifying `do` block cannot undo a half-applied wrap | Critical | accept | `begin;` … `commit;` around the whole file, as 191/193 do. |
| 2 | Neither migration header states the release ordering | Important | accept | Both headers now carry a RELEASE ORDER line (202 before merge, 201 after the bundle is live). |
| 3 | In the deploy window the new sender passed `""` for subtotal/discount, so an unwrapped body showed blank cells | Important | accept | Section keyed on a separate `has_discount` boolean (`"1"`/`""`); `subtotal`/`discount` stay formatted; the unwrapped body renders exactly as before. Fixture, migration, tests, editor chip and spec updated. |
| 4 | Fixture comment claimed byte-identity with migration 70 | Minor | accept | Comment corrected (one indentation space differs). |
| 5 | `useMonthlyInvoiceSummary` lacked an Arabic doc comment | Minor | accept | Added. |
| 6 | Hook imported a type from a component | Minor | accept | `MonthSummaryItem` now lives in `useInvoices.ts`; the ribbon re-exports it for its other consumers. |
| 7 | `receiptDocumentFilename(null, code)` used for an invoice file | Minor | accept | `${safeFilename(code)}.pdf` from `@/lib/safeFilename`. |
| 8 | `visibleTemplateSource` was a bare alias of `renderSections` | Minor | accept | One exported function, `visibleTemplateSource`. |
| 9 | `hasDiscount` location smell | Minor | reject | Moving it churns four imports for no behaviour; the badge module is where every discount helper already lives. |
| 10 | Test gaps: loader throwing; the real seeded body through `stripMarkup` | Minor | accept | Both tests added (`invoiceDocumentPdf.test.ts`, `templateRender.test.ts`). |
| 11 | Chip shows an id prefix while properties load | Minor | reject | Cosmetic, a sub-second flash on deep links; the fallback exists so the chip is never blank. |
| — | Month-detail select now shows "CODE — Name" labels | deviation | accept | Intentional consistency with the tenants/contracts filters (`propertyFilterOptions` doc); called out in the PR body. |

## Self-review

- Spec coverage: T1 (Tasks 2 stripMarkup, 4), T2 (Tasks 1, 2 sections, 3, 5), T5 (Tasks 6, 7, 8). All spec tests named in a task.
- Placeholders: none; two "check the real column/literal" notes point at exact migrations.
- Type consistency: `renderInvoiceDocumentPdf` return shape used identically in Task 4's test and sender; `MonthSummaryItem` single definition; RPC name/args identical in 6, 7, and the types entry.
