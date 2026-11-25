# Contract close-out, refund, archive and restore — design

**Date:** 2026-08-06
**Status:** approved; migration 82 shipped, 83–84 shipped, 85–91 pending

## Problem

Archiving a contract is a side effect of recording a refund. `archiveRefundTarget()`
(`src/hooks/useRefunds.ts:47-67`) stamps `archived_at` on the tenant and the contract,
sets `tenant_portal_enabled = false` and `profiles.is_active = false` — four
non-atomic client round-trips — and **never changes `contracts.state`**. Its sibling
`freezeRefundContract` (`:69-76`) is the only post-action that writes `state`, and
it is the only one that actually stopped billing.

The consequence is a row that is invisible and billable at the same time:

- **Invisible** — `useContracts.ts:91` and `useTenants.ts:214` filter `.is("archived_at", null)`.
- **Billable** — `db/migrations/37_...sql:68-74`, the only live `insert into public.invoices`,
  filtered on `c.state` alone.

Measured on production 2026-07-31 → 2026-08-06: `archived_at is null` was filtered in
seven read paths and in **zero money paths**.

### The incident this came from

Contract `CON-00008`, tenant `DANA-000006`:

| Fact                                                                  | Evidence                                       |
| --------------------------------------------------------------------- | ---------------------------------------------- |
| Archived 2026-07-31 14:57:25 by a refund with `post_action='archive'` | `contracts.archived_at`, `tenants.archived_at` |
| Left at `state='active'`                                              | `contracts.state`                              |
| Refund rows later hard-deleted 2026-08-02                             | two `refunds.delete` rows in `audit_logs`      |
| The archive itself was never audited                                  | `archiveRefundTarget` writes no audit row      |
| 4 invoices, 300.000 KWD outstanding, still being dunned               | `invoices`, `overdueRemindersJob`              |

Deleting the refund did not undo the archive. Nothing recorded who archived it, or why.

### Why a generator-only guard was insufficient

Two callers mutate invoices _before_ reaching the generator:

- `reapply_contract_invoices` (`37:214-246`) runs `delete from public.invoices` **then**
  delegates to `backfill_contract_invoices`.
- `regenerate_contract_invoices` (`55:128-348`) **Pass 1** rewrites `total`/`subtotal`/
  `discount`/`due_date` in place and writes `state='cancelled'` without entering the
  generator at all.

Additionally `generate_invoices_for_year`'s state check is bypassed entirely when
`p_include_past = true and p_contract_id is not null` — which is how every backfill and
regenerate path calls it.

## Decisions

1. **Two phases.** A minimal billing-safety hotfix first (migration 82, shipped), then the
   restructure. The hotfix stops the bleeding without waiting on the feature.
2. **`waived` means written off.** The value existed in `invoice_states` with zero writers.
   Disputes become a nullable flag (`disputed_at`, `dispute_reason`, `disputed_by`) so a
   disputed invoice keeps its state and stays in A/R aging — a state change would silently
   remove it from arrears.
3. **Refunds mirror the payments reversal pattern** (`05:597-673`): status flip plus a
   positive mirror row and an FK link. `amount > 0` CHECKs make sign-based reversal impossible.
4. **Deposit settled against unpaid rent counts as collected revenue** (owner decision,
   2026-08-06). This is the only option that keeps `invoices.paid` backed by real
   allocations — the rule migration 55 exists to enforce after migration 52 broke it.

## Lifecycle and visibility are separate concerns

`state` is lifecycle. `archived_at` is operational visibility. The three close-out
outcomes differ in `archived_at`, not only in `state`:

| `outcome`         | `contracts.state`         | `archived_at` | Lists             |
| ----------------- | ------------------------- | ------------- | ----------------- |
| `keep_terminated` | `terminated`              | **null**      | stays visible     |
| `freeze`          | `frozen`                  | **null**      | stays visible     |
| `archive`         | `terminated` \| `expired` | `now()`       | moves to Archived |

A close-out does **not** always archive. `archive_tenant` is meaningful only under
`outcome = 'archive'`, enforced by `closeout_archive_tenant_needs_archive`.

Billing eligibility always requires **both** `state = 'active'` **and** `archived_at is null`.

## Data model

- `contract_closeouts` — the aggregate. Snapshots, six `numeric(14,3)` totals, `outcome`,
  `idempotency_key` (globally unique), and `result jsonb` so a retry after a successful
  commit replays byte-identical output. Partial unique index enforces at most one `draft`
  per contract — a CHECK cannot express a cross-row rule and an index cannot be bypassed by
  a `security definer` function.
- `contract_closeout_deductions` — `amount > 0`; a zero deduction is a data-entry error.
- `contract_closeout_invoice_actions` — `leave | settle_from_deposit | write_off | cancel |
mark_disputed`. `previous_state` and `resulting_state` are **stored, not derived**: a
  statement reprinted in two years must show what was agreed then.
- `contract_operational_events` — deliberately **not** `audit_logs`. `audit_logs` is forensic,
  append-only, written by `write_audit` with request metadata, read by the Audit screen
  filtered by actor. This is the contract's operational timeline on the detail page.

### Access control

Every new public table arrives with ALL privileges granted to `anon` and `authenticated` by
Supabase default privileges, and `revoke ... from public` does **not** reach them —
`78_bulk_import_contracts.sql:161-176` documents a confirmed production exploit from exactly
that gap. Migration 56 created `refunds` with neither grant nor revoke.

So every table revokes from `public, anon, authenticated` before granting. `contract_closeouts`
grants no `delete` (close-outs are cancelled, never deleted). `contract_operational_events`
has no write policy at all — the absence is the deny, and the definer RPCs reach it as owner.

## Atomic completion

`close_out_contract(...)` returns `jsonb` and does everything in one transaction.

**Lock order: contracts → tenants → invoices (ascending id). No `units` lock.**
Three AFTER triggers sit on `contracts` and fire in name order —
`trg_contract_deactivate_portal` (writes `profiles`), `trg_contract_sync_tenant_lifecycle`
(writes `tenants`), `trg_contract_sync_unit_status` (locks `units` ascending-uuid, **last**).
Taking `units` before updating `contracts` inverts that chain and is the deadlock.

**One `update` on `contracts`, not two** — the sync trigger fires on
`update of unit_id, state, archived_at`, so writing `state` and `archived_at` together fires
it once.

**The unit is released by migration 76's trigger, never by a direct write.** A direct
`units.status` write would be rejected by `trg_unit_enforce_derived_status` anyway.

**Audit is written from inside the transaction** via `write_audit`, which is callable in SQL
(`erase_all_data()` at `45:58-66` does it) and does not raise when the actor is null. The
client helper is unusable here: it would land in a different transaction and could commit an
audit row for a close-out that then rolled back. This is the first user-facing path to write
audit from SQL, and that is a new precedent worth documenting.

**`settle_from_deposit` creates a real `payments` + `payment_allocations` pair** and calls
the existing `apply_payment_allocation`, never writing `invoices.paid` directly.

## Restore is not reactivation

Restore clears `archived_at` and nothing else by default. It preserves the terminated state,
leaves the portal disabled, leaves unit occupancy unchanged, and **never regenerates invoices** —
the single most tempting wrong addition. It must explicitly re-enable `profiles.is_active`,
because migration 21's deactivation trigger is one-way and would otherwise leave the tenant
silently locked out.

If the former unit is now held by another live contract, the old contract can still be restored
for inspection; only reactivation is blocked.

## Deliberate deviations from the original request

| Requested                                       | Built                             | Why                                                                                                                                                    |
| ----------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contract_closeouts.status` includes `reversed` | `draft \| completed \| cancelled` | A completed close-out is undone by `reverse_refund` + `restore_contract` — two auditable, independently-permissioned steps.                            |
| Header `invoice_treatment` enum incl. `mixed`   | per-invoice rows only             | The per-invoice table subsumes it; the RPC refuses when an invoice with `balance > 0` has no action, which is what "explicit decision required" means. |
| Separate write-off and dispute _states_         | `waived` + a dispute _flag_       | A disputed invoice must stay in A/R aging.                                                                                                             |

## Known gaps

- `bun run test:sql` has not produced a clean run on this machine (Docker unstable). Migrations
  82–84 were verified directly against production instead; the SQL suites are written but unproven.
- `usePermissions()` ignores custom roles, so the UI is strictly more restrictive than RLS for
  custom-role users. Pre-existing; not addressed here.
- `landing_page.*` permission codes are seeded in SQL but absent from `src/lib/permissions.ts`,
  so they never reach `can()`. Pre-existing; the same trap this work avoids for its six new codes.
