# Danat Al Mustaqbal — Database (self-hosted Supabase)

All schema is delivered as plain SQL migrations you run **manually** on your
self-hosted Supabase Postgres. The app is not wired to Lovable Cloud.

## Run order

Apply files in the order of the numeric prefix:

```
db/migrations/00_extensions.sql              # pgcrypto, uuid-ossp, citext, pg_trgm
db/migrations/01_schema_core.sql             # companies, profiles, user_roles, has_role(), is_staff()
db/migrations/02_auth_seed.sql               # new-user trigger + single company seed
db/migrations/03_phase1_permissions_audit.sql# permissions, role_permissions, audit_logs, write_audit(), has_permission()
db/migrations/04_phase2_properties_tenants_contracts.sql # properties/buildings/units/tenants/contracts/concessions + code generators
db/migrations/05_phase3_invoices_payments.sql# invoices, payments, allocations, receipts, generate_invoices/evaluate_overdue/apply_payment_allocation/reverse_payment
db/migrations/06_phase4_tenant_portal_gateway.sql # payment_requests, webhook_events, evaluate_portal_payable_invoices (chronological ordering)
db/migrations/07_phase5_notifications_reports.sql # notifications, templates, provider_configs, report_schedules, generated_reports + expiry/report fns
db/migrations/08_phase6_expenses_deposits_budget.sql # expenses, expense_categories, deposits + attachment buckets
db/migrations/09_phase7_electricity.sql      # electricity_tariffs/meters/readings/charges + consumption trigger + charge generator
db/migrations/16_admin_table_operations.sql # maintenance requests + expanded property/building/unit CSV imports
```

Phases 0–7 are complete. All migrations are idempotent and safe to re-run.

## How to apply

### Option A — `psql`

```bash
export PGURL='postgres://postgres:<password>@<host>:5432/postgres'
for f in db/migrations/00_*.sql db/migrations/01_*.sql db/migrations/02_*.sql \
         db/migrations/03_*.sql db/migrations/04_*.sql db/migrations/05_*.sql \
         db/migrations/06_*.sql db/migrations/07_*.sql db/migrations/08_*.sql \
         db/migrations/09_*.sql db/migrations/16_*.sql; do
  echo "== applying $f =="
  psql "$PGURL" -v ON_ERROR_STOP=1 -f "$f"
done
```

### Option B — Supabase Studio → SQL editor

Paste each file's contents, run it, then move to the next.

Every migration is idempotent (uses `if not exists`, `create or replace`,
`drop policy if exists ... create policy ...`), so re-running is safe.

## Conventions (all phases)

- Every `CREATE TABLE public.*` is followed by explicit `GRANT` statements,
  then `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, then `CREATE POLICY`.
- Roles are stored ONLY in `public.user_roles` — never on `profiles` or
  `auth.users`. Membership is checked via `public.has_role()` (SECURITY
  DEFINER, `set search_path = public`).
- Money uses `numeric(14,3)` (KWD). UUID primary keys. Human-readable codes
  are separate unique columns.
- Storage paths (later phases) use immutable UUIDs, e.g.
  `companies/{company_id}/tenants/{tenant_id}/documents/{file_id}`.

## After running migrations

Regenerate the TypeScript types for the app:

```bash
supabase gen types typescript \
  --db-url "$PGURL" \
  --schema public \
  > src/integrations/supabase/database.types.ts
```

## Deposit triggers move money — disable them for a manual restore

Migrations 152-154 make `public.deposits` a money-moving table: confirming a deposit
that names an invoice inserts a real `payments` row and its allocation, and
un-confirming it deletes them. Four triggers implement that:

| Trigger | On | Why it must be off during a raw restore |
| --- | --- | --- |
| `deposits_sync_invoice_ins` | `deposits` INSERT | Re-inserting a confirmed deposit re-creates its payment |
| `deposits_sync_invoice_upd` | `deposits` UPDATE | Same, for a restored update |
| `deposits_revert_on_delete` | `deposits` DELETE | Deletes payments while the dump is being cleared |
| `payments_guard_deposit_provenance` | `payments` INSERT/UPDATE | Refuses the restored `source_deposit_id` values |

**The app's own Backup → Restore screen does not need this.** `backup_restore`
sets `session_replication_role = replica` before its delete/insert loop
(`146_backups.sql`), which disables user triggers for that session, so a restore
through the UI cannot re-create payments.

The manual step is only for an out-of-band `psql` data-only restore, or a bulk
backfill that assigns `invoice_id` to many deposits at once:

```sql
begin;
alter table public.deposits disable trigger deposits_sync_invoice_ins;
alter table public.deposits disable trigger deposits_sync_invoice_upd;
alter table public.deposits disable trigger deposits_revert_on_delete;
alter table public.payments disable trigger payments_guard_deposit_provenance;
--  … restore or backfill …
alter table public.payments enable trigger payments_guard_deposit_provenance;
alter table public.deposits enable trigger deposits_revert_on_delete;
alter table public.deposits enable trigger deposits_sync_invoice_upd;
alter table public.deposits enable trigger deposits_sync_invoice_ins;
commit;
```

Re-enable inside the same transaction. Leaving one off is invisible: deposits
keep saving and simply stop settling anything.

## Rollback

There is intentionally no automated `down` migration for financial tables.
For dev environments only, drop and re-create the `public` schema.

| `31_notification_workflows.sql` | Schema: Twilio enum, audience columns, exclusivity trigger, 7-day expiry RPC, richer report HTML |
| `32_notification_workflow_seeds.sql` | Seeds: Twilio provider row, weekly/monthly schedules, new templates (run after 31 commits) |
| `33_contract_expiry_retry_failed.sql` | Expiry RPC: retry when prior notify was failed/skipped |
| `44_scheduled_report_email_design.sql` | Weekly/monthly admin report email: Stitch vibrant design (responsive table HTML, KPIs, deposits, status bars) |
| `82_billing_safety_archived_contracts.sql` | Exclude archived contracts from invoice generation + both reminder paths |
| `83_closeout_permissions.sql` | Permissions for close-out, restore, refund reverse/void, invoice write-off/dispute |
| `84_contract_closeouts.sql` | Close-out tables (header, deductions, invoice actions, operational events) + RLS |
| `85_refunds_reversal.sql` | Refund status machine, reverse/void RPCs, posted-only aggregates |
| `86_invoice_dispute_and_write_off.sql` | Invoice dispute flag + write-off to waived |
| `87_contract_closeout_rpcs.sql` | close_out_contract, preview, cancel, restore (+ in-SQL write_audit) |
| `88_closeout_notification_types.sql` | **Standalone enum only** — `contract_closeout` / `contract_restored` (must commit before 89; same trap as 71) |
| `89_closeout_workflows_and_templates.sql` | Event workflows + email-only templates for close-out / restore |
| `90_module_summaries_archive_mode.sql` | Archive-aware module list summaries |
| `91_summary_archived_count.sql` | Archived count on summary RPCs |
