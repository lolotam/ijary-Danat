# Contract close-out — execution plan

**Date:** 2026-08-06
**Design:** `docs/superpowers/specs/2026-08-06-contract-closeout-design.md`

Five PRs. Each is independently green and independently reviewable.

## Phase 0 — billing safety (shipped)

- [x] `db/migrations/82_billing_safety_archived_contracts.sql` — guards on
      `generate_invoices_for_year` (bulk skips, direct-id rejects),
      `backfill_contract_invoices`, `reapply_contract_invoices` (**before the delete**),
      `regenerate_contract_invoices` (**before Pass 1**), `evaluate_overdue`,
      `identify_contract_expiry_reminders`; plus the idempotent repair
- [x] `src/fns/overdueRemindersJob.ts` filters by contract, not tenant
- [x] `src/db/billingSafety.structure.test.ts`, `src/db/archivedBillingSafety.sqltest.ts`
- [x] Applied to production; PR #75 merged
- [ ] `archivedBillingSafety.sqltest.ts` has never run (Docker)

## PR 1 — schema foundation (shipped, PR #76)

- [x] `83_closeout_permissions.sql` — six special codes; accountant gets write_off + dispute only
- [x] `src/lib/permissions.ts` updated in the same commit
- [x] `84_contract_closeouts.sql` — four tables, `outcome` column, revoke-then-grant, RLS
- [x] `src/db/closeoutRls.sqltest.ts`, `src/db/closeout.structure.test.ts`
- [x] Applied to production; `anon` denied at grant level, verified live
- [ ] `closeoutRls.sqltest.ts` has never run (Docker)

## PR 2 — refund lifecycle + write-off/dispute

- [ ] `85_refunds_reversal.sql` — `REF-` code generator, `status`, `reversal_of_id`,
      void columns; `reverse_refund()` (positive mirror), `void_refund()` (no mirror)
- [ ] Narrow `refunds_delete_permitted` to `status = 'draft'` — closes the hard-delete
      path that orphaned CON-00008
- [ ] **Re-issue `get_budget_summary` AND `get_payments_summary`** with
      `status = 'posted' and reversal_of_id is null`, or reversals double-count
- [ ] Generalise `moduleSummaries.structure.test.ts` to resolve the highest-numbered
      migration per function, or it passes while testing dead SQL
- [ ] `86_invoice_dispute_and_write_off.sql` — dispute flag, `write_off_invoice()`
      (sets `waived`, never touches `paid`), `set_invoice_dispute()` / `clear_invoice_dispute()`
- [ ] EN `invoiceState.waived` → "Written off"; `invoiceStateTone('waived')` → `neutral`
- [ ] `src/db/refundReversal.sqltest.ts`

## PR 3 — the close-out engine

- [ ] `87_contract_closeout_rpcs.sql` — `close_out_contract`, `cancel_contract_closeout`,
      `restore_contract`, `get_contract_closeout_preview`
- [ ] Lock order contracts → tenants → invoices(asc); **no `units` lock**
- [ ] One `contracts` update; `archived_at` set only when `outcome = 'archive'`
- [ ] Idempotency via stored `result` jsonb; staleness via `contract_updated_at` → 40001
- [ ] `settle_from_deposit` creates a real payment + allocation via `apply_payment_allocation`
- [ ] Audit written in-transaction via `write_audit`
- [ ] `contractCloseout.sqltest.ts`, `contractRestore.sqltest.ts`, structure tests
- [ ] `database.types.ts` hand-merge (own commit — ~70 importers)

## PR 4 — server functions and hooks

- [ ] Seven server fns in `src/fns/`; **throw `Error`, not `Response`** (a thrown Response
      resolves client-side as success), and return `{ ok: true }` the caller asserts on
- [ ] `src/lib/closeoutSchemas.ts` shared client⇄server
- [ ] `ArchiveMode` on `useContracts` / `useTenants`; adopt `src/hooks/pagination.ts`
- [ ] Retire `archiveRefundTarget` / `applyRefundPostAction`
- [ ] `90_module_summaries_archive_mode.sql` — **needs `drop function if exists` for the old
      3-arg signatures**, unlike 82

## PR 5 — surface

- [ ] `WizardShell.tsx` + `/admin/contracts/$id/closeout` (7 steps, one form object)
- [ ] Current/Archived/All tabs via `?view=` search param
- [ ] Invoice archived badge + dispute filter; `DisputedBadge` **alongside** the state badge
- [ ] `closeoutStatement.ts` via Path A (`openPrintableDocument`) — Arabic-correct
- [ ] `88` (enum values, standalone file) + `89` (workflows/templates), email-only
- [ ] i18n keys in both locales + `test.each` per new enum family
- [ ] `docs/CLOSEOUT.md`, `docs/REFUND_ACCOUNTING.md`, runbooks, `db/README.md`, `CLAUDE.md`

## Standing gates

`bun run format` · `lint` · `typecheck` · `test` · `build`, plus `test:sql` when Docker allows.
4 prettier errors in `useGmailMessages.ts`, `useUsers.ts`, `admin.settings.users.tsx` are
pre-existing from PR #74 — do not count them as new.
