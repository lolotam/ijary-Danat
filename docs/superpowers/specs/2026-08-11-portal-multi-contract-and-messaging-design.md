# Portal multi-contract, announcement banner, live-variable messaging, bulk send, CSV export fixes

**Date:** 2026-08-11
**Branch:** `feat/portal-multi-contract-and-messaging`
**Status:** spec — awaiting Codex debate, then Grok implementation

---

## 1. Problem

The tenant portal was built on an assumption that is no longer true: **one tenant has
one contract**. Migration 110 gave a contract many units; nothing gave a *tenant* many
contracts in the portal UI. Today `usePortalLease` does:

```ts
.eq("state", "active").order("start_date", { ascending: false }).limit(1).maybeSingle()
```

A tenant holding three contracts sees exactly one of them, with no indication the other
two exist. Invoices, payments and the dashboard show an unlabelled union of everything,
so the tenant cannot tell which contract an invoice belongs to.

Five further items ride along, all independently reported:

| # | Area | Defect |
| - | ---- | ------ |
| B1 | Portal header | No channel for admin announcements |
| B2 | Admin → tenant → Send Message | Templates send with `{{amount}}` / `{{period}}` unresolved; no preview |
| B3 | Admin messaging | No way to message all tenants at once |
| B4 | contracts.csv | Multi-unit contract exports only its primary unit/property |
| B5 | tenants.csv | Multi-contract tenant collapses every contract into one semicolon-joined row; Arabic headers never applied |

---

## 2. Facts established by reading the code

These are load-bearing. Any deviation is a bug, not a preference.

1. **`invoices.contract_id` is `not null`** (`InvoiceRow`, migration 112 comment).
   One invoice belongs to exactly one contract. Invoice→contract filtering is exact.
2. **`payments` has no `contract_id`.** `PaymentRow` carries `tenant_id` and a nullable
   `unit_id` only. A payment reaches a contract via
   `payment_allocations → invoices → contract_id`, and **one payment can span two
   contracts** because `portal.invoices.tsx` currently lets the tenant select invoices
   across all of them.
3. **`evaluate_portal_payable_invoices(p_tenant_id uuid)`** is `security definer` and
   returns `sequence_order` / `is_selectable` / `lock_reason` computed across the
   tenant's whole unpaid set. `portal.invoices.tsx:96-108` enforces a **prefix rule**:
   row *n* is selectable only when rows `0..n-1` are all selected.
4. **Migration 97's header states the overload trap**: a `security definer` function's
   identity is `(name, arg types)`. `create or replace` with a new arg list creates an
   *overload* and leaves the old body live. A signature change requires
   `drop function if exists` first.
5. **`renderTemplate` leaves unknown keys verbatim** — by design, so typos surface.
   `sendNotification.ts:82-89` supplies only `tenant_name`, `company_name`, and
   `data.variables`; `SendManualMessageDialog` never sends `variables`. That is the
   exact mechanism behind B2.
6. **No bulk send exists.** `sendNotification`'s validator is `tenantId: z.string().uuid()`
   — singular. The only many-tenant paths are cron jobs over computed sets.
7. **Both CSV call sites omit the locale argument.**
   `exportRecordsToCsv(rows, filename, locale = "en")` — `admin.contracts.tsx:551` and
   `admin.tenants.index.tsx:423` pass two arguments. Arabic headers have never applied.
8. **i18n parity is test-enforced.** `src/i18n/dictionary.test.ts` fails `bun run test`
   when a key exists in one locale only, and checks every `t("literal")` resolves.
9. **`portal.tsx` already threads `?tenant=` through every `Link`** via `linkSearch`.
10. **`archived_at is not null` contracts are excluded everywhere** (migration 82 rule).

---

## 3. Decisions and stated assumptions

The user asked not to be interrupted. Two calls are genuinely the business's, not the
code's. Both are decided here explicitly and flagged in the final summary.

### D1 — Payment locking becomes **per-contract**

**Decision:** when a contract is selected, the pay-oldest-first lock applies *within that
contract*. When "All contracts" is selected, the lock applies across the tenant's whole
set exactly as today.

**Why:** "select a contract, see its invoices, pay them" is meaningless if the oldest
invoice of a *different* contract silently locks the list. The alternative — keeping a
tenant-wide lock while showing a filtered list — produces a screen where every row is
locked with a `lock_reason` naming an invoice the tenant cannot see.

**Implementation constraint:** this must happen **in SQL**, not by filtering the returned
array. Filtering client-side keeps the tenant-wide `sequence_order` but applies the prefix
rule to a filtered array, which would let a tenant pay contract B's May while contract A's
January is unpaid. That is a silent change to a money path.

### D2 — `tenants.csv` becomes one row per contract, and the importer must dedupe

**Decision:** `tenants.csv` emits one row per (tenant × contract), repeating the tenant's
own columns on each row, as the user asked. `admin_bulk_upsert` for tenants must therefore
**dedupe by tenant `code`, taking the first occurrence**, so a re-import of the new export
does not attempt N upserts of the same tenant.

**Why:** the existing code comments say outright that the bulk-import schema reads only
the first value of each joined cell. Making the export one-row-per-contract without
touching the importer would turn a working round trip into duplicate-key churn. Deduping
on first occurrence preserves exactly today's re-import behaviour (primary contract wins)
while the export gains the full data the user needs for reading and reporting.

**Scope note:** contract-level columns on a tenant row are for *reading*, not for creating
contracts on import. The tenants importer does not create contracts today and will not
start to.

### D3 — A payment spanning two contracts appears under both

A payment is shown for contract C when **any** allocated invoice belongs to C. A payment
with no allocations (rare: reversed before allocation) appears only under "All contracts".
The alternative — "primary contract by largest allocation" — would hide money from a
tenant looking at the contract they actually paid.

### D4 — The contract dropdown lists **non-archived contracts of any state**, newest first

Not active-only. A tenant with a recently ended contract still has invoices and payments
under it, and hiding it would hide their own payment history. Archived contracts
(`archived_at is not null`) are excluded, consistent with every other path.

### D5 — Selection lives in the URL as `?contract=<uuid>`

Not in per-page `useState`. This is what makes "Pay Now → My Invoices with the contract
preselected" a `search` prop rather than cross-page state, and it makes the selection
survive refresh, deep links, and the back button. It rides alongside `?tenant=` in the
existing `linkSearch` mechanism.

Absent parameter = "All contracts". A `?contract=` naming a contract that does not belong
to the tenant resolves to "All contracts" (never an error, never another tenant's data —
RLS enforces the same boundary server-side).

### D6 — Bulk send enqueues; it does not loop synchronously

A bulk send writes N `notifications` rows in `queued` state and lets
`notificationDrainJob` deliver them. A synchronous loop over 200 tenants inside one
request would exceed the Nitro request budget and leave delivery half-done with no record
of where it stopped.

**Known production limit, surfaced to the user rather than worked around:** WhatsApp
cannot currently send — all 14 templates are unmapped (migration 38) and only `smtp` is
enabled. The channel selector will offer WhatsApp and `both`, and the drain job will
record the same failure it records today. Bulk email works now; bulk WhatsApp starts
working the moment the template mapping lands.

---

## 4. Design

### 4.1 Portal multi-contract (F1)

**New hook — `usePortalContracts(tenantId)`** in `src/hooks/usePortalData.ts`:

```ts
/** عقود المستأجر المتاحة في البوابة، الأحدث أولاً. */
export function usePortalContracts(tenantId: string | null)
// → { id, code, type, state, start_date, end_date, monthly_amount, unitCodes: string[] }[]
```

Reads `contracts` where `tenant_id = ?` and `archived_at is null`, ordered
`start_date desc`, then joins `contract_units → units` for the codes shown in the
dropdown label.

**New hook — `usePortalContractSelection()`**: reads `?contract` from the router, returns
`{ contractId: string | null, setContractId(next) }` where the setter navigates preserving
every other search param. Single source of truth; the four pages consume it.

**New component — `src/components/portal/ContractSwitcher.tsx`**: a shadcn `Select`
rendering `اسم العقد (CODE)` per the user's "contract name and code in brackets", plus an
"All contracts" option. `min-w-0` and truncating, so a long Arabic contract name cannot
blow out a 360 px viewport.

**Route changes:**

| Route | Change |
| ----- | ------ |
| `portal.index.tsx` | Replace the unit/period/amount strip with the `ContractSwitcher` as a prominent button; move unit info *beneath* it. `usePortalLease` takes the selected contract. "Pay Now" links to `/portal/invoices` carrying `{ tenant?, contract }`. |
| `portal.lease.tsx` | `ContractSwitcher` on the `<h1>` line. Lease detail cards reflect the selected contract. |
| `portal.invoices.tsx` | `ContractSwitcher` on the title line; **new contract-code column** on each invoice row; rows filtered by contract via the RPC. |
| `portal.payments.tsx` | `ContractSwitcher` between the title and the Export CSV button. Rows filtered by derived contract (D3). |

**`usePortalLease(tenantId, contractId)`** — generalized: when `contractId` is null it
keeps today's "newest active contract" fallback so the dashboard has something to show
before a selection is made.

**SQL — migration `121_portal_payable_by_contract.sql`:**

```sql
drop function if exists public.evaluate_portal_payable_invoices(uuid);
create or replace function public.evaluate_portal_payable_invoices(
  p_tenant_id uuid,
  p_contract_id uuid default null
) returns table (...unchanged row type...)
```

- Body copied from migration 97 (highest-numbered live definition), with the invoice
  scan gaining `and (p_contract_id is null or i.contract_id = p_contract_id)` and
  `sequence_order` renumbering **within the filtered set**.
- The `p_contract_id` path re-states migration 97's existing auth guard verbatim
  (`is_staff(auth.uid())` OR tenant owns the profile), and additionally verifies the
  contract belongs to `p_tenant_id` — a contract id from another tenant raises rather
  than silently widening.
- `drop function` first, per fact #4. `revoke ... from public, anon` then
  `grant execute ... to authenticated, service_role`, per the migration-96 lesson that
  `from public` alone misses an explicit anon grant.
- Callers updated; `database.types.ts` hand-edited (fact: it is hand-maintained).

**Invoice contract-code column** comes from a second lightweight query
(`invoices.id → code` of its contract), joined client-side — the RPC's `returns table`
row type is deliberately left unchanged so no other caller has to move.

### 4.2 Pay Now → payment-method dropdown (F2)

Today three method buttons render immediately. New flow:

1. A single **Pay Now** button (disabled until at least one invoice is selected).
2. Pressing it opens a dropdown listing KNET / Google Pay / Apple Pay.
3. Choosing one calls the existing `paySelected(method)` unchanged.

Nothing about the gateway handoff changes: `paymentHandoffFor` already decides
redirect-vs-QR, KNET and Google Pay open the hosted page, Apple Pay shows
`ApplePayQrDialog` where the sheet cannot open. This is a presentation change over
existing, working machinery.

### 4.3 Announcement banner (F3)

**Migration `122_portal_announcement.sql`** — three columns on `companies`:

```sql
alter table public.companies
  add column if not exists announcement_ar text,
  add column if not exists announcement_en text,
  add column if not exists announcement_enabled boolean not null default false;
```

`companies` is already readable by the portal (`useCompany`), so no new RLS.

**Admin:** a card in `admin.settings.index.tsx` — enable toggle plus AR and EN text
fields, saved through the existing company-settings mutation.

**Portal:** `src/components/portal/AnnouncementBanner.tsx`, placed in `portal.tsx`'s
header between the logo `<Link>` and the action cluster, in a
`min-w-0 flex-1 overflow-hidden` slot so it cannot push the logout button off a phone.

- Infinite marquee: CSS `@keyframes` translating `-50%` over a duplicated text node
  (duplication is what makes the loop seamless without JS).
- Direction: `ltr` scrolls left-to-right, `rtl` right-to-left, driven by `dir` from
  `useI18n` — not by a hardcoded animation name.
- Bold, high-contrast, accented — it is meant to read as important.
- **`motion-reduce:animate-none`** halts it and lets the text wrap, following the idiom
  already in `portal.index.tsx`. A marquee that ignores `prefers-reduced-motion` is an
  accessibility defect, and for some vestibular conditions a literal health hazard.
- Renders nothing when disabled or when the locale's text is blank.

### 4.4 Full mobile responsiveness (F4)

Not a separate work item — an acceptance criterion on every portal file touched.
Baseline: **360 × 640** (the smallest phone in real use), tested at 360 / 414 / 768.

- Nothing scrolls the page horizontally; wide content scrolls inside its own container.
- Tap targets ≥ 44 px.
- The invoice and payment rows already use `sm:grid-cols-…`; the new contract column and
  switcher must stack rather than force a horizontal scroll.
- The sticky pay bar keeps `env(safe-area-inset-bottom)` (already present).
- RTL and LTR both verified — a `me-`/`ms-` logical-property slip only shows in one.

### 4.5 Manual message: live variables + preview (F5)

**New server fn — `src/fns/resolveTemplateVariables.ts`:**

```ts
/** يجمع القيم الحية لمتغيرات القالب لمستأجر معيّن. */
export const resolveTemplateVariables = createServerFn({ method: "POST" })
  // input:  { tenantId, templateCode | null, locale, contractId? }
  // output: { variables: Record<string,string>, subject, bodyHtml, bodyText, missing: string[] }
```

Resolves by template *type*, reading the same data the cron jobs read:

| Template type | Variables |
| ------------- | --------- |
| `overdue_reminder` | `amount` (sum of overdue balances), `period`, `unit`, `due_date`, `days_overdue` |
| `due_reminder` | next unpaid invoice's `amount`, `period`, `unit`, `due_date` |
| `receipt` | latest confirmed payment's `amount`, `period`, `unit` |
| `contract_expiry` | `unit`, `months_until_expiry`, `end_date` |
| all | `tenant_name`, `company_name` |

`missing[]` names any `{{placeholder}}` in the template with no resolved value, so the
admin sees *before sending* that a template references data this tenant does not have.

**The critical constraint:** `sendNotification` must call **this same resolver** to build
its variables. A preview computed one way and a send computed another is a preview that
lies. `sendNotification` gains a `contractId` passthrough and replaces its
two-variable literal with a resolver call. Escaping stays where it is —
`escapeVariables` for the HTML path, `stripMarkup` for plain text — so preview and send
agree character for character.

**Dialog changes** (`SendManualMessageDialog.tsx`, currently 285 lines):

- A contract selector when the tenant has more than one (feeds `contractId`).
- A preview panel with tabs: **HTML** (rendered in a sandboxed `<iframe srcdoc>` — an
  admin-authored template is not trusted input to the admin's own session) / **Plain
  text** / **Source**, and an AR ⇄ EN switch that previews *both* locales regardless of
  which will be sent.
- The resolved variable table with `missing` keys called out.
- Preview extracted to `src/components/admin/MessagePreviewPanel.tsx` to keep the dialog
  under the 500–600 line ceiling.

### 4.6 Bulk send to all tenants (F6)

**New server fn — `src/fns/sendBulkNotification.ts`:**

```ts
/** يرسل رسالة يدوية أو قالبًا إلى مجموعة من المستأجرين دفعة واحدة. */
// input: { audience: "all" | "with_active_contract" | "selected",
//          tenantIds?: string[], channel, locale | null,
//          templateCode | null, subject | null, body | null, respectRemindersEnabled: boolean }
// output: { queued: number, skipped: Array<{ tenantId, reason }> }
```

- Guarded by the same `has_permission("notifications.send")` check.
- Resolves variables **per tenant** through `resolveTemplateVariables` — otherwise a bulk
  overdue reminder tells 200 tenants the same amount.
- `respectRemindersEnabled` (default **true**) skips tenants with
  `reminders_enabled = false`. Turning it off is an explicit, logged choice.
- Skips and reports tenants with no address for the chosen channel rather than failing
  the batch.
- Inserts `queued` rows; `notificationDrainJob` delivers them (D6).
- One `write_audit` row for the batch, `notification.bulk_create`, recording audience,
  channel, template, and count.

**Admin UI:** `admin.settings.notifications.tsx` gains a **Send to all tenants** action
opening `SendBulkMessageDialog.tsx` — audience selector, channel, template, the same
preview panel (previewing against the first matching tenant, clearly labelled as a
sample), a live recipient count, and a **typed confirmation** of that count before send.
Bulk messaging is irreversible and outward-facing; a mis-click must not reach 200 people.

### 4.7 CSV exports (F7)

**Extraction first.** Row-building moves out of the routes into pure, testable modules —
`src/lib/contractCsv.ts` and `src/lib/tenantCsv.ts`. This is also how `admin.contracts.tsx`
(~1470 lines, named in CLAUDE.md as a known offender to split when next touched) gets
smaller on the way past.

**`contracts.csv` — one row per (contract × unit).** A three-unit contract emits three
rows sharing contract columns, each carrying its own `unit_code`, `unit_name`,
`property_code`, `property_name_ar/en`, plus `unit_line_order` and `unit_monthly_amount`.
The re-import contract (`unit_code` + `tenant_code` → ids) still reads a single unit per
row, so the round trip is preserved rather than broken.

**`tenants.csv` — one row per (tenant × contract × property-group).** Per the user's
description: tenant + first contract with that contract's properties and units; next row,
same tenant + second contract with its own properties and units. New columns:
`contract_code`, `contract_index` (1-based), `contract_state`, `contract_start_date`,
`contract_end_date`, `contract_monthly_amount`, alongside the existing `connected_*`
columns now scoped to that one contract. A tenant with no contracts still emits one row
with the contract columns blank — a tenant must never vanish from their own export.

**Arabic headers.** Both call sites gain the missing `locale` argument. Every new key is
added to `src/lib/csvHeaders.ts` in both locales.

---

## 5. Testing

| Area | Test | Location |
| ---- | ---- | -------- |
| Portal RPC | `p_contract_id` filters, renumbers `sequence_order` within the contract, and rejects a contract belonging to another tenant | `src/db/portalPayableByContract.sqltest.ts` |
| Portal RPC | signature is the 2-arg form and the 1-arg overload is gone | extend `src/db/portalPayableSignature.structure.test.ts` |
| Contract selection | `?contract=` round-trips; an unknown id falls back to All | `src/hooks/usePortalContractSelection.test.ts` |
| Payment→contract | a payment allocated across two contracts appears under both; an unallocated payment appears only under All | `src/lib/portalPaymentContracts.test.ts` |
| Variables | overdue resolver returns real amounts; `missing[]` names unresolved placeholders; preview and send produce identical output | `src/fns/resolveTemplateVariables.test.ts` |
| Bulk send | queues N rows, skips reminders-off tenants, reports per-tenant skips, resolves variables per tenant | `src/fns/sendBulkNotification.test.ts` |
| CSV | multi-unit contract → N rows; multi-contract tenant → N rows; a tenant with zero contracts still emits one row; Arabic headers applied | `src/lib/contractCsv.test.ts`, `src/lib/tenantCsv.test.ts` |
| Banner | disabled or blank renders nothing; direction follows locale | `src/components/portal/AnnouncementBanner.test.tsx` |
| i18n | parity holds for every new key | existing `dictionary.test.ts` (no new file) |

**Known project trap to avoid:** `createServerFn`'s test mock skips `.validator()`, so a
Zod schema asserted only through a server-fn test never actually runs. Export each schema
and assert against it directly.

Gates: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:db`.
Guards: `clean-code-guard`, `test-guard`, `docs-guard`.

---

## 6. Migration and deployment

Two new migrations, applied to live Supabase **before** the merge (a push to `main`
auto-deploys, and the new bundle would otherwise run against the old schema):

- `121_portal_payable_by_contract.sql` — `drop function` then recreate with
  `p_contract_id`.
- `122_portal_announcement.sql` — three `companies` columns, `add column if not exists`.

Procedure per CLAUDE.md: `pg_dump` first → concatenate from the Dokploy checkout →
`md5sum` against the local file → `psql -v ON_ERROR_STOP=1` → `notify pgrst, 'reload schema'`.
Verify with `bun run test:db` (clean build from scratch), never by replaying the full set
against a migrated database.

`database.types.ts` is hand-maintained: add the `companies` columns and the new RPC
signature by hand. Never overwrite it with `gen:types` output.

---

## 7. Out of scope

- WhatsApp template mapping (migration 38) — bulk WhatsApp stays blocked until it lands.
- Any change to invoice generation, allocation, or the MyFatoorah gateway.
- Refactoring `admin.invoices.tsx` (not touched by this work).
- Creating contracts from a tenants.csv import.
