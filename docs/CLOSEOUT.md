# Contract close-out (operator guide)

**Danat Al Mustaqbal ERMP** — end-of-tenancy settlement for a single lease.

## What a close-out is

A close-out is the controlled end of a tenancy: outstanding invoices are
dispositioned, the security deposit is applied to deductions and unpaid rent,
an optional refund is posted, and the contract is given a final operational
outcome. Everything money-moving is done by `close_out_contract` (migration 87)
in one database transaction. The wizard in the admin UI only collects decisions
and shows the server preview; it never computes balances in the browser.

## The seven steps

1. **Contract & move-out** — pick the move-out date; deposit held is read from
   the insurance payment row, not typed in.
2. **Outstanding invoices** — one action per unpaid invoice (leave, settle from
   deposit, write off, cancel, mark disputed).
3. **Deposit & deductions** — itemise damages / cleaning / utilities / unpaid
   rent / other. Amounts must be > 0.
4. **Settlement preview** — server-only numbers (`get_contract_closeout_preview`).
5. **Refund** — suggested refund can only be **reduced**, never increased past
   the available deposit.
6. **Outcome** — keep terminated, freeze, or archive; optional archive-tenant
   (only when outcome is archive).
7. **Confirm** — re-read, tick the confirmation box, commit.

After commit you get a success card with the close-out id, refund code, and a
**Statement** button (printable bilingual close-out statement).

## The three outcomes (how they differ)

| Outcome           | Contract state                       | `archived_at`  | Visible in operational lists? |
| ----------------- | ------------------------------------ | -------------- | ----------------------------- |
| `keep_terminated` | `terminated` (or chosen final state) | stays `null`   | **Yes**                       |
| `freeze`          | `frozen`                             | stays `null`   | **Yes**                       |
| `archive`         | `terminated` or `expired`            | set to `now()` | **No** — only Archived view   |

A close-out does **not** always archive. Only the `archive` outcome moves the
contract out of normal lists.

## What “archived” means

- Hidden from operational contract lists (and related summaries when those
  filters respect archive mode).
- **Never deleted.** History, invoices, payments, refunds, and the close-out
  row remain.
- Archived contracts are excluded from invoice generation and both reminder
  paths (migration 82).

## What Restore does — and does not do

**Does:** clear `archived_at` so the contract reappears in operational lists;
optionally restore the tenant’s archive flag when requested; writes an
operational event and an audit row.

**Does not:**

- Reactivate the lease as a live billing relationship by itself (target state is
  chosen; default restore keeps the terminal/frozen state).
- Restart invoice generation for past periods.
- Re-enable the tenant portal automatically.
- Change unit occupancy beyond what the unit-status trigger already does for the
  chosen state.

To reverse money from a completed close-out you use **`reverse_refund`** (for a
posted deposit refund) plus **`restore_contract`** if the contract was archived.
You do **not** edit close-out rows by hand.

## Write off vs dispute vs cancel

| Action                  | Effect on invoice                         | Use when…                                   |
| ----------------------- | ----------------------------------------- | ------------------------------------------- |
| **Write off**           | Remaining balance → `waived`              | You accept the loss; amount leaves AR.      |
| **Mark disputed**       | State and balance **unchanged**; flag set | Dispute is open; still collectable later.   |
| **Cancel**              | Invoice cancelled                         | Invoice should never have been due (error). |
| **Settle from deposit** | Real payment + allocation from deposit    | Deposit covers this unpaid rent/charge.     |
| **Leave**               | No change                                 | Keep on books after close-out.              |

`waived` means **written off**. Disputes are a **separate flag** (`disputed_at` /
`dispute_reason`), not a state, so a disputed invoice can still be overdue or
issued.

## Completing vs undoing

- **Complete:** wizard → `close_out_contract`. Idempotent via `idempotency_key`.
- **Undo money:** `reverse_refund` on the posted refund (creates a mirror row).
- **Bring back to lists:** `restore_contract` (does not erase the close-out).
- **Cancel a draft only:** `cancel_contract_closeout` — cannot cancel a completed
  close-out by editing tables.

## Notifications

On successful close-out the app emails staff (`contract-closeout-completed`
workflow, types `contract_closeout`). Email-only by design. A mail failure never
fails the close-out; operators see a warning toast.

## Related docs

- [ARCHIVE_RESTORE.md](./ARCHIVE_RESTORE.md)
- [REFUND_ACCOUNTING.md](./REFUND_ACCOUNTING.md)
- [AUDIT.md](./AUDIT.md)
- [runbooks/2026-08-06-closeout-deploy.md](./runbooks/2026-08-06-closeout-deploy.md)
