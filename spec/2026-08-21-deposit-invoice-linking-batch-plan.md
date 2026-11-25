# Implementation plan — deposit ↔ invoice linking batch

Companion to `2026-08-21-deposit-invoice-linking-batch.md` (revision 3).
**Plan revision 4** — revision 1 rewritten after the Codex spec review; revision 2
after plan-debate round 1; revision 4 after plan-debate round 2 (the final round).

Steps are ordered so the branch is green after each one. Features 2, 3 and 4
share no code with Feature 1 and may run in parallel; Feature 1 is strictly
sequential.

**Branch:** `feat/deposit-invoice-linking-batch-aug21`. Never commit to `main`,
which auto-deploys. Re-check the branch before every commit — the owner works
concurrently in this repo.

**Guards run before each commit, not at the end.** Revision 1 deferred them to a
final step, which contradicts CLAUDE.md: a commit containing production code
runs `clean-code-guard` first, a commit containing tests runs `test-guard`
first, a commit containing docs runs `docs-guard` first. This is stated once
here and applies to every step below.

---

## Step 0 — Baseline

`bun run lint && bun run typecheck && bun run test && bun run test:sql`.
`test:sql` is included because this is a money-path batch and a pre-existing SQL
failure must not be attributed to migration 152. Record the result in the PR
body. `serverPdf.test` is a known flake under full parallel load — re-run it
alone before treating a failure as real.

---

## Feature 1 — Deposits (sequential)

### Step 1.1 — Migration `152_deposit_invoice_link.sql`

**1. Columns and constraints**

- `deposits.contract_id uuid references public.contracts(id) on delete restrict`
- `deposits.invoice_id uuid references public.invoices(id) on delete restrict`
- `check ((contract_id is null) = (invoice_id is null))` — an `invoice_id`
  cannot arrive without the `contract_id` the mismatch check needs (D11).

  **`restrict`, not `set null`.** Plan revision 2 used `on delete set null`,
  which contradicts the paired-null check it added in the same revision:
  deleting an invoice would null `invoice_id`, leave `contract_id` populated,
  and the referential action would then violate the check — so the invoice
  delete fails with a confusing constraint error instead of a clear one.
  `restrict` says the real rule plainly: an invoice or contract that a bank
  deposit is attached to cannot be deleted until the deposit is unlinked. It
  also matches `payment_allocations.invoice_id`, already `on delete restrict`
  (`05:97`), so a settled invoice is undeletable today regardless.

- **`public.tg_invoices_unlink_deposits()`** — BEFORE delete on `invoices`.
  Without it, `restrict` breaks invoice regeneration: the regeneration and
  reapply paths delete due/overdue invoices (`139:389-405`, `127:353-375`,
  `127:438-450`), and a **pending** linked deposit has no allocation shielding
  its invoice, so the new FK would abort the entire run with an incidental FK
  violation. The trigger clears `contract_id` and `invoice_id` **together** on
  any deposit pointing at the invoice being deleted — together, because the
  paired-null check forbids clearing one alone, which is precisely what an FK
  `set null` action cannot do and a trigger can.

  It unlinks only deposits that own no payment. A *confirmed* deposit's invoice
  carries an allocation and is already undeletable through
  `payment_allocations`' own `restrict`, so that case never reaches here — and
  if it somehow did, `restrict` firing is the correct outcome rather than
  silently deleting an invoice a bank deposit settled.

  SECURITY DEFINER for the same reason as the other triggers: the person
  regenerating invoices holds `invoices.*`, not necessarily `deposits.update`.
  The unlink is audited.
- `check (currency = 'KWD')` (D12). Verify no production row violates it before
  adding, and add it as a separate `do $$ … exception when duplicate_object $$`
  block so re-application is safe.
- `payments.source_deposit_id uuid references public.deposits(id) on delete restrict`
  plus `create unique index … on public.payments (source_deposit_id) where
  source_deposit_id is not null` — the partial unique index is what makes
  settlement idempotent (D2/D3).
- Indexes on `deposits.contract_id` and `deposits.invoice_id`.
- Column comments explaining what the link means, in the style of 147.

**2. `public.tg_deposits_link_guard()`** — BEFORE insert or update of
`invoice_id, contract_id`. Invoice must exist; when both are set the invoice's
contract must match, else `deposit_invoice_contract_mismatch` (23514).
**Not** SECURITY DEFINER — it only reads `public.invoices`, readable by every
staff user, and a function needing no elevation should not have any.

**3. `public.tg_deposits_sync_invoice()`** — SECURITY DEFINER, all settle/revert
logic **inline** (D8), `revoke execute … from public, anon, authenticated`.

**Two triggers, not one.** Plan revision 2 specified a single
`after insert or update … when (… old.status …)`. That is **invalid SQL**: an
INSERT trigger has no `OLD` record and PostgreSQL rejects the `CREATE TRIGGER`
outright, so migration 152 would have failed at creation. Split:

```sql
create trigger deposits_sync_invoice_ins
  after insert on public.deposits
  for each row execute function public.tg_deposits_sync_invoice();

create trigger deposits_sync_invoice_upd
  after update on public.deposits
  for each row
  when (
    new.status       is distinct from old.status
    or new.invoice_id   is distinct from old.invoice_id
    or new.amount       is distinct from old.amount
    or new.deposit_date is distinct from old.deposit_date
    or new.deposit_type is distinct from old.deposit_type
  )
  execute function public.tg_deposits_sync_invoice();
```

The function branches on `TG_OP`. `deposit_date` and `deposit_type` are in the
`WHEN` list because they are *copied into* the payment (`payment_date`,
`method`); revision 2 omitted them, which would have left a settled payment
carrying a stale date or instrument after an edit.

**The settlement state machine is total, and re-sync is revert-first.**
Revision 2's "return early if a payment already exists" was wrong for an edit:
raising a confirmed deposit's amount would have left the old payment and
allocation untouched.

Revision 3 said "revert and settle again" without fixing the **order**, which
Codex showed is the dangerous part: the invoice's balance *already reflects* the
deposit's own allocation, so computing `least(new.amount, balance)` before
removing it reads 0 on a fully-settled invoice — and the `balance <= 0` early
return then fires and the edit silently does nothing. The sequence is therefore
explicit and revert-first:

1. take the contract advisory locks, then lock every affected invoice `for
   update` in `(period_year, period_month, id)` order;
2. load the deposit-owned payment and its allocation;
3. **delete them** (receipt → allocation → payment) and recompute the *old*
   invoice;
4. **re-read** the target invoice's balance — now restored, and for a
   same-invoice edit this restored figure is the correct cap;
5. settle against that balance;
6. one audit row describing the net effect.

The early return applies only when nothing material differs, checked before
step 3.

*Settle branch* (`status = 'confirmed'` and `invoice_id is not null`):
- take the contract lock first (below), then
  `select … from public.invoices where id = new.invoice_id for update`;
- refuse `cancelled` / `waived` (D11) with `deposit_invoice_terminal_state`;
- if a payment already carries this `source_deposit_id`: re-sync as above, or
  return if identical;
- return early if `balance <= 0`;
- enforce the chronological rule (see the lock protocol below);
- the insert uses
  `on conflict (source_deposit_id) where source_deposit_id is not null do nothing`
  so a lost race degrades to an idempotent no-op rather than surfacing a bare
  `23505` from a save the user experiences as "it failed but it worked".
  **The zero-row branch is explicit, not implied:** the insert is
  `… returning id into v_payment_id`, and when `v_payment_id is null` the
  trigger performs no allocation, no receipt refresh, no recompute and no settle
  audit — it returns. Prose saying "no-op" is not enough; the other session
  already did all of that.
- insert `payments` with `amount = least(new.amount, v_invoice.balance)`,
  `method` mapped from `deposit_type` (D13), `tenant_id` / `company_id` /
  `unit_id` resolved **from the invoice** (`payments.tenant_id` is NOT NULL and
  a deposit has no tenant), `status = 'confirmed'`,
  `source_deposit_id = new.id`, `payment_date = new.deposit_date`;
- insert the `payment_allocations` row;
- `update public.receipts set html_snapshot = public.receipt_html_for_payment(…)`
  — the receipt trigger fires before the allocation exists (`05:463`), so
  without this the receipt shows an unallocated payment (D9);
- recompute (below);
- `write_audit` with action `deposit.invoice.settle`.

*Revert branch* (any other status, or the previous invoice when the link moved):
- find the payment by `source_deposit_id`;
- delete receipts → allocations → payment, in that order
  (`receipts.payment_id` is `on delete restrict`);
- recompute; `write_audit` with `deposit.invoice.revert`.

*The recompute*, used by both branches and **not** copied from migration 129
(D4):

```sql
select coalesce(sum(pa.amount), 0) into v_paid
from public.payment_allocations pa
join public.payments p on p.id = pa.payment_id
where pa.invoice_id = v_invoice.id and p.status = 'confirmed';
```

then the state expression from `apply_payment_allocation`
(`05:571-576`), and never overwriting a terminal state. `balance` is generated —
never assigned.

**3a. The lock protocol** (Codex's still-open B2)

Revision 2 said "deterministic lock order", which is prose, not a protocol.
Concretely, every deposit settle/revert:

1. `select pg_advisory_xact_lock(hashtextextended('danat.contract', <contract_id>))`
   for **every** affected contract — both the old and the new one when a
   confirmed link moves — acquired in sorted contract-id order, **before** any
   invoice row lock;
2. then locks invoices with `for update` in `(period_year, period_month, id)`
   order.

Sorted order in both steps is what prevents two concurrent deposit saves from
deadlocking on the same pair.

**What this does and does not buy.** It fully serializes *deposit against
deposit*. It does **not** make chronological ordering a persistent invariant,
and this plan stops claiming that it does. Codex is right that serialization
alone cannot deliver it: `set_invoice_paid` locks the target invoice first
(`129:49`) and permits unmarking an earlier invoice with no check at all
(`129:103-115`), so even today an admin can unmark January and leave February
paid. The chronological rule is therefore a **settle-time admission check**,
exactly matching what `set_invoice_paid` already enforces — no stronger, no
weaker.

Making it a real invariant means changing `set_invoice_paid`'s unmark branch and
its lock order, which is a rewrite of a live money function that three other
paths call. That is **out of scope for this batch** and is recorded in
`TODO.md` as its own piece of work. Advisory locks are voluntary, so the deposit
trigger's lock buys nothing against `set_invoice_paid` until that function
adopts the same protocol; the plan says so rather than implying protection it
does not have.

**4. `public.tg_deposits_revert_on_delete()`** — BEFORE delete, **SECURITY
DEFINER** with `set search_path = public`, revoked from `public`, `anon` and
`authenticated`. Definer rights are required, not optional: authenticated users
hold no DELETE grant on `payments` (`05:141-150`), so under invoker rights the
revert would fail for every normal UI deletion. It reverts the settlement and
calls `write_audit` **inside the same trigger transaction** — deleting a
confirmed deposit moves money and must not commit without its audit row, the
same rule as the update path.

A row-level BEFORE DELETE trigger runs before the foreign-key restriction is
checked, so removing the payment here satisfies
`payments.source_deposit_id`'s `on delete restrict`.

**5. Protect provenance at the database boundary** (Codex's still-open B2,
second half). `source_deposit_id` is not immutable merely by being a column:
authenticated staff hold direct INSERT/UPDATE grants on `payments`
(`05:145`, `05:198-203`), so they could set, repoint or clear it and orphan or
hijack a settlement. Migration 152 adds
`public.tg_payments_guard_deposit_provenance()` — BEFORE insert or update on
`payments` — which raises `payment_provenance_locked` when
`source_deposit_id` is being set or changed outside the deposit trigger, and
`payment_owned_by_deposit` when a payment carrying one is being reversed or
otherwise mutated (D15).

**How the guard tells the deposit trigger apart from everyone else: role
identity, not a token.**

Plan revision 3 used a transaction-local GUC (`set local danat.deposit_sync`).
That was wrong and is withdrawn. Any role able to execute SQL can simply run
`select set_config('danat.deposit_sync', 'on', true)` — this repo's own test
harness uses exactly that mechanism (`src/db/testDb.ts:71-81`) — so the token is
forgeable. And `SET LOCAL` survives to **transaction** end, not function end, so
one legitimate settlement would leave the bypass armed for every later payment
write in the same transaction.

Instead, migration 152 creates a dedicated `NOLOGIN` role,
`danat_deposit_sync`, owns the deposit trigger functions with it, and grants it
exactly the DML it needs on `payments`, `payment_allocations`, `receipts` and
`invoices` — nothing else. Inside a `SECURITY DEFINER` function, `current_user`
becomes the function's owner, so:

- `tg_payments_guard_deposit_provenance()` runs with **invoker rights** — it
  must observe the real `current_user`, and making it definer would only ever
  show it its own owner;
- it permits a `source_deposit_id` write only when
  `current_user = 'danat_deposit_sync'`;
- a direct PostgREST write still carries `current_user = 'authenticated'` and is
  refused.

Forging this needs membership in the role, which nothing grants. The role is
deliberately **not** an existing shared owner of unrelated SECURITY DEFINER
money functions — sharing one would silently authorise all of them to mutate
deposit-owned payments.

The forgery test must attempt `set_config('danat.deposit_sync', 'on', true)`
before its forged UPDATE, so that a future regression back to the token design
fails the suite instead of quietly passing.

This also replaces revision 2's "a guard in `reverse_payment`": a check inside
that one function leaves the direct-UPDATE path open.

**6. Seed `option_lists` code `kuwait_banks`** with the licensed Kuwaiti retail
banks and **verified** Arabic names — National Bank of Kuwait, Kuwait Finance
House, Burgan Bank, Gulf Bank, Commercial Bank of Kuwait, Al Ahli Bank of
Kuwait, Boubyan Bank, Warba Bank, Kuwait International Bank, Industrial Bank of
Kuwait; Ahli United Bank seeded `is_active = false` (merged into KFH), so
historical rows still resolve to a label. Idempotent
(`on conflict (list_id, value) do nothing`).

**7. CSV currency must agree with the new constraint.**
`bulkImportSchemas.ts:75` accepts any non-empty currency string while migration
152 will reject anything but KWD. Left alone, a CSV carrying `USD` turns a
per-row validation message into an all-rows database failure inside the batch
insert. The deposits import schema is narrowed to
`z.literal("KWD")` (defaulting when blank) so the rejection happens in preflight
with a row number, and `bulkImportTemplates.ts` documents the fixed value. This
is in scope even though CSV *linking* is not (D10) — it is the import's half of
a constraint this batch adds.

Gate: `bun run test:db` builds a clean database from scratch and applies the
whole set.

### Step 1.2 — SQL tests, `src/db/depositInvoiceLink.sqltest.ts`

Written **before** the UI so the trigger is proven independently of any form.
One test per acceptance criterion, plus:

- covering deposit → `paid`, one payment with `source_deposit_id`;
- short deposit → `partially_paid`, allocation equals the deposit amount;
- `confirmed` → `cancelled` → back to `due`/`overdue`, payment gone;
- cancel against an invoice paid by an unrelated payment → that payment survives
  and the invoice stays `paid`;
- **re-saving an unchanged confirmed deposit creates no second payment** — note
  this passes because the `WHEN` clause suppresses the trigger entirely, so it
  proves the guard, not the unique index;
- **editing a confirmed deposit's amount re-syncs its payment** — the allocation
  and the invoice state follow the new amount, and there is still exactly one
  payment. Same for `deposit_date` (payment date follows) and `deposit_type`
  (method follows). These are the cases revision 2's early return got wrong;
- **a genuine two-session concurrency test**: two connections confirm the same
  deposit, or two deposits against one invoice, concurrently. One commits, the
  other degrades to the `on conflict … do nothing` no-op or blocks on the
  advisory lock — never two payments and never an over-allocation. This needs
  two real `pg` clients, not two sequential queries on one;
- **provenance cannot be forged**: a direct
  `update public.payments set source_deposit_id = …` as an authenticated staff
  user raises `payment_provenance_locked`, and clearing it on a deposit-owned
  payment raises too;
- **an invoice carrying a reversed payment recomputes correctly** — the mirror
  allocation is not counted (this test fails against migration 129's expression,
  which is the point);
- two deposits on one invoice, one cancelled → the other's allocation survives;
- moving `invoice_id` while confirmed → old reverts, new settles;
- deleting a confirmed deposit → its invoice reverts and the delete succeeds;
- contract mismatch, terminal state, non-KWD currency, and
  `invoice_id` without `contract_id` all raise;
- an earlier unpaid invoice blocks the confirm;
- direct `reverse_payment` on a deposit payment raises;
- a settle and a revert each write an audit row;
- **budget/summary assertions** (D16): the payment appears in
  `get_payments_summary` collections while `get_budget_summary`'s `deposits`
  key stays 0;
- a raw `insert into deposits` with a link (no form involved) still syncs.

### Step 1.3 — Types and hooks

- `database.types.ts` by hand: `contract_id` / `invoice_id` on `DepositRow`,
  `source_deposit_id` on the payment row.
- `useContractInvoicesForDeposit(contractId)` in `src/hooks/useInvoices.ts` —
  every invoice on the contract, period ascending, no state filter, with a query
  key distinct from `["invoices","settleable",…]`.
- `useDeposits.ts`: carry `contract_id` / `invoice_id` through create and
  update, and **widen the invalidation** (N1) — deposit mutations currently
  invalidate deposits, budget and reports but not invoices, payments, payment
  summaries, receipts or contract-detail queries, all of which a settlement now
  changes.

### Step 1.4 — Extract `DepositFormDialog.tsx` (separate commit)

Move the dialog, its Zod schema, `emptyDeposit` and the local `Field` helper
into `src/components/admin/deposits/DepositFormDialog.tsx`, behaviour unchanged,
so the field additions that follow read as a diff rather than a move.
`clean-code-guard` runs before this commit.

### Step 1.5 — The form

- contract select first, reusing the entry shape
  `PaymentSidePanels.useContractDirectory` builds (`CODE — tenant name`);
  extracted to a shared hook if that is clean, otherwise a second call site with
  a comment saying why;
- invoice select second, from `useContractInvoicesForDeposit`, labelled
  `CODE (Month YYYY) — state`, disabled until a contract is chosen, cleared when
  the contract changes, with terminal-state and chronologically-blocked options
  **disabled** so D7's raise is normally unreachable;
- date, then bank as a `Select` over `mapCatalogueOptions(kuwait_banks)`, keeping
  an uncatalogued stored value selectable;
- currency: disabled input, schema `z.literal("KWD")`;
- a warning when the deposit amount and the invoice balance differ (D6);
- the save handler translates the trigger's raised codes —
  `deposit_invoice_contract_mismatch`, `deposit_invoice_terminal_state`, the
  chronological rejection, `payment_owned_by_deposit` — into toasts.

Deposits table: the bank column renders through
`useCatalogueLabel("kuwait_banks")`.

### Step 1.6 — i18n

New keys in **both** locales, Arabic first. Parity is test-enforced.

### Step 1.7 — Operational documentation

`db/README.md` gains the restore/backfill procedure from D1, naming **every**
trigger this batch adds — `deposits_sync_invoice_ins`,
`deposits_sync_invoice_upd`, `deposits_revert_on_delete` and
`payments_guard_deposit_provenance` — not just the first, which is what
revision 2 listed.

It also records what does **not** need the procedure: the app's own
`backup_restore` sets `session_replication_role = replica` (`146:405`) before
its delete/insert loop, so ordinary row triggers are already suppressed and a
restore through the Backup screen cannot re-create payments. The manual
disable is for an out-of-band `psql` data-only restore or a bulk `invoice_id`
backfill — the two cases nothing else covers.

`docs-guard` runs before this commit.
`TODO.md` records the two deferred items — `set_invoice_paid`'s
reversal-blind recompute (D4) and the importer's missing `deposit_type`.

---

## Feature 2 — Invoice period in the partial-payment dropdown

A local `invoicePeriodLabel(year, month)` in `RecordPanelDialog.tsx`, exported
for its test only, built from a fixed English month table (not `Intl`, so the
label cannot drift with runtime locale data), with an Arabic doc comment. No
out-of-range fallback — `period_month` is database-constrained to 1–12.
`PartialPaymentInvoiceField` renders `` `${invoice.code} (${label})` ``.

Test: the twelve months and the year passthrough.

---

## Feature 3 — Insurance relabel (one line)

`src/i18n/dictionary.ts:2574`: `"contracts.deposit"` becomes
`"Insurance (KWD)"`. Arabic is unchanged.

**Nothing is added to `ContractTabPanel`** — it already renders this field at
line 241. The same key labels the contract form at `ContractFormDialog.tsx:526`,
so both requested surfaces change from this one edit.

Grep the English dictionary for other strings naming the *contract's* insurance
and correct only those; leave every `deposits.*` string alone.

---

## Feature 4 — Shop card alignment and the row view

1. Recover: `git show c699dbf^:src/components/admin/landing-page/ShopsTable.tsx`.
2. In `ShopsTable.tsx`:
   - `ShopCard` — name to `text-lg`; `text-center` on the name block, secondary
     name, slug, contract label and hours.
   - Restore the table as `ShopRows`, keeping its columns and both actions, with
     `PreviewableImage` replacing the two raw `<img>` tags. **Do not restore the
     Arabic name duplication** — in Arabic the old markup rendered `name_ar` in
     both the Name and Arabic Name columns; show the active locale's name and
     the other language's.
   - A `Rows | Cards` toggle above the list, rows default, persisted with the
     repo's existing hydration-safe pattern (`useInvoicesLayoutTheme.ts:13-30`):
     default on both server and client, storage read in a `useEffect`. Not a
     `useState` initialiser — that avoids the server exception but still
     mismatches hydration when the stored value is `cards`. Radiogroup semantics
     with accessible labels.
3. Extend `ShopsTable.test.tsx`: default is rows, toggling shows cards, the
   choice survives a remount, and the Arabic name columns differ.
4. Only `ShopsTable.tsx` and its test are touched; the 1662-line route gains
   nothing.

---

## Step 5 — Full gate run

After the per-commit guards, run the whole set once more before the PR:
`bun run lint && bun run typecheck && bun run test && bun run test:sql`.
Red is fixed and both re-run; nothing moves on red.

---

## Step 6 — Production migration, then merge

The order is fixed: **the migration is applied to production before the code
merges**, because merging to `main` deploys the new bundle immediately and it
would otherwise run against the old schema.

Revision 1 said to apply it from Dokploy's checkout before the merge. That
cannot work: Dokploy clones `main` only when it builds, so a feature-branch push
never places the file on the server. The migration is therefore **transferred
explicitly**, which is also the owner's established practice:

1. `pg_dump` production over `ssh-danatfuture-mcp` — schema changes are not
   reversible. The dump exceeds the MCP call timeout, so wrap it as
   `nohup sh -c '… ; echo $? > /root/status.txt' &` and poll the status file.
2. Push the branch and open the PR (a branch push does not deploy).
3. Wait for the **CodeRabbit** review — the only reviewer that works on this
   repo. Read comment *bodies*, not the author list. Apply findings, re-run the
   matching guards and the gates, and push **follow-up commits** — not a
   force-push. Revision 1 planned a force-push; the Lovable rule makes ordinary
   commits the safer default and nothing here needs history rewritten.
4. Transfer `152_deposit_invoice_link.sql` to the server in base64 chunks (the
   SSH exec bridge caps a command at roughly 1 KB), reassemble, and **`md5sum`
   against the local file** — that checksum is the only thing proving production
   runs the same bytes `test:db` validated.
5. Apply it:
   `docker exec -i danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres --single-transaction -v ON_ERROR_STOP=1 -f - < /root/152.sql`.
   `--single-transaction` matters: `ON_ERROR_STOP` alone can leave half the
   columns, functions and triggers installed. `NOTICE` lines from
   `drop … if exists` are not errors — grep for `^ERROR` and trust the exit
   code.
6. `notify pgrst, 'reload schema'`, or PostgREST serves a stale signature cache
   and the new columns 404.
7. **Verify by exercising the behaviour, not by listing object names**: on a
   scratch contract, confirm a linked deposit, check the invoice flips to `paid`
   with one `source_deposit_id` payment, cancel it, check the invoice returns
   and the payment is gone, then delete the scratch rows.
8. Merge into `main`. **This deploys.**
9. `graphify update .`, then `verification-before-completion`.

Note that between steps 5 and 8 production runs the *old* bundle against the
*new* schema. That is safe: the old code never writes `contract_id` or
`invoice_id`, so the trigger's change guard makes it a no-op on every write it
performs.

## Owner decisions — taken 2026-08-21

Three decisions deviate from the literal request. All three were put to the
owner directly and answered; none is an open assumption.

| # | Decision | Literal request | **Owner's answer** |
|---|---|---|---|
| 1 | **D5** cancel semantics | "Cancelled → the invoice reverts to Unpaid" | **Leave it paid.** Cancelling removes only the payment the deposit created; an invoice paid by MyFatoorah or a manual mark stays paid. No conflict policy is built |
| 2 | **D10** CSV deposits | (not raised) | **Leave CSV unlinked.** Imported deposits stay bank-ledger-only; only form-created deposits link. CSV linking is a follow-up |
| 3 | **D17** link cardinality | "Each deposit connects to a single specific invoice" | **Optional link.** At most one invoice; an unreconciled deposit can still be recorded |

A fourth point Codex asked the owner to accept explicitly — that chronological
ordering remains a **settle-time admission check and not a persistent
invariant** — is a restatement of behaviour `set_invoice_paid` already has
(`129:103-116` unmarks an earlier invoice with no check), not a new limitation
this batch introduces. It is recorded here and in `TODO.md` rather than raised
as a decision, because refusing it would mean rewriting a live money function
that three other paths call.

## Risk register

| Risk | Mitigation |
|---|---|
| Double settlement from a re-saved deposit | Partial unique index on `source_deposit_id` + the trigger's change guard; SQL test |
| Concurrent confirmations overallocate | `for update` on the invoice; deterministic lock order for the chronological check |
| Reversed money counted as paid | Recompute joins `payments` and filters `status = 'confirmed'`; SQL test that fails against 129's expression |
| Deposit cancellation deletes gateway money | Payment located by `source_deposit_id`, never by tenant or reference; SQL test |
| Deposit-generated payment reversed behind the deposit's back | `reverse_payment` refuses it |
| SECURITY DEFINER helper called directly | No callable helper; logic inlined, revoked from `authenticated` too |
| Money committed without an audit row | `write_audit` inside the trigger, both branches |
| Receipt shows an unallocated payment | `html_snapshot` refreshed after allocating, as `apply_payment_allocation` does |
| Restore or backfill re-fires the trigger | Documented disable/enable procedure in `db/README.md` |
| Migration half-applied to production | `--single-transaction` |
| Migration never reaches the server | Explicit base64 transfer + `md5sum`, not Dokploy's checkout |
| Merge deploys before the migration lands | Step 6 orders the migration ahead of the merge |
| Non-KWD deposit produces a KWD payment | `check (currency = 'KWD')` in the database |
| Terminal invoice silently un-written-off | Terminal-state guard + disabled dropdown options |
| Hydration mismatch on the view toggle | Existing `useEffect` pattern, not a `useState` initialiser |
| Stale UI after a settlement | Widened query invalidation in `useDeposits` |
