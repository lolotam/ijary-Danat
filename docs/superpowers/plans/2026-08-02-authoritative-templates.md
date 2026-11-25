# Authoritative Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the stored `notification_templates` body actually control the sent email for the six types that have senders, and give admins an HTML source editor with a live Arabic/English preview.

**Architecture:** Generalise migration 68's proven `loadCredentialCopy` pattern into a shared `loadTemplateCopy`. Each sender loads the DB copy, falls back to its built-in builder when the row is missing or inactive, and composes through one `renderEmailDocument` that applies the branded shell unless the body is a full HTML document. Migration 70 seeds every body so it reproduces today's output, making the switch invisible until an admin edits.

**Tech Stack:** TanStack Start (React 19), Bun, Vitest, self-hosted Supabase (Postgres 17.6), Tailwind 4 + shadcn/ui, manual SQL migrations.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-02-authoritative-templates-design.md`. Read it before Task 1.
- **Branch:** `feat/authoritative-templates`, cut from `main` after PR #61.
- **Migrations go to the LIVE database over `ssh-danatfuture-mcp`, not local Docker.** Container `danatfuture-supabase-ozoxsa-db-1`, `psql -U supabase_admin -d postgres`, run with `-v ON_ERROR_STOP=1 --single-transaction`. Apply **only** the new migration — never replay the set. SSH exec caps commands at **1000 characters**: transfer via `base64 -w0`, `split -b 800`, chunked `printf … >>`, then `base64 -d` and **verify `md5sum` against the local file** before running.
- **Snapshot before writing:** `select code, body_ar, body_en from public.notification_templates` to a file on the host, so the previous bodies are recoverable.
- **`src/integrations/supabase/database.types.ts` is hand-maintained.** Never run `bun run gen:types`.
- **Never edit an applied migration.** New behaviour goes in a new numbered file.
- **Every user-facing string needs both locales** in `src/i18n/dictionary.ts`. `type Dict = Record<string, string>` — **`typecheck` will NOT catch a missing key.** Verify parity with `rg -c`.
- **Escaping rule:** placeholder _values_ are escaped (`escapeVariables`); the admin-authored markup around them is not. Never escape the template body itself.
- **Gates before presenting any task:** `bun run lint`, `bun run typecheck`, `bun run test`.
- Commit after every task. Never force-push, rebase, amend or squash.

---

## File Structure

| File                                            | Responsibility                                                   | Task |
| ----------------------------------------------- | ---------------------------------------------------------------- | ---- |
| `src/lib/emailTemplates.ts`                     | `renderEmailDocument` — the one place the shell decision is made | 1    |
| `src/lib/templateRender.ts`                     | Gains `stripMarkup`, promoted from `notifyUserCredentials`       | 1    |
| `src/lib/templateRender.test.ts`                | Extend for `stripMarkup`                                         | 1    |
| `src/lib/emailTemplates.test.ts`                | Extend for `renderEmailDocument`                                 | 1    |
| `src/fns/loadTemplateCopy.ts`                   | The shared DB loader                                             | 2    |
| `src/fns/loadTemplateCopy.test.ts`              | Loader behaviour and fallback                                    | 2    |
| `src/fns/notifyUserCredentials.ts`              | Drops its private copy, imports the shared one                   | 2    |
| `src/lib/templateVariables.ts`                  | Placeholder registry + preview samples                           | 3    |
| `db/migrations/70_seed_template_bodies.sql`     | Seeds 14 bodies reproducing current output                       | 4    |
| `src/db/templateBodies.sqltest.ts`              | Rows intact, idempotent                                          | 4    |
| `src/lib/templateFidelity.test.ts`              | **Seeded bodies reproduce the builders**                         | 4    |
| `src/fns/notifyPaymentSuccess.ts`               | receipt + payment-admin-alert become template-driven             | 5    |
| `src/fns/notifyDepositConfirmed.ts`             | deposit-confirmation                                             | 5    |
| `src/fns/overdueRemindersJob.ts`                | overdue-reminder                                                 | 5    |
| `src/fns/contractExpiryJob.ts`                  | contract-expiry                                                  | 5    |
| `src/fns/sendInvoiceToTenant.ts`                | invoice-document                                                 | 5    |
| `src/components/admin/TemplateEditorDialog.tsx` | Extracted editor: source + preview + placeholders                | 6    |
| `src/routes/admin.settings.notifications.tsx`   | Renders the extracted dialog                                     | 6    |
| `src/i18n/dictionary.ts`                        | `templates.*` keys, both locales                                 | 6    |

---

## Task 1: One place decides the shell

**Files:**

- Modify: `src/lib/emailTemplates.ts`
- Modify: `src/lib/templateRender.ts`
- Modify: `src/lib/emailTemplates.test.ts`, `src/lib/templateRender.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:

  ```ts
  // emailTemplates.ts
  export function renderEmailDocument(locale: EmailLocale, title: string, bodyHtml: string): string;
  // templateRender.ts
  export function stripMarkup(html: string | null): string;
  ```

  Tasks 5 and 6 both call `renderEmailDocument`. Task 2 calls `stripMarkup`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/emailTemplates.test.ts`:

```ts
import { renderEmailDocument } from "./emailTemplates";

describe("renderEmailDocument", () => {
  test("wraps inner content in the branded shell", () => {
    const html = renderEmailDocument("en", "Receipt", "<p>Hello</p>");
    expect(html).toContain("<p>Hello</p>");
    expect(html).toContain("Danat Al Mustaqbal Real Estate");
    expect(html).toContain('dir="ltr"');
  });

  test("an Arabic shell is RTL", () => {
    expect(renderEmailDocument("ar", "إيصال", "<p>مرحبا</p>")).toContain('dir="rtl"');
  });

  test("a full document is used verbatim, shell skipped", () => {
    // The escape hatch: an admin who pastes a whole document gets exactly that,
    // brand header included or not, as they chose.
    const doc = "<!doctype html><html><body>mine</body></html>";
    expect(renderEmailDocument("en", "T", doc)).toBe(doc);
  });

  test("detection ignores leading whitespace and case", () => {
    const doc = "\n  <HTML><body>mine</body></HTML>";
    expect(renderEmailDocument("en", "T", doc)).toBe(doc);
  });

  test("a body merely containing <html> later is still wrapped", () => {
    // Only a body that STARTS as a document opts out. A paragraph mentioning
    // <html> in prose must not accidentally lose the brand shell.
    const body = "<p>use &lt;html&gt; carefully</p>";
    expect(renderEmailDocument("en", "T", body)).toContain("Danat Al Mustaqbal");
  });
});
```

Append to `src/lib/templateRender.test.ts`:

```ts
import { stripMarkup } from "./templateRender";

describe("stripMarkup", () => {
  test("block tags become newlines and entities are decoded", () => {
    // WhatsApp is plain text and would otherwise show a literal &amp;.
    expect(stripMarkup("<p>A &amp; B</p><p>C</p>")).toBe("A & B\nC");
  });

  test("null is empty, not the string 'null'", () => {
    expect(stripMarkup(null)).toBe("");
  });

  test("collapses runaway blank lines", () => {
    expect(stripMarkup("<p>a</p><br/><br/><br/><p>b</p>")).toBe("a\n\nb");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun vitest run src/lib/emailTemplates.test.ts src/lib/templateRender.test.ts`
Expected: FAIL — `renderEmailDocument` and `stripMarkup` are not exported.

- [ ] **Step 3: Implement**

In `src/lib/emailTemplates.ts`, add after `wrapLayout`:

```ts
/**
 * Composes a finished email document from a body.
 *
 * The single place the shell decision is made, so the senders and the admin
 * preview cannot disagree about what an email will look like.
 *
 * A body that STARTS as an HTML document is used verbatim — the escape hatch for
 * an admin who wants total control of one email. Note that skipping wrapLayout
 * also skips the `dir` it sets, so a full-document Arabic template must carry
 * its own dir="rtl". Anything else is inner content and gets the branded shell.
 */
export function renderEmailDocument(locale: EmailLocale, title: string, bodyHtml: string): string {
  if (/^\s*(<!doctype|<html)/i.test(bodyHtml)) return bodyHtml;
  return wrapLayout(locale, title, bodyHtml);
}
```

In `src/lib/templateRender.ts`, add (moved verbatim from `notifyUserCredentials.ts:68-82`, now exported):

```ts
/**
 * Flattens rendered HTML into the plain-text alternative.
 *
 * Block tags become newlines so paragraphs stay paragraphs, and the entities the
 * renderer introduced are turned back into their characters — WhatsApp is plain
 * text and would otherwise show a literal `&amp;`.
 *
 * One authored body, both representations: the table has no body_text column and
 * deliberately does not gain one.
 */
export function stripMarkup(html: string | null): string {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|h[1-6]|li)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
```

Then delete the private `stripMarkup` from `src/fns/notifyUserCredentials.ts` and import it from `@/lib/templateRender`.

- [ ] **Step 4: Run tests**

Run: `bun vitest run src/lib/ src/fns/notifyUserCredentials.test.ts`
Expected: PASS, including the existing credentials tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/emailTemplates.ts src/lib/emailTemplates.test.ts src/lib/templateRender.ts src/lib/templateRender.test.ts src/fns/notifyUserCredentials.ts
git commit -m "feat(templates): one function decides the email shell

renderEmailDocument applies the branded shell unless the body is already a
full document. Senders and the admin preview both call it, so they cannot
disagree about what an email looks like. stripMarkup is promoted out of
notifyUserCredentials so the plain-text alternative is derived once."
```

---

## Task 2: The shared loader

**Files:**

- Create: `src/fns/loadTemplateCopy.ts`, `src/fns/loadTemplateCopy.test.ts`
- Modify: `src/fns/notifyUserCredentials.ts` (delete `loadCredentialCopy`, import the shared one)

**Interfaces:**

- Consumes: `renderTemplate`, `escapeVariables` from `@/lib/templateRender`.
- Produces:

  ```ts
  export async function loadTemplateCopy(
    code: string,
    locale: EmailLocale,
    variables: Record<string, string>,
  ): Promise<{ subject: string | null; body: string | null }>;
  ```

  Task 5 calls this once per sender.

- [ ] **Step 1: Write the failing test**

Create `src/fns/loadTemplateCopy.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

const maybeSingle = vi.fn();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }) }),
  },
}));

const { loadTemplateCopy } = await import("./loadTemplateCopy");

const ROW = {
  subject_ar: "إيصال {{code}}",
  subject_en: "Receipt {{code}}",
  body_ar: "<p>مرحبا {{name}}</p>",
  body_en: "<p>Hello {{name}}</p>",
};

beforeEach(() => {
  vi.clearAllMocks();
  maybeSingle.mockResolvedValue({ data: ROW, error: null });
});

describe("loadTemplateCopy", () => {
  test("reads the column matching the locale", async () => {
    // What an admin edits under "Arabic" must be exactly what an Arabic
    // recipient receives — never the English column.
    const ar = await loadTemplateCopy("receipt-ar", "ar", { name: "أحمد", code: "R-1" });
    expect(ar.body).toBe("<p>مرحبا أحمد</p>");
    expect(ar.subject).toBe("إيصال R-1");

    const en = await loadTemplateCopy("receipt-en", "en", { name: "Ahmed", code: "R-1" });
    expect(en.body).toBe("<p>Hello Ahmed</p>");
  });

  test("a missing row returns nulls so the caller can fall back", async () => {
    // A deleted or inactive template must degrade to the built-in copy, never
    // to sending nothing.
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(loadTemplateCopy("gone", "en", {})).resolves.toEqual({
      subject: null,
      body: null,
    });
  });

  test("a read error returns nulls rather than throwing", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(loadTemplateCopy("receipt-en", "en", {})).resolves.toEqual({
      subject: null,
      body: null,
    });
  });

  test("values are escaped but the template's own markup is not", async () => {
    // A tenant named <script> must not inject through a placeholder, while the
    // admin's own <p> must survive.
    const out = await loadTemplateCopy("receipt-en", "en", {
      name: "<script>alert(1)</script>",
      code: "R-1",
    });
    expect(out.body).toContain("&lt;script&gt;");
    expect(out.body).not.toContain("<script>");
    expect(out.body).toContain("<p>");
  });

  test("an unknown placeholder survives verbatim", async () => {
    // A typo must be visible in the output, not a silent blank.
    const out = await loadTemplateCopy("receipt-en", "en", { code: "R-1" });
    expect(out.body).toContain("{{name}}");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun vitest run src/fns/loadTemplateCopy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/fns/loadTemplateCopy.ts`:

```ts
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { EmailLocale } from "@/lib/emailTemplates";
import { escapeVariables, renderTemplate } from "@/lib/templateRender";

/**
 * The admin-editable subject and body for one notification template.
 *
 * Generalised from loadCredentialCopy (migration 68), which proved the pattern
 * for the credentials mail. The row is chosen by code and the column is then
 * read for the same locale, so what an admin edits under "Arabic" is exactly
 * what an Arabic recipient gets.
 *
 * Returns nulls when the row is missing or inactive — every caller falls back to
 * its built-in copy, so a deleted or disabled template degrades to the previous
 * email rather than sending nothing.
 *
 * Values are escaped; the surrounding template text is admin-authored and may
 * legitimately contain markup.
 */
export async function loadTemplateCopy(
  code: string,
  locale: EmailLocale,
  variables: Record<string, string>,
): Promise<{ subject: string | null; body: string | null }> {
  const result = await supabaseAdmin
    .from("notification_templates")
    .select("subject_ar, subject_en, body_ar, body_en")
    .eq("code", code)
    .eq("is_active", true)
    .maybeSingle();
  if (result.error || !result.data) return { subject: null, body: null };

  const safe = escapeVariables(variables);
  const row = result.data;
  return {
    subject: renderTemplate(locale === "ar" ? row.subject_ar : row.subject_en, safe),
    body: renderTemplate(locale === "ar" ? row.body_ar : row.body_en, safe),
  };
}
```

In `src/fns/notifyUserCredentials.ts`, delete the private `loadCredentialCopy` (lines 44–60) and replace its two call sites with:

```ts
const copy = await loadTemplateCopy(
  locale === "ar" ? "user-credentials-ar" : "user-credentials-en",
  locale,
  credentialVariables(fields, loginUrl),
);
```

mapping `copy.body` where `copy.intro` was used. Add the import and keep the existing behaviour otherwise unchanged.

- [ ] **Step 4: Run tests**

Run: `bun vitest run src/fns/loadTemplateCopy.test.ts src/fns/notifyUserCredentials.test.ts && bun run typecheck`
Expected: PASS — 5 new tests, and the 5 credentials tests unchanged and green.

- [ ] **Step 5: Commit**

```bash
git add src/fns/loadTemplateCopy.ts src/fns/loadTemplateCopy.test.ts src/fns/notifyUserCredentials.ts
git commit -m "feat(templates): share the template copy loader

Generalises migration 68's loadCredentialCopy so every sender can read its
admin-edited subject and body the same way, with the same fall back to the
built-in copy when a row is missing or inactive."
```

---

## Task 3: The placeholder registry

**Files:**

- Create: `src/lib/templateVariables.ts`, `src/lib/templateVariables.test.ts`

**Interfaces:**

- Consumes: `NotificationType` from `database.types`.
- Produces:
  ```ts
  export interface TemplateVariableSpec {
    key: string;
    labelAr: string;
    labelEn: string;
    sample: string;
  }
  export const TEMPLATE_VARIABLES: Partial<Record<NotificationType, TemplateVariableSpec[]>>;
  export function sampleVariablesFor(type: NotificationType): Record<string, string>;
  ```
  Task 4's fidelity test, Task 5's senders and Task 6's editor all read this.

This file is **pure** — no Supabase import — so the browser can import it.

- [ ] **Step 1: Write the failing test**

Create `src/lib/templateVariables.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { TEMPLATE_VARIABLES, sampleVariablesFor } from "./templateVariables";

describe("TEMPLATE_VARIABLES", () => {
  test("every type with a sender has variables declared", () => {
    // The editor lists these and the preview substitutes them. A type missing
    // here shows an admin no placeholders at all.
    for (const type of [
      "receipt",
      "overdue_reminder",
      "contract_expiry",
      "document_send",
      "deposit_confirmation",
      "payment_admin_alert",
      "user_credentials",
    ] as const) {
      expect(TEMPLATE_VARIABLES[type]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("every variable carries both locale labels and a sample", () => {
    for (const specs of Object.values(TEMPLATE_VARIABLES)) {
      for (const spec of specs ?? []) {
        expect(spec.labelAr.length).toBeGreaterThan(0);
        expect(spec.labelEn.length).toBeGreaterThan(0);
        expect(spec.sample.length).toBeGreaterThan(0);
      }
    }
  });

  test("keys are snake_case, matching the {{placeholder}} convention", () => {
    for (const specs of Object.values(TEMPLATE_VARIABLES)) {
      for (const spec of specs ?? []) expect(spec.key).toMatch(/^[a-z0-9_]+$/);
    }
  });

  test("sampleVariablesFor returns a flat key/value map", () => {
    const samples = sampleVariablesFor("receipt");
    expect(samples.tenant_name).toBeTruthy();
    expect(typeof samples.amount).toBe("string");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun vitest run src/lib/templateVariables.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/templateVariables.ts`. The variable sets come directly from the
existing builder signatures in `emailTemplates.ts`, so a template can express
everything its builder could:

```ts
import type { NotificationType } from "@/integrations/supabase/database.types";

/**
 * One `{{placeholder}}` an admin may use, with the value the preview shows.
 *
 * Editor list and preview samples come from the same declaration on purpose:
 * defining them apart is how a preview comes to advertise a placeholder the
 * sender never supplies.
 */
export interface TemplateVariableSpec {
  key: string;
  labelAr: string;
  labelEn: string;
  sample: string;
}

const v = (key: string, labelAr: string, labelEn: string, sample: string) => ({
  key,
  labelAr,
  labelEn,
  sample,
});

/**
 * Keyed by notification type. Derived from each builder's parameters in
 * emailTemplates.ts — keep the two in step when a builder gains a field.
 *
 * Samples are invented, never real records: this renders on an admin screen and
 * must not put a real tenant's name, phone or balance there.
 */
export const TEMPLATE_VARIABLES: Partial<Record<NotificationType, TemplateVariableSpec[]>> = {
  receipt: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("amount", "المبلغ", "Amount", "250.000 KWD"),
    v("payment_date", "تاريخ الدفع", "Payment date", "2026-08-01"),
    v("reference", "المرجع", "Reference", "PAY-2026-0042"),
  ],
  overdue_reminder: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("outstanding", "المبلغ المستحق", "Outstanding", "500.000 KWD"),
    v("days_overdue", "أيام التأخير", "Days overdue", "12"),
  ],
  contract_expiry: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("contract_code", "رقم العقد", "Contract code", "CTR-2025-0130"),
    v("end_date", "تاريخ الانتهاء", "End date", "2026-12-31"),
  ],
  document_send: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("unit_name", "الوحدة", "Unit", "شقة 12"),
    v("property_name", "العقار", "Property", "برج دانة"),
    v("invoice_number", "رقم الفاتورة", "Invoice number", "INV-2026-0042"),
    v("period", "الفترة", "Period", "2026-08"),
    v("issue_date", "تاريخ الإصدار", "Issue date", "2026-08-01"),
    v("due_date", "تاريخ الاستحقاق", "Due date", "2026-08-10"),
    v("subtotal", "المجموع الفرعي", "Subtotal", "250.000 KWD"),
    v("discount", "الخصم", "Discount", "0.000 KWD"),
  ],
  deposit_confirmation: [
    v("amount", "المبلغ", "Amount", "1,000.000 KWD"),
    v("bank_name", "البنك", "Bank", "بنك الكويت الوطني"),
    v("deposit_date", "تاريخ الإيداع", "Deposit date", "2026-08-01"),
    v("code", "رقم الإيداع", "Deposit code", "DEP-2026-0007"),
    v("note", "ملاحظة", "Note", "إيداع نقدي"),
  ],
  payment_admin_alert: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("amount", "المبلغ", "Amount", "250.000 KWD"),
    v("periods", "الفترات", "Periods", "2026-08"),
    v("payment_codes", "أكواد الدفع", "Payment codes", "PAY-2026-0042"),
  ],
  user_credentials: [
    v("display_name", "الاسم", "Display name", "أحمد المطيري"),
    v("username", "اسم المستخدم", "Username", "ahmed"),
    v("password", "كلمة المرور", "Password", "••••••••"),
    v("email", "البريد", "Email", "ahmed@example.com"),
    v("mobile", "الجوال", "Mobile", "+965 5000 0000"),
    v("login_url", "رابط الدخول", "Login URL", "https://danat-future.com/portal"),
  ],
  due_reminder: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("amount", "المبلغ", "Amount", "250.000 KWD"),
    v("due_date", "تاريخ الاستحقاق", "Due date", "2026-08-10"),
  ],
};

/** The preview's substitution map for one type. */
export function sampleVariablesFor(type: NotificationType): Record<string, string> {
  return Object.fromEntries((TEMPLATE_VARIABLES[type] ?? []).map((s) => [s.key, s.sample]));
}
```

Note `password` samples as bullets, never a real-looking secret — the preview is
a screen an admin may share.

- [ ] **Step 4: Run tests**

Run: `bun vitest run src/lib/templateVariables.test.ts && bun run typecheck`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/templateVariables.ts src/lib/templateVariables.test.ts
git commit -m "feat(templates): declare the placeholders and their preview samples

One declaration drives both the editor's placeholder list and the preview's
substitution, so the preview cannot advertise a placeholder no sender fills.
Samples are invented — this renders on an admin screen and must not show a
real tenant's name or balance."
```

---

## Task 4: Seed the bodies, and prove they reproduce today's emails

**Files:**

- Create: `db/migrations/70_seed_template_bodies.sql`
- Create: `src/db/templateBodies.sqltest.ts`
- Create: `src/lib/templateFidelity.test.ts`

**Interfaces:**

- Consumes: `TEMPLATE_VARIABLES` (Task 3), `renderEmailDocument` (Task 1).
- Produces: 14 seeded bodies. Task 5's senders read them.

**This is the task the whole spec's safety claim rests on.** The bodies must
reproduce the builders' output, or Task 5 silently degrades every email.

### How to write each body

For each of the seven non-credentials types, open its builder in
`emailTemplates.ts`, take the `body` string it constructs, and replace each
interpolated value with the matching `{{placeholder}}` from
`TEMPLATE_VARIABLES`. Keep the markup and inline styles exactly as they are.

Worked example — `paymentReceiptTemplate` builds (Arabic arm):

```html
<p>عزيزنا <strong>${tenantName}</strong>،</p>
<p>تم استلام دفعتك بمبلغ <strong>${amount}</strong> بتاريخ ${paymentDate}.</p>
<p>رقم المرجع: <strong>${reference}</strong></p>
```

so `receipt-ar.body_ar` becomes:

```html
<p>عزيزنا <strong>{{tenant_name}}</strong>،</p>
<p>تم استلام دفعتك بمبلغ <strong>{{amount}}</strong> بتاريخ {{payment_date}}.</p>
<p>رقم المرجع: <strong>{{reference}}</strong></p>
```

Do the same for every type and both locales. **Do not trust inspection** — Step 3's
fidelity test is what proves each one, and it must pass before this task is done.

- [ ] **Step 1: Write the failing sqltest**

Create `src/db/templateBodies.sqltest.ts`:

```ts
import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

const CODES = [
  "contract-expiry-ar",
  "contract-expiry-en",
  "deposit-confirmation-ar",
  "deposit-confirmation-en",
  "due-reminder-ar",
  "due-reminder-en",
  "invoice-document-ar",
  "invoice-document-en",
  "overdue-reminder-ar",
  "overdue-reminder-en",
  "payment-admin-alert-ar",
  "payment-admin-alert-en",
  "receipt-ar",
  "receipt-en",
  "user-credentials-ar",
  "user-credentials-en",
];

describe("migration 70", () => {
  test("all sixteen templates are present, active and have both bodies", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ code: string }>(
        `select code from public.notification_templates
          where is_active and body_ar is not null and body_en is not null
          order by code`,
      );
      expect(rows.map((r) => r.code)).toEqual(CODES);
    });
  });

  test("every seeded body carries at least one placeholder", async () => {
    // A body with no {{placeholder}} would render the same text for every
    // tenant — the giveaway that a value was hardcoded during the port.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ code: string }>(
        `select code from public.notification_templates
          where body_ar not like '%{{%' or body_en not like '%{{%'`,
      );
      expect(rows.map((r) => r.code)).toEqual([]);
    });
  });

  test("re-running the seed does not deactivate a template", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.notification_templates set is_active = false where code = 'receipt-ar'`,
      );
      await client.query(
        `update public.notification_templates
            set body_ar = '<p>{{tenant_name}}</p>' where code = 'receipt-ar'`,
      );
      const { rows } = await client.query<{ is_active: boolean }>(
        `select is_active from public.notification_templates where code = 'receipt-ar'`,
      );
      expect(rows[0].is_active).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Write the fidelity test**

Create `src/lib/templateFidelity.test.ts`. This is the check that nothing else
performs:

```ts
import { describe, expect, test } from "vitest";

import {
  contractExpiryTemplate,
  depositConfirmationTemplate,
  invoiceDocumentTemplate,
  overdueReminderTemplate,
  paymentAdminAlertTemplate,
  paymentReceiptTemplate,
} from "./emailTemplates";
import { SEEDED_BODIES } from "./__fixtures__/seededBodies";
import { renderTemplate } from "./templateRender";
import { sampleVariablesFor } from "./templateVariables";

/**
 * Migration 70's whole safety claim is that the seeded bodies reproduce what the
 * builders produce today, so making templates authoritative changes no email
 * until an admin edits one.
 *
 * Nothing else checks that. If a hand-ported body drops the receipt's amounts
 * table, every other test in this piece still passes and the regression ships.
 *
 * Exact equality would fail on whitespace trivia, so this asserts the weaker but
 * sufficient property: every dynamic value the builder emits also appears in the
 * rendered template.
 */
const CASES = [
  {
    type: "receipt" as const,
    code: "receipt",
    build: (locale: "ar" | "en") =>
      paymentReceiptTemplate({
        locale,
        tenantName: "أحمد المطيري",
        amount: "250.000 KWD",
        paymentDate: "2026-08-01",
        reference: "PAY-2026-0042",
      }),
  },
  {
    type: "overdue_reminder" as const,
    code: "overdue-reminder",
    build: (locale: "ar" | "en") =>
      overdueReminderTemplate({
        locale,
        tenantName: "أحمد المطيري",
        outstanding: "500.000 KWD",
        daysOverdue: 12,
      }),
  },
  {
    type: "contract_expiry" as const,
    code: "contract-expiry",
    build: (locale: "ar" | "en") =>
      contractExpiryTemplate({
        locale,
        tenantName: "أحمد المطيري",
        contractCode: "CTR-2025-0130",
        endDate: "2026-12-31",
      }),
  },
  {
    type: "deposit_confirmation" as const,
    code: "deposit-confirmation",
    build: (locale: "ar" | "en") =>
      depositConfirmationTemplate({
        locale,
        amount: "1,000.000 KWD",
        bankName: "بنك الكويت الوطني",
        depositDate: "2026-08-01",
        code: "DEP-2026-0007",
        note: "إيداع نقدي",
      }),
  },
  {
    type: "payment_admin_alert" as const,
    code: "payment-admin-alert",
    build: (locale: "ar" | "en") =>
      paymentAdminAlertTemplate({
        locale,
        tenantName: "أحمد المطيري",
        amount: "250.000 KWD",
        periods: "2026-08",
        paymentCodes: "PAY-2026-0042",
      }),
  },
];

describe("seeded bodies reproduce the builders", () => {
  for (const testCase of CASES) {
    for (const locale of ["ar", "en"] as const) {
      test(`${testCase.code}-${locale} keeps every dynamic value`, () => {
        const samples = sampleVariablesFor(testCase.type);
        const seeded = SEEDED_BODIES[`${testCase.code}-${locale}`][locale];
        const rendered = renderTemplate(seeded, samples) ?? "";
        const builderHtml = testCase.build(locale).html;

        for (const value of Object.values(samples)) {
          if (!builderHtml.includes(value)) continue; // builder does not use it
          expect(rendered, `${testCase.code}-${locale} lost "${value}"`).toContain(value);
        }
      });
    }
  }

  test("invoice-document keeps its line-item values", () => {
    const samples = sampleVariablesFor("document_send");
    const seeded = SEEDED_BODIES["invoice-document-en"].en;
    const rendered = renderTemplate(seeded, samples) ?? "";
    for (const key of ["invoice_number", "subtotal", "due_date", "unit_name"]) {
      expect(rendered).toContain(samples[key]);
    }
  });
});
```

Create `src/lib/__fixtures__/seededBodies.ts` exporting the **same strings the
migration seeds**, so the test checks the real bodies rather than a paraphrase:

```ts
/**
 * The bodies migration 70 seeds, mirrored here so templateFidelity.test.ts
 * checks the real text. When you change the migration, change this — the sqltest
 * checks the database, this checks the content.
 */
export const SEEDED_BODIES: Record<string, { ar: string; en: string }> = {
  // one entry per code, filled in Step 3 alongside the migration
};
```

- [ ] **Step 3: Write the migration and fill the fixture together**

Create `db/migrations/70_seed_template_bodies.sql`. For each of the 16 codes,
`update ... set body_ar = …, body_en = …, subject_ar = …, subject_en = …
where code = '<code>'`. Use `update`, not `insert … on conflict`: every row
already exists, and `update` cannot accidentally create a duplicate or reset
`is_active`.

Header comment:

```sql
-- ---------------------------------------------------------------------------
-- 70 — seed every template body so it reproduces the builder's current output
-- ---------------------------------------------------------------------------
--
-- Making templates authoritative means the stored body replaces the builder's
-- inner content entirely. Seeding bodies that already reproduce today's emails
-- is what makes that switch safe: on the day it ships, every email is the same
-- as it was, and nothing changes until an admin edits a template.
--
-- Bodies are INNER CONTENT — renderEmailDocument wraps them in the branded
-- shell. A body that starts with <!doctype or <html is used verbatim instead.
--
-- `update`, not `insert … on conflict`: all 16 rows already exist, and update
-- cannot create a duplicate or reset is_active.
```

Copy each body string into `src/lib/__fixtures__/seededBodies.ts` as you write it.

- [ ] **Step 4: Apply to the live database and run the tests**

First snapshot, then transfer and apply per the Global Constraints:

```bash
# on the host, before applying
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres \
  -c "\copy (select code, subject_ar, subject_en, body_ar, body_en from public.notification_templates order by code) to '/tmp/templates-before-70.csv' csv header"
```

Then apply migration 70 with `-v ON_ERROR_STOP=1 --single-transaction`, after
verifying the transferred file's `md5sum` matches the local one.

Run: `bun vitest run src/lib/templateFidelity.test.ts && bun run test`
Expected: PASS. If a fidelity test fails, the ported body lost a value — fix the
migration and the fixture, do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/70_seed_template_bodies.sql src/db/templateBodies.sqltest.ts src/lib/templateFidelity.test.ts src/lib/__fixtures__/seededBodies.ts
git commit -m "feat(templates): seed every body to reproduce today's emails

Making templates authoritative means the stored body replaces the builder's
inner content. Seeding bodies that already reproduce current output is what
makes that safe — the switch is observable only as new capability, never as
new wording.

templateFidelity.test.ts is the only check that the ported bodies kept every
dynamic value; without it a dropped receipt table would ship green."
```

---

## Task 5: The six senders read their template

**Files:**

- Modify: `src/fns/notifyPaymentSuccess.ts` (receipt + payment-admin-alert)
- Modify: `src/fns/notifyDepositConfirmed.ts`
- Modify: `src/fns/overdueRemindersJob.ts`
- Modify: `src/fns/contractExpiryJob.ts`
- Modify: `src/fns/sendInvoiceToTenant.ts`
- Modify: each one's existing `.test.ts`

**Interfaces:**

- Consumes: `loadTemplateCopy` (Task 2), `renderEmailDocument` (Task 1), seeded bodies (Task 4).
- Produces: no new exports. Behaviour change only.

`due_reminder` is deliberately **not** in this list — nothing enqueues that type,
so there is no send path to make template-driven. See spec §7.

- [ ] **Step 1: Write the failing test for one sender first**

Add to `src/fns/notifyDepositConfirmed.test.ts`:

```ts
test("the stored template body reaches the enqueued notification", async () => {
  // The assertion that would have failed for all six senders before this piece:
  // it proves the row is actually READ, not merely tagged on the notification.
  maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
  templateRow.mockResolvedValue({
    data: {
      subject_ar: "س",
      subject_en: "S",
      body_ar: "<p>AR-MARKER</p>",
      body_en: "<p>EN-MARKER</p>",
    },
    error: null,
  });

  await notifyDepositConfirmedRecord(DEPOSIT_ID);

  const body = enqueue.mock.calls[0]?.[0]?.body as string;
  expect(body).toContain("EN-MARKER");
});

test("a missing template falls back to the built-in copy and still sends", async () => {
  maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
  templateRow.mockResolvedValue({ data: null, error: null });

  await notifyDepositConfirmedRecord(DEPOSIT_ID);

  expect(enqueue).toHaveBeenCalled();
  const body = enqueue.mock.calls[0]?.[0]?.body as string;
  expect(body.length).toBeGreaterThan(0);
});
```

This requires extending that file's `supabaseAdmin` mock so the deposit fetch and
the template fetch resolve separately. Add a `templateRow` mock and route
`from()` on the table name:

```ts
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: () =>
          table === "notification_templates"
            ? { eq: () => ({ maybeSingle: templateRow }) }
            : { maybeSingle, single: depositRow },
      }),
    }),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun vitest run src/fns/notifyDepositConfirmed.test.ts`
Expected: FAIL — the body comes from the builder, so `EN-MARKER` is absent.

- [ ] **Step 3: Wire that sender**

In `notifyDepositConfirmed.ts`, replace the direct builder call:

```ts
const variables = {
  amount,
  bank_name: deposit.bank_name,
  deposit_date: deposit.deposit_date,
  code: deposit.code,
  note: deposit.note ?? "",
};
const code = locale === "ar" ? "deposit-confirmation-ar" : "deposit-confirmation-en";
const copy = await loadTemplateCopy(code, locale, variables);
const builtIn = depositConfirmationTemplate({
  locale,
  amount,
  bankName: deposit.bank_name,
  depositDate: deposit.deposit_date,
  code: deposit.code,
  note: deposit.note,
});
// The stored template wins; the builder is the safety net for a deleted or
// inactive row, never a second source of truth for the happy path.
const subject = copy.subject ?? builtIn.subject;
const body = copy.body ? renderEmailDocument(locale, subject, copy.body) : builtIn.html;
```

then pass `subject` and `body` to `enqueueNotification`.

- [ ] **Step 4: Run and confirm**

Run: `bun vitest run src/fns/notifyDepositConfirmed.test.ts`
Expected: PASS — including the Piece 1 pause tests, unchanged.

- [ ] **Step 5: Repeat for the remaining five**

Apply the identical three-line shape to each, using its own code and variables:

| File                      | Template code                 | Variables (keys from `TEMPLATE_VARIABLES`)                                                                | Builder                     |
| ------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------- |
| `notifyPaymentSuccess.ts` | `receipt-{ar,en}`             | `tenant_name, amount, payment_date, reference`                                                            | `paymentReceiptTemplate`    |
| `notifyPaymentSuccess.ts` | `payment-admin-alert-{ar,en}` | `tenant_name, amount, periods, payment_codes`                                                             | `paymentAdminAlertTemplate` |
| `overdueRemindersJob.ts`  | `overdue-reminder-{ar,en}`    | `tenant_name, outstanding, days_overdue`                                                                  | `overdueReminderTemplate`   |
| `contractExpiryJob.ts`    | `contract-expiry-{ar,en}`     | `tenant_name, contract_code, end_date`                                                                    | `contractExpiryTemplate`    |
| `sendInvoiceToTenant.ts`  | `invoice-document-{ar,en}`    | `tenant_name, unit_name, property_name, invoice_number, period, issue_date, due_date, subtotal, discount` | `invoiceDocumentTemplate`   |

Add the same two tests (template reaches the body; missing row falls back) to
each sender's test file, adapting the mock the same way.

Where a sender also produces a WhatsApp or text part, derive it with
`stripMarkup(copy.body)` when the template supplied one, else keep the builder's
`text`.

- [ ] **Step 6: Run every gate**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS. Confirm the Piece 1 workflow tests are untouched and green.

- [ ] **Step 7: Commit**

```bash
git add src/fns/
git commit -m "feat(templates): six senders now read their stored template

Each loads its admin-edited subject and body, falling back to the built-in
builder only when the row is missing or inactive. Combined with migration
70's seeds, no email changes until an admin edits one — but from now on,
editing a template actually changes what gets sent.

due_reminder is excluded: nothing enqueues that type, so it has no send path
to make template-driven."
```

---

## Task 6: The editor — HTML source and a live preview

**Files:**

- Create: `src/components/admin/TemplateEditorDialog.tsx`
- Modify: `src/routes/admin.settings.notifications.tsx` (render it; delete the inline dialog)
- Modify: `src/i18n/dictionary.ts`

**Interfaces:**

- Consumes: `TEMPLATE_VARIABLES`, `sampleVariablesFor` (Task 3), `renderEmailDocument` (Task 1), `renderTemplate` (existing).
- Produces:
  ```ts
  export function TemplateEditorDialog(props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    template: Tables<"notification_templates"> | null;
  }): JSX.Element;
  ```

The inline dialog at `admin.settings.notifications.tsx:820-952` moves into its own
file — that route is already ~990 lines and gains a preview pane here.

- [ ] **Step 1: Add the copy in both locales**

In `src/i18n/dictionary.ts`, add to the **Arabic** map:

```ts
    "templates.sourceTab": "شيفرة HTML",
    "templates.previewTab": "معاينة",
    "templates.placeholders": "المتغيّرات المتاحة",
    "templates.insertPlaceholder": "إدراج",
    "templates.previewNote": "معاينة ببيانات تجريبية — ليست بيانات مستأجر حقيقي.",
    "templates.fullDocumentNote":
      "إذا بدأ النص بـ <!doctype أو <html فسيُستخدم كما هو بدون القالب المؤسسي — عندها يجب ضبط dir=\"rtl\" بنفسك للعربية.",
```

and to the **English** map:

```ts
    "templates.sourceTab": "HTML",
    "templates.previewTab": "Preview",
    "templates.placeholders": "Available variables",
    "templates.insertPlaceholder": "Insert",
    "templates.previewNote": "Preview uses sample data — not a real tenant's details.",
    "templates.fullDocumentNote":
      "A body starting with <!doctype or <html is used verbatim without the brand shell — set dir=\"rtl\" yourself for Arabic.",
```

Verify parity by hand — `typecheck` will not catch a missing key:

Run: `rg -c '"templates\.(sourceTab|previewTab|placeholders|insertPlaceholder|previewNote|fullDocumentNote)"' src/i18n/dictionary.ts`
Expected: `12` — six keys × two locales.

- [ ] **Step 2: Build the body editor with its preview**

Create `src/components/admin/TemplateEditorDialog.tsx`. The core is one
`BodyField` used for both locales:

```tsx
/**
 * One body field: HTML source, or a preview of what that HTML becomes.
 *
 * The preview renders through renderEmailDocument — the same function the
 * senders call — so it is honest by construction rather than by a second
 * implementation kept in step.
 *
 * It renders inside an EMPTY-sandbox iframe: no allow-scripts, no
 * allow-same-origin. Admin-authored HTML therefore cannot run script, reach the
 * session, or escape into the admin layout, and a malformed template breaks only
 * its own pane. That is why no HTML sanitiser is used — the body is *meant* to
 * contain arbitrary markup, authored by someone who may already change what the
 * system emails. The isolation protects the admin app from broken HTML, not the
 * system from the admin.
 */
function BodyField({
  label,
  locale,
  value,
  onChange,
  type,
}: {
  label: string;
  locale: EmailLocale;
  value: string;
  onChange: (next: string) => void;
  type: NotificationType;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"source" | "preview">("source");

  const previewHtml = useMemo(() => {
    const rendered = renderTemplate(value, sampleVariablesFor(type)) ?? "";
    return renderEmailDocument(locale, label, rendered);
  }, [value, locale, label, type]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Tabs value={tab} onValueChange={(v) => setTab(v as "source" | "preview")}>
          <TabsList className="h-8">
            <TabsTrigger value="source" className="text-xs">
              {t("templates.sourceTab")}
            </TabsTrigger>
            <TabsTrigger value="preview" className="text-xs">
              {t("templates.previewTab")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {tab === "source" ? (
        <Textarea
          dir="ltr"
          rows={12}
          className="font-mono text-xs"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <iframe
          // Empty sandbox: maximum restriction. Do not add allow-scripts.
          sandbox=""
          srcDoc={previewHtml}
          title={`${label} preview`}
          className="h-[22rem] w-full rounded-md border bg-white"
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add the placeholder reference**

Above the two body fields, list the selected type's placeholders; clicking one
appends it to the focused body:

```tsx
<div className="space-y-1">
  <Label className="text-xs">{t("templates.placeholders")}</Label>
  <div className="flex flex-wrap gap-1">
    {(TEMPLATE_VARIABLES[draft.type] ?? []).map((spec) => (
      <button
        key={spec.key}
        type="button"
        className="rounded border bg-muted px-2 py-0.5 font-mono text-xs hover:bg-accent"
        title={locale === "ar" ? spec.labelAr : spec.labelEn}
        onClick={() => insertPlaceholder(spec.key)}
      >
        {`{{${spec.key}}}`}
      </button>
    ))}
  </div>
  <p className="text-xs text-muted-foreground">{t("templates.previewNote")}</p>
  <p className="text-xs text-muted-foreground">{t("templates.fullDocumentNote")}</p>
</div>
```

Move the rest of the existing dialog (code, type, channel, locale, the two
subject inputs, the footer buttons and the save handler) across unchanged.

- [ ] **Step 4: Render it from the route**

In `admin.settings.notifications.tsx`, delete the inline `<Dialog>` at lines
820–952 and its `templateDraft` state, import the new component, and render:

```tsx
<TemplateEditorDialog
  open={templateOpen}
  onOpenChange={setTemplateOpen}
  template={templateTarget}
/>
```

- [ ] **Step 5: Run every gate**

Run: `bun run lint && bun run typecheck && bun run test && bun run build`
Expected: PASS. There is no component-test harness in this repo, so compilation
plus the browser check below is the verification.

- [ ] **Step 6: Check it in the browser**

Run `bun run dev`, sign in as admin, open `/admin/settings/notifications` →
Templates → edit `receipt-ar`. Confirm:

1. Body fields show monospace HTML source.
2. **Preview** renders the branded shell with sample values substituted — Arabic RTL, English LTR.
3. The placeholder chips match the selected type and insert at the cursor.
4. Pasting `<!doctype html><html dir="rtl"><body>hi</body></html>` previews without the brand shell.
5. Pasting `<script>document.title='x'</script>` in the body does **not** change the admin page title — the sandbox holds.
6. Saving persists, and re-opening shows the saved HTML.

- [ ] **Step 7: Commit**

```bash
git add src/components/admin/TemplateEditorDialog.tsx src/routes/admin.settings.notifications.tsx src/i18n/dictionary.ts
git commit -m "feat(templates): HTML source editor with a live sandboxed preview

Both locales preview independently through renderEmailDocument — the same
function the senders call — so the preview cannot drift from what is sent.
The preview runs in an empty-sandbox iframe, so admin-authored HTML cannot
script, reach the session, or break the admin layout.

Moves the dialog out of the notifications route, which was already ~990
lines."
```

---

## Task 7: Update the docs

**Files:**

- Modify: `CLAUDE.md`

- [ ] **Step 1: Correct the architecture note**

Add to the `src/fns/` bullet:

```markdown
`loadTemplateCopy` reads the admin-edited subject/body from
`notification_templates`; senders fall back to the built-in builder in
`src/lib/emailTemplates.ts` only when a row is missing or inactive. Bodies are
inner content wrapped by `renderEmailDocument`, unless they start with
`<!doctype`/`<html`, in which case they are used verbatim. `due_reminder` has
no sender and is seed-only.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe the template-driven send path"
```

---

## Self-Review

**Spec coverage**

| Spec section                                          | Task                                       |
| ----------------------------------------------------- | ------------------------------------------ |
| §2 hybrid shell + full-document opt-in + `dir` caveat | 1, 6                                       |
| §3 seed bodies reproducing current output             | 4                                          |
| §4 shared loader, fallback, escaping, `stripMarkup`   | 1, 2                                       |
| §5 variables registry + preview samples               | 3                                          |
| §6 editor, sandboxed preview, placeholder help        | 6                                          |
| §7 six senders; `due_reminder` seed-only              | 5                                          |
| §8 tests 1–8                                          | 5 (1, 2), 2 (3, 4), 1 (5), 2 (6), 4 (7, 8) |

**Type consistency** — `loadTemplateCopy(code, locale, variables)` is defined in
Task 2 and called with the same three arguments in Task 5.
`renderEmailDocument(locale, title, bodyHtml)` is defined in Task 1 and called
with the same three in Tasks 5 and 6. `sampleVariablesFor(type)` is defined in
Task 3 and used in Tasks 4 and 6. `SEEDED_BODIES` is created in Task 4 and used
only there.

**Known gaps, stated rather than hidden**

1. **Task 6 has no automated test.** No component-test harness exists in this
   repo. Verified by `lint`/`typecheck`/`build` plus the six-point browser check,
   which explicitly includes the sandbox-holds check.
2. **`SEEDED_BODIES` duplicates the migration's strings.** That duplication is
   deliberate — it is what lets the fidelity test check the real content in a
   unit test — but it can drift. Task 4 Step 3 says to write both together, and
   the sqltest checks the database side independently.
