# Admin summary cards — design

**Date:** 2026-08-03
**Status:** approved

## Problem

The five admin list pages — Payments, Expenses, Contracts, Tenants, Units — open
directly onto a table. Nothing on the page states the totals. To answer "how much
did we collect", "how many units are vacant", or "what are we owed", an operator
reads rows and adds them up by eye.

Three of the five are server-side paginated at ten rows
(`admin.payments.tsx:139`, `admin.expenses.tsx:149`, `admin.contracts.tsx:171`),
so the answer is not even on screen to be added up. The other two
(`admin.tenants.index.tsx:252`, `admin.units.index.tsx:143`) sidestep paging by
requesting `pageSize: 1000` and show a `listTruncated` banner when that overflows.

There is no shared aggregate anywhere for these modules. `db/migrations/` contains
**no SQL views at all**, and the only summary functions that exist are
`get_budget_summary` and `get_deposit_total`.

## Decisions

Settled with the product owner before this design:

1. **Cards follow the page's active filters.** Filter expenses to one property and
   the totals show that property only.
2. **Totals come from new SQL RPCs**, one per page, taking the same filter
   arguments as the list query — the `get_deposit_total` pattern.
3. **The approved card sets** are listed under _Card sets_ below.
4. **One deviation, on Payments only** — see _Why Payments is module-wide_.

## Why Payments is module-wide

The Payments page has no page-level filter. It is a tab shell (`PaymentsPage`,
`admin.payments.tsx:970`) whose only search box lives **inside** the Full-payments
tab. The other three tabs are backed by `useMoneyRecords`
(`src/hooks/useRefunds.ts:89`), which takes no filters at all — just `.limit(500)`.

That is not an oversight in the UI, it is the schema. Verified in
`src/integrations/supabase/database.types.ts`:

| Table                | has `code`? | has `status`? |
| -------------------- | ----------- | ------------- |
| `payments`           | yes         | yes           |
| `partial_payments`   | **no**      | **no**        |
| `insurance_payments` | **no**      | **no**        |
| `refunds`            | **no**      | **no**        |

Three of the four are plain ledgers — amount, date, tenant, note. A text search or
status filter is not expressible against them. A cross-tab card row driven by the
Full tab's local search would show a "Refunds" figure that contradicts the Refunds
tab whenever the box is non-empty.

So the Payments card row sits above the tabs and is module-wide. The RPC still
**accepts** the filter arguments and applies them to the `payments` table, so
lifting the search box above the tabs later turns filter-following on with a
one-line change in the route. The other four pages follow their filters from day
one.

## Card sets

| Page          | Cards — value → hint                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Payments**  | Full payments (KWD → n records) · Partial (KWD → n) · Insurance held (KWD → n) · Refunds (KWD → n) · Net collected (KWD)                         |
| **Expenses**  | Total (KWD → n) · Approved (KWD → n) · Pending (KWD → n) · This month (KWD → n)                                                                  |
| **Contracts** | Total (n) · Active (n → % of total, progress bar) · Expiring ≤60d (n → soonest end date) · Ended (n) · Annual rent value (KWD → monthly as hint) |
| **Tenants**   | Total (n) · Active (n) · In arrears (KWD → n tenants) · Blocked/inactive (n)                                                                     |
| **Units**     | Total (n) · Occupied (n → occupancy %, progress bar) · Vacant (n) · Under maintenance (n) · Monthly rent potential (KWD)                         |

## Semantics that are not obvious

**Confirmed-and-not-reversed.** The Full-payments total counts
`status = 'confirmed' and reversed_by_payment_id is null` — the same predicate
`get_budget_summary` uses for `collections`. Chosen so the Payments card and the
budget report on `/admin/reports` cannot disagree.

**Insurance does not move net.** `net = full + partial − refunds`. Insurance is a
holding, not income; `useBudget.ts:26` already documents this and
`BudgetSummary` keeps `insurance_collected` out of `net` for the same reason.

**There is no `expiring` contract state.** `ContractState` is
`draft | active | frozen | suspended | expired | renewed | terminated`, and
migration 76 states outright that nothing in the codebase transitions a contract
to `expired` — `contractExpiryJob` only sends reminders. So:

- `expiring_60d` = `state = 'active' and end_date between current_date and current_date + 60`
- `ended` = `state in ('expired','terminated')` — contracts someone ended by hand

**`units.status = 'occupied'` is authoritative.** Migration 76 made it a
trigger-maintained projection of active contracts; the app cannot write it
(`omitDerivedStatus`, `useUnits.ts:202`). `available` and `reserved` are retired
values kept only because Postgres cannot drop an enum member — do not surface them.

**Arrears** sums `invoices.balance` where `state = 'overdue' and balance > 0`, the
same predicate behind the `hasOverdue` badge in `useTenants.ts`, so the card and
the row badges agree. The tenant figure is `count(distinct tenant_id)`.

## Known wart

`useDashboardKpis` (`admin.index.tsx:97`) counts tenants and units with **no
`archived_at` filter**, while every list hook excludes archived rows. The new RPCs
follow the **list hooks**. A page card may therefore differ from the `/admin`
dashboard tile — the page card is the correct one. Reconciling the dashboard is
out of scope and left as a follow-up.

## Security

Each RPC is `stable security definer`, which bypasses RLS by design — so the
permission check _is_ the access control, exactly as in `get_budget_summary`:

```sql
if auth.role() = 'authenticated'
   and not public.has_permission(auth.uid(), 'payments.read') then
  raise exception 'Permission denied' using errcode = '42501';
end if;
```

All five codes (`payments.read`, `expenses.read`, `contracts.read`,
`tenants.read`, `units.read`) already exist — migration 03 generates the catalog
as modules × actions.

**The grant closes a hole the existing migrations leave open.** They only
`revoke ... from public`, which does **not** reach `anon`: Supabase grants `anon`
directly through default privileges, so `anon` retains execute. Every function
here revokes from `public, anon` explicitly.

## Failure behaviour

A summary query that errors must never blank the table beneath it. `SummaryCards`
renders nothing on error and logs to the console. The table is the product; the
cards are a garnish.

## Out of scope

- Collapsing the ~14 duplicated `Intl.NumberFormat` declarations (a new
  `formatKwd` helper is added and used by new code only).
- Pointing `useBudget.ts` at the new shared `numberValue`. It keeps its own local
  copy; that hook is on the money path behind `/admin/reports` and a drive-by
  dedupe does not belong in this change.
- Lifting the Payments search above the tabs.
- Fixing `useDashboardKpis`' missing `archived_at` filter.

---

---
