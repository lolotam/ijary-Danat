# Deposit ↔ invoice linking, insurance relabel, and landing shop views

**Date:** 2026-08-21
**Branch:** `feat/deposit-invoice-linking-batch-aug21`
**Migrations:** `152_deposit_invoice_link.sql`, `153_deposit_settlement.sql`,
`154_kuwait_banks_catalogue.sql` — split by responsibility after review, because
one file came to 710 lines against the 500-600 ceiling. Apply all three together.
**Revision:** 3 — revision 2 rewrote the spec after Codex rejected revision 1; revision 3
folds in the owner's decisions on D5 / D10 / D17 and the plan-debate corrections.

Four independent user requests batched into one branch. They share no code, so
they are specified separately; only Feature 1 touches the money path and it is
the only one carrying schema, triggers or SQL tests.

> **Revision 2 changes.** Revision 1 was rejected with eleven blocking
> objections. The material corrections: the settlement is idempotent and keyed
> by an immutable `source_deposit_id` rather than a text reference (was B1/B2);
> the invoice recompute sums only *confirmed* payments, because the existing
> expression this spec meant to copy counts reversals as payments (B3); the
> settle helper is inlined into the trigger and callable by nobody (B4); the
> trigger writes its own audit row and refreshes the receipt (B5); CSV linking
> is **cut from scope** rather than promised (B6); the budget-policy change is
> stated and tested rather than filed under "out of scope" (B8); the production
> migration sequence is rewritten because the file cannot reach the server
> before the merge (B9); Feature 3's new field is **cut** because it already
> exists (B10); Feature 4 follows the repo's existing hydration-safe storage
> hook (B11).

---

## Feature 1 — Bank deposits become contract- and invoice-aware

### 1.1 What the user asked for

1. A bilingual Kuwaiti bank dropdown, manageable from Company Settings, feeding
   the Add Deposit form's bank field.
2. Currency locked to KWD — fixed, non-editable.
3. Contract selection **before** the deposit date and bank name, working the way
   the partial-payment dialog works.
4. Choosing a contract lists that contract's invoices — **paid and unpaid** —
   because the accountant may have marked the invoice paid before recording the
   deposit.
5. Each deposit connects to exactly one invoice.
6. Deposit status drives the linked invoice: `confirmed` → paid;
   `pending` / `cancelled` → unpaid; reversibly.

### 1.2 Current state

`public.deposits` (migration 08; `deposit_type` added in 106) has no
`contract_id` and no `invoice_id`, and nothing relates a deposit to an invoice.
`bank_name` is free text. `currency` is an editable input defaulting to `'KWD'`,
constrained by nothing.

Deposits are written from three places:

- the form's save → `useCreateDeposit` / `useUpdateDeposit` (direct PostgREST
  table writes),
- the attachment-preview dialog's delete → `useUpdateDeposit` again, re-sending
  the whole payload including `status` (`admin.deposits.tsx:462-490`),
- `bulk_import_phase6` (live definition
  `db/migrations/149_tenant_civil_ids_and_address.sql:83-89`), which inserts
  only `code, company_id, deposit_date, bank_name, amount, currency, note,
  status, created_by` — **no** `contract_id`, `invoice_id`, or even
  `deposit_type`.

Invoices reach `paid` through `set_invoice_paid` (live: migration 129), the
MyFatoorah webhook, and `paymentReconcileJob`. `apply_payment_allocation`
(`05_phase3_invoices_payments.sql:540-593`) is the canonical allocator: it
guards against exceeding the balance, recomputes the invoice, and refreshes the
receipt HTML after allocating.

Migration 106 deliberately detached deposits from budget math: *"bank deposits
are no longer summed into budget. Key `deposits` stays in the JSON as 0."*

### 1.3 Design decisions

**D1 — The sync is a trigger on `deposits`.**
Three client paths already write the table directly (§1.2) and an RPC would have
to be adopted by each of them. A trigger covers every path including any added
later. Migration 147 is cited only for the *shape* of the argument, not as a
money-moving precedent — 147 is explicitly inert, and this trigger is not. The
operational costs of a money-moving trigger are accepted with mitigations:

- **Restores and backfills.** `db/README.md` gains a documented procedure
  naming all four new triggers, to be disabled around an out-of-band `psql`
  data-only restore or a bulk `invoice_id` backfill. The app's own
  `backup_restore` needs no such step: it already sets
  `session_replication_role = replica` (`146:405`) before its delete/insert
  loop, so restoring through the Backup screen cannot re-create payments.
- **Bulk import.** Deposits imported from CSV are never linked (§D10), so the
  trigger is a no-op for them and cannot abort an import.

**D2 — Provenance is an immutable `payments.source_deposit_id`, not a text reference.**
Revision 1 tagged the payment `AUTO-DEP:<deposit code>`. A text reference is
mutable — editing the payment's reference, or the deposit's code, orphans the
link and cancellation can no longer find what to remove. Migration 152 adds
`payments.source_deposit_id uuid references public.deposits(id) on delete
restrict`, with a **partial unique index** on it. The unique index is what makes
settlement idempotent: a second attempt to settle the same deposit violates it
rather than creating a second payment.

`on delete restrict`, not cascade: deleting a deposit must not silently delete a
payment. The delete trigger reverts first, which removes the payment, and only
then is the deposit deletable.

The column is protected at the database boundary by
`tg_payments_guard_deposit_provenance`, an **invoker-rights** trigger that
admits a `source_deposit_id` write only when `current_user` is the dedicated
`NOLOGIN` role owning the deposit-sync functions. Staff hold direct INSERT and
UPDATE grants on `payments` (`05:145`, `05:198-203`), so without this they could
repoint or clear the link and orphan a settlement. An earlier draft used a
transaction-local GUC as the token; that was withdrawn because any SQL-capable
role can set it (`src/db/testDb.ts:71-81` does exactly that) and because
`SET LOCAL` persists to transaction end, leaving the bypass armed for every
later payment write in the same transaction.

**D3 — Settlement is idempotent, and the trigger fires only on real changes.**
Revision 1's dispatcher would double-settle: `update ... of status` fires
whenever the column is in the SET list, changed or not, and both the form save
and the attachment-delete resend the whole row. Two guards:

- the UPDATE trigger carries a `when` clause covering `status`, `invoice_id`,
  `amount`, `deposit_date` and `deposit_type` — the last two because they are
  copied into the payment, so omitting them would leave a settled payment with a
  stale date or instrument. INSERT and UPDATE are **separate triggers**: a
  combined `after insert or update … when (… old … )` is invalid SQL, since an
  INSERT trigger has no `OLD`, and would have failed at migration time;
- an edit to a confirmed deposit **re-syncs** rather than returning early, and
  does so revert-first — the invoice's balance already reflects the deposit's own
  allocation, so capping against it before removing it would read zero;
- the partial unique index on `payments.source_deposit_id` turns a lost race into
  an `on conflict … do nothing` no-op instead of a duplicate payment.

**D4 — The invoice is recomputed from *confirmed* payments only.**
Revision 1 copied migration 129's `sum(payment_allocations.amount)`. That
expression is wrong in this schema: `reverse_payment`
(`05_phase3_invoices_payments.sql:663`) inserts a **positive** mirror allocation
row on the reversal payment, so a raw sum counts reversed money as paid. The
recompute is:

```sql
select coalesce(sum(pa.amount), 0)
from public.payment_allocations pa
join public.payments p on p.id = pa.payment_id
where pa.invoice_id = <id> and p.status = 'confirmed'
```

Both the original and its reversal carry `status = 'reversed'`, so they net to
zero. **This is a pre-existing latent bug in `set_invoice_paid`;** fixing 129 is
out of scope for this batch but is recorded in `TODO.md`.

**D5 — Reverting a deposit undoes only what that deposit did.**
`pending` / `cancelled` deletes that deposit's own payment (receipt →
allocation → payment, the order migration 129 uses, because
`receipts.payment_id` is `on delete restrict`) and recomputes. If the invoice
was already settled by a gateway payment or a manual mark, the deposit created
nothing, so cancelling it removes nothing and the invoice stays paid.

> **Owner decision, taken 2026-08-21: confirmed.** The literal request —
> "Pending Review or Cancelled → the invoice reverts to Unpaid" — read literally
> would delete gateway money the deposit never created. The owner was shown all
> three options (leave it paid / block the cancellation / force it unpaid) and
> chose **leave it paid**. This is no longer an assumption.

**D6 — A confirmed deposit allocates `min(deposit.amount, invoice.balance)`, and the payment equals the allocation.**
Codex argued the payment should equal the full deposit amount, with the surplus
left as an unallocated credit, so a 700 KWD deposit against a 500 KWD balance
does not "lose" 200 KWD from collections. This spec keeps payment = allocation,
for a domain reason: a **bank** deposit commonly aggregates several tenants'
rent into one slip, so the surplus is not necessarily this tenant's money.
Booking it as this tenant's credit fabricates a different thing than
over-settling does. The full 700 remains visible and reported by
`get_deposits_summary` on `/admin/deposits`, which is the ledger that owns it.

The invoice state derives exactly as `apply_payment_allocation` derives it. Two
consequences stated plainly:

- a deposit covering the whole balance produces `paid` — the requested
  behaviour;
- a deposit **short** of the balance produces `partially_paid`, not `paid`. The
  acceptance criteria say so; revision 1 contradicted itself here.

The form warns when the deposit amount and the invoice balance differ, before
saving.

**D7 — Chronological order is enforced in the database and pre-flighted in the UI.**
The trigger applies `set_invoice_paid`'s rule (no earlier `due`/`overdue`/
`partially_paid` invoice on the same contract) and raises, aborting the write.
Because the deposit form settles one row at a time, the raise surfaces as a
toast naming the blocking invoice. The invoice dropdown additionally **disables**
options that the rule would reject, so the error is normally unreachable rather
than merely handled.

**D8 — The settle logic lives inside the trigger function; nothing new is callable by `authenticated`.**
Revision 1 planned `settle_deposit_invoice(...)` granted to `authenticated` with
no internal permission check — a tenant with a leaked deposit UUID could have
called it with `p_settle => false` and deleted receipts, allocations and
payments through SECURITY DEFINER rights. There is no separate callable helper.
The trigger function is SECURITY DEFINER (necessary: `deposits.update` and
`invoices.update` are different permissions — `08:135` vs the invoice policies —
and under invoker rights RLS would skip the invoice UPDATE **silently**, which
migration 147's header calls the worst possible outcome) and is revoked from
`public`, `anon` **and** `authenticated`. A trigger function needs no EXECUTE
grant to the writing user.

**Recorded consequence:** holding `deposits.create` / `deposits.update` now
transitively authorises creating and removing real payments. That is the
feature the owner asked for; it is stated here so the permission model is not
widened by accident.

**D9 — The trigger writes its own audit row and refreshes the receipt.**
CLAUDE.md's rule — multi-table money must not commit without its audit row, the
reason `close_out_contract` and `erase_all_data` call `write_audit` from inside
SQL — applies here: the trigger touches deposits, payments, allocations,
receipts and invoices. Client-side audit runs after the transaction and is
absent entirely for a raw PostgREST write. The trigger calls `write_audit` with
actions `deposit.invoice.settle` / `deposit.invoice.revert`.

A confirmed payment gets its receipt from a trigger *before* the allocation
exists (`05:463`); `apply_payment_allocation` refreshes `html_snapshot`
afterwards (`05:589`). This trigger does the same, or the receipt shows an
unallocated payment.

**D10 — CSV import stays unlinked. Cut from scope. (Owner decision, 2026-08-21: confirmed.)**
Linking a deposit from a CSV would require four coordinated changes — the
template (`bulkImportTemplates.ts:23`), the Zod schema
(`bulkImportSchemas.ts:69`), server-side resolution of contract/invoice *codes*
to UUIDs, and the `bulk_import_phase6` insert list. None exist. Revision 1's
acceptance criterion promising CSV-imported deposits would sync was
unimplementable, and is **removed**. Imported deposits remain unlinked, exactly
as today. (The importer also still drops `deposit_type`, a pre-existing gap from
migration 106 — noted in `TODO.md`, not fixed here.)

**D11 — The link is both-null-or-both-present, and terminal invoice states are refused.**
- `check ((contract_id is null) = (invoice_id is null))` on `deposits`, so an
  `invoice_id` cannot arrive without the `contract_id` the mismatch check needs.
- The guard raises `deposit_invoice_contract_mismatch` when the invoice's
  contract differs.
- The trigger refuses to settle an invoice in a terminal state
  (`cancelled`, `waived`) — both can carry a positive balance, and settling a
  written-off invoice would silently un-write-off it. The dropdown lists them,
  greyed and unselectable, so the accountant can see they exist.
- A revert never overwrites a terminal state; it recomputes only from
  `due` / `overdue` / `partially_paid` / `paid`.

**D12 — Currency is locked in the database, not only in the form.**
`check (currency = 'KWD')` on `deposits`. A form-only lock leaves the table and
the CSV importer accepting any currency, and a USD deposit would then produce a
KWD payment.

Verified against production on 2026-08-21 over `ssh-danatfuture-mcp`:
`public.deposits` holds **0 rows** (742 invoices, 210 payments, 15 contracts).
So this constraint, the both-null-or-both-present check (D11) and the new
columns all apply to an empty table — there is no backfill question and no
existing row can be rejected. `option_lists` holds thirteen codes and
`kuwait_banks` is not among them, so the seed is purely additive.

**D13 — The payment's method mirrors the deposit's instrument.**
`deposit_type` `cash` → `payment_methods` `cash`; `cheque` → `cheque`. Revision 1
hardcoded `bank_transfer`, discarding what the accountant recorded.

**D14 — The bank catalogue is an `option_lists` entry, code `kuwait_banks`.**
No new table: `option_lists` / `option_list_items` (migration 13) already give
bilingual labels, `sort_order`, an `is_active` toggle and an admin screen at
Settings → Lists. Because `bank_name` is free text and not a Postgres enum, the
dropdown uses `mapCatalogueOptions` / `useCatalogueLabel` (the migration
99/101/103 pattern), **not** `useListDrivenOptions`, which filters against an
enum's allowed values and would return nothing here.

The stored `value` is the English bank name. A legacy deposit whose `bank_name`
is not in the catalogue keeps rendering its raw stored value through
`catalogueLabelFor`'s final fallback and stays selectable, so editing an old
deposit does not silently rewrite its bank.

Ahli United Bank (Kuwait) merged into Kuwait Finance House and is seeded
`is_active = false` rather than omitted, so historical deposits naming it still
resolve to a label. The catalogue is admin-editable precisely so this stays
correctable without a migration.

**D15 — The sync is one-directional: deposit → invoice.**
No reverse trigger. Codex's related point stands and is handled instead by
guarding the payment: `reverse_payment` is blocked for a payment carrying a
`source_deposit_id`, with a message directing the operator to change the
deposit's status. Otherwise reversing the payment would reopen the invoice while
the deposit still read `confirmed` — a state the UI could not explain.

**D16 — Budget impact is a stated policy change, not "out of scope".**
Migration 106 made bank deposits ledger-only. A confirmed, linked deposit now
creates an ordinary confirmed payment, which **does** enter
`get_payments_summary` collections and the budget's net. This is the intended
consequence of the owner's request — the deposit is now the record of rent
actually collected. The deposits ledger itself stays at 0 in
`get_budget_summary`, so there is no double count, and the
`min(amount, balance)` cap means allocations can never exceed an invoice total.
Acceptance criteria and SQL tests cover budget, payment summary, and the
reversal interaction.

**D17 — `contract_id` / `invoice_id` are nullable. (Owner decision, 2026-08-21: optional link confirmed.)**
Every production deposit has neither. "Each deposit connects to a single
specific invoice" is implemented as *at most one*: a deposit links to one
invoice or to none. Requiring a link would make every existing row invalid and
would forbid recording a bank deposit that is not yet reconciled — which is the
normal state of a deposit on the day it is entered.

**D18 — The deposit's invoice dropdown gets its own hook.**
`useSettleableInvoices` narrows to unpaid, settleable invoices and feeds the
partial-payment dialog, where that narrowing is the point. Deposits get
`useContractInvoicesForDeposit`, listing every invoice on the contract in period
order regardless of state, each labelled with its state.

### 1.4 Behaviour specification

**Form order**, matching the partial-payment dialog:

1. Contract — optional; clearing it clears the invoice
2. Invoice — enabled once a contract is chosen; terminal-state and
   chronologically-blocked options are disabled
3. Deposit date
4. Bank name (dropdown, `kuwait_banks`)
5. Amount
6. Currency — disabled, always `KWD`
7. Deposit type
8. Status
9. Attachment, notes

**Status → invoice matrix.** Deposit D linked to invoice I:

| Transition | Effect on I |
|---|---|
| → `confirmed` | insert payment `source_deposit_id = D.id`, amount `min(D.amount, I.balance)`, method from `D.deposit_type`, allocate it, refresh the receipt, recompute I |
| `confirmed` → `pending` / `cancelled` | delete D's payment (receipt → allocation → payment), recompute I |
| `pending` → `cancelled` | no-op |
| `invoice_id` changed while `confirmed` | revert the old invoice, settle the new one |
| D deleted | revert first, then the delete proceeds |
| D `confirmed`, I already fully paid | no payment created; I stays `paid` |
| D re-saved unchanged | no-op (D3) |
| I is `cancelled` / `waived` | raises; the option was disabled in the UI |

Every branch writes an audit row.

### 1.5 Out of scope

- Fixing `set_invoice_paid`'s reversal-blind recompute (D4) — recorded in
  `TODO.md`.
- CSV import linking (D10), and the importer's missing `deposit_type`.
- Multi-invoice deposits; reverse sync; backfilling existing deposits.

---

## Feature 2 — Invoice period in the partial-payment dropdown

`PartialPaymentInvoiceField` (`RecordPanelDialog.tsx:56-79`) renders
`invoice.code` alone. Each option gains its period in brackets:

```
INV-000123 (January 2026)
```

`SettleableInvoiceOption` already carries `period_year` / `period_month`; no
query changes.

**Assumption.** The request says "the day, the month, and the year", but every
worked example is `January 2026` and the stated purpose is *"so I can easily see
which month the invoice belongs to."* An invoice has a billing period, not a
day. Month-and-year is implemented.

**Assumption.** "Write the month in English letters" applies in **both** locales
per the explicit instruction — the Arabic UI shows `(January 2026)` too. The name
comes from a fixed English month table, not `Intl.DateTimeFormat`, so the label
cannot drift with the runtime's locale data.

The helper is a local function in `RecordPanelDialog.tsx`, exported for its unit
test only — Codex is right that a new shared module for one label is
overengineering until a second consumer exists. `period_month` is
database-constrained to 1–12, so no out-of-range fallback is written.

---

## Feature 3 — "Deposit" becomes "Insurance" on the contract

**Reduced to a one-line change.** The Contract Details tab **already** renders
this field: `ContractTabPanel.tsx:241-244` shows `t("contracts.deposit")` with
`formatAmount(contract.deposit ?? 0, locale)`. Revision 1 proposed adding it,
which would have produced two identical fields.

What remains:

- `src/i18n/dictionary.ts:2574`: `"contracts.deposit": "Deposit (KWD)"` becomes
  `"Insurance (KWD)"`. Arabic is already `"التأمين (د.ك)"` and is unchanged.
- The same key labels the contract form's field
  (`ContractFormDialog.tsx:526`), so the form relabels from the same edit —
  which is request 3.1.
- The column stays `contracts.deposit` in the database and in every type.

**Decision — the displayed value stays `contract.deposit`.**
Codex asks whether this should be the *contractual* insurance or the *currently
held* insurance, noting closeout treats `insurance_payments.amount` as
authoritative. The Contract Details tab describes the contract's own terms, and
the field it already renders is the contract's column; changing its meaning
while relabelling it would be two changes disguised as one. The Insurance tab
remains where the held holding is seen. Only the label changes.

English strings naming bank deposits (`deposits.*`) are untouched;
`closeout.depositHeldHint` already reads "insurance record".

---

## Feature 4 — Landing-page shop card: alignment, and the row view restored

Scope: **Company Settings → Public Landing Page Settings → Shops tab** — the
admin screen `ShopsTable.tsx`, rendered from `admin.settings.landing-page.tsx`
line 1136. Not the public landing page.

### 4.1 Card alignment

In `ShopCard`, below the logo/cover pair: the primary name grows to `text-lg`,
and the name, secondary-language name, slug, contract label and opening hours
are `text-center` — a non-directional class, identical in RTL and LTR — so the
block reads as one centred stack.

### 4.2 Row view restored, and made the default

Commit `c699dbf` replaced the shops table with a card grid; the markup is
recovered from
`git show c699dbf^:src/components/admin/landing-page/ShopsTable.tsx` and reused.

- A `Rows | Cards` toggle above the list, **rows default**.
- The choice persists in `localStorage` via the repo's existing hydration-safe
  pattern (`useInvoicesLayoutTheme.ts:13-30`): both server and client render the
  default first, and storage is read in a `useEffect`. A `typeof window` guard in
  a `useState` initialiser would avoid the server exception but still produce a
  hydration mismatch when the stored value is `cards`.
- The toggle uses radiogroup semantics with `aria-pressed` and accessible
  labels.
- The restored table keeps its columns and both actions, and its two raw `<img>`
  tags become `PreviewableImage` so rows gain the eye overlay the cards have.
- **The old Arabic duplication is not restored.** The recovered markup rendered
  `name_ar` in both the "Name" and "Arabic Name" columns when the locale was
  Arabic. The restored table shows the active locale's name and the other
  language's name. Restoring the structure does not mean restoring the bug.
- The featured indicator stays a gold dot — an indicator, not an action.

**Assumption.** Only the **shops** tab is restored. `c699dbf` also converted
slides and gallery; the request names the shop card, so those keep their cards.

Everything lives in `ShopsTable.tsx`; the 1662-line landing-page route gains
nothing.

---

## Cross-cutting constraints

- **Migration 152**, verified by `bun run test:db` (clean database from
  scratch), applied to production with `--single-transaction` so a failure
  cannot leave half the columns, functions and triggers installed.
- **The migration must reach production before the code deploys**, and a feature
  branch push does not put it on the server — Dokploy only clones `main`. The
  sequence is in the plan.
- **New SECURITY DEFINER functions are revoked from `public`, `anon` and
  `authenticated`**; `src/db/anonExecute.sqltest.ts` catches only the first two.
- **`database.types.ts` is hand-maintained** — new columns added by hand.
- **i18n parity is test-enforced** — every key in both locales.
- **`admin.deposits.tsx` is 668 lines**; the form dialog is extracted as part of
  this work, per the CLAUDE.md ceiling rule for a file already being edited.
- Every new function carries an Arabic doc comment above it.

## Acceptance criteria

1. Add Deposit shows Contract → Invoice → Date → Bank (dropdown) → Amount →
   Currency (disabled `KWD`) in that order.
2. The bank list is editable from Settings → Lists in both languages; an item
   toggled inactive disappears from the form.
3. Selecting a contract lists all of its invoices, paid ones included, each
   showing its state; terminal and chronologically-blocked ones are disabled.
4. A `confirmed` deposit whose amount **covers** the balance settles it: the
   invoice reads `paid` and one payment exists with `source_deposit_id` set.
5. A `confirmed` deposit **short** of the balance leaves the invoice
   `partially_paid` with an allocation equal to the deposit amount — no money is
   fabricated.
6. Switching that deposit to `pending` or `cancelled` returns the invoice to
   `due` / `overdue` and removes the deposit's payment.
7. Saving the same confirmed deposit twice creates exactly one payment.
8. Cancelling a deposit against an invoice already paid by other means leaves
   that invoice `paid` and deletes nothing else.
9. An invoice with a reversed payment recomputes correctly — the reversal's
   mirror allocation is not counted as paid.
10. Settling a `cancelled` or `waived` invoice is refused.
11. A deposit in a currency other than KWD cannot be inserted.
12. Every settle and revert writes an audit row, and the receipt reflects the
    allocation.
13. Reversing a deposit-generated payment directly is refused.
14. A confirmed linked deposit's payment appears in `get_payments_summary`
    collections, while `get_budget_summary`'s `deposits` key stays 0.
15. The partial-payment invoice dropdown reads `CODE (Month YYYY)` in both
    locales.
16. The contract form and Contract Details tab both read "Insurance (KWD)" in
    English, with no duplicated field.
17. The Shops tab opens in row view, toggles to cards, remembers the choice
    without a hydration mismatch, and the card's names and hours are centred and
    larger.
18. `bun run lint`, `typecheck`, `test`, `test:sql` all pass.
