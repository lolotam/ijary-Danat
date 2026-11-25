# Ten-Task Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver ten product changes — per-contract shop logos, a Cards Control settings screen, property occupancy counts, sequential mark-as-paid enforcement, a column-sorting rollout, commercial names on documents, split contract discount columns, invoice-bound discounts with a duplicate-proof constraint, a portal discount badge, and tenant-detail discount surfacing — as five file-disjoint branches merged one at a time into `main`.

**Architecture:** One base commit establishes a shared card registry and visibility hook so lanes can gate their own pages without depending on each other. The five lanes then own mutually exclusive file sets. The structural change is task 8: percentage and fixed discounts stop being derived from concession date ranges at invoice-generation time and become explicit links from a concession to specific invoices, with `unique (invoice_id)` enforcing "one discount per invoice" declaratively.

**Tech Stack:** TanStack Start (React 19) + Nitro, self-hosted Supabase (Postgres 17, PostgREST, GoTrue), Tailwind CSS 4 + shadcn/ui, react-hook-form + Zod, Vitest, Bun.

**Spec:** `docs/superpowers/specs/2026-08-13-ten-task-batch-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **`src/integrations/supabase/database.types.ts` is hand-maintained** despite looking generated. It exports 73 aliases the Supabase generator does not emit. Add new tables and RPCs by hand. Never overwrite it with `bun run gen:types` output.
- **i18n parity is test-enforced.** `src/i18n/dictionary.test.ts` fails `bun run test` when a key exists in only one locale, and when a `t("literal")` in source does not resolve. Every new string needs both `ar` and `en`.
- **New public tables arrive with `ALL` granted to `anon` and `authenticated`.** `revoke all ... from public` does **not** reach `anon` — revoke from `anon` and `authenticated` explicitly, then grant narrowly.
- **Throw `Error`, never `new Response(...)`, from server functions.** A thrown `Response` resolves as *success* on the client through `x-tss-raw`.
- **Server-function `.validator()` never runs under the test mock.** Any guard that must be tested lives in the function body.
- **`invoices.balance` is `generated always as (total - paid) stored` — but `discount` is an ordinary stored column.** Any code that reduces a total MUST write `discount` too. Writing `total` alone leaves an invoice whose total is reduced while `discount` still reads 0, so the portal badge, the tenant-detail column and the printed document all say "no discount" over a discounted amount. `balance` is the only column that follows automatically.
- **Migrations are ordered by leading number** (`sort -V`, not lexicographic). Numbers for this batch are pre-assigned: **126** card visibility, **127** concession link table + generation change, **128** duplicate cleanup. Do not pick your own number.
- **Do not run `bun run format` before staging** — it rewrites all markdown and buries the real diff.
- **Files stay under 500–600 lines.** Split by responsibility when a file you are editing exceeds it.
- **Every function gets a doc comment above it, leading with an Arabic description.** English may follow for the *why*.
- **Gates before any PR:** `bun run lint`, `bun run typecheck`, `bun run test`. Lane 2 additionally runs `bun run test:sql`.
- **Never force-push, rebase, amend, or squash commits already pushed to `main`** — the repo is Lovable-connected.

---

## Task 0: Base — card registry and visibility hook

Owned by the orchestrator, merged before all lanes. Lanes 1, 2, 3 and 5 consume it.

**Files:**
- Create: `db/migrations/126_card_visibility.sql`
- Create: `src/lib/cardRegistry.ts`
- Create: `src/hooks/useCardVisibility.ts`
- Create: `src/hooks/useCardVisibility.test.ts`
- Modify: `src/integrations/supabase/database.types.ts`
- Modify: `src/i18n/dictionary.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CARD_REGISTRY: readonly CardDefinition[]` where `CardDefinition = { id: string; page: CardPage; labelKey: string }`
  - `type CardPage = "dashboard" | "tenants" | "units" | "contracts" | "payments" | "deposits" | "expenses" | "properties"`
  - `useCardVisibility(): { isCardVisible: (id: string) => boolean; isLoading: boolean }`
  - `useSetCardVisibility(): UseMutationResult<void, Error, { cardId: string; isVisible: boolean }>`

- [ ] **Step 1: Write the migration**

```sql
-- 126_card_visibility.sql
-- Company-wide show/hide for the KPI cards above each list page.
-- Absence of a row means visible, so a newly added card needs no data migration.

create table if not exists public.card_visibility (
  company_id uuid not null references public.companies(id) on delete cascade,
  card_id text not null,
  is_visible boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (company_id, card_id)
);

alter table public.card_visibility enable row level security;

-- Supabase grants ALL to anon and authenticated on new public tables by
-- default, and `revoke from public` does not reach either role.
revoke all on public.card_visibility from anon, authenticated, public;
grant select on public.card_visibility to authenticated;
grant select, insert, update, delete on public.card_visibility to service_role;

drop policy if exists card_visibility_select on public.card_visibility;
create policy card_visibility_select on public.card_visibility
  for select to authenticated using (true);

drop policy if exists card_visibility_write on public.card_visibility;
create policy card_visibility_write on public.card_visibility
  for all to authenticated
  using (public.has_permission('settings.manage'))
  with check (public.has_permission('settings.manage'));

drop trigger if exists set_updated_at on public.card_visibility;
create trigger set_updated_at before update on public.card_visibility
  for each row execute function public.tg_set_updated_at();
```

**Corrected during implementation:** there is no `settings` permission module.
Codes are generated from `PERMISSION_MODULES × BASE_PERMISSION_ACTIONS`, so the
right one is `company.update`. `has_permission` also takes **two** arguments —
`has_permission(_user_id uuid, _code text)` — so the call is
`public.has_permission(auth.uid(), 'company.update')`. A one-argument call fails
function resolution at migration time rather than merely denying writes.

- [ ] **Step 2: Write the failing test**

`src/hooks/useCardVisibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { CARD_REGISTRY } from "@/lib/cardRegistry";
import { resolveCardVisibility } from "@/hooks/useCardVisibility";

describe("resolveCardVisibility", () => {
  it("treats an absent row as visible", () => {
    const isVisible = resolveCardVisibility([]);
    expect(isVisible("dashboard.outstanding")).toBe(true);
  });

  it("hides a card that has a row with is_visible false", () => {
    const isVisible = resolveCardVisibility([
      { card_id: "dashboard.outstanding", is_visible: false },
    ]);
    expect(isVisible("dashboard.outstanding")).toBe(false);
  });

  it("gives every registry card a unique id", () => {
    const ids = CARD_REGISTRY.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every registry card a label key present in both locales", async () => {
    const { dictionary } = await import("@/i18n/dictionary");
    for (const card of CARD_REGISTRY) {
      expect(dictionary.en[card.labelKey], `en:${card.labelKey}`).toBeTruthy();
      expect(dictionary.ar[card.labelKey], `ar:${card.labelKey}`).toBeTruthy();
    }
  });
});
```

Check the dictionary's actual export name first with
`grep -n "^export const\|^export default" src/i18n/dictionary.ts` and adjust the
import to match — do not assume `dictionary`.

- [ ] **Step 3: Run the test and confirm it fails**

Run: `bun run test src/hooks/useCardVisibility.test.ts`
Expected: FAIL — `Cannot find module '@/lib/cardRegistry'`.

- [ ] **Step 4: Write the registry**

`src/lib/cardRegistry.ts` declares all 41 cards. Ids are `<page>.<slug>`.
Enumerate them by reading each page's `VibrantKpiCard` calls in order:

| Page | Source file | Count |
| --- | --- | --- |
| dashboard | `src/routes/admin.index.tsx` (from line ~248) | 9 |
| tenants | `src/routes/admin.tenants.index.tsx:470` | 4 |
| units | `src/routes/admin.units.index.tsx:218` | 5 |
| contracts | `src/routes/admin.contracts.tsx:652` | 5 |
| payments | `src/routes/admin.payments.tsx:1022` | 5 |
| deposits | `src/routes/admin.deposits.tsx:276` | 4 |
| expenses | `src/routes/admin.expenses.tsx:343` | 4 |
| properties | `src/routes/admin.properties.index.tsx` | as found |

The dashboard's nine cards use inline `locale === "ar" ? … : …` labels rather
than `t()`. Add `settings.cards.dashboard.*` keys for those nine so the settings
screen has something to render; do **not** refactor the dashboard's own labels in
this task.

- [ ] **Step 5: Write the hook**

`src/hooks/useCardVisibility.ts` exports the pure `resolveCardVisibility(rows)`
helper — tested directly, since it holds all the logic — plus the React Query
wrapper `useCardVisibility()` and the `useSetCardVisibility()` mutation that
upserts one `(company_id, card_id)` row and invalidates the `["card-visibility"]`
query key.

- [ ] **Step 6: Add the table to `database.types.ts` by hand**

Follow the existing `TableDefinition` shape used by neighbouring tables in that
file. Do not run `gen:types`.

- [ ] **Step 7: Run gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 8: Apply migration 126 to production, then commit**

```bash
# On the production host, via ssh-danatfuture-mcp, BEFORE the merge:
#   pg_dump first, then apply, then:
#   psql -Atc "notify pgrst, 'reload schema'"
git add db/migrations/126_card_visibility.sql src/lib/cardRegistry.ts \
  src/hooks/useCardVisibility.ts src/hooks/useCardVisibility.test.ts \
  src/integrations/supabase/database.types.ts src/i18n/dictionary.ts
git commit -m "feat(settings): card registry and company-wide visibility hook"
```

---

## Task 1 (Lane 1): Shop logo per contract

**Files:**
- Modify: `src/hooks/useLinkedBrand.ts`
- Modify: `src/hooks/useTenants.ts:92,120,235-252`
- Modify: `src/routes/admin.tenants.index.tsx:617-620,953-957`
- Modify: `src/routes/portal.index.tsx:28`
- Modify: `src/routes/admin.tenants.$id.index.tsx:39`
- Modify: `src/components/admin/tenant-detail/TenantContractTabs.tsx`
- Test: `src/hooks/useLinkedBrand.test.ts` (create), `src/hooks/useTenants.test.ts`

**Interfaces:**
- Consumes: `fetchActiveBrandsByContractIds(contractIds: string[]): Promise<Map<string, BrandAssetUrls>>` from `src/lib/brandLogos.ts` — already per-contract, do not change it.
- Produces: `TenantActiveLocation` gains `logoUrl: string | null` and `cardUrl: string | null`; new hook `useBrandsForTenantContracts(tenantId: string | null): UseQueryResult<Map<string, LinkedBrand>>`.

**The defect:** `useTenants.ts:236` reads `locations[0]` and `useLinkedBrand.ts:29`
uses `.limit(1).maybeSingle()`. Both collapse a multi-contract tenant to one brand.
`brandLogos.ts` is already correct — the loss is entirely downstream.

- [ ] **Step 1: Write the failing test for the per-contract mapping**

Assert that a tenant with two active contracts, each with its own active brand,
produces two locations whose `logoUrl` values differ and match their own
contract. Follow the mocking style already in `src/hooks/useContracts.test.ts`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test src/hooks/useTenants.test.ts`
Expected: FAIL — both locations carry the primary contract's logo.

- [ ] **Step 3: Attach the logo per location in `useTenants`**

Inside the `locations` map at `useTenants.ts:212`, read `brands.get(contract.id)`
for each contract rather than only for `primary`. Keep the tenant-level
`shopLogoUrl` / `shopCardUrl` as the primary contract's values so the CSV export
and mobile card list keep working unchanged.

- [ ] **Step 4: Replace the single-brand tenant hook**

In `useLinkedBrand.ts`, add `useBrandsForTenantContracts` returning a
`Map<contractId, LinkedBrand>` built from a query **without** `.limit(1)`.
Keep `useBrandForUnit` single-valued: the `one_active_contract_per_unit` unique
index means a unit has at most one active contract.

- [ ] **Step 5: Render one logo per contract line in the tenants list**

At `admin.tenants.index.tsx:953`, the shop column renders per tenant. Render one
logo per entry of `tenant.activeContracts`, aligned to that contract's line, so
the shop column and the contract column stay row-aligned. A contract with no
brand renders the existing placeholder rather than collapsing the row.

- [ ] **Step 6: Follow the selected contract in the portal and tenant detail**

`portal.index.tsx` and `admin.tenants.$id.index.tsx` / `TenantContractTabs.tsx`
select from the map by the currently selected contract id instead of calling
`useBrandForTenant`.

- [ ] **Step 7: Run tests and gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useLinkedBrand.ts src/hooks/useTenants.ts \
  src/routes/admin.tenants.index.tsx src/routes/portal.index.tsx \
  src/routes/admin.tenants.$id.index.tsx \
  src/components/admin/tenant-detail/TenantContractTabs.tsx \
  src/hooks/useTenants.test.ts src/hooks/useLinkedBrand.test.ts
git commit -m "fix(logos): resolve the shop logo per contract instead of per tenant"
```

**Manual verification (gates cannot prove this):** open a tenant with two active
branded contracts. The list shows two different logos; switching the portal
contract selector switches the dashboard logo.

---

## Task 2 (Lane 3): Cards Control settings screen

**Files:**
- Create: `src/routes/admin.settings.cards.tsx`
- Create: `src/routes/admin.settings.cards.test.tsx`
- Modify: `src/routes/admin.settings.tsx:10-23` (tabs array)
- Modify: `src/components/admin/SummaryCards.tsx`
- Modify: `src/routes/admin.index.tsx`, `admin.units.index.tsx`, `admin.deposits.tsx`, `admin.expenses.tsx`, `admin.properties.index.tsx`
- Modify: `src/i18n/dictionary.ts`

**Interfaces:**
- Consumes: `CARD_REGISTRY`, `useCardVisibility`, `useSetCardVisibility` from Task 0.
- Produces: nothing other lanes consume.

Lanes 1, 2 and 5 gate the pages they own (tenants, contracts, payments) using
the same hook. This lane does not touch those three files.

- [ ] **Step 1: Add the tab**

Add `{ to: "/admin/settings/cards", key: "settings.cardsControl" as const }` to
the `tabs` array in `admin.settings.tsx`, with `settings.cardsControl` in both
locales (`ar: "التحكم في البطاقات"`, `en: "Cards control"`).

- [ ] **Step 2: Write the failing test**

`src/routes/admin.settings.cards.test.tsx` renders the screen with a mocked
registry and asserts: every page group appears; every card in the registry
renders a checkbox; toggling a checkbox calls the mutation once with
`{ cardId, isVisible: false }`.

Note: shadcn `Button` bakes `disabled:*` classes into every render, so
`toMatch(/disabled/)` on a class string always passes. Assert on the
`disabled` attribute if you assert disabled state at all.

- [ ] **Step 3: Run it and confirm it fails**

Run: `bun run test src/routes/admin.settings.cards.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Build the screen**

Group `CARD_REGISTRY` by `page`, render each group as a card with a checkbox per
entry, wired to `useSetCardVisibility`.

- [ ] **Step 5: Gate the pages this lane owns**

In each of dashboard, units, deposits, expenses, properties: wrap each
`VibrantKpiCard` so it renders only when `isCardVisible("<page>.<slug>")`. Do not
skip the summary query — this system serves ~70 units and the summary is one
RPC; conditional fetching adds branching for no measurable gain.

- [ ] **Step 6: Run gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git commit -am "feat(settings): cards control screen and page-level card gating"
```

**Manual verification (required — the gates cannot prove this):** uncheck a card
in settings, then load its page and confirm the card is gone. This repository's
recurring defect is configuration that is stored and never read; a passing test
on the settings form proves only that the form works.

---

## Task 3 (Lane 3): Property card occupied / vacant counts

**Files:**
- Modify: `src/routes/admin.properties.index.tsx`
- Modify: `src/hooks/useProperties.ts` (confirm the filename with `ls src/hooks | grep -i propert`)
- Test: alongside the hook

**Interfaces:**
- Consumes: nothing from other lanes.
- Produces: property rows gain `occupiedUnits: number` and `vacantUnits: number`.

- [ ] **Step 1: Write the failing test for the occupancy aggregate**

A property with 5 units, 3 of which are named by `contract_units` rows belonging
to contracts in state `active`, reports `occupiedUnits: 3` and `vacantUnits: 2`.
Include a case where a unit belongs to a contract in state `expired` — it counts
as vacant.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test src/hooks/useProperties.test.ts`
Expected: FAIL — fields undefined.

- [ ] **Step 3: Compute occupancy from contracts, not `units.status`**

Join `units → contract_units → contracts` and count distinct units whose
contract state is `active`. `units.status` is deliberately not the source: this
codebase has a documented pattern of status columns written and never read, and a
card that disagrees with the contracts table is worse than no card.

- [ ] **Step 4: Add the collapsible control to the card**

Under the total-units figure, a full-width toggle expands to two circles —
Occupied and Vacant — each showing its count. Use the existing shadcn
`Collapsible`. New i18n keys `properties.occupied` / `properties.vacant` in both
locales.

- [ ] **Step 5: Run gates and commit**

Run: `bun run lint && bun run typecheck && bun run test`

```bash
git commit -am "feat(properties): occupied and vacant unit counts on the property card"
```

---

## Task 4 (Lane 4): Sequential mark-as-paid

**Files:**
- Modify: `src/fns/createPayment.ts:221` region (extract the guard)
- Create: `src/fns/assertPayableInOrder.ts` + `src/fns/assertPayableInOrder.test.ts`
- Modify: the mark-as-paid server function (find it with `grep -rn "markPaid\|mark_invoice_paid" src/fns src/hooks`)
- Modify: `src/routes/admin.invoices.tsx:1195-1210`
- Modify: `src/components/admin/tenant-detail/InvoiceRowsTable.tsx:246-260`
- Modify: `src/components/admin/MarkInvoicePaidDialog.tsx`
- Modify: `src/lib/paymentErrors.ts`, `src/i18n/dictionary.ts`

**Interfaces:**
- Consumes: nothing from other lanes.
- Produces: `assertPayableInOrder(supabase, { invoiceId, contractId }): Promise<void>` — throws `Error("Invoices must be paid in chronological order.")` when an earlier-period unpaid invoice exists on the same contract.

Lane 4 owns `InvoiceRowsTable.tsx` first; lane 2 rebases onto it.

- [ ] **Step 1: Write the failing test**

```ts
// src/fns/assertPayableInOrder.test.ts
it("throws when an earlier unpaid invoice exists on the same contract", async () => {
  await expect(
    assertPayableInOrder(clientWith([
      { id: "older", contract_id: "c1", period_year: 2026, period_month: 1, balance: 500 },
    ]), { invoiceId: "newer", contractId: "c1" }),
  ).rejects.toThrow("chronological order");
});

it("allows an invoice when the only older unpaid invoice is on a different contract", async () => {
  await expect(
    assertPayableInOrder(clientWith([
      { id: "older", contract_id: "c2", period_year: 2026, period_month: 1, balance: 500 },
    ]), { invoiceId: "newer", contractId: "c1" }),
  ).resolves.toBeUndefined();
});

it("throws a plain Error, never a Response", async () => {
  const thrown = await assertPayableInOrder(/* older unpaid */).catch((e) => e);
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(Response);
});
```

The third assertion is not decoration: a thrown `Response` resolves as *success*
client-side through `x-tss-raw`, so the block would silently do nothing.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test src/fns/assertPayableInOrder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Put the invariant in SQL, not in a lifted TypeScript helper**

Do **not** lift `createPayment.ts:196`'s `invoiceSelection` wholesale. It is not
a one-invoice assertion: it needs a tenant id, an optional contract id, the whole
selected prefix, and the RPC's ordering and balances, and it returns a payment
total. Copying it would also open a check-then-pay race.

`setInvoicePaid` receives only `{ invoiceId, manualPaymentReason, paid }`
(`src/fns/setInvoicePaid.ts:13`) — there is no `contractId`, and a
client-supplied one could not be trusted anyway.

So the hard invariant goes **inside the `set_invoice_paid` SQL path**, deriving
the contract and period from the locked invoice row in the same transaction. A
TypeScript pre-check may stay in the server function for a friendly message, but
it is the courtesy, not the guarantee.

The guard runs **only when `paid: true`**. Marking an invoice *unpaid* must stay
unrestricted, or an admin who marked a newer invoice paid by mistake could never
undo it.

**Scope is PER CONTRACT**, derived from the locked invoice's own `contract_id`.
The product owner chose this knowing the consequence: the admin KNET link button
in the same table omits its contract id and is therefore **tenant-wide**, so
mark-as-paid is deliberately the looser of the two. A tenant with two shops can
have shop B's March marked paid while shop A's January is unpaid, even though the
link button beside it would refuse. Do not "fix" this by making the guard
tenant-wide — it is a decision, not an oversight.

Verified as unaffected: closeout settles through `apply_payment_allocation`,
reconciliation through `settleGatewayPayment`, refunds through the reversal
RPCs, and no bulk-import path calls `set_invoice_paid`. The guard must **not** be
pushed down into the generic allocation engine, which would catch all of them.

- [ ] **Step 4: Add the message in both locales**

```ts
// en
"invoices.markPaidOutOfOrder":
  "You should pay the previous invoices firstly before marking this invoice as paid.",
// ar
"invoices.markPaidOutOfOrder":
  "يجب دفع الفواتير السابقة أولاً قبل تعليم هذه الفاتورة كمدفوعة.",
```

Leave `invoices.knetLinkOutOfOrder` untouched — it describes link generation and
its wording still fits that flow. Map the thrown error to the new key in
`paymentErrors.ts` for the mark-paid call sites only.

- [ ] **Step 5: Delete the dead override permission**

`payments.override_chronological_order` sits in `src/lib/permissions.ts:34`,
`src/lib/permissionLabels.ts:55,67` (both locales) and the seeded catalogue in
`db/migrations/03_phase1_permissions_audit.sql:276` — and **no code anywhere
reads it**. It is a checkbox in the roles screen that promises an override the
system has never had. With the hard block confirmed, remove it from the
constant, both label locales, and the catalogue table via migration **129**.

Grep first — `grep -rn "override_chronological_order" src db` — and confirm the
only hits are the four above before deleting.

- [ ] **Step 6: Run gates and commit**

Run: `bun run lint && bun run typecheck && bun run test`

```bash
git commit -am "feat(invoices): enforce chronological order when marking an invoice paid"
```

---

## Task 5 (Lane 4): Commercial name on receipts and invoices

**Files:**
- Create: `src/lib/partyName.ts` + `src/lib/partyName.test.ts`
- Modify: `src/components/admin/ReceiptPrint.tsx`, `src/components/admin/InvoicePrint.tsx`
- Modify: `src/lib/paymentReceiptHtml.ts`, `src/lib/invoicePrintHtml.ts`

**Interfaces:**
- Produces: `resolvePartyName(tenant: { commercial_name: string | null; name_ar: string | null; name_en: string | null }, locale: "ar" | "en"): string`

- [ ] **Step 1: Write the failing test**

```ts
it("prefers the commercial name in both locales", () => {
  const tenant = { commercial_name: "Danat Cafe", name_ar: "شركة x", name_en: "Company X" };
  expect(resolvePartyName(tenant, "en")).toBe("Danat Cafe");
  expect(resolvePartyName(tenant, "ar")).toBe("Danat Cafe");
});

it("falls back to the locale's tenant name when the commercial name is empty", () => {
  expect(resolvePartyName({ commercial_name: "", name_ar: "شركة x", name_en: "Company X" }, "ar"))
    .toBe("شركة x");
  expect(resolvePartyName({ commercial_name: null, name_ar: "شركة x", name_en: "Company X" }, "en"))
    .toBe("Company X");
});

it("never returns an empty string when any name is present", () => {
  expect(resolvePartyName({ commercial_name: "   ", name_ar: null, name_en: "Company X" }, "ar"))
    .toBe("Company X");
});
```

The whitespace case matters: a `commercial_name` of `"   "` is truthy in JS and
would print a blank party on a real receipt.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test src/lib/partyName.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement and route all four documents through it**

One helper used by print, download and email attachment, so the three cannot
drift apart. Confirm each call site actually queries `commercial_name` — several
of these selects are explicit column lists and will silently yield `undefined`
otherwise.

- [ ] **Step 4: Run gates and commit**

Run: `bun run lint && bun run typecheck && bun run test`

```bash
git commit -am "feat(documents): print the commercial name as the party on invoices and receipts"
```

**Note:** the server-side PDF attachment uses `pdfkit`, which is Latin-only and
mojibakes Arabic. Its labels stay English by existing design; only the party name
value changes there.

---

## Task 6 (Lane 5): Column sorting rollout

**Files:**
- Modify: `src/routes/admin.properties.$id.tsx` (units table)
- Modify: `src/routes/admin.units.$id.tsx` (contracts, monthly invoices, manual payments)
- Modify: `src/routes/admin.reports.tsx`, `src/components/admin/ScheduledAndGeneratedReports.tsx`
- Modify: notification pool and template tables under `src/components/admin/notifications/`
- Modify: `src/routes/admin.payments.tsx` (refund, partial payment, insurance payment tables) **and** apply this lane's card gate to that page
- Modify: `src/components/admin/PaymentSidePanels.tsx`

**Interfaces:**
- Consumes: `useTableSort`, `SortableHead` from `src/components/admin/SortableTable.tsx` — **unchanged**. Also `useCardVisibility` from Task 0 for the payments page gate.
- Produces: nothing.

- [ ] **Step 1: Read the reference implementation**

`src/routes/admin.tenants.index.tsx` and `admin.contracts.tsx:777` show the
established pattern. Follow it exactly; do not modify the primitive.

- [ ] **Step 2: For each table, write a test asserting sort on the underlying value**

For at least the date and money columns, assert that sorting orders by the
underlying `Date`/`number`, not the formatted string — `"10 KWD"` sorts before
`"9 KWD"` as text, which is the bug this step exists to prevent.

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `bun run test`
Expected: FAIL on the new assertions.

- [ ] **Step 4: Wrap each header in `SortableHead` with a value-returning `getValue`**

Every column header in every listed table becomes sortable.

- [ ] **Step 5: Gate the payments page cards**

This lane owns `admin.payments.tsx`, so it applies `isCardVisible("payments.*")`
to that page's five cards.

- [ ] **Step 6: Run gates and commit**

Run: `bun run lint && bun run typecheck && bun run test`

```bash
git commit -am "feat(tables): column sorting across the remaining admin tables"
```

---

## Task 7 (Lane 2): Split the contract concession column

**Files:**
- Modify: `src/routes/admin.contracts.tsx:777-780,866-870`
- Modify: `src/hooks/useContracts.ts` (concession aggregates)
- Test: `src/hooks/useContracts.test.ts`

**Interfaces:**
- Produces: contract rows gain `freeMonths: number`, `percentDiscount: { months: number; percent: number } | null`, `fixedDiscount: { months: number; amount: number } | null`.

- [ ] **Step 1: Write the failing test**

A contract with a 3-month fixed discount of 100 KWD yields
`fixedDiscount: { months: 3, amount: 100 }`; one with no discounts yields `null`
for both, **not** `{ months: 0 }`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test src/hooks/useContracts.test.ts`

- [ ] **Step 3: Replace the single column with three**

`Free months` | `Percentage discount` | `Fixed discount`. The latter two render
`count — value`, e.g. `3 — 30%` and `3 — 100 KWD`, in both locales. Each column
is sortable on its numeric month count. Empty cells use the existing "no value"
treatment, not a zero.

The "amount after discount" column from the original request is **out of scope**
by the owner's decision — do not add it.

- [ ] **Step 4: Extract `ConcessionsDialog` into its own file**

`src/routes/admin.contracts.tsx` is ~1470 lines and is a documented split
target; tasks 7 and 8 both edit the dialog. Move `ConcessionsDialog` and its Zod
schema to `src/components/admin/contracts/ConcessionsDialog.tsx`. Move only —
behaviour changes belong to Task 8.

- [ ] **Step 5: Run gates and commit**

```bash
git commit -am "feat(contracts): split the concession column into free months, percentage and fixed"
```

---

## Task 8 (Lane 2): Bind discounts to invoices

This is the structural task. Read the spec's Section 8 before starting.

**Files:**
- Create: `db/migrations/127_concession_invoices.sql`
- Create: `db/migrations/128_cancel_duplicate_concessions.sql`
- Create: `src/db/concessionInvoices.sqltest.ts`
- Modify: `src/components/admin/contracts/ConcessionsDialog.tsx`
- Modify: `src/hooks/useContracts.ts` (concession hooks at lines 636, 652)
- Modify: `src/integrations/supabase/database.types.ts`

**Interfaces:**
- Consumes: the extracted dialog from Task 7.
- Produces: RPC `apply_concession_to_invoices(p_concession_id uuid, p_invoice_ids uuid[])`; hook `useDiscountableInvoices(contractId: string | null)`.

**Root cause — do not skip this paragraph.** The live
`generate_invoices_for_year` (migration `119`, ~line 215) applies percentage and
fixed discounts **by date range**, looping over every matching concession and
subtracting each in turn. Two concessions whose ranges both cover March both
reduce March. INV-0000250 carrying a 100 *and* a 200 discount is that loop, not a
dialog bug. Filtering the dropdown alone leaves the defect intact — regenerating
the invoice re-derives both.

- [ ] **Step 1: Write the failing SQL test**

`src/db/concessionInvoices.sqltest.ts`, following the style of
`src/db/portalPayableByContract.sqltest.ts`:

1. Applying a fixed 100 discount to a chosen invoice leaves its `code` unchanged
   and reduces `total` by 100, with `balance` following automatically.
2. Inserting a second `concession_invoices` row for the same `invoice_id` raises
   a unique violation.
3. Deleting the first concession cascades its link away and makes the invoice
   selectable again.
4. Running `reapply_contract_invoices` on the contract does **not** delete the
   discounted invoice.
5. Generating invoices for a contract that has two overlapping percentage
   concessions applies **neither** at generation time (they now apply only
   through explicit links).

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test:sql` (needs Docker; `bun run test:db` provisions the database)
Expected: FAIL — relation `concession_invoices` does not exist.

- [ ] **Step 3: Write migration 127**

```sql
-- 127_concession_invoices.sql
-- Percentage and fixed discounts stop being derived from concession date ranges
-- at generation time and become explicit links to specific invoices.
--
-- The date-range loop in generate_invoices_for_year subtracted EVERY active
-- concession covering a period, so two overlapping records both reduced the same
-- invoice. `unique (invoice_id)` below is the business rule made declarative:
-- one discount per invoice, freed again when the concession is deleted.

create table if not exists public.concession_invoices (
  concession_id uuid not null references public.concessions(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (concession_id, invoice_id),
  unique (invoice_id)
);

revoke all on public.concession_invoices from anon, authenticated, public;
grant select on public.concession_invoices to authenticated;
grant select, insert, update, delete on public.concession_invoices to service_role;
alter table public.concession_invoices enable row level security;
-- RLS policies mirror the existing concessions_select_allowed policy in
-- db/migrations/04_phase2_properties_tenants_contracts.sql:287 — read it and
-- follow the same contract-scoped shape.
```

Then, in the same migration, re-issue `generate_invoices_for_year` with the
percentage/fixed branch removed from the date-range loop (keep `free_months`,
which skips invoice creation entirely via `period_in_free_months` and can never
collide), and re-issue `reapply_contract_invoices` so its delete branch also
requires `not exists (select 1 from public.concession_invoices ci where ci.invoice_id = v_invoice.id)`
— the same protection paid invoices already have from migration 95.

Copy the **current** function bodies from `db/migrations/119_review_fixes.sql`
before editing; they are the live definitions. Editing an applied migration in
place does not reach production — always a new file.

- [ ] **Step 4: Write the apply RPC**

`apply_concession_to_invoices` is `security definer`. For each invoice id, in a
single transaction:

1. `select ... for update` on the invoice — the check and the write must not race.
2. Reject unless the invoice is fully unpaid, in a live state, belongs to this
   concession's contract and company, and has no existing link.
3. Recompute from the invoice's **own stored `subtotal`**, never from the
   contract's current `contract_units` rents. Repricing a historical invoice
   against today's rent would silently change its base amount — a different and
   much worse bug than the one being fixed.
4. Write **both** `discount` and `total`, preserving `subtotal - discount = total`.
   `discount` is a plain stored column; only `balance` follows automatically from
   `total - paid`. Writing `total` alone produces an invoice that charges less
   while every discount display says there is no discount.
5. Insert the `concession_invoices` link and the `is_concession` `invoice_items`
   line atomically with the amount change — a link without its item, or an item
   without its link, is a half-applied discount.

- [ ] **Step 5: Write migration 128**

Cancels duplicate discounts predating the constraint, keeping the oldest per
contract-period. Production has been hand-cleaned, so this is expected to be a
no-op; it ships so a restored backup cannot reintroduce the state. Before adding
the unique constraint, run the read-only count against production and confirm it
is zero.

- [ ] **Step 6: Run the SQL tests and confirm they pass**

Run: `bun run test:sql`
Expected: PASS, all five cases.

- [ ] **Step 6b: Dry-run 127 and 128 against a restored production dump**

Restore a `pg_dump` of production into a scratch database, apply both
migrations, and abort the whole lane unless every invoice still satisfies:

```sql
-- Must return zero rows.
select id, code from public.invoices
where subtotal - discount <> total
   or balance <> total - paid
   or total < paid;

-- Every discounted invoice has exactly one link and one concession item.
select i.id, i.code from public.invoices i
where i.discount > 0
  and (select count(*) from public.concession_invoices ci where ci.invoice_id = i.id) <> 1;

-- No link crosses a contract boundary.
select ci.invoice_id from public.concession_invoices ci
join public.invoices i on i.id = ci.invoice_id
join public.concessions cn on cn.id = ci.concession_id
where cn.contract_id <> i.contract_id;
```

Also diff every invoice's `(id, code, subtotal, discount, total, paid)` before
and after: the only rows permitted to change are ones the duplicate cleanup was
expected to touch. A test database proves the logic; only the dump proves the
existing rows survive it.

- [ ] **Step 7: Replace the date fields with an invoice multi-select**

In the dialog, `free_months` keeps its current from/to behaviour — already
correct. For percentage and fixed:

- Hide the from/to date fields.
- Show a multi-select listing invoices as `INV-0000250 — March 2026`.
- The list contains only invoices on this contract that are **fully unpaid** and
  have **no** `concession_invoices` row.
- Derive the concession's `start_date` / `end_date` from the selected invoices'
  periods so the existing table columns keep working.

The filter is a usability measure. The unique constraint is the guarantee — do
not treat the filter as sufficient.

- [ ] **Step 8: Add the two dialog table columns**

Month count, and the invoice codes the discount covers.

- [ ] **Step 9: Run gates**

Run: `bun run lint && bun run typecheck && bun run test && bun run test:sql`

- [ ] **Step 10: Apply 127 and 128 to production, then commit**

Migrations go to `danatfuture-supabase-ozoxsa-db-1` with `pg_dump` first and
`notify pgrst, 'reload schema'` after, **before** the PR merges — merging
auto-deploys, and code arriving before schema runs the new bundle against the old
database.

```bash
git commit -am "feat(discounts): bind percentage and fixed discounts to specific invoices"
```

---

## Task 9 (Lane 2): Portal invoice discount badge

**Files:**
- Modify: `src/routes/portal.invoices.tsx`
- Modify: `src/hooks/usePortalInvoices.ts` (only if `discount` is not already selected)
- Modify: `src/i18n/dictionary.ts`

- [ ] **Step 1: Write the failing test**

An invoice with `discount: 10` renders a badge reading `Discount: (10 KWD)`; an
invoice with `discount: 0` renders **no** badge and adds no column.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test src/routes/portal.invoices.test.tsx`

- [ ] **Step 3: Add the badge inside the existing record**

No new column, so undiscounted invoices are visually unchanged. Amount only, no
percentage. Keys `portal.invoice.discountBadge` in both locales.

- [ ] **Step 4: Run gates and commit**

```bash
git commit -am "feat(portal): badge a discounted invoice in My Invoices"
```

---

## Task 10 (Lane 2): Tenant-detail discount column and free-months field

**Files:**
- Modify: `src/components/admin/tenant-detail/InvoiceRowsTable.tsx` (rebased onto lane 4)
- Modify: `src/components/admin/tenant-detail/ContractTabPanel.tsx:213-227`
- Modify: `src/i18n/dictionary.ts`

- [ ] **Step 1: Write the failing test**

An invoice linked to a fixed-discount concession renders a badge with the month
count and the KWD amount; one linked to a percentage concession renders the
percentage plus the resulting discounted amount; an invoice with no discount
renders the existing empty treatment.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test src/components/admin/tenant-detail`

- [ ] **Step 3: Add the Discount column**

Values derive from the invoice's own `discount` and its linked concession — one
source of truth, so a discount applied in the contract dialog is reflected here
along with the updated total and balance.

- [ ] **Step 4: Add the Free months field**

Directly under the Unit field in the contract layout, showing the count of free
months. Uses the existing empty treatment when there are none.

- [ ] **Step 5: Run gates and commit**

```bash
git commit -am "feat(tenant-detail): discount column on invoices and free-months on the contract"
```

---

## Delivery

**Merge order: base → 5 → 1 → 3 → 4 → 2.**

Lane 2 lands last: it is the largest and needs `InvoiceRowsTable.tsx` after lane
4 has finished with it. The orchestrator rebases lane 2 before its PR.

**`src/i18n/dictionary.ts` is the one genuinely shared file.** Merge order
serialises those conflicts rather than removing them, and four lanes would each
add keys to it. Mitigation: **every new i18n key for all ten tasks is added in
the base commit**, leaving all five lanes *read-only* against `dictionary.ts`. A
lane that finds it needs a key it does not have asks the orchestrator to add it
to `main` rather than editing the file itself.

`database.types.ts` is shared by the base and lane 2 only, which is safe because
the base is a mandatory ancestor of every lane.

Each lane: branch from the latest `main`, implement, run gates, run
`clean-code-guard` on production code and `test-guard` on tests, open a PR, wait
for the Codex bot review, address findings, then merge.

Migration-bearing lanes (base, 2) apply their SQL to production **before** the
merge, since merging auto-deploys.

## Self-review

- **Spec coverage:** spec §1→Task 1, §2→Task 2, §3→Task 3, §4→Task 4, §5→Task 6, §6→Task 5, §7→Task 7, §8→Task 8, §9→Task 9, §10→Task 10, §11→Delivery. Task 0 covers the shared base the spec's §11 requires.
- **Placeholder scan:** no TBD/TODO. Both former lookups are now resolved facts: the permission is `company.update` with a two-argument `has_permission`, and the dictionary exports `dictionaries`.
- **Post-review corrections (Codex, read-only critique):** `discount` is a plain stored column, so the apply RPC writes `discount` and `total`, not `total` alone; the RPC computes from each invoice's own stored `subtotal` rather than from current `contract_units`, so history is not repriced; the chronological guard moves into the `set_invoice_paid` SQL path (deriving the contract from the locked row) instead of being lifted out of `invoiceSelection`, and runs only for `paid: true`; all i18n keys move to the base commit.
- **Type consistency:** `isCardVisible` is used with that exact name in Tasks 0, 2 and 6. `resolvePartyName`, `assertPayableInOrder`, `apply_concession_to_invoices` and `useDiscountableInvoices` each appear with one spelling throughout.
