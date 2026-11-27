# IJARY database

All schema is plain SQL, applied manually to the self-hosted Supabase Postgres. There is no automatic schema migration on deployment.

## Run order

1. Every file in [`db/migrations/`](migrations/), ordered by the **numeric prefix** (for example `100_…` after `99_…`). Both [`scripts/test-db.sh`](../scripts/test-db.sh) and [`scripts/gen-types.sh`](../scripts/gen-types.sh) use `sort -V`; a bare lexicographic sort is wrong once the prefixes change width.
2. Then the files in [`supabase/migrations/`](../supabase/migrations/), in their own name order.

Each script applies the files with `psql -v ON_ERROR_STOP=1`. The migration set is not fully re-runnable, so do not re-apply it to a database that has already been migrated; provision a clean database instead. For a production apply, take a `pg_dump` first, apply the reviewed files in order, then run:

```sql
notify pgrst, 'reload schema';
```

Without that notification PostgREST keeps a stale signature cache and new RPCs answer 404. See the [deployment runbook](../deploy/ijary/README.md) for the operational sequence.

## Local SQL test database

| Command            | Effect                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `bun run test:db`  | Build or reuse the Docker Postgres used by the SQL tests, then print its connection URL. `--fresh` forces a rebuild. |
| `bun run test:sql` | Run `src/db/**/*.sqltest.ts` against that database with one fork and no file parallelism.                            |
| `bun run test`     | Run the fast Vitest unit suite; the SQL suite is deliberately excluded from it.                                      |

`bun run test:db` applies [`db/testing/00_service_scaffold.sql`](testing/00_service_scaffold.sql) before the migrations because the bare Postgres image lacks the auth/storage baseline the migrations expect. It fingerprints the migration sources, so it reuses the container when they are unchanged and rebuilds when they change.

## Company isolation rules for new tables

A new company-scoped table must follow the [company-context contract](../specs/001-multi-company-saas/contracts/company-context.md):

- It has a `company_id` column, with RLS enabled and forced: `alter table public.<table> force row level security`.
- Its policies target `authenticated, company_service` and compare with a hoisted context call: `company_id = (select public.current_company_id())`. Other auth helpers are hoisted the same way, for example `(select public.is_staff((select auth.uid())))`; never write a bare `is_staff(auth.uid())`.
- Platform tables on the allow-list are the only tables without `company_id`; they are checked separately.
- Storage objects live under `companies/<company_id>/...`.
- No function or source file looks up an "oldest company" with `from companies … limit 1`, and no grant gives `delete` on `companies`. Suspension is the only access removal.
- A `security definer` function must reference `current_company_id()` or be on the platform allow-list. Prefer `security invoker` where the caller's rights are enough.
- Revoke `execute` on new functions from `public` and `anon`.

These rules are enforced by SQL structure tests, not by convention alone:

| Test                                                                                                          | What it checks                                                                      |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`src/db/isolation/tablesScoped.sqltest.ts`](../src/db/isolation/tablesScoped.sqltest.ts)                     | `company_id`, forced RLS and `current_company_id()` policies on every scoped table. |
| [`src/db/rlsHoistedAuth.sqltest.ts`](../src/db/rlsHoistedAuth.sqltest.ts)                                     | Auth and company helpers appear inside scalar sub-selects.                          |
| [`src/db/isolation/definerFunctions.sqltest.ts`](../src/db/isolation/definerFunctions.sqltest.ts)             | `security definer` functions are listed or use the company context.                 |
| [`src/db/isolation/definerNullContext.sqltest.ts`](../src/db/isolation/definerNullContext.sqltest.ts)         | Definer functions fail closed without a company context.                            |
| [`src/db/isolation/noOldestCompany.structure.test.ts`](../src/db/isolation/noOldestCompany.structure.test.ts) | No `from companies … limit 1` lookup.                                               |
| [`src/db/isolation/twoCompanies.sqltest.ts`](../src/db/isolation/twoCompanies.sqltest.ts)                     | Reserved slugs, no `delete` grant on `companies`, and platform-admin gating.        |
| [`src/db/isolation/crossCompanyMatrix.sqltest.ts`](../src/db/isolation/crossCompanyMatrix.sqltest.ts)         | Two seeded companies cannot reach each other's rows.                                |
| [`src/db/isolation/storagePaths.sqltest.ts`](../src/db/isolation/storagePaths.sqltest.ts)                     | Storage paths keep the `companies/<company_id>/` prefix.                            |

## Types

`src/integrations/supabase/database.types.ts` is hand-maintained. It exports named aliases that the generated file does not emit, so overwriting it breaks imports across the app.

```bash
bun run gen:types
```

That script applies `db/migrations/` to an ephemeral Postgres and writes `src/integrations/supabase/database.types.generated.ts` as a reference. Copy the new table, column or RPC entry into `src/integrations/supabase/database.types.ts` by hand, in the surrounding style, then delete the generated file. The `--force` flag exists for a deliberate codebase-wide migration off the named aliases; it is not the normal path.

## Manual data restores

The app's own Backup → Restore path sets `session_replication_role = replica` before its delete/insert loop (`146_backups.sql`), so user triggers cannot fire. An out-of-band `psql` data-only restore, or a bulk backfill that assigns `invoice_id` to many deposits at once, has to disable the four settlement triggers in the same transaction:

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

Re-enable every trigger before commit. Leaving one off is invisible: deposits keep saving and simply stop settling.

## Rollback

There is no automated `down` migration for financial tables. Schema changes are not reversible by rerunning a file; restore from a backup or, in development only, drop and recreate the `public` schema.
