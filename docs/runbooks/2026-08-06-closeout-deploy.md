# Runbook — close-out deploy (2026-08-06)

Apply on the Danat-Future production Supabase Postgres
(`danatfuture-supabase-ozoxsa-db-1`). Migrations are manual SQL, filename order,
typically with `psql -v ON_ERROR_STOP=1 -f …` under `--single-transaction` per
file (or Studio SQL editor, one file at a time).

## Migration order 83 → 91

Apply **only** what is not yet applied. Highest known on this feature set is 91.

| #      | File                                      | Notes                                                                                                                     |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 83     | `83_closeout_permissions.sql`             | Seeds `contracts.close_out`, restore, refund reverse/void, invoice write-off/dispute. Pair with `src/lib/permissions.ts`. |
| 84     | `84_contract_closeouts.sql`               | Tables + RLS for close-outs, deductions, invoice actions, operational events.                                             |
| 85     | `85_refunds_reversal.sql`                 | Refund status machine, reverse/void RPCs, aggregate filters.                                                              |
| 86     | `86_invoice_dispute_and_write_off.sql`    | Dispute flag + write-off (`waived`).                                                                                      |
| 87     | `87_contract_closeout_rpcs.sql`           | `close_out_contract`, preview, cancel, restore.                                                                           |
| **88** | **`88_closeout_notification_types.sql`**  | **STANDALONE ENUM FILE — see warning below.**                                                                             |
| 89     | `89_closeout_workflows_and_templates.sql` | Event workflows + email templates (uses enum from 88).                                                                    |
| 90     | `90_module_summaries_archive_mode.sql`    | Archive-aware list summaries.                                                                                             |
| 91     | `91_summary_archived_count.sql`           | Archived count on summaries.                                                                                              |

Also required earlier in the set (if not already live): **82**
(`82_billing_safety_archived_contracts.sql`) — archived contracts out of
invoice generation and reminder paths.

### **Standalone-88 warning (bold)**

> **Migration 88 must be its own committed transaction.**  
> It only runs `alter type public.notification_types add value …`.  
> Migrations run with `--single-transaction`. A new enum value **cannot** be
> used in the same transaction that added it (`unsafe use of new value of enum
type`). Migration **89** seeds `notification_templates` that reference those
> values — it **must** run **after** 88 has committed.  
> **Do not merge 88 and 89 into one file.** Same pattern as 71 + 72.

## Types after schema change

```bash
bun run gen:types
```

That writes **`database.types.generated.ts` (reference only)**.

Then **hand-copy** new tables / enums / RPCs into
`src/integrations/supabase/database.types.ts`.

> **Never overwrite `database.types.ts` with the generated file.** It exports
> ~73 named aliases the generator does not emit; ~70 app files import them.

For this feature the hand-maintained file already needs:

- `NotificationType`: `contract_closeout`, `contract_restored`
- Close-out table aliases (if not already present from 84+)

## Permission seed ↔ app constants

Every permission inserted in **83** must exist in `src/lib/permissions.ts`
(`PERMISSIONS` map). If you add a permission in SQL only, the UI cannot gate on
it. If you add it only in TS, RLS / `has_permission` denies the action.

## Verification queries

```sql
-- Enum
select unnest(enum_range(null::public.notification_types))::text
  where unnest(enum_range(null::public.notification_types))::text
    in ('contract_closeout','contract_restored');

-- Workflows
select key, kind, is_active, recipient_targets
  from public.cron_jobs
 where key in ('contract-closeout-completed','contract-restored');

-- Templates (email only — provider name must be null)
select code, type, channel, provider_template_name,
       length(subject_ar), length(body_ar)
  from public.notification_templates
 where code like 'contract-closeout%' or code like 'contract-restored%';

-- Permissions
select code from public.permissions
 where code like 'contracts.%' or code like 'refunds.%' or code like 'invoices.%'
 order by code;
```

App smoke:

1. Run close-out wizard on a non-production contract (or staging).
2. Confirm success toast; Statement opens printable HTML (Arabic shapes correctly).
3. Confirm notification row `type = contract_closeout` (or skipped if workflow paused).
4. Archive view shows archived contracts; Restore returns them without reactivating billing by default.

SQL suite (local Docker):

```bash
bun run test:db    # refresh if migrations changed
bun run test:sql
```

## Rollback note

There is **no automated down migration** for financial tables. Practical
options:

1. **Forward-fix** app code; leave tables/RPCs in place (preferred).
2. Pause workflows:  
   `update cron_jobs set is_active = false where key in ('contract-closeout-completed','contract-restored');`
3. Dev only: drop/recreate public schema and re-apply the full set from scratch
   (`bun run test:db` style). **Never** do that on production.

Do not delete `contract_closeouts` rows that already have completed settlements
— they are the legal/accounting statement of record.
