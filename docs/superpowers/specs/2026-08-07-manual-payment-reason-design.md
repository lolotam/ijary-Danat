# Manual payment reason and Method of Payment — design

Date: 2026-08-07
Task: #6 — record *why* an invoice was marked paid by hand, and show how every
paid invoice was actually settled.

Depends on task 7 (`f59817e`) having landed: the gateway now writes real methods
(`knet`) onto payments instead of leaving admin placeholders labelled `cash`, so
a "Method of Payment" column has something truthful to show.

## 1. Current behaviour

- `/admin/invoices` marks an invoice paid from a **single icon-button click** —
  there is no dialog, so there is nowhere to ask for a reason today.
- `set_invoice_paid(uuid, boolean)` (migration 23) creates the settling payment
  with `method` **hardcoded to `'cash'`**, regardless of how the money arrived.
  A bank transfer, a cheque and a pure data correction are all recorded as cash.
- The invoices table has no method column at all.
- Reasons for manual settlement are not captured anywhere.

## 2. Design

### 2.1 Reasons live in the existing catalog, not a new table

The task asks for a `manual_payment_reasons` table plus a dedicated
"Reason of Manual Payment" admin section. The repo already has
`option_lists` / `option_list_items` (migration 13) with a Settings → Lists CRUD
screen, bilingual labels, sort order, an `is_active` flag, RLS, and a free-text /
enum-backed validation split. `unit_floors`, `commercial_activities` and
`gmail_categories` are all seeded lists using it.

A bespoke table would reimplement roughly 300 lines of that. So: a new list code
`manual_payment_reasons`, seeded with the four values. Admins manage it at
Settings → Lists rather than a page of its own.

**This is a deliberate deviation from the literal task wording.** The capability
asked for — add, edit, disable reasons from the dashboard — is delivered in full;
only its location differs.

### 2.2 The reason drives the payment method

This is the part that makes the feature worth more than a text field. Each
reason carries its settlement method in `option_list_items.metadata`:

| value | Label (EN) | `metadata.payment_method` |
| ----- | ---------- | ------------------------- |
| `bank_transfer` | Bank transfer | `bank_transfer` |
| `complete_partial_payment` | Complete / partial payment | `cash` |
| `cheque` | Check | `cheque` |
| `audit_adjustment` | Audit / data adjustment | `cash` |

`set_invoice_paid` reads that mapping and stamps the created payment with the
real method instead of always `'cash'`. Recording a bank transfer as cash was a
reporting defect in its own right; capturing the reason is what finally supplies
the information needed to fix it.

Unmapped or missing metadata falls back to `'cash'` — the current behaviour — so
an admin adding a fifth reason cannot break settlement.

### 2.3 `invoices.payment_method` is maintained by a trigger, not by callers

Two new columns on `invoices`:

- `manual_payment_reason text` — the chosen reason's `value`.
- `payment_method text` — how the invoice was actually settled.

`payment_method` is **not** written by application code. A trigger on
`payment_allocations` derives it from the allocated payment:

- after insert → set `invoices.payment_method` to that payment's `method`.
- after delete → recompute from surviving allocations; when none remain, set both
  `payment_method` and `manual_payment_reason` to null.

Every settlement path already goes through `payment_allocations` — manual marking,
gateway settlement, partial payments, reversals, and task 7's adoption branch.
One trigger therefore covers all of them, including paths written in TypeScript,
and no caller can forget to update the column.

It also delivers the task's "empty cell when unpaid" rule as a *consequence*
rather than a rendering special-case: un-marking an invoice deletes its
allocation, which nulls both columns. A cell that renders from a column which is
authoritative cannot drift from the row's state.

### 2.4 Replacing the RPC signature, carefully

`set_invoice_paid` gains a third parameter. In Postgres that creates an
**overload**, it does not replace — and PostgREST could keep resolving callers to
the old 2-argument version, silently discarding every reason. So the migration
explicitly drops the old signature first:

```sql
drop function if exists public.set_invoice_paid(uuid, boolean);
```

The new signature needs its **own** `revoke ... from public, anon` and
`grant execute to authenticated, service_role`. Migration 96 revoked the old
signature; grants do not carry across signatures, and `anon` holds its own grant
(see migration 96's own rationale).

### 2.5 UI

- A new `MarkInvoicePaidDialog`: reason `<Select>` populated from the active
  items of `manual_payment_reasons`, submit disabled until one is chosen. Opens
  in place of the direct call when marking paid. **Un**-marking stays a direct
  action — there is no reason to give for undoing a mistake.
- A "Method of Payment" column between State and Due date, rendering a
  translated label for `payment_method`, and an empty cell when it is null.

### 2.6 Email

`paymentReceiptHtml` / the admin alert gain one conditional row, "Reason of
manual payment", rendered only when `manual_payment_reason` is set — so gateway
receipts are untouched. Both the admin alert and the tenant receipt get it.

## 3. Files

| File | Change |
| ---- | ------ |
| `db/migrations/108_manual_payment_reason.sql` | New — columns, seeded list, trigger, RPC replacement |
| `src/integrations/supabase/database.types.ts` | Hand-add the two columns and the new RPC signature |
| `src/fns/setInvoicePaid.ts` | Accept and forward `manualPaymentReason` |
| `src/components/admin/MarkInvoicePaidDialog.tsx` | New |
| `src/routes/admin.invoices.tsx` | Dialog wiring + Method of Payment column |
| `src/lib/paymentReceiptHtml.ts` | Conditional reason row |
| `src/lib/emailTemplates.ts` | Conditional reason row in the admin alert |
| `src/i18n/dictionary.ts` | New keys, both locales |

## 4. Testing

- **Unit**: the reason → method mapping, including the `cash` fallback for
  unmapped metadata; the receipt renderer emitting the row only when a reason is
  present.
- **SQL**: marking paid stores reason and method; un-marking clears both; the
  trigger sets `payment_method` from a gateway allocation with no application
  code involved; the old 2-arg signature is gone.
- **Regression**: a gateway-settled invoice never acquires a
  `manual_payment_reason`, and its `payment_method` reads `knet`/`card` — the
  case the task names explicitly.
- **i18n**: `dictionary.test.ts` already fails the build on a key added to only
  one locale.

## 5. Out of scope

- Backfilling `payment_method` for historically paid invoices. The trigger only
  fires on new allocations; existing rows show an empty cell until re-settled. A
  one-off backfill is a separate decision — flagged, not assumed.
- Reasons for partial payments and refunds, which have their own flows.
