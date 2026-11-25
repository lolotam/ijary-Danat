-- ============================================================================
-- verify-migrations.sql
-- ============================================================================
-- READ-ONLY verification of close-out / billing-safety migrations on a live
-- Postgres. Prints one row per check: check_name | result (PASS | FAIL).
--
-- Touch nothing. No INSERT / UPDATE / DELETE / CREATE / DROP / ALTER / TRUNCATE
-- / COPY / CALL / DO / NOTIFY / LISTEN / LOCK / GRANT / REVOKE / SET ROLE.
--
-- Run (orchestrator on production host):
--   docker exec -i danatfuture-supabase-ozoxsa-db-1 \
--     psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
--     < scripts/verify-migrations.sql
--
-- Or after packing this file the same way as a migration.
-- ============================================================================

\pset format aligned
\pset border 2
\pset null '(null)'
\timing off

\echo
\echo '========== verify-migrations.sql (READ-ONLY) =========='
\echo

WITH checks AS (
  -- 1. Four close-out / invoice-event notification enum values exist.
  SELECT
    1 AS sort_key,
    'notification_types_closeout_enums' AS check_name,
    (
      SELECT count(*) = 4
      FROM unnest(enum_range(NULL::public.notification_types)) AS e(val)
      WHERE e.val::text IN (
        'contract_closeout',
        'contract_restored',
        'invoice_written_off',
        'invoice_disputed'
      )
    ) AS ok

  UNION ALL

  -- 2. Four event rows in cron_jobs for the close-out / invoice-event workflows.
  SELECT
    2,
    'cron_jobs_closeout_events',
    (
      SELECT count(*) = 4
      FROM public.cron_jobs
      WHERE kind = 'event'
        AND key IN (
          'contract-closeout-completed',
          'contract-restored',
          'invoice-written-off',
          'invoice-disputed'
        )
    )

  UNION ALL

  -- 3. Eight notification_templates for those types; none carry the Meta
  --    sentinel that means "WhatsApp name still required".
  SELECT
    3,
    'notification_templates_closeout_eight_no_sentinel',
    (
      SELECT count(*) = 8
      FROM public.notification_templates
      WHERE type::text IN (
        'contract_closeout',
        'contract_restored',
        'invoice_written_off',
        'invoice_disputed'
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.notification_templates
      WHERE type::text IN (
        'contract_closeout',
        'contract_restored',
        'invoice_written_off',
        'invoice_disputed'
      )
        AND provider_template_name = 'META_TEMPLATE_NAME_REQUIRED'
    )

  UNION ALL

  -- 4a. Four close-out tables exist.
  SELECT
    4,
    'closeout_tables_exist',
    (
      SELECT count(*) = 4
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'contract_closeouts',
          'contract_closeout_deductions',
          'contract_closeout_invoice_actions',
          'contract_operational_events'
        )
    )

  UNION ALL

  -- 4b. Role `anon` holds NO privilege on any of those four tables.
  SELECT
    5,
    'closeout_tables_anon_no_grants',
    (
      SELECT count(*) = 0
      FROM information_schema.role_table_grants
      WHERE grantee = 'anon'
        AND table_schema = 'public'
        AND table_name IN (
          'contract_closeouts',
          'contract_closeout_deductions',
          'contract_closeout_invoice_actions',
          'contract_operational_events'
        )
    )

  UNION ALL

  -- 5. Archived-contract guard lives in the LIVE body of all six guarded
  --    functions (migration 82). Every public overload must mention archived_at.
  SELECT
    6,
    'archived_at_guard_in_six_functions',
    (
      SELECT count(DISTINCT p.proname) = 6
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'generate_invoices_for_year',
          'backfill_contract_invoices',
          'reapply_contract_invoices',
          'regenerate_contract_invoices',
          'evaluate_overdue',
          'identify_contract_expiry_reminders'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'generate_invoices_for_year',
          'backfill_contract_invoices',
          'reapply_contract_invoices',
          'regenerate_contract_invoices',
          'evaluate_overdue',
          'identify_contract_expiry_reminders'
        )
        AND position('archived_at' IN p.prosrc) = 0
    )

  UNION ALL

  -- 6. No contract in an impossible state: archived yet still operational.
  SELECT
    7,
    'no_archived_operational_contracts',
    (
      SELECT count(*) = 0
      FROM public.contracts
      WHERE archived_at IS NOT NULL
        AND state IN ('draft', 'active', 'frozen', 'suspended')
    )

  UNION ALL

  -- 7. get_contracts_summary has exactly one overload, and it is the 4-arg form.
  --    Two overloads means a signature-changing migration was applied without
  --    dropping the old one; 3-arg callers would silently hit the stale body.
  SELECT
    8,
    'get_contracts_summary_one_4arg_overload',
    (
      SELECT count(*) = 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'get_contracts_summary'
    )
    AND coalesce(
      (
        SELECT p.pronargs = 4
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'get_contracts_summary'
        LIMIT 1
      ),
      false
    )

  UNION ALL

  -- 8. Same for get_tenants_summary.
  SELECT
    9,
    'get_tenants_summary_one_4arg_overload',
    (
      SELECT count(*) = 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'get_tenants_summary'
    )
    AND coalesce(
      (
        SELECT p.pronargs = 4
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'get_tenants_summary'
        LIMIT 1
      ),
      false
    )

  UNION ALL

  -- 9. Group-3 money / state / data SECURITY DEFINER functions must not grant
  --    EXECUTE to role `anon` (migration 96). RLS helpers has_permission /
  --    is_staff / has_role are intentionally omitted from this list.
  SELECT
    10,
    'money_rpcs_anon_no_execute',
    (
      SELECT count(*) = 0
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'apply_payment_allocation',
          'backfill_contract_invoices',
          'contract_period_amounts',
          'evaluate_overdue',
          'evaluate_portal_payable_invoices',
          'generate_electricity_charges',
          'generate_invoices',
          'generate_invoices_for_year',
          'generate_salaries_for_month',
          'invoice_has_pending_request',
          'reapply_contract_invoices',
          'receipt_html_for_payment',
          'regenerate_contract_invoices',
          'reverse_payment',
          'set_invoice_paid',
          '_seed_option_items',
          'build_scheduled_report_html',
          'erase_all_data',
          'get_budget_summary',
          'get_deposit_total',
          'identify_contract_expiry_reminders',
          'record_cron_run',
          'write_audit',
          'next_building_code',
          'next_contract_code',
          'next_electricity_charge_code',
          'next_employee_code',
          'next_invoice_code',
          'next_maintenance_request_code',
          'next_payment_code',
          'next_payment_request_code',
          'next_property_code',
          'next_receipt_code',
          'next_tenant_code',
          'next_unit_code',
          'compute_electricity_amount',
          'compute_tenant_lifecycle',
          'compute_unit_status',
          'set_tenant_blocked',
          'sync_tenant_lifecycle_for',
          'sync_unit_status_for',
          'unit_has_active_contract'
        )
        AND has_function_privilege('anon', p.oid, 'EXECUTE')
    )
),
labeled AS (
  SELECT
    sort_key,
    check_name,
    CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL' END AS result
  FROM checks
),
with_overall AS (
  SELECT sort_key, check_name, result FROM labeled
  UNION ALL
  SELECT
    999 AS sort_key,
    '*** OVERALL ***' AS check_name,
    CASE
      WHEN bool_and(result = 'PASS') THEN 'PASS'
      ELSE 'FAIL'
    END AS result
  FROM labeled
)
SELECT check_name, result
FROM with_overall
ORDER BY sort_key;

\echo
\echo 'If any row shows FAIL (especially *** OVERALL ***), stop and investigate.'
\echo '========== end verify-migrations.sql =========='
\echo
