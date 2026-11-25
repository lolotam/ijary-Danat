# Refund accounting

## Status machine

| Status     | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `draft`    | Not yet part of collections; can still be voided without a mirror.      |
| `posted`   | Counts in budget / deposit aggregates.                                  |
| `voided`   | Cancelled without ever having been a real outflow (no mirror row).      |
| `reversed` | Was posted; a **negative mirror** row was inserted by `reverse_refund`. |

## Void vs reverse

- **Void** — for drafts (or never-posted mistakes). Sets `voided_at` /
  `void_reason`. **No mirror row**: the refund never counted as money out, so
  there is nothing to reverse in the ledger sense.
- **Reverse** — for **posted** refunds only. Marks the original `reversed` and
  inserts a linked mirror row (`reversal_of_id`) with opposite effect. Mirrors
  the payment-reversal pattern from migration 05. Negatives are impossible on a
  single row because of `amount > 0` CHECKs; the pair carries the story.

## Aggregate filters (load-bearing)

Both deposit / refund aggregate functions filter:

```sql
status = 'posted' AND reversal_of_id IS NULL
```

Why both clauses:

1. `status = 'posted'` — drafts, voided, and reversed originals must not move
   totals.
2. `reversal_of_id IS NULL` — the **mirror** row is also `posted` (or
   status-equivalent in the reverse pair). Without this filter, a reverse would
   count as a second outflow (original already flipped to `reversed`, but the
   positive mirror would still add in).

If you change these functions, keep both predicates or budget reports will
double-count reversals.

## Owner decision — 2026-08-06

**Deposit money settled against unpaid rent COUNTS AS COLLECTED REVENUE.**

Close-out `settle_from_deposit` does **not** quietly reduce invoice balances.
It creates a real `payments` row (cash, reference `CLOSEOUT:{contract_code}`)
and runs `apply_payment_allocation` for the settle lines.

Consequences:

- The close-out month’s **collections rise** by the settled amount.
- Invoice `paid` / state updates go through the same path as any other cash
  payment.
- This is **policy**, not a bug. Do not “fix” the collections bump by skipping
  the payment row.

## Close-out refunds

A completed close-out may create one posted refund for the unused deposit
remainder. To undo that money after the fact, use `reverse_refund` — not row
edits.

## Permissions

| Code              | Use                   |
| ----------------- | --------------------- |
| `refunds.create`  | Create / post refunds |
| `refunds.update`  | Edit drafts           |
| `refunds.void`    | Void                  |
| `refunds.reverse` | Reverse posted        |

See also [CLOSEOUT.md](./CLOSEOUT.md) and [AUDIT.md](./AUDIT.md).
