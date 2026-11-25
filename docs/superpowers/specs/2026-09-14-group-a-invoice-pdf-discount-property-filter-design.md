# Group A — invoice PDF on manual send, discount row only when real, property filter on /admin/invoices

Date: 2026-09-14. Branch: `feat/invoice-pdf-and-filters` (cut from `main` at
2c491c8, after group B). Lands as a pull request.

**Release ordering (two different directions).** Migration 202 (the summary
RPC) is applied to the live database **before** the merge, because the new
bundle calls it. Migration 201 (the template section wrap) is applied **after
the merged bundle is live and verified**, because the old renderer would
print `{{#has_discount}}` literally to tenants. Until 201 runs, the live body
keeps showing the rows; the new renderer treats an unwrapped body exactly as
before.

Covers user tasks T1, T2, T5.

## Evidence that shaped the design

- The manual **Send invoice** action (`src/fns/sendInvoiceToTenant.ts`)
  enqueues an email and a WhatsApp row with no `attachment_paths`; it has
  never rendered a PDF. The receipt path (`renderPaymentReceiptPdfs` →
  `renderAndStorePdf` → `attachmentPayload`) already carries a PDF on both
  channels and the dispatcher turns it into an Evolution media part. Production
  row 2026-09-13 09:42 for INV-0003154 had no attachment keys.
- The WhatsApp text of that send was the admin-edited template body flattened
  by `stripMarkup`, which emits no separator between `<td>` cells, hence
  `رقم الفاتورةINV-0003154المستأجر…`.
- The printable invoice sheet (`src/lib/invoicePrintHtml.ts:124-127`) renders
  the discount row unconditionally; the receipt sheet
  (`paymentReceiptHtml.ts:156-158`) already hides it when no allocation has a
  discount. The email/WhatsApp body comes from `notification_templates`
  (seeded by migration 70, later edited: live checksums differ from the seed)
  and `renderTemplate` is a plain `{{var}}` substituter with no conditionals.
- `/admin/invoices` has no summary RPC: `useMonthlyInvoiceSummary` selects
  `period_month,total,paid,balance,state` for the year and aggregates in
  JavaScript. Per-year invoice counts top out at 857 (2027), under the
  1,000-row cap. 230 invoices span units in more than one building.
- The property → invoice join must go through `invoice_items.unit_id`
  (`invoices.unit_id` is NULL on consolidated invoices, migration 112).
  `useInvoices` already implements it for the month table.

## T1 — PDF attachment on the manual invoice send

### Rendering

New `src/lib/invoiceDocumentPdf.ts` exporting
`renderInvoiceDocumentPdf({ invoice, locale }): Promise<{ bucket; path; displayName } | null>`:

1. `loadInvoicesWithRelations(supabaseAdmin, [invoice])` for tenant, units,
   property and contract.
2. `get_invoice_payment_breakdown(p_invoice_id)` RPC parsed with
   `parseInvoicePaymentBreakdown`.
3. Company row (`companies` ordered by `created_at`, first).
4. `buildInvoiceDocument(invoiceWithRelations, company, locale, fallbackTitle, breakdown)`
   — the same sheet the admin prints and the portal downloads.
5. `renderAndStorePdf({ arabic: true, discriminator: invoice.id, html, name: invoice.code, prefix: "invoice-documents" })`.
   `displayName` is `receiptDocumentFilename(null, invoice.code)` →
   `INV-0003154.pdf`.

Never throws: a failed relation load, breakdown, or render logs and returns
`null`, and the send goes out as text only (same policy as receipts: losing
the attachment is a degradation, losing the send is an outage).

### Sending

`sendInvoiceToTenant` renders once before the channel loop and spreads
`attachmentPayload(stored, [displayName])` into **both** payloads. The
dispatcher already downloads from `attachment_bucket` (`report-documents`)
and, under Evolution, sends the PDF as a document media part; under
Meta/Twilio the key is ignored.

### WhatsApp text

`stripMarkup` gains cell separators: `</td>` and `</th>` become a single
space, `</tr>` becomes a newline (before the existing block-tag rule). The
same body then reads `رقم الفاتورة INV-0003154` on its own line. This changes
every WhatsApp rendering of a table-shaped template body for the better; a
test pins a two-cell row.

## T2 — the discount row appears only when there is a discount

### One predicate

`hasDiscount(value: number | string | null | undefined): boolean` in
`src/lib/invoiceDiscountBadge.ts` (numeric > 0 after `Number()`), used by
`invoiceDiscountBadge`, `invoiceDiscountBadgeText`, `buildPaymentReceiptHtml`
and the new call sites below. Three copies of `discount == null || discount <= 0`
become one.

### Printable invoice sheet

`buildInvoicePrintHtml` renders the discount row only when
`hasDiscount(breakdown.invoice.discount)`. Every consumer inherits it: admin
print, admin PDF download, portal download, payment print bundle, the new
manual-send attachment. The doc comment in `paymentReceiptHtml.ts:128-134`
that asserts the opposite for invoices is rewritten. Tests at
`invoicePrintHtml.test.ts:85-109` are updated to expect no row at zero; the
`discount: 750` case keeps its row.

### Built-in email template

`invoiceDocumentTemplate` takes `discount: string | null`. When `null`, both
the "الإجمالي قبل الخصم / Subtotal" and "الخصم / Discount" rows are omitted
(subtotal equals total then, and a "before discount" line with no discount
line under it is the same confusion). `sendInvoiceToTenant` passes `null`
when `!hasDiscount(invoice.discount)`.

### Admin-editable template body: section syntax

`renderTemplate` learns mustache-style sections:

- `{{#key}} … {{/key}}` renders the inner text only when the variable is a
  non-empty string.
- `{{^key}} … {{/key}}` renders it only when the variable is absent or empty.
- Sections nest, are resolved innermost-first before scalar substitution, and
  an unknown key behaves as empty. A section body may contain no other section
  tag (opening **or closing**), so a crossed or unmatched closer such as
  `{{#a}}A{{/b}}B{{/a}}` matches nothing and every tag is left verbatim (same
  policy as an unknown `{{var}}`). Replacement goes through a callback, never
  a replacement string, so authored text containing `$&`, `$'` or `` $` ``
  is inserted literally and the loop always terminates.
- `findMissingPlaceholders` (the notifications-preview diagnostic) scans the
  **visible** source: hidden sections are removed with the same semantics
  before scalars are checked, so a hidden `{{discount}}` is not reported as
  missing while an unresolved variable inside a shown section still is.

The section is keyed on a **separate boolean variable**, `has_discount`
(`"1"` or `""`), while `subtotal` and `discount` stay formatted exactly as
before. This is what makes the deploy window safe: the new renderer on the
still-unwrapped live body renders the two rows with their real values, as it
always did, and only after migration 201 wraps them does `has_discount`
start hiding them. `sendInvoiceToTenant` sets `has_discount =
hasDiscount(invoice.discount) ? "1" : ""`; the template editor lists
`has_discount` among the invoice-document variables with a hint that it is
for `{{#has_discount}}` sections. `resolveTemplateVariables` (manual sends
from the notifications screen) never supplied it, so a manual send of the
wrapped template omits the two rows — the correct reading of "no value".

Migration `201_invoice_template_discount_section.sql` wraps the two rows in
the **live** body by exact-markup replacement, so an admin-edited body keeps
every other edit:

```sql
update public.notification_templates
   set body_ar = replace(body_ar,
     '<tr><td style="padding:8px 12px;color:#6b6b6b;">الإجمالي قبل الخصم</td>',
     '{{#has_discount}}<tr><td style="padding:8px 12px;color:#6b6b6b;">الإجمالي قبل الخصم</td>')
 where code = 'invoice-document' and position('{{#has_discount}}' in body_ar) = 0;
-- then close the section after the discount row's </tr>, same guard; same for body_en
```

Idempotent by the `position(...) = 0` guard, and **verified, not assumed**:
a `do` block after the updates raises unless each body contains exactly one
`{{#has_discount}}`, exactly one `{{/has_discount}}`, in the order opener →
`{{subtotal}}` → `{{discount}}` → closer. A body whose markup drifted from the
literals therefore aborts the migration loudly instead of reporting success
over an unwrapped row. `src/lib/__fixtures__/seededBodies.ts`
is updated to the wrapped shape so the fidelity fixture matches what a fresh
database holds after 70 + 201. `TemplateEditorDialog` shows one hint line
documenting the section syntax next to the variable chips.

### Not changed

The tenant-detail invoices table keeps its Discount column (decision). The
portal invoice list already hides the badge at zero.

## T5 — property filter on /admin/invoices

### Attribution rule (decision)

A building's numbers are the **rent lines of its units**. An invoice that
spans two buildings is split pro-rata by rent lines: with `share =
Σ(rent lines whose unit is in the building) / Σ(all rent lines)`, the
building's `total`, `paid` and `outstanding` are `total × share`,
`paid × share`, `balance × share`. `count` and `overdue` count invoices that
**touch** the building: at least one rent line whose unit is in it, whatever
its amount (a zero-priced unit still touches). Rent lines are `invoice_items`
with a `unit_id` and neither `is_extra_charge` nor `is_concession`; an
invoice with no rent lines, or whose rent lines sum to zero, contributes zero
money to every building (share 0) while still counting where it touches.
Extra charges and discounts are carried by the share, not attributed to a
unit.

**Precision contract.** Shares are analytical, unrounded fractions; each
month's `total`, `paid`, `outstanding` are rounded once, at the end, to three
decimals. Building sums may therefore differ from the year total by fils
(1 KWD split three ways gives 0.333 + 0.333 + 0.333). The cards are analysis,
not a ledger; no remainder reconciliation is attempted.

### RPC

Migration `202_invoice_month_summary_rpc.sql`:

```sql
create or replace function public.get_invoice_month_summary(
  p_year integer,
  p_property_id uuid default null
) returns table (
  month integer, count bigint, total numeric, paid numeric,
  outstanding numeric, overdue bigint
)
```

`security definer`, `set search_path = public, pg_temp`, guarded by
`has_permission(auth.uid(), 'invoices.read')` for `authenticated`. With
`p_property_id` null it aggregates whole invoices for the year (byte-identical
numbers to today's client aggregation). With a property it applies the share
above. Always returns 12 rows (months with nothing are zero). Grants:
`revoke … from public, anon; grant … to authenticated, service_role`.

### Client

- `useMonthlyInvoiceSummary(year, propertyId, enabled)` calls the RPC;
  query key `["invoice-month-summary", year, propertyId ?? null]`. The
  existing prefix invalidation still hits.
- `database.types.ts` gets the RPC entry by hand.
- Route search gains `property?: string`, accepted only when it matches the
  `8-4-4-4-12` hex UUID structure, threaded through `goToYear`, `goToMonth`,
  `backToMonths`. The URL param becomes the single source for the property
  filter. Sentinels are normalised at the boundaries: the URL carries the id
  or nothing; the hook receives `string | undefined`; the two selects receive
  their own "all" vocabulary (`""` for `FilterSelect`, `"all"` for the
  month-detail `SelectFilter`). Whenever the URL property changes, including
  via browser Back/Forward, an effect resets `page` to 1 and `unitId` to
  "all", the same resets the old local handler performed. `useProperties` is
  enabled whenever the page can read (not only inside a month).
- Both overviews (`MonthlyInvoicesOverview`, `ClassicInvoicesOverview`) get
  `propertyId`, `propertyOptions`, `onSelectProperty` props and render a
  `FilterSelect` (`filters.property` / `filters.allProperties`, options from
  `propertyFilterOptions`) **immediately after the add-year button in the
  same flex row**.
- The route resolves `propertyLabel` from the loaded options
  (`propertyFilterOptions`), falling back to the first eight characters of
  the id when the option is not loaded (missing `properties.read`, load
  failure, id outside the page). It is passed to both overviews:
  `MonthlyInvoicesOverview` forwards it to `AnnualKpiRibbon`, which shows it
  as a chip next to the year chip; `ClassicInvoicesOverview` (no ribbon)
  shows the same chip beside its year select. "Annual total" is never read
  as portfolio-wide when a building is selected.

## Migrations

| File | Content |
|---|---|
| `201_invoice_template_discount_section.sql` | wrap the subtotal+discount rows of `invoice-document` in `{{#has_discount}}…{{/has_discount}}` (ar + en, idempotent) |
| `202_invoice_month_summary_rpc.sql` | `get_invoice_month_summary(integer, uuid)` |

## Tests

SQL (`src/db/*.sqltest.ts`):

- `invoiceTemplateDiscountSection.sqltest.ts`: after 201 both bodies contain
  exactly one `{{#has_discount}}` and one `{{/has_discount}}`, re-running the
  migration file changes nothing, other rows are byte-identical.
- `invoiceMonthSummary.sqltest.ts`: two single-unit contracts in two
  properties plus one two-unit contract across both (300 + 200); year
  totals with null property equal the sum of invoices; property A's total
  equals its own contract plus 300/500 of the shared invoice; paid/outstanding
  follow the share after a partial payment; a month with no invoices returns
  zeros; `anon` cannot execute; a user without `invoices.read` is refused.

Vitest:

- `templateRender.test.ts`: sections shown/hidden, inverted sections,
  nesting, unknown key, unmatched tag left verbatim; `stripMarkup` cell
  separators.
- `invoicePrintHtml.test.ts`: no discount row at zero, row at 750.
- `emailTemplates.test.ts`: `invoiceDocumentTemplate` with `discount: null`
  has neither subtotal nor discount row.
- `invoiceDiscountBadge.test.ts`: `hasDiscount` cases (null, 0, "0", 0.001, "12").
- `invoiceDocumentPdf.test.ts`: returns null and logs when the breakdown RPC
  fails; returns bucket/path/displayName when everything resolves (mocks at
  the Supabase and `renderAndStorePdf` boundaries only).
- `sendInvoiceToTenant.test.ts`: both payloads carry
  `attachment_bucket/paths/names` when the PDF resolves; neither carries them
  when it returns null; `discount` variable is `""` at zero.
- `useInvoices.test.ts`: summary hook calls the RPC with `p_property_id`.
- `MonthlyInvoicesOverview.test.tsx` / `ClassicInvoicesOverview.test.tsx`:
  the property select renders after the add-year trigger and calls
  `onSelectProperty`.
- `admin.invoices` search validation: `property` accepted as uuid, dropped
  otherwise.

## Out of scope

Hiding the tenant-detail Discount column; a portal-side property view; the
payment-page filter policy ("filters never touch the cards") stays as is for
payments.
