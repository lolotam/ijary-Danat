# Group B — close-out follow-ups, due day 1, rent increase

Date: 2026-09-14. Branch: `feat/contract-closeout-and-increase`. Lands as a
pull request against `main`, which auto-deploys; migrations are applied to the
live Supabase before the merge.

This spec covers three of the eleven September requests (user numbering T10,
T3, T11). Groups A, C and D have their own specs.

## Evidence that shaped the design

- INV-0007120 (CON-00026, 9/2026) was written off by close-out c33c53ba at
  2026-09-13 12:09:34, then `invoice.mark_paid` at 12:13:59 and 12:19:32 each
  followed by `invoice.unmark_paid`, leaving it `due`. `set_invoice_paid`
  (migration 159) has no state guard and inserts the allocation directly,
  bypassing the only waived check in `apply_payment_allocation`. Its unpay
  branch recomputes state from money and has no branch that can yield
  `waived`. Restored by hand to `waived` with an audit row on 2026-09-13
  22:58 UTC.
- DANA-000024 stays `active` because it holds CON-00063 (live until
  2027-12-31). `compute_tenant_lifecycle` (migration 59) already implements
  "ended only when no contract is active". Decision: keep that rule.
- The tenants list `?view=active` tab pins `lifecycle=active` server-side;
  the Life Cycle select then ANDs a second value client-side. Choosing
  "Contract Ended" on the Active tab therefore always returns zero rows,
  although three tenants are `contract_ended`.
- 67 of 70 active contracts carry `due_day = 15`. The column default, the form
  default, the save RPC default and the bulk-import default are all 1. The
  15s are data. All four pricing sites read `contracts.due_day` as the day of
  the **period** month; no trigger recomputes existing `due_date`.
- Contract-expiry tenant **email** ignores `tenants.reminders_enabled` at all
  three layers: `identify_contract_expiry_reminders` lost the join filter in
  migration 58, `contractExpiryJob.ts` gates only the WhatsApp leg, and the
  dispatcher's check lives inside the WhatsApp branch.
- No rent-escalation concept exists. Rent is `contract_units.monthly_amount`,
  read inline by `generate_invoices_for_year` and the fill pass of
  `sync_contract_invoice_schedule`, and via `contract_period_amounts` by
  `regenerate_contract_invoices` and the reprice pass of sync.
  `contract_period_amounts(p_contract_id, p_period_start)` already takes the
  period and ignores it.

## T10 — close-out follow-ups

### Guard `set_invoice_paid`

Re-issue `public.set_invoice_paid(uuid, boolean, text, text)` (body from
migration 159) with one addition immediately after the `for update` select:

```sql
if v_invoice.state in ('cancelled', 'waived') then
  raise exception 'Invoice % cannot be marked paid or unpaid in its current state',
    v_invoice.code using errcode = '22023';
end if;
```

Both branches are covered by the single check. The error text mirrors
`write_off_invoice` (migration 86).

### Action column in the tenant detail

`src/components/admin/InvoiceRowActions.tsx` disables the paid toggle unless
`invoice.state === "paid"` or the state is payable (`due`, `overdue`,
`partially_paid`). The component already computes `payable` for the KNET
button; the toggle reuses it. This mirrors `InvoiceMonthRowActions.tsx`.

### Life Cycle filter

In `src/routes/admin.tenants.index.tsx`, the lifecycle passed to `useTenants`
becomes `filters.lifecycle ?? viewLifecycle`. The select overrides the tab's
pin; the tab still applies when the select is empty. The client-side
`tenantTableFilters` check stays as is (it becomes a no-op when both agree).
`useTenantsSummary` is unchanged.

### Close-out wizard seed

In `src/routes/admin.contracts_.$id.closeout.tsx`, the seed effect sets
`action: "write_off"` for an unpaid invoice whose period month is **after**
the move-out month, and `"leave"` otherwise. The comparison uses
`period_year`/`period_month` against the wizard's move-out date. When the
operator changes the move-out date after the rows were seeded, every row the
operator has **not** touched is re-seeded from the new date; rows the
operator changed by hand keep their value (a `touched` set of invoice ids is
kept in component state and updated by the radio `onChange`). The operator
can still change every row; `close_out_contract` remains an executor of the
approved list.

### Not changed

`tenants.lifecycle` semantics. DANA-000024 shows the "CON-00026 ended" badge
only on that contract, not on the tenant.

## T3 — due day 1 and reminders

### Migration: bulk due day

One idempotent migration:

```sql
update public.contracts
   set due_day = 1
 where due_day <> 1
   and archived_at is null
   and state not in ('terminated', 'expired');

update public.invoices i
   set due_date = make_date(i.period_year, i.period_month, 1)
  from public.contracts c
 where c.id = i.contract_id
   and c.due_day = 1
   and c.archived_at is null
   and c.state not in ('terminated', 'expired')
   and i.state in ('due', 'overdue', 'partially_paid')
   and i.due_date <> make_date(i.period_year, i.period_month, 1);
```

The invoice update repeats the contract predicates so a terminated or
archived contract that already carried day 1 keeps its historical due dates.
`paid`, `waived`, `cancelled` invoices are untouched. The nightly `overdue`
job then flips September rows (strict `due_date + grace_days < today`) and
`overdue-reminders` sends to every tenant with reminders enabled. The user
accepted this one-time burst.

This is a **one-time normalisation**, not a new rule: the form, the save RPC
and bulk import keep accepting any day 1–28, and their defaults were already
1. Due dates only move earlier here, so no invoice needs an `overdue → due`
reversal.

### Reminders honoured on every cron channel

- `src/fns/contractExpiryJob.ts`: the tenant email leg gains
  `if (!tenant.reminders_enabled) skip("email", EMAIL_SKIP.remindersDisabled)`
  before the address check, with a new `EMAIL_SKIP.remindersDisabled` reason.
  The WhatsApp leg already has the equivalent check.
- `src/fns/dispatchNotification.ts`: the proactive-type reminders check moves
  out of the WhatsApp branch and applies to both channels for
  `due_reminder`, `overdue_reminder`, `contract_expiry`, **only when
  `notification.audience === "tenant"`**. Admin alert rows carry the same
  `tenant_id` and type, and must keep sending.
- `identify_contract_expiry_reminders` is **not** changed. The job uses its
  candidate list for the admin alert as well as the tenant legs, so a SQL
  filter on `reminders_enabled` would silence the admin alert for an opted-out
  tenant's contract. The gate lives in the job and the dispatcher.

Receipts, credentials, manual sends and admin alerts are unaffected. The job
test proves it: the same opted-out tenant gets no tenant leg on either
channel while the admin email is still queued.

## T11 — rent increase

### Schema

Three nullable columns on `public.contracts`:

| Column | Type | Rule |
|---|---|---|
| `increase_after_years` | integer | `>= 1` |
| `increase_type` | text | `in ('percent', 'fixed')` |
| `increase_value` | numeric(14,3) | `> 0`; for `percent` also `<= 100` |

Check constraint `contracts_increase_all_or_none`: all three null, or all
three **explicitly `is not null`** plus their value checks. A CHECK whose
expression evaluates to NULL passes in Postgres, so `increase_after_years >= 1`
alone would admit a row with only that column set; every populated-branch
predicate is written against a non-null column. Once per contract is implied
by the shape. `database.types.ts` gets the three fields by hand.

### Effective period

```sql
create function public.contract_increase_effective_period(p_contract public.contracts)
returns date language sql immutable as $$
  select case when p_contract.increase_after_years is null then null
    else date_trunc('month', p_contract.start_date
         + make_interval(years => p_contract.increase_after_years))::date end
$$;
```

A period `p_period_start >= effective` carries the increase.

### Unit pricer

```sql
create function public.contract_unit_period_amounts(p_contract_id uuid, p_period_start date)
returns table (unit_id uuid, unit_code text, line_order int, monthly_amount numeric)
```

- Before the effective period, or with no increase: each unit's
  `contract_units.monthly_amount` unchanged.
- `percent`: `round(cu.monthly_amount * (1 + increase_value / 100), 3)`.
- `fixed`: the increase is split by **largest remainder in fils**. Work in
  integer thousandths: `total_fils = increase_value * 1000`; each unit's
  exact share is `total_fils * cu.monthly_amount / sum`; every unit first
  gets `floor(share)`; the leftover fils (`total_fils - sum(floors)`, always
  `0 ≤ leftover < unit count`) go one each to the units with the largest
  fractional parts, ties broken by `line_order`. Every share is therefore
  non-negative and the lines sum exactly to `sum + increase_value`. (Naive
  "round each, dump the remainder on the last line" can push the last line
  negative: six units at 0.001 with a 0.003 increase.)
- Ordered by `line_order, unit_id`, the same order the line loops use today.

### Wiring the four sites

- `contract_period_amounts(p_contract_id, p_period_start)` computes
  `subtotal = sum(contract_unit_period_amounts) + contract_extra_charges_total`.
- `generate_invoices_for_year` and the fill pass of
  `sync_contract_invoice_schedule` stop pricing inline and call
  `contract_period_amounts(v_contract.id, v_period_start)`.
- All three invoice-line loops iterate `contract_unit_period_amounts` instead
  of `contract_units`, emitting the period's unit amount as `unit_price` and
  `amount`.
- `regenerate_contract_invoices` and the reprice pass of sync are unchanged
  apart from the loop.

Skip rules are unchanged: paid, partially paid, waived, cancelled and
concession-linked invoices are never repriced.

### Save RPC and lock

`save_contract_with_units` accepts `increase_after_years`, `increase_type`,
`increase_value` on create and update. Key-presence semantics match the rest
of the RPC: an **absent** key preserves the stored value, an explicit JSON
null clears it.

On update the RPC first locks the contract row (`select ... for update`),
then builds the **candidate row exactly as the UPDATE would** (same
`coalesce`/key-presence rules, including `start_date`, which moves the
anniversary). **Only an existing increase is locked.** Recording the first
increase on a contract is always accepted, even when invoices on or after
its anniversary are already paid: CON-00026 carried "increases by 15% after
year 2" as free text for two years, and the operator must be able to make
that data. Paid invoices are never repriced regardless. When the stored row
already has an increase and the candidate's effective period **or** any of
the three values differs, the RPC locks and inspects the affected invoices:

```sql
select 1 from public.invoices i
 where i.contract_id = p_contract_id
   and make_date(i.period_year, i.period_month, 1) >= least(old_effective, new_effective)
   and (i.state in ('paid', 'partially_paid') or coalesce(i.paid, 0) > 0)
 for update
```

A hit raises
`'Rent increase is locked: an invoice on or after its effective period has been paid'`
(`errcode 22023`). `coalesce(paid, 0) > 0` is required because
`evaluate_overdue` moves a `partially_paid` invoice to `overdue` while its
money stays; state alone would miss it. The row locks cover the invoices the
check can see: `set_invoice_paid` locks the invoice it settles but not the
contract, so a payment landing on an invoice that was still `due` at the
check's snapshot can commit alongside an increase change. Accepted at this
scale (debate finding #4, review finding #2); the complete fix is a `for
share` on the contract inside the money-writing RPCs, a separate change.
Clearing all three is allowed under the same lock rule. A patch that repeats
the stored values is not a change and never raises.

The edit path already calls `syncContractSchedule` after save, which reprices
unpaid future invoices. The create path calls `backfillInvoices`, which
generates with the new pricer. No new server function.

### Form and display

`src/lib/contractForm.ts`: optional `increase` object
`{ after_years, type, value }` or null; Zod refines `value <= 100` for
percent. `contractFormDefaults.increase = null`.

`ContractFormDialog.tsx`: a collapsible "Rent increase" section with a
switch, then the three fields. When the server reports the lock (a
`locked_increase` flag returned by a small read: any paid invoice on/after the
effective period), the section renders read-only with a note. Labels in
`src/i18n/dictionary.ts` for `ar` and `en` (`contracts.increase.*`).

There is no contract detail page in this app (the routes are the list and
the close-out wizard). The display surface is the contracts table: one muted
line under the monthly amount cell, e.g. "زيادة 10% من 2027-02" /
"Increase 10% from 2027-02".

Save and reprice are two requests today (the dialog saves, then calls the
schedule sync and shows `contracts.regenerateError` if that fails). That
behaviour is unchanged and pre-dates this work; a failed sync is reported as
an error, never as success, and the operator re-saves to retry.

`ContractFormDialog.tsx` is near the file ceiling; the section is its own
component `src/components/admin/contracts/ContractIncreaseSection.tsx`.

## Migrations

| File | Content |
|---|---|
| `194_set_invoice_paid_refuses_waived.sql` | guard |
| `195_due_day_first.sql` | bulk due-day normalisation (contracts + unpaid invoices) |
| `196_contract_rent_increase_schema.sql` | columns, checks, `contract_increase_effective_period`, `contract_unit_period_amounts`, `contract_period_amounts` re-issue |
| `197_generate_invoices_uses_period_pricer.sql` | `generate_invoices_for_year` re-issue |
| `198_regenerate_uses_period_pricer.sql` | `regenerate_contract_invoices` re-issue |
| `199_sync_schedule_uses_period_pricer.sql` | `sync_contract_invoice_schedule` re-issue |
| `200_save_contract_accepts_increase.sql` | `save_contract_with_units` re-issue with lock |

Every re-issue copies the highest-numbered body and changes only what is
named here. Grants are restated after each `create or replace` (migration 96
rule). `notify pgrst, 'reload schema'` after applying.

## Tests

SQL (`src/db/*.sqltest.ts`, run by `bun run test:sql`):

- `setInvoicePaidRefusesWaived.sqltest.ts`: waived and cancelled raise on pay
  and unpay; due still pays.
- `dueDayFirst.sqltest.ts`: migration is idempotent; paid/waived due dates
  untouched; a terminated contract keeps 15; a terminated contract already on
  day 1 keeps its day-15 invoice dates.
- `rentIncreasePricing.sqltest.ts`: percent and fixed before/after the
  anniversary; every partial-null column combination is rejected by the
  check; largest-remainder split on six 0.001 units with a 0.003 increase
  gives non-negative lines that sum to the header; lines equal header on
  generate (including **future** months generated with
  `p_include_past = false`), regenerate and sync; a true create through the
  RPC stores the trio; lock raises after a paid invoice and after a partially
  paid invoice that `evaluate_overdue` moved to `overdue`; a start-date change
  that moves the anniversary is locked the same way; an unchanged patch does
  not raise; clearing the increase on an unlocked contract reprices back.

Vitest (`src/**/*.test.ts(x)`):

- `contractForm.test.ts`: increase trio validation, percent cap.
- `admin.tenants` lifecycle composition helper.
- `InvoiceRowActions.test.tsx`: toggle disabled on waived (assert
  `disabled=""`, not a class).
- `contractExpiryJob.test.ts`: email leg skipped with reminders off.
- `dispatchNotification` proactive email skipped with reminders off.
- Close-out seed helper: period after move-out month seeds `write_off`.

## Out of scope

Lifecycle semantics, a `due_reminder` sender (none exists today), a rent
increase that repeats, per-unit fixed increases, groups A, C, D.
