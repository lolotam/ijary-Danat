# Payments ordering, partial-payment settlement, and Resend sender identity

**Date:** 2026-08-24
**Branch:** `feat/payments-ordering-partials-resend-sender`
**Status:** draft — pending Codex adversarial review

---

## 0. Three premises in the request that the code contradicts

These are stated up front because the rest of the spec is written against the
real code, not the request's description of it.

1. **There is no `/admin/payments/add` route.** "Add Payment" is a `<Dialog>`
   inside `src/routes/admin.payments.tsx` (dialog at 652–892, opened from the
   button at 415–426). Everything the request calls "the Add Payment page" is
   that dialog.

2. **There is no `?tab=delivery` search param.** `admin.settings.notifications.tsx`
   uses plain shadcn `<Tabs defaultValue>` with no `validateSearch` (61–63). The
   outer tab's value is `providers`, labelled "Delivery providers"
   (`dictionary.ts:3501`). Navigating to `?tab=delivery` does nothing today.
   This spec does **not** add URL-param tab sync — out of scope.

3. **`partial_payments` is a deliberately inert ledger, and making it settle
   invoices overturns a documented, tested invariant.** Migration
   `147_partial_payment_status.sql` states it plainly:

   > `partial_payments` stays inert: excluded from `get_budget_summary`,
   > allocating against nothing, changing no invoice balance. `refunds.sqltest.ts`
   > asserts exactly that and is the guard against this migration drifting into
   > the money path. **A status column describes a row; it must never move money.**

   `src/db/refunds.sqltest.ts:186` — `describe("partial payments are inert")` —
   enforces it, and `get_budget_summary` (106:107) and `get_payments_overview`
   (106:209) both exclude the table by name.

   **This spec deliberately overturns that invariant.** The justification is in
   §2.1: the repo has already performed this exact inversion once, for deposits,
   in migration `153_deposit_settlement.sql`, whose header names migration 147 as
   the thing it is inverting. This is a repeat of a decision already taken, not a
   new architectural direction.

---

## 1. Problem statement

### 1.1 Full-payment dialog — no ordering enforcement, unreadable invoice rows

The tenant portal refuses to let a tenant pay February while January is open. It
enforces this in three layers: `evaluate_portal_payable_invoices`
(`121_portal_payable_by_contract.sql:39`) computes `sequence_order`,
`is_selectable` and a bilingual `lock_reason`; `portal.invoices.tsx:131-146`
disables the checkbox; and `createPayment.ts:266-302` re-checks the prefix
server-side.

The admin Add Payment dialog has **none** of this. `settleableInvoices`
(`src/lib/invoiceSettlement.ts:30`) sorts oldest-first and the seeding effect
(`admin.payments.tsx:257-265`) pre-ticks the oldest invoice, but every checkbox
is independently clickable: an admin can tick March alone and leave January open.
`createPayment`'s `invoiceSelection` guard runs only on the portal RPC path.

Separately, each row prints the period as a bare number over two lines:

```jsx
<p className="font-medium">{invoice.code}</p>
<p className="text-xs text-muted-foreground">
  {invoice.period_month}/{invoice.period_year} — {t("invoices.balance")}: …
</p>
```

`1/2026` rather than `January 2026`, and the balance wraps below the code.

### 1.2 Partial-payment dialog — narrow, uncapped, and it moves no money

`RecordPanelDialog.tsx:143` renders `<DialogContent>` with **no className**, so
it falls back to `max-w-lg` (`ui/dialog.tsx:48`). The contract `<Select>` holds
`{code} — {tenant name}`, which overflows. (Add Payment, for contrast, uses
`max-w-2xl`.)

The amount input (`RecordPanelDialog.tsx:189-198`) is a raw `useState<string>`
with no form library, no Zod schema, and validation limited to
`PaymentSidePanels.tsx:245-249`:

```js
if (!Number.isFinite(value) || value <= 0) { toast.error(…); return; }
```

No `max`, no comparison against the linked invoice, no DB check constraint. A
5,000 KD partial against a 500 KD invoice is accepted today.

And the invoice never becomes `paid`, because nothing connects the two. The only
trigger runs the **opposite** direction — `tg_partial_payments_sync_status`
(147) fires `AFTER UPDATE OF state ON invoices` and pushes the invoice's state
down onto its partials. The partial-payment write is a direct client-side
PostgREST insert (`useRefunds.ts:85-110`); there is no server fn.

**Confirmed against production**, invoice `INV-0003085`:

|                            |                                     |
| -------------------------- | ----------------------------------- |
| `invoices.total`           | 1350.000                            |
| `invoices.paid`            | 0.000                               |
| `invoices.balance`         | 1350.000                            |
| `invoices.state`           | `overdue`                           |
| `partial_payments` rows    | 1 × 1175.000, `status = incomplete` |
| `payment_allocations` rows | **0**                               |

The 1,175 KD exists only as a note. Only two paths ever flip an invoice to
`paid`: `apply_payment_allocation` (`05_phase3_invoices_payments.sql:495-595`)
and `set_invoice_paid` (`159_manual_payment_method.sql:78`). Neither is reachable
from the partial-payment dialog.

> **Note on the reported test.** The request describes creating _two_ partial
> payments totalling the invoice. Production holds only one row (1,175 against a
> 1,350 invoice). Either the second was deleted, or it errored. The spec does not
> depend on which, but the backfill in §2.4 covers only rows that actually exist.

### 1.3 Resend card — one field, and it is the name of an env var

`ProviderConfigCard.tsx` renders whatever `PROVIDER_CONFIG_SHAPE` declares. For
Resend that is one entry (`configValidation.ts:27-30`):

```ts
resend: { required: { secret_env: "RESEND_API_KEY" }, optional: {} },
```

So the card shows a single text input holding an **env-var name** — never a
credential (enforced by `provider_configs_secret_references_only`, migration
07:44-63, and mirrored client-side by `validateProviderConfig`).

There are two disjoint sender paths:

| Path                                                      | `from` source                                                   | Has a UI?                              |
| --------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| Mailbox compose — `resendMailboxSend.ts:139-164`          | user-picked, validated against the `resend_senders` option list | yes — `GmailComposeDialog.tsx:164-183` |
| Notification dispatch — `dispatchNotification.ts:231-235` | `config.from_email ?? process.env.RESEND_FROM`                  | **no**                                 |

`provider_configs.from_email` is a real column (migration 07:38, types at
`database.types.ts:838`) that **no UI writes**. That is the gap: automatic
notifications fall back to `RESEND_FROM` and cannot be changed without a deploy.

The `resend_senders` catalogue already exists in production with five verified
addresses (`no-reply@`, `management@`, `ceo@`, `ahmed@`, `islam@`
`danat-future.com`), seeded by `158_mailbox_provider.sql:71-111` and editable at
Settings → Lists without a deploy.

Emails carry **no logo**. `wrapLayout` (`emailTemplates.ts:26-77`) draws a
text-only header from a hardcoded `BRAND` constant (10–18) that never reads
`companies.logo_url`.

---

## 2. Design

### 2.1 The inversion, and why it is allowed

Migration `153_deposit_settlement.sql` did this exact thing to `deposits`, and
its header explains the move in terms of migration 147:

> **WHAT MAKES THIS DIFFERENT FROM MIGRATION 147**
> 147 gave `partial_payments` a status derived FROM the invoice and said plainly
> that "a status column describes a row; it must never move money". This runs the
> other way: the deposit's status DRIVES the invoice. Every guard here exists
> because of that inversion.

Every guard 153 installs for deposits transfers to partial payments unchanged:
`current_user`-based provenance (not a forgeable GUC), a real FK column with a
partial unique index (not a mutable text reference), a contract-scoped advisory
lock, `for update` before the aggregate, and a recompute that sums only
allocations belonging to a **`confirmed`** payment.

That last point is not optional. `reverse_payment` (05:663) writes a _positive_
mirror allocation on the reversal payment, so a raw `sum(payment_allocations.amount)`
counts reversed money as paid. `recompute_invoice_from_confirmed` joins to
`payments` and filters `p.status = 'confirmed'`; both the original and its mirror
are `reversed`, so they net out. **The new function reuses
`recompute_invoice_from_confirmed` rather than copying 129's arithmetic.**

### 2.2 Where partial payments deviate from the deposit blueprint

Three deliberate differences. Codex should attack these specifically.

| #   | Deposits (153)                                           | Partial payments (this spec)                                                                  | Why                                                                                                                                                                                                               |
| --- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `least(deposit.amount, invoice.balance)` — silently caps | `raise exception 'partial_payment_exceeds_balance'`                                           | The request asks for over-entry to be _impossible_. Silently booking less than the admin typed would make the ledger row and the allocation disagree.                                                             |
| D2  | Settles on `status = 'confirmed'`                        | Settles on **INSERT**, unconditionally when `invoice_id is not null`                          | `partial_payments` has no confirmation step. Its `status` is derived _from_ the invoice (147) and stays that way.                                                                                                 |
| D3  | `revert_deposit_settlement` on un-confirm and on delete  | Revert on **DELETE only**; `UPDATE` of `amount`/`invoice_id` on a settled row is **rejected** | User decision (§2.7). Fewer states, no partial-revert window. **Superseded by** `2026-09-07-partial-payment-edit-and-invoice-breakdown-design.md` (D3′): editing a settled partial re-syncs rather than refusing. |

D2 has a consequence worth stating: a partial payment with `invoice_id is null`
(the free-standing note the panel still allows) settles nothing and stays inert,
exactly as today.

### 2.3 New SQL — migration 160

`db/migrations/160_partial_payment_settlement.sql`. Numbering: 159 is the current
highest (`ls db/migrations | sort -V | tail -1`).

**1. Provenance column**

```sql
alter table public.payments
  add column if not exists source_partial_payment_id uuid
  references public.partial_payments(id) on delete restrict;

create unique index if not exists payments_source_partial_payment_uidx
  on public.payments (source_partial_payment_id)
  where source_partial_payment_id is not null;
```

`on delete restrict` mirrors `payments_source_deposit_id_fkey`. The delete path
(§2.3.4) removes the payment before the ledger row, so the restrict never fires
in normal operation — it is there to make an out-of-band delete fail loudly
rather than orphan money.

**2. Provenance guard** — extend `tg_payments_guard_deposit_provenance` to cover
the new column, or add a sibling trigger. Staff hold direct INSERT/UPDATE grants
on `payments` (05:145, 05:198), so without this a client connection could point
`source_partial_payment_id` at another tenant's ledger row, clear it to orphan a
settlement, or flip a partial-owned payment to `reversed` behind the ledger's
back. The test is `current_user in ('authenticated','anon','service_role')`,
**not** a GUC — a transaction-local flag is forgeable and `SET LOCAL` survives to
commit, leaving the bypass armed (153's own reasoning).

**3. `apply_partial_payment_settlement(p_partial_payment_id uuid) returns uuid`**

SECURITY DEFINER, `set search_path = public`, refusing the three client roles.
Mirrors `apply_deposit_settlement` step for step:

1. Load the row; return `null` when `invoice_id is null`.
2. Read the contract **from the invoice**, then
   `pg_advisory_xact_lock(hashtextextended(contract_id::text, 0))` — serialise on
   the contract _before_ touching any invoice, so two partials on the same
   contract cannot interleave between the chronological check and the write.
   **Same lock key as `apply_deposit_settlement`**, so a deposit and a partial on
   one contract serialise against each other too.

   > The key must come from `invoices.contract_id`, not
   > `partial_payments.contract_id`. Deposits carries
   > `deposits_contract_invoice_paired CHECK ((contract_id IS NULL) = (invoice_id
IS NULL))`, so its own column is never null when an invoice is named.
   > `partial_payments` has **no** such constraint — only `amount_check` and
   > `status_check` — and `tg_partial_payments_link_guard` (151:44) validates
   > `contract_id` only `if new.contract_id is not null`. A row naming an invoice
   > with a null `contract_id` is therefore reachable, and keying the lock off
   > that column would let two writers on one contract take different keys and
   > never serialise — which is exactly the race the cap in step 5 depends on
   > losing. `invoices.contract_id` is `NOT NULL`.

3. `select … from invoices where id = … for update`.
4. Reject `state in ('cancelled','waived')` → `partial_payment_invoice_terminal_state`.
5. **Reject `amount > invoice.balance`** → `partial_payment_exceeds_balance`
   (deviation D1). This is the real cap; the client `max` is UX only.
6. Chronological admission check, character-for-character the one
   `set_invoice_paid` applies (159:118-129) and `apply_deposit_settlement`
   repeats — same contract, earlier `(period_year, period_month)`, `balance > 0`,
   `state in ('due','overdue','partially_paid')` →
   `partial_payment_invoice_out_of_order`.
7. Insert `payments` (`method = 'cash'`, `account_type = 'commercial_account'`,
   `payment_date = paid_date`, `reference = null`,
   `status = 'confirmed'`, `source_partial_payment_id = p_partial_payment_id`)
   with `on conflict (source_partial_payment_id) where source_partial_payment_id
is not null do nothing … returning id`. A null return means a concurrent
   transaction already settled this row — return early rather than
   double-allocate.
8. Insert `payment_allocations (payment_id, invoice_id, amount)`.
9. Refresh the receipt snapshot: `update receipts set html_snapshot =
receipt_html_for_payment(v_payment_id) where payment_id = v_payment_id`. The
   receipt trigger fires on the payment INSERT, _before_ the allocation exists
   (05:463), so its snapshot would otherwise show an unallocated payment.
10. `perform recompute_invoice_from_confirmed(invoice_id)`.

> `partial_payments` has no `code` column. Step 7 uses
> `'Partial payment ' || p_partial_payment_id` for the note and leaves
> `reference` null, rather than inventing a code sequence. **Open for Codex:**
> whether to add `partial_payments.code` with a `next_*_code()` default for
> operator legibility, or keep it out of scope.

**4. Revert, split across two triggers**

`revert_deposit_settlement` does the deletes _and_ the recompute in one call.
Copying that shape here **deadlocks against the delete being performed**, and the
deposit blueprint gives no warning because deposits cannot hit it.

The chain: `delete from partial_payments` → BEFORE DELETE → revert → the invoice
goes `paid` → `partially_paid` → `partial_payments_sync_status` fires (147:95,
`AFTER UPDATE OF state ON invoices`) → `update partial_payments set status =
'incomplete' where invoice_id = … and status <> 'incomplete'` → **that predicate
matches the row currently being deleted**, which still exists inside its own
BEFORE trigger. Postgres raises `tuple to be deleted was already modified by an
operation triggered by the current command`.

Deposits is immune because `sync_status` writes `partial_payments`, never
`deposits`. The hazard is specific to this table, and it fires in exactly the
headline case: two partials settle an invoice in full, then one is deleted.

So the revert splits:

- `revert_partial_payment_settlement(p_partial_payment_id)` — deletes the
  receipt, the allocation and the payment. **No recompute.** This is all the FK's
  `on delete restrict` needs satisfied before the row goes.
- `recompute_invoice_from_confirmed(invoice_id)` runs from an **AFTER DELETE**
  trigger, by which point the ledger row is gone and `sync_status` finds nothing
  to update.

**5. Triggers on `partial_payments`**

- `AFTER INSERT … WHEN (new.invoice_id is not null)` → `apply_partial_payment_settlement(new.id)`.
- `BEFORE DELETE` → `revert_partial_payment_settlement(old.id)` (deletes only).
- `AFTER DELETE … WHEN (old.invoice_id is not null)` → `recompute_invoice_from_confirmed(old.invoice_id)`.
- `BEFORE UPDATE OF amount, invoice_id` → if a payment with
  `source_partial_payment_id = old.id` exists and either column changed,
  `raise exception 'partial_payment_settled_immutable'` (deviation D3).

**Deleting the invoice itself needs no new handling.** `partial_payments.invoice_id`
is `on delete set null` — an UPDATE of `invoice_id`, which does reach the
immutability trigger. But an invoice carrying a settlement cannot be deleted at
all: `payment_allocations_invoice_id_fkey` is `on delete restrict`, the same wall
a deposit-settled invoice already hits. The trigger changes which error surfaces,
never whether the delete succeeds. For an unsettled partial the `exists(…)` is
false and the SET NULL proceeds.

This is also why `partial_payments` must **not** gain the
`(contract_id is null) = (invoice_id is null)` check that deposits carries.
`tg_invoices_unlink_deposits` exists solely because that constraint makes a bare
SET NULL illegal — it has to null both columns. Adding the constraint here would
manufacture the same problem and require the same mirror trigger to solve it.

The INSERT path has no equivalent hazard: `link_guard` (151:57-61) writes
`status = 'incomplete'` BEFORE INSERT, the settlement flips the invoice AFTER
INSERT, and `sync_status` then updates a row that is fully committed to the
statement. It changes only `status`, and
`tg_partial_payments_settled_immutable` is `BEFORE UPDATE OF amount,
invoice_id` — so it does not fire. That column list is load-bearing; widening it
to a bare `BEFORE UPDATE` would make every settlement raise.

A trigger rather than an RPC for the same reason 153 gives: the table is written
directly over PostgREST from `useCreateMoneyRecord` and could be written by
anything added later — "five scattered checks is where one gets missed".

`tg_partial_payments_link_guard` (live body at `151:21-62`) and
`tg_partial_payments_sync_status` (147) both **stay**. The link guard's
`new.status := case when invoice.state = 'paid' …` still runs BEFORE INSERT, sees
the pre-settlement state, and writes `incomplete`; the AFTER-INSERT settlement
then flips the invoice to `paid`, whose own AFTER UPDATE trigger
(`tg_partial_payments_sync_status`) corrects the ledger row to `complete`. The
two triggers compose correctly in that order. **Codex should verify this
ordering claim against the trigger firing sequence — it is the subtlest part of
the design.**

**6. Reporting stays unchanged.** `get_budget_summary` (106:107) and
`get_payments_overview` (106:209) continue to exclude `partial_payments` from
aggregates. That exclusion is now _required for correctness rather than by
design_: the money is counted once, through the `payments` row the settlement
creates. Migration 160 must add a comment saying so, or a later reader will
"fix" the exclusion and double-count.

**7. Backfill** (user decision, §2.7). At the end of migration 160:

```sql
do $$
declare r record;
begin
  for r in
    select pp.id from public.partial_payments pp
    join public.invoices i on i.id = pp.invoice_id
    left join public.payments p on p.source_partial_payment_id = pp.id
    where pp.invoice_id is not null and p.id is null
    order by i.period_year, i.period_month, pp.created_at
  loop
    perform public.apply_partial_payment_settlement(r.id);
  end loop;
end $$;
```

Ordered oldest-invoice-first so the chronological check cannot reject a row that
a later iteration would have unblocked. A row that still fails (over-balance, or
a genuinely out-of-order historical entry) must **abort the migration**, not be
skipped — a silently skipped backfill is indistinguishable from a successful one,
and the difference is money. Against current production this loop settles exactly
one row: the 1,175 against `INV-0003085`, leaving it `partially_paid` with
`balance = 175.000`.

Two things about that abort. Only three of the 160 migrations open an explicit
transaction, so `psql -f` autocommits per statement: the `DO` block is one
statement, and a mid-loop raise rolls back **every settlement the loop made**
while leaving the DDL above it committed. That is recoverable — fix the offending
row, re-run the block — but it must be written down, or whoever hits it will
assume the whole migration needs undoing.

And it must fail _legibly_. A bare `partial_payment_exceeds_balance` raised from
inside a loop names no row. A pre-flight `select` listing every row that _would_
fail, run before the loop, turns a forensic exercise into a line of output.

### 2.4 Full-payment dialog — contiguous-prefix selection

The server rule the admin path needs already exists but is not reachable:
`invoiceSelection` (`createPayment.ts:266-302`) is module-local and calls the
**portal** RPC, which filters on `is_visible_to_tenant` — wrong for admin, where
an invoice hidden from the tenant is still payable by staff.

Rather than widen that RPC or export a portal-shaped helper, extract the
selection rule as a **pure function over already-fetched rows**, in
`src/lib/invoiceSettlement.ts` next to `settleableInvoices`:

```ts
/**
 * يحدد الفواتير التي يجوز اختيارها: بادئة متصلة من الأقدم فالأحدث.
 *
 * The portal enforces the same rule in three places — the RPC's `is_selectable`
 * (121:95), the checkbox in portal.invoices.tsx:131, and createPayment.ts:266 —
 * but none of them is reusable here: all three read the portal RPC, which
 * filters on `is_visible_to_tenant`. Staff may settle an invoice hidden from the
 * tenant, so the admin dialog needs the rule without that filter. Kept pure over
 * an already-sorted array so it is testable without a database.
 */
export function isContiguousPrefix(ordered: InvoiceLike[], selectedIds: string[]): boolean;
export function selectThrough(ordered: InvoiceLike[], index: number): string[];
export function deselectFrom(ordered: InvoiceLike[], index: number): string[];
```

`selectThrough` / `deselectFrom` reproduce `portal.invoices.tsx:139-146`: ticking
row _n_ selects rows 0..n; unticking row _n_ selects rows 0..n-1. The checkbox at
`admin.payments.tsx:817` gets `disabled` when the row is neither the next
selectable nor already selected, plus the portal's `opacity-75` dimming and a
`lock_reason`-style hint. `settleableInvoices` already guarantees the array is
sorted `period_year → period_month → code`, which is what makes the index
arithmetic sound.

The dialog is not the only way an admin settles a later invoice: the invoices
table has a **Mark Paid** button. That path is already covered — it calls
`set_invoice_paid`, whose chronological guard (159:118-129) raises before any
money moves. Stated here so a reader checking the request's "cannot pay a later
invoice while older ones are open" against the code does not conclude it was
missed.

Defence in depth: `submitPayment` (339–374) re-asserts `isContiguousPrefix`
before calling `settleInvoices` and refuses with a toast, because a refetch can
reorder the list under a selection made before it arrived.

Be precise about what backs it. `apply_payment_allocation` — the function this
path actually calls — rejects `amount > balance` and over-allocation, but has
**no** chronological check; only `set_invoice_paid` and the deposit/partial
settlement functions do. So on the full-payment path the ordering rule is
enforced in the UI alone. The next section says why that gap is left open.

> **Known gap, deliberately not closed.** The admin full-payment path calls
> `createPayment` + `applyAllocation` per invoice, which reach
> `apply_payment_allocation` — and _that_ function has no chronological check
> (only `set_invoice_paid` and the deposit/partial settlement functions do). So
> after this change the ordering rule is enforced in the admin UI but not in the
> SQL that the admin UI calls. Closing it means adding the admission check to
> `apply_payment_allocation`, which the MyFatoorah webhook and
> `paymentReconcileJob` also call — a webhook that starts raising on out-of-order
> settlement would strand real gateway money. **Explicit non-goal; Codex should
> confirm it is the right call rather than silently inheriting it.**

### 2.5 Invoice row formatting

One line, month as a pill:

```jsx
<div className="grid grid-cols-[auto_1fr] items-center gap-3 rounded-lg border p-3">
  <Checkbox … />
  <div className="flex flex-wrap items-center gap-2">
    <span className="font-medium">{invoice.code}</span>
    <Badge variant="secondary" className="rounded-full">
      {invoicePeriodLabel(invoice.period_year, invoice.period_month)}
    </Badge>
    <span className="text-muted-foreground ms-auto text-xs">
      {t("invoices.balance")}: <LtrText>{formatAmount(invoice.balance, locale)}</LtrText>
    </span>
  </div>
</div>
```

`invoicePeriodLabel` (`src/lib/invoicePeriodLabel.ts:38`) is the right helper and
is **already used by the partial-payment invoice picker**
(`RecordPanelDialog.tsx:72`), so this makes the two dialogs agree. Its docstring
(24–37) records that it returns English month names even in the Arabic UI on the
accountant's request, backed by a fixed table rather than `Intl` to avoid browser
locale-data variance. This spec honours that decision and does **not** switch to
`formatBillingPeriod`.

`ms-auto` rather than `ml-auto` so the balance sits at the line's end under RTL.
`flex-wrap` keeps the row from overflowing on narrow viewports — "one line" is
the layout intent, not a reason to let content clip.

### 2.6 Partial-payment dialog

- **Width:** `RecordPanelDialog.tsx:143` → `<DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">`, matching Add Payment. `RecordPanelDialog` also serves Refunds and Insurance; all three carry the same contract `<Select>` and benefit equally.
- **Cap:** derive `remaining` from the selected invoice's `balance` (already on the option rows from `useSettleableInvoices`, `useInvoices.ts:437-455`). Set `max={remaining}` on the input, block submit above it with a specific message naming the remaining amount, and show the remaining balance as helper text under the field. When no invoice is linked there is no cap.
  - `min="0.001"` **must** be paired with `step="0.001"` or the browser rejects whole numbers — this repo has hit that exact bug before (`min` without a matching `step` blocks the form). The existing input already has `step="0.001"`; keep them together.
- **Errors:** the new SQL exceptions surface through PostgREST as raw errcodes. Map `partial_payment_exceeds_balance`, `partial_payment_invoice_out_of_order`, `partial_payment_invoice_terminal_state` and `partial_payment_settled_immutable` to bilingual dictionary keys in the dialog's error handler, so the admin never sees a Postgres string.
- **Delete:** the panel's delete already goes through `useDeleteMoneyRecord`; the BEFORE DELETE trigger reverts the settlement underneath it. Add a confirmation line stating that deleting will un-settle the invoice.

### 2.7 User decisions (confirmed before drafting)

| Question                                    | Decision                                                  |
| ------------------------------------------- | --------------------------------------------------------- |
| The orphaned 1,175 partial on `INV-0003085` | **Backfill** it through the new settlement path (§2.3.7)  |
| Editing / deleting a settled partial        | **Delete reverts; edit rejected** (deviation D3)          |
| Email logo source                           | **Dedicated upload, falling back to the app logo** (§2.8) |

### 2.8 Resend card — sender dropdown and logo

**Sender dropdown.** Add to `ProviderConfigCard` a Resend-only `<Select>` bound
to `provider_configs.from_email`, with options from
`useOptionListItemsByCode(RESEND_SENDER_LIST_CODE)` — the same hook and the same
catalogue `GmailComposeDialog.tsx:164-183` already uses. `from_email` is a
**column, not a `config` jsonb key**; `useUpdateProviderConfig` already accepts
any `TablesUpdate<"provider_configs">` (`useProviderConfigs.ts:36-68`), so only
the card's `onSave` signature widens from `(config)` to
`(updates: { config?, from_email? })`. No hook change, no migration.

This lands on the **notification-dispatch** path only
(`dispatchNotification.ts:231-235`, `config.from_email ?? process.env.RESEND_FROM`)
— which is exactly the gap. Mailbox compose keeps picking its own sender per
message; the two paths stay disjoint and that is correct.

The dropdown is restricted to the catalogue rather than free text because Resend
verifies a _domain_ and rejects an unverified sender at send time with an error
the operator has to interpret — 158:75-84's reasoning, unchanged.

**Logo.** Three parts:

1. `companies.email_logo_url text` — new nullable column, migration 160 (same
   file; it is one deploy). Nullable _is_ the fallback: null means "use
   `logo_url`".
2. The Resend card gets an upload field reusing **`ImageSourceInput`**
   (`src/components/admin/ImageSourceInput.tsx:53-188`) with
   `bucket="branding" folder="email-logo"` and a small `maxDimension`. Preferred
   over copying `BrandingAssetField` (`admin.settings.index.tsx:210-297`) because
   it adds client-side downscaling (`compressImageFile`), an upload timeout, RLS
   error mapping and an inline `role="alert"` — and its doc comment (75–79)
   explicitly anticipates a smaller bound for logos. The `branding` bucket is
   public (`21_settings_integrations.sql:34`, re-asserted by `74:139-145`, and
   verified present in production `pg_policies` as `branding_public_read` for
   `{public}`), so the resulting URL is fetchable by mail clients.
3. `wrapLayout` (`emailTemplates.ts:56-61`) emits an inert **marker comment**
   `<!--EMAIL_LOGO-->` in its header cell, above the brand name. The send path
   replaces that marker with an `<img>` — bounded `max-height`, the brand name as
   `alt` so a client that blocks images still reads the brand — or with an empty
   string when there is no logo.

**Why a marker and not a parameter.** The obvious design — thread a `logoUrl`
argument through `wrapLayout`'s callers — rests on a false premise, and the
premise is worth recording because it is easy to re-derive.
`dispatchNotification.ts` does **not** build HTML. It imports neither
`emailTemplates` nor `loadTemplateCopy`; it sends `notification.body`
(239/247/270), a string already stored on the row. The HTML is built upstream by
**sixteen** sender files — `notifyContactInquiry`, `notifyContractCloseout`,
`notifyContractLifecycle`, `notifyContractRestored`, `notifyDepositConfirmed`,
`notifyInvoiceDisputed`, `notifyInvoiceWrittenOff`, `notifyMaintenanceRequest`,
`notifyPaymentSuccess`, `notifyRefundRecorded`, `notifyUserCredentials`,
`overdueRemindersJob`, `contractExpiryJob`, `sendCompanyInfo`,
`sendInvoiceToTenant`, `sendTenantCredentials` — plus `TemplateEditorDialog`
client-side. Threading a parameter means editing all sixteen and remembering it
in every sender added later; one missed sender is an unbranded email nobody
notices.

A module-scoped logo with a setter, read by `wrapLayout`, was the other
candidate. It collapses to one edit but makes the output of a pure function
depend on ambient mutable state, and a sender that runs before anything primes
it silently sends without a logo.

The marker keeps `wrapLayout` pure and puts the substitution at the one place
every email provably passes through — the send path — where it can `await`
branding. `dispatchNotification` and `resendMailboxSend` each apply it once.

Two constraints this must respect, both load-bearing:

- `renderEmailDocument` runs **both** server-side (jobs, senders) and
  client-side (`TemplateEditorDialog.tsx:36,65,97`). The marker is inert
  wherever nothing replaces it, so the client needs no branding fetch; the
  preview substitutes it locally from `useCompany` so the admin sees what will
  be sent. Server-side the URL comes from `getPublicBranding()`
  (`src/fns/publicBranding.ts:20-41`, which already service-role-selects branding
  columns with a 60 s cache — extend its select and its cached shape).
- A template body starting with `<!doctype` or `<html>` **bypasses `wrapLayout`
  entirely** (`emailTemplates.ts:91`), so it carries no marker and will never
  show the logo. Documented at 85–88; state it in the Resend card's helper text
  so an admin who writes a full-document template is not surprised.

`emailTemplates.test.ts:231` asserts the brand name is present in the rendered
document — that assertion must keep passing, which it does as long as the name
stays in the header beside the logo.

---

## 3. Scope

**In:** everything in §2.

**Out, stated so it is not silently assumed:**

- URL search-param sync for the notification settings tabs (§0.2).
- A chronological admission check inside `apply_payment_allocation` (§2.4).
- Fixing migration 129's reversed-money sum bug (tracked in `TODO.md`; the new
  code sidesteps it by reusing `recompute_invoice_from_confirmed`).
- Any change to the WhatsApp or SMTP provider cards.
- Splitting `admin.payments.tsx`. It is ~1,120 lines — over the 500–600 ceiling,
  and §2.4/§2.5 touch it. **Open for Codex:** whether extracting
  `FullPaymentsPanel` into its own file belongs in this branch or a follow-up.

---

## 4. Verification

**SQL** (`bun run test:sql`, new cases in `src/db/`):

1. A partial below the balance → invoice `partially_paid`, `paid` = the amount, one `payments` row with `source_partial_payment_id` set, one allocation.
2. Two partials summing to the total → invoice `paid`, and both ledger rows flipped to `complete` by 147's trigger. **This is the reported bug; it is the headline test.**
3. A partial exceeding the balance → `partial_payment_exceeds_balance`, nothing written.
4. A partial on February while January is open → `partial_payment_invoice_out_of_order`.
5. Deleting a settled partial → payment, allocation and receipt gone, invoice back to its prior state.
6. Updating a settled partial's amount → `partial_payment_settled_immutable`.
7. A partial with `invoice_id is null` → still inert, nothing written. **This is `refunds.sqltest.ts:186` narrowed, not deleted** — the "inert" describe block must be rewritten to assert inertness _for unlinked rows only_, or it will fail and its failure would be the correct signal that the invariant changed.
8. A client role calling `apply_partial_payment_settlement` directly → `42501`.
9. A client role setting `source_partial_payment_id` on a `payments` insert → rejected by the provenance guard.
10. Reversing a partial-sourced payment → `recompute_invoice_from_confirmed` nets the mirror allocation out; the invoice does **not** stay `paid`.
11. The backfill loop, run against a fixture holding a pre-existing unsettled linked partial.

**Unit** (`bun run test`): `isContiguousPrefix` / `selectThrough` / `deselectFrom` including the empty, single-row and all-selected cases; the partial-amount cap boundary at exactly `remaining`; `wrapLayout` emitting the marker and the brand name, `applyEmailLogo` with and without a logo URL, and the `<!doctype>` bypass; `invoicePeriodLabel` in the new row.

Note: `src/fns` tests mock `createServerFn` in a way that **skips `.validator()`**,
so a Zod schema declared inline there is never exercised. Any new schema must be
exported and asserted directly.

**Gates:** `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:sql`.
**Guards:** `clean-code-guard` (production code), `test-guard` (tests),
`docs-guard` (this spec and any docstring changes).

**Manual, on production after deploy:** confirm `INV-0003085` reads
`partially_paid` / `balance 175.000`; add a 175 partial and confirm it flips to
`paid`; send one notification and confirm the From address and the logo.

---

## 5. Rollout

Order matters — `main` auto-deploys via Dokploy and there is no staging.

1. `pg_dump` first. Schema changes are not reversible.
2. Apply migration 160 to `danatfuture-supabase-ozoxsa-db-1` over
   `ssh-danatfuture-mcp`, **before** merging. Files arrive free in
   `/etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code` at the start of
   each build — but that checkout is of `main`, which will not yet contain 160,
   so this one transfers by chunked base64 with an `md5sum` check against the
   local file. The MCP bridge caps command size at a few KB and times out on long
   commands; wrap the `psql` run in
   `nohup sh -c '… ; echo $? > /root/status.txt' &` and poll.
3. `notify pgrst, 'reload schema'` — without it PostgREST keeps a stale signature
   cache and the new RPCs 404.
4. Verify the backfill: `INV-0003085` → `partially_paid`, `paid 1175.000`,
   `balance 175.000`, one `payments` row carrying `source_partial_payment_id`.
5. Hand-copy the new column and RPC entries into `database.types.ts`. It is
   hand-maintained despite looking generated; `bun run gen:types` writes a
   _reference_ file and must never overwrite it.
6. Merge → Dokploy rebuilds → the new bundle meets the already-migrated schema.
7. `graphify update .`

**Rollback.** Code rolls back by reverting the merge. Schema does not: dropping
`source_partial_payment_id` would orphan the `payments` rows the backfill
created. If 160 must be undone, run `revert_partial_payment_settlement` over
every settled row _first_, then drop the triggers, functions and column.
