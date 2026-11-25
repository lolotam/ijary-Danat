# Payments Ordering, Partial-Payment Settlement, and Resend Sender — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin Add Payment dialog enforce oldest-first invoice settlement and read cleanly, make partial payments actually settle the invoices they name (capped at the remaining balance), and give the Resend delivery card a sender address and an email logo.

**Architecture:** Part A inverts `partial_payments` from an inert ledger into a settlement source, copying migration 153's deposit blueprint guard-for-guard and reusing `recompute_invoice_from_confirmed` for the state transition. Part B extracts the portal's contiguous-prefix selection rule as a pure function over already-sorted rows, because the portal's own three implementations all read an RPC that filters on `is_visible_to_tenant`. Part D writes `provider_configs.from_email` (a column that already exists and no UI writes) and threads a logo URL into `wrapLayout` as an argument, never a fetch — it runs client-side too.

**Tech Stack:** TanStack Start (React 19), Postgres 17 (self-hosted Supabase), Vitest (`bun run test`) + a real-Postgres SQL suite (`bun run test:sql`), Tailwind 4 + shadcn/ui, react-hook-form + Zod.

**Spec:** `docs/superpowers/specs/2026-08-24-payments-ordering-partials-resend-sender-design.md`

---

## Ground rules for whoever executes this

1. **Every function gets an Arabic doc comment above it.** Arabic first, English after only for the *why*. This is enforced by review, not by lint. See `AGENTS.md`.
2. **Never edit `database.types.ts` by running `bun run gen:types`.** That writes a *reference* file. The real one is hand-maintained and exports 73 aliases the generator does not emit. Hand-copy new entries.
3. **Never edit `src/routeTree.gen.ts`.**
4. **Do not run `bun run format`.** It rewrites every markdown file in the repo and buries the real diff.
5. **`min` and `step` on a number input travel together.** `min="0.001"` without `step="0.001"` makes the browser reject whole numbers, and Vitest cannot see native validation — it only shows up in a browser.
6. Migration files must be **LF, not CRLF**. `psql` silently skips statements after a `$$` tag under CRLF. Check with `file db/migrations/160_*.sql` — it must not say "CRLF".

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `db/migrations/160_partial_payment_settlement.sql` | Provenance column, guard, apply/revert functions, triggers, backfill, `companies.email_logo_url` | Create |
| `src/db/partialPaymentSettlement.sqltest.ts` | Proves the settlement, the cap, the ordering rule, the revert and the guards | Create |
| `src/db/refunds.sqltest.ts:186-241` | The "inert" block, narrowed to unlinked rows only | Modify |
| `src/lib/invoiceSettlement.ts` | Gains the pure contiguous-prefix selection rule | Modify |
| `src/lib/invoiceSettlement.test.ts` | Tests for it | Create or modify |
| `src/routes/admin.payments.tsx` | Checkbox gating + the one-line month-pill row | Modify |
| `src/components/admin/RecordPanelDialog.tsx` | Dialog width, amount cap, remaining-balance hint | Modify |
| `src/components/admin/PaymentSidePanels.tsx` | Cap validation + SQL error mapping | Modify |
| `src/lib/partialPaymentErrors.ts` | Maps the new Postgres errors to dictionary keys | Create |
| `src/lib/partialPaymentErrors.test.ts` | Tests for it | Create |
| `src/components/admin/ProviderConfigCard.tsx` | Resend sender `<Select>` + logo upload | Modify |
| `src/routes/admin.settings.notifications.tsx:536-577` | Widen `onSave` to carry `from_email` / logo | Modify |
| `src/lib/emailTemplates.ts:26-93` | Emits the inert `<!--EMAIL_LOGO-->` marker in the header | Modify |
| `src/lib/emailLogo.ts` | The marker constant and the pure substitution helper | Create |
| `src/lib/emailLogo.test.ts` | Tests for it | Create |
| `src/lib/emailTemplates.test.ts` | Marker present in the shell, absent from a full document | Modify |
| `src/fns/publicBranding.ts` | Select and cache `email_logo_url` | Modify |
| `src/fns/dispatchNotification.ts:231-245` | Substitute the logo — the chokepoint all sixteen senders reach | Modify |
| `src/fns/resendMailboxSend.ts:148-164` | Same substitution for hand-composed mail | Modify |
| `src/components/admin/TemplateEditorDialog.tsx` | Same substitution so the preview matches the send | Modify |
| `src/i18n/dictionary.ts` | New keys, **both locales or the parity test fails** | Modify |
| `src/integrations/supabase/database.types.ts` | `payments.source_partial_payment_id`, `companies.email_logo_url`, the two new RPCs | Modify |

---

# PART A — Partial payments settle invoices

This is the reported bug and the riskiest part. Do it first and completely.

---

## Task 1: Migration 160 — provenance column and guard

**Files:**
- Create: `db/migrations/160_partial_payment_settlement.sql`

- [ ] **Step 1: Read the blueprint before writing anything**

Read `db/migrations/153_deposit_settlement.sql` end to end. This migration is
its sibling and every deviation is deliberate and listed in §2.2 of the spec.
Read `db/migrations/147_partial_payment_status.sql` too — it is the invariant
being overturned, and the header of 160 must say so.

- [ ] **Step 2: Write the header and the provenance column**

```sql
-- 160_partial_payment_settlement.sql
--
-- Makes a partial payment that names an invoice actually settle it: it inserts
-- a real `payments` row and its allocation, and deleting the partial removes
-- them. Cumulative partials reaching the invoice total therefore mark it paid,
-- which is what the Partial Payments panel has always implied and never did.
--
-- THIS OVERTURNS MIGRATION 147
-- 147 said plainly that "a status column describes a row; it must never move
-- money", and `refunds.sqltest.ts` was written to hold it to that. Migration 153
-- had already performed the identical inversion for `deposits`, and its header
-- names 147 as the thing it inverts. This is that same move, applied to the
-- table 147 was actually about. Every guard 153 installs is reproduced here
-- because every reason for them transfers unchanged.
--
-- WHAT STAYS TRUE FROM 147
-- `partial_payments.status` is still derived FROM the invoice by
-- `tg_partial_payments_sync_status`, and a partial with a null `invoice_id` is
-- still completely inert. Only the linked case moves money.
--
-- WHY A TRIGGER AND NOT AN RPC
-- `partial_payments` is written directly over PostgREST by
-- `useCreateMoneyRecord` and could be written by anything added later. An RPC
-- would have to be adopted by each writer — the "five scattered checks is where
-- one gets missed" shape CLAUDE.md warns about.
--
-- THE RECOMPUTE REUSES `recompute_invoice_from_confirmed`
-- It must not copy migration 129's `sum(payment_allocations.amount)`:
-- `reverse_payment` (05:663) writes a POSITIVE mirror allocation on the reversal
-- payment, so a raw sum counts reversed money as paid. The shared function joins
-- to `payments` and filters `status = 'confirmed'`, so an original and its
-- mirror net out.
--
-- ALSO IN THIS FILE
-- `companies.email_logo_url`, for the Resend delivery card. It ships here rather
-- than in a 161 because it is one deploy and migrations are applied by hand.

------------------------------------------------------------
-- 1. Provenance is a column, not a string
------------------------------------------------------------

-- A text reference is mutable, so editing it orphans the settlement; and
-- `set_invoice_paid`'s unpay branch deletes EVERY payment carrying its
-- reference, which for a shared tag would let one row's cancellation destroy
-- another's money. A real FK with a partial unique index means a partial payment
-- owns exactly one payment and a revert can only ever find its own.
alter table public.payments
  add column if not exists source_partial_payment_id uuid;

do $$
begin
  alter table public.payments
    add constraint payments_source_partial_payment_id_fkey
    foreign key (source_partial_payment_id)
    references public.partial_payments(id) on delete restrict;
exception when duplicate_object then null;
end $$;

create unique index if not exists payments_source_partial_payment_uidx
  on public.payments (source_partial_payment_id)
  where source_partial_payment_id is not null;

comment on column public.payments.source_partial_payment_id is
  'The partial payment this payment was created to settle. Owned by the settlement trigger; a client connection cannot set, clear or repoint it.';
```

`on delete restrict` matches `payments_source_deposit_id_fkey`. The BEFORE
DELETE trigger in Task 2 removes the payment first, so it never fires in normal
operation — it is there so an out-of-band delete fails loudly instead of
orphaning money.

- [ ] **Step 3: Extend the provenance guard**

`tg_payments_guard_deposit_provenance` already exists (153). Replace it with a
version covering both columns. Read the live body first:

```bash
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres \
  -c "select pg_get_functiondef('tg_payments_guard_deposit_provenance'::regproc)"
```

Append to the migration:

```sql
------------------------------------------------------------
-- 2. Provenance cannot be forged from a client connection
------------------------------------------------------------

-- Staff hold direct INSERT and UPDATE grants on `payments` (05:145, 05:198), so
-- without this they could point `source_partial_payment_id` at someone else's
-- ledger row, clear it and orphan a settlement, or flip a partial-owned payment
-- to `reversed` behind the ledger's back.
--
-- The test is `current_user`, not a GUC. A transaction-local flag is forgeable —
-- any role able to run SQL can `select set_config(…, true)`, which is exactly
-- what src/db/testDb.ts does — and `SET LOCAL` survives to transaction end,
-- leaving the bypass armed for every later payment write in the same
-- transaction. Inside a SECURITY DEFINER function `current_user` is the
-- function's owner instead.
--
-- INVOKER rights on purpose. A definer-rights guard would only ever observe its
-- own owner and would wave everything through.
create or replace function public.tg_payments_guard_deposit_provenance()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_client_role boolean := current_user in ('authenticated', 'anon', 'service_role');
begin
  if not v_client_role then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.source_deposit_id is not null or new.source_partial_payment_id is not null then
      raise exception 'payment_provenance_is_not_settable' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.source_deposit_id is distinct from old.source_deposit_id
     or new.source_partial_payment_id is distinct from old.source_partial_payment_id then
    raise exception 'payment_provenance_is_not_settable' using errcode = '42501';
  end if;

  if (old.source_deposit_id is not null or old.source_partial_payment_id is not null)
     and new.status is distinct from old.status then
    raise exception 'payment_provenance_status_is_owned' using errcode = '42501';
  end if;

  return new;
end;
$fn$;
```

> **Preserve, do not invent.** The body above is the shape 153 installs. If the
> live definition differs in any way — a different exception name, an extra
> branch, a different `tg_op` handling — keep the live behaviour for
> `source_deposit_id` exactly and only add the `source_partial_payment_id`
> clauses beside it. Re-read the live body and diff it against what you write.
> Also re-create the trigger if 153's `create trigger` names specific columns in
> an `UPDATE OF` list — it must now include `source_partial_payment_id`.

- [ ] **Step 4: Verify the file is LF and syntactically valid so far**

```bash
file db/migrations/160_partial_payment_settlement.sql
```
Expected: `ASCII text` or `UTF-8 Unicode text` — **not** "with CRLF line terminators".

- [ ] **Step 5: Commit**

```bash
git add db/migrations/160_partial_payment_settlement.sql
git commit -m "feat(db): payments.source_partial_payment_id and its provenance guard"
```

---

## Task 2: Migration 160 — the settlement and revert functions

**Files:**
- Modify: `db/migrations/160_partial_payment_settlement.sql`

- [ ] **Step 1: Write `apply_partial_payment_settlement`**

Append:

```sql
------------------------------------------------------------
-- 3. Settlement
------------------------------------------------------------

-- يسدّد الدفعة الجزئية على الفاتورة التي تشير إليها، بإنشاء دفعة حقيقية
-- وتخصيصها، ثم إعادة احتساب حالة الفاتورة.
--
-- Mirrors `apply_deposit_settlement` (153) step for step. Three deliberate
-- differences, all in the spec's §2.2:
--   * an amount above the balance RAISES rather than capping with `least(…)`,
--     because the panel must make over-entry impossible and a silent cap would
--     leave the ledger row and its allocation disagreeing about the number;
--   * it settles on INSERT, because `partial_payments` has no confirm step;
--   * editing a settled row is refused rather than re-synced.
create or replace function public.apply_partial_payment_settlement(p_partial_payment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_partial public.partial_payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_tenant public.tenants%rowtype;
  v_contract uuid;
  v_payment_id uuid;
begin
  if current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'partial_payment_settlement_internal_only' using errcode = '42501';
  end if;

  select pp.* into v_partial
    from public.partial_payments pp where pp.id = p_partial_payment_id;
  if not found or v_partial.invoice_id is null then
    return null;
  end if;

  -- Serialise on the contract before touching any invoice row, so two partials
  -- against the same contract cannot interleave between the chronological check
  -- and the write. Same lock key as `apply_deposit_settlement`, so a deposit and
  -- a partial on one contract serialise against each other too.
  --
  -- The key comes from the INVOICE, not from `partial_payments.contract_id`.
  -- Deposits may use its own column because `deposits_contract_invoice_paired`
  -- forces (contract_id is null) = (invoice_id is null); this table has no such
  -- constraint, and `tg_partial_payments_link_guard` (151:44) checks contract_id
  -- only when it is non-null. A row naming an invoice with a null contract_id is
  -- reachable, and keying off it would give two writers on one contract
  -- different keys — losing exactly the race the balance check below depends on
  -- winning. `invoices.contract_id` is NOT NULL.
  select i.contract_id into v_contract
    from public.invoices i where i.id = v_partial.invoice_id;
  if v_contract is null then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_contract::text, 0));

  select i.* into v_invoice
    from public.invoices i where i.id = v_partial.invoice_id for update;
  if not found then return null; end if;

  if v_invoice.state in ('cancelled', 'waived') then
    raise exception 'partial_payment_invoice_terminal_state' using errcode = '23514';
  end if;

  -- The real cap. The `max` attribute on the input is UX; two partials passing
  -- client validation concurrently is exactly what this and the lock exist for.
  if v_partial.amount > v_invoice.balance then
    raise exception 'partial_payment_exceeds_balance' using errcode = '23514';
  end if;

  -- The same admission check `set_invoice_paid` applies (159:118-129). Compared
  -- as (year, month) so January always precedes February whatever the due dates
  -- do.
  if exists (
    select 1
      from public.invoices earlier
     where earlier.contract_id = v_invoice.contract_id
       and earlier.id <> v_invoice.id
       and earlier.balance > 0
       and earlier.state in ('due', 'overdue', 'partially_paid')
       and (earlier.period_year, earlier.period_month)
           < (v_invoice.period_year, v_invoice.period_month)
  ) then
    raise exception 'partial_payment_invoice_out_of_order' using errcode = '23514';
  end if;

  select t.* into v_tenant from public.tenants t where t.id = v_invoice.tenant_id;

  insert into public.payments (
    code, company_id, tenant_id, unit_id, account_type, method, amount, currency,
    payment_date, note, status, source_partial_payment_id
  ) values (
    public.next_payment_code(), v_tenant.company_id, v_invoice.tenant_id, v_invoice.unit_id,
    'commercial_account', 'cash', v_partial.amount, 'KWD',
    v_partial.paid_date,
    'Settled from partial payment on invoice ' || v_invoice.code, 'confirmed',
    v_partial.id
  )
  on conflict (source_partial_payment_id) where source_partial_payment_id is not null
  do nothing
  returning payments.id into v_payment_id;

  -- Nothing came back: a concurrent transaction already settled this row and did
  -- all of the work below. Doing any of it again would double-allocate.
  if v_payment_id is null then
    return v_invoice.id;
  end if;

  insert into public.payment_allocations (payment_id, invoice_id, amount)
  values (v_payment_id, v_invoice.id, v_partial.amount);

  -- The receipt trigger fires on the payment INSERT, before the allocation
  -- exists (05:463), so the snapshot it took shows an unallocated payment.
  update public.receipts r
     set html_snapshot = public.receipt_html_for_payment(v_payment_id)
   where r.payment_id = v_payment_id;

  perform public.recompute_invoice_from_confirmed(v_invoice.id);
  return v_invoice.id;
end;
$fn$;
```

> `reference` is left null deliberately: `partial_payments` has no code column,
> and `set_invoice_paid`'s unpay branch deletes payments *by reference*, so a
> made-up tag would put this money in reach of an unrelated cancellation.

- [ ] **Step 2: Write `revert_partial_payment_settlement`**

```sql
-- يلغي تسديد الدفعة الجزئية: يحذف الإيصال والتخصيص والدفعة، دون إعادة احتساب
-- الفاتورة — تلك تتم في مُشغّل AFTER DELETE.
--
-- Finds the payment by `source_partial_payment_id` alone — never by reference or
-- tenant. That is the whole point of the column: a revert can only ever find the
-- payment its own ledger row created.
--
-- WHY THE RECOMPUTE IS NOT HERE, UNLIKE `revert_deposit_settlement`
-- This runs from BEFORE DELETE, where the ledger row still exists. Recomputing
-- takes the invoice from `paid` back to `partially_paid`, which fires
-- `partial_payments_sync_status` (147:95, AFTER UPDATE OF state ON invoices),
-- whose `update partial_payments … where invoice_id = … and status <>
-- 'incomplete'` matches the very row being deleted — and Postgres raises "tuple
-- to be deleted was already modified by an operation triggered by the current
-- command". Deposits is immune only because sync_status writes
-- `partial_payments`, never `deposits`. Moving the recompute to AFTER DELETE
-- means sync_status finds no surviving row.
create or replace function public.revert_partial_payment_settlement(p_partial_payment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_payment_id uuid;
  v_invoice_id uuid;
begin
  if current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'partial_payment_settlement_internal_only' using errcode = '42501';
  end if;

  select p.id into v_payment_id
    from public.payments p where p.source_partial_payment_id = p_partial_payment_id;
  if v_payment_id is null then return null; end if;

  select pa.invoice_id into v_invoice_id
    from public.payment_allocations pa where pa.payment_id = v_payment_id limit 1;

  -- A confirmed payment gets a receipt from a trigger; drop it first or the
  -- receipts FK blocks the delete.
  delete from public.receipts r where r.payment_id = v_payment_id;
  delete from public.payment_allocations pa where pa.payment_id = v_payment_id;
  delete from public.payments p where p.id = v_payment_id;

  return v_invoice_id;
end;
$fn$;
```

- [ ] **Step 3: Wire the triggers**

```sql
------------------------------------------------------------
-- 4. Triggers on partial_payments
------------------------------------------------------------

create or replace function public.tg_partial_payments_settle()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.apply_partial_payment_settlement(new.id);
  return null;  -- AFTER trigger: the return value is discarded.
end;
$fn$;

drop trigger if exists partial_payments_settle on public.partial_payments;
create trigger partial_payments_settle
  after insert on public.partial_payments
  for each row when (new.invoice_id is not null)
  execute function public.tg_partial_payments_settle();

-- BEFORE DELETE removes the money rows, which is all `on delete restrict` needs
-- satisfied. It must NOT recompute — see the function's own comment.
create or replace function public.tg_partial_payments_revert_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.revert_partial_payment_settlement(old.id);
  return old;
end;
$fn$;

drop trigger if exists partial_payments_revert_on_delete on public.partial_payments;
create trigger partial_payments_revert_on_delete
  before delete on public.partial_payments
  for each row execute function public.tg_partial_payments_revert_on_delete();

-- AFTER DELETE, with the ledger row gone, so the invoice's own sync_status
-- trigger has nothing left to update and cannot collide with the delete.
create or replace function public.tg_partial_payments_recompute_after_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.recompute_invoice_from_confirmed(old.invoice_id);
  return null;
end;
$fn$;

drop trigger if exists partial_payments_recompute_after_delete on public.partial_payments;
create trigger partial_payments_recompute_after_delete
  after delete on public.partial_payments
  for each row when (old.invoice_id is not null)
  execute function public.tg_partial_payments_recompute_after_delete();

-- A settled row is immutable in the two columns that describe the money. Edit is
-- refused rather than re-synced (spec §2.2, D3): fewer states, and no window in
-- which the allocation and the ledger row disagree.
create or replace function public.tg_partial_payments_settled_immutable()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if (new.amount is distinct from old.amount
      or new.invoice_id is distinct from old.invoice_id)
     and exists (select 1 from public.payments p
                  where p.source_partial_payment_id = old.id) then
    raise exception 'partial_payment_settled_immutable' using errcode = '23514';
  end if;
  return new;
end;
$fn$;

drop trigger if exists partial_payments_settled_immutable on public.partial_payments;
create trigger partial_payments_settled_immutable
  before update of amount, invoice_id on public.partial_payments
  for each row execute function public.tg_partial_payments_settled_immutable();
```

- [ ] **Step 4: Document why reporting still excludes the table**

```sql
comment on table public.partial_payments is
  'Part-payment ledger. A row naming an invoice settles it through a real payment and allocation (migration 160); a row with a null invoice_id is inert. Deliberately absent from get_budget_summary and from get_payments_overview''s net: the money is already counted once, through the payment the settlement creates. Adding it back would double-count.';
```

Without this, the next reader sees an exclusion that migration 147 justified on
grounds that no longer hold, "fixes" it, and doubles every partial payment in
the budget.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/160_partial_payment_settlement.sql
git commit -m "feat(db): partial payments settle the invoice they name"
```

---

## Task 3: Narrow the "inert" assertion instead of deleting it

**Files:**
- Modify: `src/db/refunds.sqltest.ts:186-241`

The first test in that block links its partial to `invoicesBefore.rows[0]` — the
oldest invoice — so after Task 2 it will fail. **That failure is correct and is
the signal the invariant changed.** Narrow the block; do not delete it.

- [ ] **Step 1: Run the suite and watch it fail**

```bash
bun run test:sql -- refunds
```
Expected: `partial payments are inert › creating one changes no invoice balance…` FAILS.
The second test (`it creates no payment allocation`, no `invoice_id`) still passes.

- [ ] **Step 2: Rewrite the describe block**

Replace lines 186–241 with:

```ts
describe("an unlinked partial payment is still inert", () => {
  // Migration 147 made this true of every partial payment. Migration 160
  // deliberately narrowed it: a row that names an invoice now settles it. What
  // survives — and what this still guards — is that a row naming nothing moves
  // nothing, and that neither kind is ever summed into the budget, because the
  // settlement's own `payments` row is already counted there.
  test("creating one changes no invoice balance and no budget figure", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`select * from public.backfill_contract_invoices($1)`, [contractId]);
      await seedPayment(client, tenantId, 1000);

      const invoicesBefore = await client.query(
        `select id, paid, balance, state from public.invoices
          where contract_id = $1 order by period_month`,
        [contractId],
      );
      const budgetBefore = await budget(client);

      await client.query(
        `insert into public.partial_payments (tenant_id, contract_id, amount, paid_date)
         values ($1, $2, 123.456, '2026-03-01')`,
        [tenantId, contractId],
      );

      const invoicesAfter = await client.query(
        `select id, paid, balance, state from public.invoices
          where contract_id = $1 order by period_month`,
        [contractId],
      );
      expect(invoicesAfter.rows).toEqual(invoicesBefore.rows);
      expect(await budget(client)).toEqual(budgetBefore);
    });
  });

  test("it creates no payment allocation", async () => {
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(
        `insert into public.partial_payments (tenant_id, contract_id, amount)
         values ($1, $2, 99)`,
        [tenantId, contractId],
      );
      const { rows } = await client.query(
        `select 1 from public.payment_allocations pa
          join public.invoices i on i.id = pa.invoice_id where i.contract_id = $1`,
        [contractId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  test("a linked partial stays out of the budget even though it moved money", async () => {
    // The exclusion in get_budget_summary is now required for correctness rather
    // than by design: the settlement's payment is what the budget counts.
    await withRollback(async (client) => {
      const { tenantId, contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(`select public.generate_invoices($1::uuid, 2026)`, [contractId]);
      const target = await client.query<{ id: string }>(
        `select id from public.invoices where contract_id = $1
          order by period_year, period_month limit 1`,
        [contractId],
      );

      await client.query(
        `insert into public.partial_payments (tenant_id, contract_id, invoice_id, amount, paid_date)
         values ($1, $2, $3, 100, '2026-03-01')`,
        [tenantId, contractId, target.rows[0].id],
      );

      const summary = await budget(client);
      expect(summary).not.toHaveProperty("partial_payments");
      expect(Number((summary as Record<string, unknown>).collections)).toBe(100);
    });
  });
});
```

Also update the file header at lines 11–16: `"a partial payment must move
nothing"` is no longer true and must not be left standing.

```ts
/**
 * T13 — refunds, partial payments and insurance.
 *
 * Two of these assertions are the point of the whole batch:
 *   * archiving after a refund must never destroy financial history;
 *   * a partial payment that names no invoice must still move nothing, and
 *     neither kind may ever be summed into the budget twice.
 */
```

- [ ] **Step 3: Run**

```bash
bun run test:sql -- refunds
```
Expected: PASS.

> If `collections` is not the key `get_budget_summary` uses for confirmed
> payments, read the function and use the real key. Do not weaken the assertion
> to `toBeDefined()` — an assertion that cannot fail is worse than no test.

- [ ] **Step 4: Commit**

```bash
git add src/db/refunds.sqltest.ts
git commit -m "test(db): narrow the partial-payment inertness guard to unlinked rows"
```

---

## Task 4: The settlement test suite

**Files:**
- Create: `src/db/partialPaymentSettlement.sqltest.ts`

Model it on `src/db/depositInvoiceLink.sqltest.ts` — read that file first; its
`scenario` / `invoiceState` / `seedAdmin` helpers are the idiom.

- [ ] **Step 1: Write the fixtures**

```ts
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import {
  actAs,
  captureRaise,
  closePool,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 160 — a partial payment that names an invoice settles it.
 *
 * These run against the trigger, never through the panel, because the panel is
 * not the only writer: `useCreateMoneyRecord` inserts over PostgREST and
 * anything added later would too. A test through a mocked client would prove
 * nothing about either.
 */

type Scenario = Awaited<ReturnType<typeof scenario>>;

/**
 * عقد بفواتير مولّدة، جاهز لاستقبال دفعات جزئية.
 */
async function scenario(client: PoolClient, monthlyAmount = 500) {
  const fx = await seedContract(client, {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    monthlyAmount,
  });
  await client.query(`select public.generate_invoices($1::uuid, 2026)`, [fx.contractId]);
  const invoices = await client.query<{
    id: string;
    total: string;
    period_month: number;
  }>(
    `select id, total, period_month from public.invoices
      where contract_id = $1 order by period_year, period_month`,
    [fx.contractId],
  );
  return { ...fx, invoices: invoices.rows };
}

/**
 * ينشئ دفعة جزئية مرتبطة بفاتورة، ويعيد معرّفها.
 */
async function insertPartial(
  client: PoolClient,
  fx: Scenario,
  options: { amount: number; invoiceId?: string | null },
): Promise<string> {
  const linked = options.invoiceId !== undefined ? options.invoiceId : fx.invoices[0].id;
  const row = await client.query<{ id: string }>(
    `insert into public.partial_payments
       (company_id, tenant_id, contract_id, invoice_id, amount, paid_date)
     values ($1, $2, $3, $4, $5, '2026-01-10') returning id`,
    [fx.companyId, fx.tenantId, linked ? fx.contractId : null, linked, options.amount],
  );
  return row.rows[0].id;
}

/**
 * حالة الفاتورة ومبلغها المسدَّد ورصيدها.
 */
async function invoiceState(client: PoolClient, invoiceId: string) {
  const row = await client.query<{ state: string; paid: string; balance: string }>(
    `select state, paid, balance from public.invoices where id = $1`,
    [invoiceId],
  );
  return row.rows[0];
}

/**
 * الدفعات المملوكة لهذه الدفعة الجزئية، مُحدَّدة بـ `source_partial_payment_id` وحده.
 */
async function ownedPayments(client: PoolClient, partialId: string) {
  const row = await client.query<{ id: string; amount: string; status: string }>(
    `select id, amount, status from public.payments where source_partial_payment_id = $1`,
    [partialId],
  );
  return row.rows;
}
```

- [ ] **Step 2: Write the settlement tests**

```ts
describe("a linked partial payment settles its invoice", () => {
  test("below the balance leaves it partially paid", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const partialId = await insertPartial(client, fx, { amount: 200 });

      const payments = await ownedPayments(client, partialId);
      expect(payments).toHaveLength(1);
      expect(Number(payments[0].amount)).toBe(200);
      expect(payments[0].status).toBe("confirmed");

      const after = await invoiceState(client, invoice.id);
      expect(after.state).toBe("partially_paid");
      expect(Number(after.paid)).toBe(200);
      expect(Number(after.balance)).toBe(Number(invoice.total) - 200);
    });
  });

  // THE REPORTED BUG. Two partials adding up to the total must mark it paid.
  test("two partials reaching the total mark it paid and complete both rows", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const total = Number(invoice.total);

      const first = await insertPartial(client, fx, { amount: total - 150 });
      expect((await invoiceState(client, invoice.id)).state).toBe("partially_paid");

      const second = await insertPartial(client, fx, { amount: 150 });

      const after = await invoiceState(client, invoice.id);
      expect(after.state).toBe("paid");
      expect(Number(after.balance)).toBe(0);

      // 147's invoice-to-partial trigger still runs, and now has something to do.
      const statuses = await client.query<{ id: string; status: string }>(
        `select id, status from public.partial_payments where id = any($1::uuid[]) order by id`,
        [[first, second]],
      );
      expect(statuses.rows.map((r) => r.status)).toEqual(["complete", "complete"]);
    });
  });

  test("an unlinked partial settles nothing", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200, invoiceId: null });

      expect(await ownedPayments(client, partialId)).toHaveLength(0);
      expect(Number((await invoiceState(client, fx.invoices[0].id)).paid)).toBe(0);
    });
  });
});
```

- [ ] **Step 3: Write the refusal tests**

```ts
describe("the money it moves is guarded", () => {
  test("an amount above the balance is refused and nothing is written", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];

      const error = await captureRaise(client, () =>
        insertPartial(client, fx, { amount: Number(invoice.total) + 1 }),
      );
      expect(error).toMatch(/partial_payment_exceeds_balance/);

      expect(Number((await invoiceState(client, invoice.id)).paid)).toBe(0);
      const rows = await client.query(`select 1 from public.partial_payments`);
      expect(rows.rows).toHaveLength(0);
    });
  });

  test("the cap is the REMAINING balance, not the total", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const total = Number(invoice.total);
      await insertPartial(client, fx, { amount: total - 100 });

      const error = await captureRaise(client, () =>
        insertPartial(client, fx, { amount: 101 }),
      );
      expect(error).toMatch(/partial_payment_exceeds_balance/);
    });
  });

  test("exactly the remaining balance is accepted", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const total = Number(invoice.total);
      await insertPartial(client, fx, { amount: total - 100 });
      await insertPartial(client, fx, { amount: 100 });

      expect((await invoiceState(client, invoice.id)).state).toBe("paid");
    });
  });

  test("a later invoice is refused while an earlier one is open", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const error = await captureRaise(client, () =>
        insertPartial(client, fx, { amount: 100, invoiceId: fx.invoices[1].id }),
      );
      expect(error).toMatch(/partial_payment_invoice_out_of_order/);
    });
  });

  test("a later invoice is accepted once the earlier one is settled", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      await insertPartial(client, fx, { amount: Number(fx.invoices[0].total) });
      await insertPartial(client, fx, { amount: 100, invoiceId: fx.invoices[1].id });

      expect((await invoiceState(client, fx.invoices[1].id)).state).toBe("partially_paid");
    });
  });

  test("a cancelled invoice is refused", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      await client.query(`update public.invoices set state = 'cancelled' where id = $1`, [
        fx.invoices[0].id,
      ]);
      const error = await captureRaise(client, () => insertPartial(client, fx, { amount: 10 }));
      expect(error).toMatch(/partial_payment_invoice_terminal_state/);
    });
  });
});

describe("a settled partial payment can be deleted but not edited", () => {
  test("deleting reverts the payment, the allocation and the receipt", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const partialId = await insertPartial(client, fx, { amount: 200 });
      const paymentId = (await ownedPayments(client, partialId))[0].id;

      await client.query(`delete from public.partial_payments where id = $1`, [partialId]);

      expect(await ownedPayments(client, partialId)).toHaveLength(0);
      const allocations = await client.query(
        `select 1 from public.payment_allocations where payment_id = $1`,
        [paymentId],
      );
      expect(allocations.rows).toHaveLength(0);
      const receipts = await client.query(`select 1 from public.receipts where payment_id = $1`, [
        paymentId,
      ]);
      expect(receipts.rows).toHaveLength(0);

      const after = await invoiceState(client, invoice.id);
      expect(Number(after.paid)).toBe(0);
      expect(after.state).not.toBe("paid");
    });
  });

  // REGRESSION. Both other delete tests leave the invoice `partially_paid`, so
  // its status is already 'incomplete' and sync_status's `and status <>
  // 'incomplete'` makes it a no-op — neither can reach the collision. Only a
  // FULLY paid invoice puts a 'complete' row in sync_status's path, and that row
  // is the one being deleted. Without the BEFORE/AFTER split this raises
  // "tuple to be deleted was already modified…".
  test("deleting a partial from a fully paid invoice succeeds and reopens it", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const total = Number(invoice.total);
      const first = await insertPartial(client, fx, { amount: total - 150 });
      await insertPartial(client, fx, { amount: 150 });
      expect((await invoiceState(client, invoice.id)).state).toBe("paid");

      await client.query(`delete from public.partial_payments where id = $1`, [first]);

      const after = await invoiceState(client, invoice.id);
      expect(after.state).toBe("partially_paid");
      expect(Number(after.paid)).toBe(150);

      const survivor = await client.query<{ status: string }>(
        `select status from public.partial_payments where invoice_id = $1`,
        [invoice.id],
      );
      expect(survivor.rows.map((r) => r.status)).toEqual(["incomplete"]);
    });
  });

  test("deleting one leaves another partial's money alone", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const first = await insertPartial(client, fx, { amount: 100 });
      await insertPartial(client, fx, { amount: 150 });

      await client.query(`delete from public.partial_payments where id = $1`, [first]);

      expect(Number((await invoiceState(client, invoice.id)).paid)).toBe(150);
    });
  });

  test("changing a settled row's amount is refused", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200 });

      const error = await captureRaise(client, () =>
        client.query(`update public.partial_payments set amount = 300 where id = $1`, [partialId]),
      );
      expect(error).toMatch(/partial_payment_settled_immutable/);
      expect(Number((await ownedPayments(client, partialId))[0].amount)).toBe(200);
    });
  });

  test("changing an unsettled row's amount is allowed", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 200, invoiceId: null });
      await client.query(`update public.partial_payments set amount = 300 where id = $1`, [
        partialId,
      ]);
      const row = await client.query<{ amount: string }>(
        `select amount from public.partial_payments where id = $1`,
        [partialId],
      );
      expect(Number(row.rows[0].amount)).toBe(300);
    });
  });
});
```

- [ ] **Step 4: Write the provenance and reversal tests**

```ts
describe("provenance and reversal", () => {
  test("a client role cannot set source_partial_payment_id", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 100 });
      const adminId = await seedAdmin(client);

      const error = await captureRaise(client, () =>
        actAs(client, adminId, () =>
          client.query(
            `insert into public.payments
               (tenant_id, amount, method, status, payment_date, source_partial_payment_id)
             values ($1, 5, 'cash', 'confirmed', '2026-01-11', $2)`,
            [fx.tenantId, partialId],
          ),
        ),
      );
      expect(error).toMatch(/payment_provenance_is_not_settable/);
    });
  });

  test("a client role cannot call the settlement function directly", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const partialId = await insertPartial(client, fx, { amount: 100, invoiceId: null });
      const adminId = await seedAdmin(client);

      const error = await captureRaise(client, () =>
        actAs(client, adminId, () =>
          client.query(`select public.apply_partial_payment_settlement($1)`, [partialId]),
        ),
      );
      expect(error).toMatch(/partial_payment_settlement_internal_only/);
    });
  });

  // reverse_payment writes a POSITIVE mirror allocation (05:663). A recompute
  // that summed payment_allocations raw would leave the invoice paid.
  test("reversing the settlement's payment reopens the invoice", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];
      const partialId = await insertPartial(client, fx, { amount: Number(invoice.total) });
      expect((await invoiceState(client, invoice.id)).state).toBe("paid");

      const paymentId = (await ownedPayments(client, partialId))[0].id;
      await client.query(`select public.reverse_payment($1)`, [paymentId]);

      const after = await invoiceState(client, invoice.id);
      expect(after.state).not.toBe("paid");
      expect(Number(after.paid)).toBe(0);
    });
  });
});
```

Copy `seedAdmin` verbatim from `depositInvoiceLink.sqltest.ts:78-97`.

> **Check `reverse_payment`'s real signature and `captureRaise`'s real shape
> before writing these two.** If `reverse_payment` takes more arguments, or
> `captureRaise` returns an object rather than a string, adapt — do not leave a
> test that passes because it silently caught the wrong error.

- [ ] **Step 5: Run**

```bash
bun run test:sql -- partialPaymentSettlement
```
Expected: all PASS. If `bun run test:db` has not been run in this session, run it
first — the suite needs a clean Postgres built from every migration in order,
which is also the only proof that 160 applies to a database built from scratch.

- [ ] **Step 6: Commit**

```bash
git add src/db/partialPaymentSettlement.sqltest.ts
git commit -m "test(db): partial-payment settlement, cap, ordering, revert and provenance"
```

---

## Task 5: Backfill, and the email logo column

**Files:**
- Modify: `db/migrations/160_partial_payment_settlement.sql`

- [ ] **Step 1: Append the backfill**

It must come **after** the functions and triggers exist.

```sql
------------------------------------------------------------
-- 5. Backfill rows written before this migration
------------------------------------------------------------

-- Production holds partial payments that name an invoice and settled nothing —
-- money an accountant recorded and the system ignored. Ordered oldest-invoice
-- first so the chronological check cannot reject a row that a later iteration
-- would have unblocked.
--
-- A row that still fails aborts the migration. A skipped backfill is
-- indistinguishable from a successful one, and the difference is money.
--
-- Only three of the 160 migrations open an explicit transaction, so `psql -f`
-- autocommits per statement: this DO block is ONE statement, and a mid-loop
-- raise rolls back every settlement the loop made while leaving the DDL above it
-- committed. Recoverable — fix the row and re-run the block — but say so, or
-- whoever hits it assumes the whole migration must be undone.

-- Pre-flight. A bare `partial_payment_exceeds_balance` raised from inside the
-- loop names no row; this names every row that would fail, before any of them
-- does.
do $$
declare v_bad text;
begin
  select string_agg(pp.id::text || ' (' || i.code || ')', ', ')
    into v_bad
    from public.partial_payments pp
    join public.invoices i on i.id = pp.invoice_id
    left join public.payments p on p.source_partial_payment_id = pp.id
   where pp.invoice_id is not null and p.id is null
     and (pp.amount > i.balance
          or i.state in ('cancelled', 'waived')
          or exists (
            select 1 from public.invoices earlier
             where earlier.contract_id = i.contract_id
               and earlier.id <> i.id
               and earlier.balance > 0
               and earlier.state in ('due', 'overdue', 'partially_paid')
               and (earlier.period_year, earlier.period_month)
                   < (i.period_year, i.period_month)));
  if v_bad is not null then
    raise exception 'backfill_would_fail_for: %', v_bad;
  end if;
end $$;
```

All three raise conditions, so the pre-flight and the loop agree on what fails.

It is still **best-effort, and must not be described as a guarantee**: it reads
`i.balance` as it stands before the loop runs. Two rows against one invoice that
each fit individually but exceed it together both pass here and the second fails
inside the loop. That is the loop's job to catch; the pre-flight exists to turn
the common case into a legible message, not to make failure impossible.

```sql

do $$
declare r record;
begin
  for r in
    select pp.id
      from public.partial_payments pp
      join public.invoices i on i.id = pp.invoice_id
      left join public.payments p on p.source_partial_payment_id = pp.id
     where pp.invoice_id is not null and p.id is null
     order by i.period_year, i.period_month, pp.created_at
  loop
    perform public.apply_partial_payment_settlement(r.id);
  end loop;
end $$;
```

- [ ] **Step 2: Append the email logo column**

```sql
------------------------------------------------------------
-- 6. Email logo (Resend delivery card)
------------------------------------------------------------

-- Nullable IS the fallback: null means "use companies.logo_url". The `branding`
-- bucket is public (21:34, re-asserted by 74:139-145), so the URL stored here is
-- fetchable by a mail client, which a signed URL would not be.
alter table public.companies
  add column if not exists email_logo_url text;

comment on column public.companies.email_logo_url is
  'Absolute public URL of the logo embedded in outgoing email. Null falls back to logo_url. Must be publicly fetchable — mail clients load it remotely.';
```

- [ ] **Step 3: Add a backfill test**

Append to `src/db/partialPaymentSettlement.sqltest.ts`:

```ts
describe("the backfill", () => {
  test("settles a pre-existing linked partial that owns no payment", async () => {
    await withRollback(async (client) => {
      const fx = await scenario(client);
      const invoice = fx.invoices[0];

      // Reproduce a pre-migration row: linked, but with the settlement trigger
      // disabled, which is exactly the state production was left in.
      await client.query(`alter table public.partial_payments disable trigger partial_payments_settle`);
      const partialId = await insertPartial(client, fx, { amount: 200 });
      await client.query(`alter table public.partial_payments enable trigger partial_payments_settle`);
      expect(await ownedPayments(client, partialId)).toHaveLength(0);

      await client.query(`select public.apply_partial_payment_settlement($1)`, [partialId]);

      expect(await ownedPayments(client, partialId)).toHaveLength(1);
      expect(Number((await invoiceState(client, invoice.id)).paid)).toBe(200);
    });
  });
});
```

> `disable trigger` needs table ownership. `withRollback` runs as the pool's
> superuser unless `actAs` wraps it, so this works — but confirm against
> `src/db/testDb.ts` and, if it does not, seed the row through
> `actAsSuperuser` with the trigger dropped and re-created inside the rollback.

- [ ] **Step 4: Run the full SQL suite**

```bash
bun run test:db && bun run test:sql
```
Expected: all green. `test:db` rebuilds the database from every migration in
order — that is what proves 160 applies to a clean database, which is the only
thing production's `psql` run will resemble.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/160_partial_payment_settlement.sql src/db/partialPaymentSettlement.sqltest.ts
git commit -m "feat(db): backfill unsettled partial payments; add companies.email_logo_url"
```

---

## Task 6: Hand-copy the schema into `database.types.ts`

**Files:**
- Modify: `src/integrations/supabase/database.types.ts`

- [ ] **Step 1: Generate the reference file**

```bash
bun run gen:types
```
This writes `database.types.generated.ts`. **It is reference only.** Never copy
it over `database.types.ts`.

- [ ] **Step 2: Hand-add three things**

1. `payments`: `source_partial_payment_id: string | null` in Row, and
   `source_partial_payment_id?: string | null` in Insert and Update. Place it
   next to `source_deposit_id` and follow that column's exact formatting.
2. `companies`: `email_logo_url: string | null` in Row, optional in Insert and
   Update. Place it next to `logo_url` (Row ~1292).
3. The two RPCs in the `Functions` block, following the shape of the
   `apply_deposit_settlement` entry if one exists:
   `apply_partial_payment_settlement: { Args: { p_partial_payment_id: string }; Returns: string }`
   and the same for `revert_partial_payment_settlement`.

- [ ] **Step 3: Verify**

```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/integrations/supabase/database.types.ts
git commit -m "chore(types): add partial-payment provenance and email_logo_url"
```

---

# PART B — Full-payment dialog

---

## Task 7: The contiguous-prefix selection rule

**Files:**
- Modify: `src/lib/invoiceSettlement.ts`
- Create/modify: `src/lib/invoiceSettlement.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "vitest";

import {
  deselectFrom,
  isContiguousPrefix,
  nextSelectableIndex,
  selectThrough,
} from "@/lib/invoiceSettlement";

const rows = [{ id: "jan" }, { id: "feb" }, { id: "mar" }];

describe("isContiguousPrefix", () => {
  test("an empty selection is a valid prefix", () => {
    expect(isContiguousPrefix(rows, [])).toBe(true);
  });

  test("the oldest alone is a prefix", () => {
    expect(isContiguousPrefix(rows, ["jan"])).toBe(true);
  });

  test("all of them is a prefix", () => {
    expect(isContiguousPrefix(rows, ["jan", "feb", "mar"])).toBe(true);
  });

  test("skipping the oldest is not", () => {
    expect(isContiguousPrefix(rows, ["feb"])).toBe(false);
  });

  test("a gap in the middle is not", () => {
    expect(isContiguousPrefix(rows, ["jan", "mar"])).toBe(false);
  });

  test("selection order does not matter, only membership", () => {
    expect(isContiguousPrefix(rows, ["feb", "jan"])).toBe(true);
  });

  test("an id that is not in the list is not a prefix", () => {
    expect(isContiguousPrefix(rows, ["jan", "apr"])).toBe(false);
  });
});

describe("selectThrough and deselectFrom", () => {
  test("ticking a row selects everything up to and including it", () => {
    expect(selectThrough(rows, 2)).toEqual(["jan", "feb", "mar"]);
  });

  test("unticking a row keeps everything before it", () => {
    expect(deselectFrom(rows, 1)).toEqual(["jan"]);
  });

  test("unticking the oldest clears the selection", () => {
    expect(deselectFrom(rows, 0)).toEqual([]);
  });
});

describe("nextSelectableIndex", () => {
  test("with nothing selected only the oldest may be ticked", () => {
    expect(nextSelectableIndex(rows, [])).toBe(0);
  });

  test("it advances as the prefix grows", () => {
    expect(nextSelectableIndex(rows, ["jan"])).toBe(1);
  });

  test("with everything selected there is no next row", () => {
    expect(nextSelectableIndex(rows, ["jan", "feb", "mar"])).toBe(3);
  });

  test("an empty list has no selectable row", () => {
    expect(nextSelectableIndex([], [])).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run test -- invoiceSettlement
```
Expected: FAIL — the four functions do not exist.

- [ ] **Step 3: Implement**

Append to `src/lib/invoiceSettlement.ts`:

```ts
/** الحد الأدنى الذي تحتاجه قواعد الاختيار: المعرّف فقط. */
type SelectableRow = { id: string };

/**
 * يتحقق أن الفواتير المختارة تشكّل بادئة متصلة من الأقدم فالأحدث.
 *
 * The portal enforces the same rule in three places — `is_selectable` in
 * `evaluate_portal_payable_invoices` (121:95), the checkbox in
 * portal.invoices.tsx:131, and `invoiceSelection` in createPayment.ts:266 — and
 * none of them is reusable here, because all three read the portal RPC, which
 * filters on `is_visible_to_tenant`. Staff may settle an invoice that is hidden
 * from the tenant, so the admin dialog needs the rule without that filter.
 *
 * Pure over an already-sorted array so it is testable without a database.
 * `settleableInvoices` is what guarantees the sort.
 */
export function isContiguousPrefix(ordered: SelectableRow[], selectedIds: string[]): boolean {
  const selected = new Set(selectedIds);
  if (selected.size !== selectedIds.length) return false;
  const prefix = ordered.slice(0, selected.size);
  return prefix.length === selected.size && prefix.every((row) => selected.has(row.id));
}

/**
 * يعيد الاختيار الناتج عن تأشير الصف رقم `index`: كل ما قبله ومعه.
 *
 * Mirrors portal.invoices.tsx:139-146 exactly, so the two screens cannot drift.
 */
export function selectThrough(ordered: SelectableRow[], index: number): string[] {
  return ordered.slice(0, index + 1).map((row) => row.id);
}

/**
 * يعيد الاختيار الناتج عن إلغاء تأشير الصف رقم `index`: كل ما قبله فقط.
 */
export function deselectFrom(ordered: SelectableRow[], index: number): string[] {
  return ordered.slice(0, index).map((row) => row.id);
}

/**
 * رقم الصف الوحيد المسموح بتأشيره تاليًا؛ يساوي طول القائمة عند اختيار الكل.
 */
export function nextSelectableIndex(ordered: SelectableRow[], selectedIds: string[]): number {
  return isContiguousPrefix(ordered, selectedIds) ? selectedIds.length : 0;
}
```

- [ ] **Step 4: Run**

```bash
bun run test -- invoiceSettlement
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoiceSettlement.ts src/lib/invoiceSettlement.test.ts
git commit -m "feat(payments): pure contiguous-prefix rule for admin invoice selection"
```

---

## Task 8: Gate the checkboxes and re-assert on submit

**Files:**
- Modify: `src/routes/admin.payments.tsx:808-840` (rows), `:339-374` (submit)

- [ ] **Step 1: Replace the `onCheckedChange` handler**

The current handler (817–828) rebuilds the array by filtering `settleable`,
which keeps it sorted but allows any combination. Replace with the prefix rule:

```jsx
{settleable.map((invoice, index) => {
  const checked = field.value.includes(invoice.id);
  const selectable = index === nextSelectableIndex(settleable, field.value);
  const locked = !checked && !selectable;
  return (
    <div
      key={invoice.id}
      className={cn(
        "grid grid-cols-[auto_1fr] items-center gap-3 rounded-lg border p-3",
        locked && "opacity-75",
      )}
    >
      <Checkbox
        checked={checked}
        disabled={locked}
        aria-label={invoice.code}
        onCheckedChange={(next) =>
          field.onChange(
            next === true ? selectThrough(settleable, index) : deselectFrom(settleable, index),
          )
        }
      />
      {/* row body — Task 9 */}
    </div>
  );
})}
```

- [ ] **Step 2: Show why a row is locked**

Under the row body, matching the portal's lock message
(`portal.invoices.tsx:310-315`):

```jsx
{locked && settleable[nextSelectableIndex(settleable, field.value)] ? (
  <p className="text-muted-foreground col-start-2 flex items-center gap-1 text-xs">
    <LockKeyhole className="size-3 shrink-0" aria-hidden />
    {t("payments.payEarlierInvoiceFirst", {
      period: invoicePeriodLabel(
        settleable[nextSelectableIndex(settleable, field.value)].period_year,
        settleable[nextSelectableIndex(settleable, field.value)].period_month,
      ),
    })}
  </p>
) : null}
```

Check how `t()` handles interpolation in this codebase before using
`{ period }` — grep an existing call with a placeholder. If `t()` takes no
params, build the string by concatenation instead.

- [ ] **Step 3: Add the dictionary keys — both locales**

In `src/i18n/dictionary.ts`, beside the other `payments.*` keys:

```ts
"payments.payEarlierInvoiceFirst": "ادفع فاتورة {period} أولًا",
```
and the English `"Pay the {period} invoice first"`.

**`dictionary.test.ts` fails `bun run test` on a key present in only one locale**,
and also checks that every `t("literal")` in the source resolves. Add both, and
add every key this plan introduces to both.

- [ ] **Step 4: Re-assert on submit**

In `submitPayment` (339–374), before calling `settleInvoices`:

```ts
// A refetch can reorder `settleable` under a selection made before it
// arrived, so re-assert before spending money.
//
// Be precise about what backs this. `apply_payment_allocation` — the
// function this path actually calls — rejects an over-allocation but has NO
// chronological check; only set_invoice_paid and the deposit/partial
// settlement functions do. On this path the ordering rule is enforced in the
// UI alone, deliberately: making apply_payment_allocation raise would strand
// gateway money mid-webhook.
if (!isContiguousPrefix(settleable, values.invoiceIds)) {
  toast.error(t("payments.selectionMustBeChronological"));
  return;
}
```

Add `payments.selectionMustBeChronological` to both locales.

- [ ] **Step 5: Verify the seeding effect still agrees**

The effect at 257–265 pre-ticks only the oldest invoice, which is
`selectThrough(settleable, 0)` — already a valid prefix. Confirm by reading it;
if it ticks anything else, change it to `selectThrough(settleable, 0)`.

- [ ] **Step 6: Run the gates**

```bash
bun run lint && bun run typecheck && bun run test
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/routes/admin.payments.tsx src/i18n/dictionary.ts
git commit -m "feat(payments): admin Add Payment enforces oldest-first selection"
```

---

## Task 9: One-line invoice row with a month pill

**Files:**
- Modify: `src/routes/admin.payments.tsx:829-839`

- [ ] **Step 1: Replace the row body**

```jsx
<div className="flex flex-wrap items-center gap-2">
  <span className="font-medium">{invoice.code}</span>
  <Badge variant="secondary" className="rounded-full font-normal">
    {invoicePeriodLabel(invoice.period_year, invoice.period_month)}
  </Badge>
  <span className="text-muted-foreground ms-auto text-xs">
    {t("invoices.balance")}: <LtrText>{formatAmount(invoice.balance, locale)}</LtrText>
  </span>
</div>
```

Import `invoicePeriodLabel` from `@/lib/invoicePeriodLabel` and `Badge` from
`@/components/ui/badge`.

Three things worth not getting wrong:
- `invoicePeriodLabel` returns **English** month names even in the Arabic UI.
  That is deliberate (its docstring, 24–37: the accountant asked to read the
  month as a word, and a fixed table avoids browser locale-data variance). It is
  already what the partial-payment invoice picker uses
  (`RecordPanelDialog.tsx:72`), so this makes the two dialogs agree. **Do not
  swap it for `formatBillingPeriod`.**
- `ms-auto`, not `ml-auto` — the balance must sit at the line's end under RTL.
- `flex-wrap` — "one line" is the layout intent, not licence to clip on a narrow
  viewport.

- [ ] **Step 2: Check it in the browser**

```bash
bun run dev
```
Open `/admin/payments`, click Add Payment, pick a contract with several unpaid
invoices. Confirm: one line per invoice; a rounded month pill reading e.g.
`January 2026`; the balance at the line's end; only the oldest unticked row is
clickable; the rest are dimmed with a lock hint. Switch the UI to Arabic and
confirm the balance is still at the line's end.

- [ ] **Step 3: Run the gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/routes/admin.payments.tsx
git commit -m "feat(payments): one-line invoice rows with a month pill"
```

---

# PART C — Partial-payment dialog

---

## Task 10: Width, cap, and error mapping

**Files:**
- Modify: `src/components/admin/RecordPanelDialog.tsx:143,189-198`
- Modify: `src/components/admin/PaymentSidePanels.tsx:245-249`
- Create: `src/lib/partialPaymentErrors.ts` + its test

- [ ] **Step 1: Widen the dialog**

`RecordPanelDialog.tsx:143` currently renders `<DialogContent>` with no
className, falling back to `max-w-lg` (`ui/dialog.tsx:48`). Change to:

```jsx
<DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
```

Matching Add Payment (`admin.payments.tsx:653`). `RecordPanelDialog` also serves
Refunds and Insurance; all three carry the same contract `<Select>` and benefit.

- [ ] **Step 2: Write the failing error-mapping test**

`src/lib/partialPaymentErrors.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { partialPaymentErrorKey } from "@/lib/partialPaymentErrors";

describe("partialPaymentErrorKey", () => {
  test("maps the over-balance refusal", () => {
    expect(partialPaymentErrorKey({ message: "partial_payment_exceeds_balance" })).toBe(
      "payments.partialExceedsBalance",
    );
  });

  test("maps the chronological refusal", () => {
    expect(partialPaymentErrorKey({ message: "partial_payment_invoice_out_of_order" })).toBe(
      "payments.partialOutOfOrder",
    );
  });

  test("maps the terminal-state refusal", () => {
    expect(partialPaymentErrorKey({ message: "partial_payment_invoice_terminal_state" })).toBe(
      "payments.partialInvoiceTerminal",
    );
  });

  test("maps the immutability refusal", () => {
    expect(partialPaymentErrorKey({ message: "partial_payment_settled_immutable" })).toBe(
      "payments.partialSettledImmutable",
    );
  });

  test("finds the code inside a wrapped PostgREST message", () => {
    expect(
      partialPaymentErrorKey({
        message: 'new row violates ... "partial_payment_exceeds_balance"',
      }),
    ).toBe("payments.partialExceedsBalance");
  });

  test("returns null for anything else, so the caller keeps its own fallback", () => {
    expect(partialPaymentErrorKey({ message: "connection reset" })).toBeNull();
    expect(partialPaymentErrorKey(null)).toBeNull();
    expect(partialPaymentErrorKey(undefined)).toBeNull();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
bun run test -- partialPaymentErrors
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
/**
 * يحوّل رسائل أخطاء قاعدة البيانات الخاصة بالدفعات الجزئية إلى مفاتيح ترجمة.
 *
 * Migration 160 raises named exceptions rather than returning a flag, so they
 * reach the browser as raw PostgREST strings. Without this the admin reads a
 * Postgres identifier. Returns null rather than a generic key so the caller
 * keeps whatever fallback it already had — silently swallowing an unmapped
 * error is how a real failure becomes invisible.
 */
const ERROR_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["partial_payment_exceeds_balance", "payments.partialExceedsBalance"],
  ["partial_payment_invoice_out_of_order", "payments.partialOutOfOrder"],
  ["partial_payment_invoice_terminal_state", "payments.partialInvoiceTerminal"],
  ["partial_payment_settled_immutable", "payments.partialSettledImmutable"],
];

export function partialPaymentErrorKey(error: { message?: string } | null | undefined): string | null {
  const message = error?.message;
  if (!message) return null;
  return ERROR_KEYS.find(([code]) => message.includes(code))?.[1] ?? null;
}
```

- [ ] **Step 5: Run**

```bash
bun run test -- partialPaymentErrors
```
Expected: PASS.

- [ ] **Step 6: Cap the amount input**

In `PaymentSidePanels.tsx`, derive the remaining balance from the selected
invoice. `useSettleableInvoices` (`useInvoices.ts:437-455`) already returns
`balance` on each option row.

```ts
/**
 * الرصيد المتبقي على الفاتورة المختارة، أو null إن لم تُختر فاتورة.
 *
 * The cap only exists when a row names an invoice: an unlinked partial payment
 * settles nothing and has nothing to exceed.
 */
const remaining = useMemo(() => {
  if (!invoiceId) return null;
  const invoice = settleableInvoices.find((row) => row.id === invoiceId);
  return invoice ? Number(invoice.balance) : null;
}, [invoiceId, settleableInvoices]);
```

Replace the validation at 245–249:

```ts
const value = Number(amount);
if (!Number.isFinite(value) || value <= 0) {
  toast.error(t("payments.invalidAmount"));
  return;
}
// Client-side so the admin is told before the round trip. The real cap is
// migration 160's `partial_payment_exceeds_balance` — two dialogs open at once
// both pass this check and only one can win.
if (remaining !== null && value > remaining) {
  toast.error(`${t("payments.partialExceedsBalance")} (${formatAmount(remaining, locale)})`);
  return;
}
```

And in the mutation's `onError`, before whatever generic toast exists:

```ts
const key = partialPaymentErrorKey(error);
toast.error(key ? t(key) : t("common.saveFailed"));
```

Use the file's existing generic-failure key rather than inventing
`common.saveFailed` — grep for what the neighbouring mutations already use.

- [ ] **Step 7: Pass the cap into the input**

`RecordPanelDialog.tsx:189-198` — add a `remaining` prop and render:

```jsx
<Input
  type="number"
  step="0.001"
  min="0.001"
  max={remaining ?? undefined}
  value={amount}
  onChange={(e) => onAmountChange(e.target.value)}
/>
{remaining !== null ? (
  <p className="text-muted-foreground text-xs">
    {t("payments.remainingBalance")}: <LtrText>{formatAmount(remaining, locale)}</LtrText>
  </p>
) : null}
```

**`min` and `step` must travel together.** `min="0.001"` with the default
`step=1` makes the browser reject `3500`, and Vitest cannot see native
validation — it only shows up in a browser. The existing input already has
`step="0.001"`; keep them adjacent so nobody removes one.

- [ ] **Step 8: Add the dictionary keys — both locales**

`payments.partialExceedsBalance`, `payments.partialOutOfOrder`,
`payments.partialInvoiceTerminal`, `payments.partialSettledImmutable`,
`payments.remainingBalance`.

Arabic first, e.g.
`"payments.partialExceedsBalance": "المبلغ يتجاوز الرصيد المتبقي للفاتورة"`.

- [ ] **Step 9: Add the delete confirmation line**

Deleting a settled partial now un-settles the invoice. Whatever confirmation the
panel's delete already shows, add a sentence saying so, in both locales.

> Native `confirm()` hard-freezes browser automation in this repo. If the delete
> path uses `confirm()`, leave it as it is — do not "improve" it into an
> AlertDialog as part of this task, and verify the delete against the database
> rather than by clicking it in an automated browser.

- [ ] **Step 10: Verify in the browser**

```bash
bun run dev
```
`/admin/payments` → Partial tab → Add. Confirm: the dialog is visibly wider and a
long contract name no longer overflows; picking an invoice shows its remaining
balance; typing more than the remaining balance is refused with a message naming
the remaining amount; a whole number like `500` is accepted (the `min`/`step`
trap); creating a partial that covers the remaining balance flips the invoice to
Paid in the invoices list.

- [ ] **Step 11: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/components/admin/RecordPanelDialog.tsx src/components/admin/PaymentSidePanels.tsx src/lib/partialPaymentErrors.ts src/lib/partialPaymentErrors.test.ts src/i18n/dictionary.ts
git commit -m "feat(payments): widen the partial dialog, cap the amount, translate the refusals"
```

---

# PART D — Resend sender and email logo

---
## Task 11: The logo marker in the template shell

**Files:**
- Modify: `src/lib/emailTemplates.ts:26-93`
- Modify: `src/lib/emailTemplates.test.ts`
- Create: `src/lib/emailLogo.ts` + its test

**Read this before writing code — the obvious design is wrong.**

The natural move is to thread a `logoUrl` argument through `wrapLayout`'s
callers. It does not work here, and the reason is not obvious from the file.
`dispatchNotification.ts` **does not build HTML**: it imports neither
`emailTemplates` nor `loadTemplateCopy`, and sends `notification.body` (239, 247,
270) — a string already stored on the row. Sixteen sender files build that HTML
(`notifyContactInquiry`, `notifyContractCloseout`, `notifyContractLifecycle`,
`notifyContractRestored`, `notifyDepositConfirmed`, `notifyInvoiceDisputed`,
`notifyInvoiceWrittenOff`, `notifyMaintenanceRequest`, `notifyPaymentSuccess`,
`notifyRefundRecorded`, `notifyUserCredentials`, `overdueRemindersJob`,
`contractExpiryJob`, `sendCompanyInfo`, `sendInvoiceToTenant`,
`sendTenantCredentials`), plus `TemplateEditorDialog` client-side. A parameter
means editing all sixteen and remembering it in every sender added later — and
one missed sender is an unbranded email nobody notices.

So `wrapLayout` emits an inert **marker**, and the send path substitutes it. One
edit per send path, `wrapLayout` stays pure, and the substitution happens
somewhere that can `await` branding.

- [ ] **Step 1: Write the failing tests for the substitution helper**

`src/lib/emailLogo.ts` is a pure string function, testable without a database.
`src/lib/emailLogo.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { EMAIL_LOGO_MARKER, applyEmailLogo } from "@/lib/emailLogo";

describe("applyEmailLogo", () => {
  test("replaces the marker with an img", () => {
    const html = `<td>${EMAIL_LOGO_MARKER}<div>Brand</div></td>`;
    const out = applyEmailLogo(html, "https://example.test/logo.png", "Danat");
    expect(out).toContain('src="https://example.test/logo.png"');
    expect(out).toContain('alt="Danat"');
    expect(out).not.toContain(EMAIL_LOGO_MARKER);
  });

  test("removes the marker when there is no logo", () => {
    const html = `<td>${EMAIL_LOGO_MARKER}<div>Brand</div></td>`;
    const out = applyEmailLogo(html, null, "Danat");
    expect(out).not.toContain(EMAIL_LOGO_MARKER);
    expect(out).not.toContain("<img");
    expect(out).toContain("<div>Brand</div>");
  });

  test("leaves a document with no marker untouched", () => {
    const html = "<!doctype html><html><body>Raw</body></html>";
    expect(applyEmailLogo(html, "https://example.test/l.png", "Danat")).toBe(html);
  });

  test("escapes the url and the alt text", () => {
    const out = applyEmailLogo(
      `x${EMAIL_LOGO_MARKER}y`,
      'https://e.test/a.png"onerror="alert(1)',
      '"><script>alert(1)</script>',
    );
    expect(out).not.toContain("<script>");
    expect(out).not.toContain('onerror="alert(1)"');
  });

  test("replaces every marker, not only the first", () => {
    const out = applyEmailLogo(
      `${EMAIL_LOGO_MARKER}|${EMAIL_LOGO_MARKER}`,
      null,
      "Danat",
    );
    expect(out).not.toContain(EMAIL_LOGO_MARKER);
  });

  test("an empty-string url is treated as no logo", () => {
    const out = applyEmailLogo(`x${EMAIL_LOGO_MARKER}y`, "", "Danat");
    expect(out).not.toContain("<img");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run test -- emailLogo
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * علامة يضعها قالب البريد مكان الشعار، ويستبدلها مسار الإرسال قبل الإرسال.
 *
 * An HTML comment, so a document that reaches a mail client without ever passing
 * through `applyEmailLogo` renders correctly with no logo rather than showing a
 * stray token. That matters because a template body the admin wrote as a full
 * `<!doctype>` document bypasses the shell entirely (emailTemplates.ts:91) and
 * carries no marker at all.
 */
export const EMAIL_LOGO_MARKER = "<!--EMAIL_LOGO-->";

/**
 * يستبدل علامة الشعار بصورة الشعار، أو يزيلها إن لم يكن هناك شعار.
 *
 * Pure and synchronous on purpose: `wrapLayout` runs in the browser too
 * (TemplateEditorDialog), so nothing on this path may fetch. The caller resolves
 * the URL — from `readPublicBranding()` on the server, from `useCompany()` in the
 * preview — and hands it in.
 */
export function applyEmailLogo(
  html: string,
  logoUrl: string | null | undefined,
  brandName: string,
): string {
  if (!html.includes(EMAIL_LOGO_MARKER)) return html;
  const replacement = logoUrl?.trim()
    ? `<img src="${escapeHtml(logoUrl.trim())}" alt="${escapeHtml(brandName)}" ` +
      `style="max-height:44px;max-width:200px;display:block;margin-bottom:12px;border:0;" />`
    : "";
  return html.split(EMAIL_LOGO_MARKER).join(replacement);
}
```

`escapeHtml` already exists in `emailTemplates.ts`, module-private. **Export it
from there and import it here.** Do not create `src/lib/escapeHtml.ts`: six
independent copies already exist across `src/lib` (`companyInfoMessage`,
`emailTemplates`, `printDocument`, `signatureHtml`, `templateRender`, `xlsx`),
so a shared module used by two of them adds a seventh site rather than
consolidating. Repo-wide consolidation is real work and is out of scope for this
branch. What matters here is not writing a *seventh* copy — this one escapes a
URL that reaches a mail client.

`split().join()` rather than `replace()`: `String.replace` with a string pattern
replaces only the first occurrence, and `$&`-style sequences in a URL would be
interpreted as replacement patterns.

- [ ] **Step 4: Emit the marker from `wrapLayout`**

In the header cell (`emailTemplates.ts:56-61`), immediately before the brand-name
`<div>`:

```ts
`${EMAIL_LOGO_MARKER}` +
`<div style="font-size:20px;font-weight:700;letter-spacing:0.3px;">${escapeHtml(brandName)}</div>`
```

The brand name **stays**. `emailTemplates.test.ts:231` asserts it, and a client
that blocks images must still show who sent the mail — which is also why the
`alt` text is the brand name.

- [ ] **Step 5: Add the shell tests**

Append to `src/lib/emailTemplates.test.ts`:

```ts
describe("the email logo marker", () => {
  test("the wrapped document carries the marker", () => {
    const html = renderEmailDocument("en", "Title", "<p>Body</p>");
    expect(html).toContain(EMAIL_LOGO_MARKER);
    expect(html).toContain("Danat Al Mustaqbal");
  });

  test("a full-document body carries no marker and is returned verbatim", () => {
    const body = "<!doctype html><html><body>Raw</body></html>";
    const out = renderEmailDocument("en", "Title", body);
    expect(out).toBe(body);
    expect(out).not.toContain(EMAIL_LOGO_MARKER);
  });

  test("every built-in template carries the marker", () => {
    // The marker only works if it is in the ONE place every template funnels
    // through. wrapLayout is called at emailTemplates.ts:92, 245, 291, 389, 440,
    // 508, 531, 564, 601 and 636 — a template that grew its own header would
    // silently never show a logo.
    const html = renderEmailDocument("ar", "عنوان", "<p>محتوى</p>");
    expect(html).toContain(EMAIL_LOGO_MARKER);
  });
});
```

> Replace that third test with one that calls the **actual** built-in builders
> once you have read their exported names. Asserting `renderEmailDocument` twice
> proves one code path twice. Enumerate the exported builders and loop over them;
> if that is impractical, assert instead that `wrapLayout` is the only function
> in the file emitting `background:${BRAND.primary}` — a header built anywhere
> else would then fail the test.

- [ ] **Step 6: Run**

```bash
bun run test -- emailTemplates emailLogo
```
Expected: PASS, including the pre-existing brand-name assertion at line 231.

- [ ] **Step 7: Commit**

```bash
git add src/lib/emailTemplates.ts src/lib/emailTemplates.test.ts src/lib/emailLogo.ts src/lib/emailLogo.test.ts
git commit -m "feat(email): logo marker in the template shell and its substitution helper"
```

---

## Task 12: Substitute the logo on the send paths

**Files:**
- Modify: `src/fns/publicBranding.ts:20-41`
- Modify: `src/fns/dispatchNotification.ts` (around 231-245)
- Modify: `src/fns/resendMailboxSend.ts` (around 148-164)
- Modify: `src/components/admin/TemplateEditorDialog.tsx`

- [ ] **Step 1: Widen `readPublicBranding`**

It already service-role-selects `logo_url, favicon_url, portal_bg_url` with a
60-second in-process cache (11–12, 22, 35). Add `email_logo_url` to the select
**and to the cached shape's type** — a column added to the query but not the type
is silently dropped by the mapper and the bug looks like "the logo doesn't work".

Add beside it:

```ts
/**
 * شعار البريد: الشعار المخصّص للبريد، وإلا شعار التطبيق، وإلا لا شيء.
 *
 * Null is the fallback, not an error: an installation that never uploaded an
 * email logo should still send mail, just without one.
 */
export function emailLogoUrl(
  branding: { email_logo_url?: string | null; logo_url?: string | null } | null,
): string | null {
  return branding?.email_logo_url ?? branding?.logo_url ?? null;
}
```

- [ ] **Step 2: Substitute in `dispatchNotification`**

This is the chokepoint every automatic notification passes through. Find where
the email body is handed to the provider (near the `from` resolution at 231–245)
and wrap it:

```ts
// Every automatic email funnels through here, so the logo is applied once
// rather than in each of the sixteen senders that build the HTML — and one of
// those forgotten is an unbranded email nobody notices.
const branding = await readPublicBranding();
const htmlBody = applyEmailLogo(notification.body, emailLogoUrl(branding), BRAND_NAME);
```

Pass `htmlBody` where `notification.body` went. Read the surrounding code first:
if the body is used for both the email and a WhatsApp message, substitute only on
the email branch — `applyEmailLogo` is a no-op on a body with no marker, but
routing it through the WhatsApp branch would be misleading to the next reader.

**Substitute before the mailbox mirror, not only before the send.**
`dispatchNotification` also mirrors the message into the mailbox at 257–281 via
`recordSentResendMessage`, which stores `body_text` and a
`snippet: input.body.slice(0, 200)` that the mailbox list renders. If the
substitution happens after that call, the archive keeps a raw `<!--EMAIL_LOGO-->`
and disagrees with what was actually delivered. Compute `htmlBody` **once**,
above both, and pass the same string to `sendWithResend`/`sendWithSmtp` and to
`recordSentResendMessage`.

Storing the *un*-substituted marker in `notifications.body` is correct and
deliberate: the senders write that column before dispatch, so a resend by
`runNotificationDrainJob` re-substitutes against current branding instead of
replaying a stale logo URL. Applying `applyEmailLogo` to an already-substituted
body finds no marker and is a no-op, so a double application is harmless.

`BRAND_NAME`: `BRAND` is currently module-private in `emailTemplates.ts:10-18`.
Export the localised brand name (a small `brandName(locale)` helper, or the
`BRAND` object) rather than re-typing the string — a second copy will drift.

- [ ] **Step 3: Substitute in `resendMailboxSend`**

The mailbox compose path builds its own HTML and does not go through
`dispatchNotification`. Apply the same substitution before the
`sendWithResend(...)` call at 148–164, so a hand-composed message is branded the
same way. If a composed body never passes through `wrapLayout`, it carries no
marker and this is a no-op — which is correct, not a gap.

- [ ] **Step 4: Substitute in the preview**

`TemplateEditorDialog.tsx:36,65,97` renders with `renderEmailDocument`. After it,
apply `applyEmailLogo` with `company.email_logo_url ?? company.logo_url` from
`useCompany()`, so the admin's preview matches what will actually be sent. This
is why the substitution is a separate pure function rather than something the
server does inline.

- [ ] **Step 5: Verify no send path was missed**

```bash
grep -rn "sendWithResend\|sendWithSmtp" src/ --include=*.ts
```

Every call site must have had `applyEmailLogo` applied to its HTML upstream, or
be a path that provably carries no marker. List them in the commit message.
**Do not skip this step** — the whole design rests on the substitution sitting at
a genuine chokepoint, and this is the check that proves it does.

- [ ] **Step 6: Gates**

```bash
bun run lint && bun run typecheck && bun run test
```

- [ ] **Step 7: Commit**

```bash
git add src/fns/publicBranding.ts src/fns/dispatchNotification.ts src/fns/resendMailboxSend.ts src/components/admin/TemplateEditorDialog.tsx src/lib/emailTemplates.ts
git commit -m "feat(email): apply the brand logo on every send path"
```

---

## Task 13: The Resend card — sender dropdown and logo upload

**Files:**
- Modify: `src/components/admin/ProviderConfigCard.tsx`
- Modify: `src/routes/admin.settings.notifications.tsx:536-577`

- [ ] **Step 1: Widen the `onSave` contract**

`ProviderConfigCard` today calls `onSave(config)` (90–113) and the route maps it
to `updateProvider.mutate({ id, updates: { config } })`. `from_email` is a
**column, not a `config` jsonb key** — putting it in `config` would trip
`provider_configs_secret_references_only` (07:44-63).

Change the prop to:

```ts
onSave: (updates: { config?: Json; from_email?: string | null }) => void;
```

and the route's handler to `updates: updates`. `useUpdateProviderConfig` already
accepts any `TablesUpdate<"provider_configs">` (`useProviderConfigs.ts:36-68`),
so **no hook change and no migration** are needed for the sender.

- [ ] **Step 2: Add the sender `<Select>`, Resend only**

Pass `fromEmail={provider.from_email}` from the route, and render, gated on
`provider === "resend"`:

```jsx
<div className="space-y-2">
  <Label>{t("providerField.fromEmail")}</Label>
  <Select value={fromEmailDraft ?? ""} onValueChange={setFromEmailDraft}>
    <SelectTrigger dir="ltr"><SelectValue placeholder={t("providerField.fromEmailPlaceholder")} /></SelectTrigger>
    <SelectContent>
      {(senders.data ?? []).map((item) => (
        <SelectItem key={item.value} value={item.value} dir="ltr">
          {item.value} — {locale === "ar" ? item.label_ar : item.label_en}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
  <p className="text-muted-foreground text-xs">{t("providerField.fromEmailHint")}</p>
</div>
```

with

```ts
const senders = useOptionListItemsByCode(RESEND_SENDER_LIST_CODE, provider === "resend");
```

— the same hook and the same catalogue `GmailComposeDialog.tsx:164-183` uses
(`useOptionLists.ts:42-62`, `RESEND_SENDER_LIST_CODE` from
`@/fns/resendMailboxSend`). The list already holds five verified addresses in
production and is editable at Settings → Lists without a deploy.

A dropdown rather than free text because Resend verifies a *domain* and rejects
an unverified sender at send time with an error the operator has to interpret
(158:75-84).

`dir="ltr"` on the trigger and items: email addresses are Latin inside an RTL
page.

`fromEmailHint` must say that this address is used for **automatic
notifications**; mailbox compose picks its own per message. The two paths are
disjoint (`dispatchNotification.ts:231-235` vs `resendMailboxSend.ts:139-164`)
and an admin who does not know that will file a bug.

- [ ] **Step 3: Add the logo upload, Resend only**

Reuse `ImageSourceInput` (`src/components/admin/ImageSourceInput.tsx:53-188`) —
not a copy of `BrandingAssetField`. It already does client-side downscaling
(`compressImageFile`), an upload timeout, RLS/size error mapping and an inline
`role="alert"`, and its doc comment (75–79) explicitly anticipates a smaller
bound for logos.

```jsx
<div className="space-y-2">
  <Label>{t("providerField.emailLogo")}</Label>
  <ImageSourceInput
    value={emailLogoDraft ?? ""}
    onChange={setEmailLogoDraft}
    bucket="branding"
    folder="email-logo"
    canUpload
    maxDimension={480}
    uploadHint={t("providerField.emailLogoHint")}
  />
</div>
```

The logo lives on `companies.email_logo_url`, **not** on `provider_configs`, so
it saves through `useUpdateCompany` (`src/hooks/useCompany.ts`) rather than
`onSave`. Read `admin.settings.index.tsx:377-387` for how that hook is fed.

`emailLogoHint` must carry the caveat from `emailTemplates.ts:85-88`: a template
whose body starts with `<!doctype` or `<html>` bypasses the shell and will not
show the logo. Say it in both locales.

- [ ] **Step 4: Dictionary keys — both locales**

`providerField.fromEmail`, `providerField.fromEmailPlaceholder`,
`providerField.fromEmailHint`, `providerField.emailLogo`,
`providerField.emailLogoHint`.

- [ ] **Step 5: Verify the save round-trips**

```bash
bun run dev
```
`/admin/settings/notifications` → Delivery providers → Email → Resend. Pick a
sender, upload a logo, save, reload the page, confirm both persisted. Then check
the database:

```bash
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres \
  -c "select provider, is_enabled, from_email from public.provider_configs where provider='resend'"
```

(Against local dev, not production — production gets the migration in Task 15.)

- [ ] **Step 6: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/components/admin/ProviderConfigCard.tsx src/routes/admin.settings.notifications.tsx src/i18n/dictionary.ts
git commit -m "feat(notifications): Resend sender dropdown and email logo upload"
```

---

# PART E — Land it

---

## Task 14: Guards and full gates

- [ ] **Step 1: Run the guards**

Per `AGENTS.md`, these are required, not optional. A green suite says nothing
about a test that asserts nothing or a catch block that swallows its error.

- `clean-code-guard` over every production file touched.
- `test-guard` over `src/db/partialPaymentSettlement.sqltest.ts`, the rewritten
  block in `src/db/refunds.sqltest.ts`, `src/lib/invoiceSettlement.test.ts`,
  `src/lib/partialPaymentErrors.test.ts`, `src/lib/emailTemplates.test.ts`,
  `src/lib/emailLogo.test.ts`.
- `docs-guard` over the spec, this plan, and every new doc comment.

Treat any finding as blocking. Fix, re-run the guard, then continue.

- [ ] **Step 2: Full gates**

```bash
bun run lint && bun run typecheck && bun run test && bun run test:sql
```

All four must be green. If `serverPdf` fails, run it alone before blaming this
branch — it spawns a real Chromium and flakes under full-suite parallelism.

- [ ] **Step 3: Update the knowledge graph**

```bash
graphify update .
```

- [ ] **Step 4: Commit anything the guards changed**

---

## Task 15: Apply migration 160 to production, then merge

**Order matters.** `main` auto-deploys via Dokploy and there is no staging. The
schema must be live **before** the bundle that expects it.

- [ ] **Step 1: Back up first**

Over `ssh-danatfuture-mcp`. Schema changes are not reversible.

```bash
nohup sh -c 'docker exec danatfuture-supabase-ozoxsa-db-1 pg_dump -U supabase_admin -d postgres -Fc -f /tmp/pre_160.dump && docker cp danatfuture-supabase-ozoxsa-db-1:/tmp/pre_160.dump /root/danat_pre_160_20260824.dump; echo $? > /root/status.txt' &
```

Poll `/root/status.txt`. The MCP bridge times out on long commands and returns
"No response from server" while the command is still running — never re-run a
`pg_dump` on that basis.

- [ ] **Step 2: Transfer the migration**

The usual trick — reading the file out of Dokploy's checkout — **does not work
here**, because that checkout is of `main` and `main` does not yet contain 160.
Transfer by chunked base64 (the bridge caps a command at a few KB), then:

```bash
md5sum /root/160_partial_payment_settlement.sql
```

Compare against the local `md5sum`. **They must match**; that is the only thing
proving production runs the same bytes `bun run test:sql` validated.

- [ ] **Step 3: Apply**

```bash
nohup sh -c 'docker exec -i danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - < /root/160_partial_payment_settlement.sql > /root/apply.log 2>&1; echo $? > /root/status.txt' &
```

Poll, then `grep '^ERROR' /root/apply.log`. `drop … if exists` emits `NOTICE`
lines on first application; those are not errors. Trust `ON_ERROR_STOP=1` plus
the exit code, not the absence of output.

- [ ] **Step 4: Reload PostgREST's schema cache**

```bash
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -Atc "notify pgrst, 'reload schema'"
```

Without this the new RPCs 404 from a stale signature cache even though they
exist.

- [ ] **Step 5: Verify the backfill landed**

```bash
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -c \
"select i.code, i.state, i.total, i.paid, i.balance,
        (select count(*) from public.payments p where p.source_partial_payment_id = pp.id) as owned
   from public.partial_payments pp join public.invoices i on i.id = pp.invoice_id"
```

Expected for `INV-0003085`: `partially_paid`, `total 1350.000`, `paid 1175.000`,
`balance 175.000`, `owned 1`.

**If this shows anything else, stop and do not merge.** The database is now ahead
of `main` and the discrepancy must be understood first.

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin feat/payments-ordering-partials-resend-sender
gh pr create --title "Payments ordering, partial-payment settlement, and Resend sender" --body-file <(...)
```

The body must reference the spec, list the gate and guard results, and state
plainly that migration 160 is **already applied to production** and that merging
triggers a deploy.

- [ ] **Step 7: Wait for the review, apply corrections, then merge**

Do not self-merge. Corrections are force-pushed to **this branch only** — never
to `main`, which Lovable tracks. Re-run the gates and the matching guards after
each correction.

- [ ] **Step 8: After the merge**

Confirm Dokploy rebuilt and the container swapped. Then, on production:
add a 175 KD partial payment to `INV-0003085` and confirm it flips to **Paid**;
send one notification and confirm the From address and the logo.

---

## Self-review notes for the executor

- **Every dictionary key must exist in both locales.** `dictionary.test.ts`
  fails `bun run test` on a one-sided key and also checks that every
  `t("literal")` in the source resolves.
- **`eslint no-unused-vars` is OFF in this repo.** A dead import never fails
  lint. Check by hand.
- **The `createServerFn` mock in `src/fns` tests skips `.validator()`**, so a
  Zod schema declared inline in a server fn is never exercised. This plan adds
  no server fn, but if you add one, export the schema and assert it directly.
- **A shadcn `Button` bakes `disabled:*` classes into every render**, so
  `expect(html).toMatch(/disabled/)` always passes. Assert `disabled=""`.
- **Do not run `bun run format`** — it rewrites every markdown file in the repo.
