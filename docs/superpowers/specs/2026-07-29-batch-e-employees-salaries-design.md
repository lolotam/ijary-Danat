# Batch E — T14a: Employees and Salaries

**Date:** 2026-07-29
**Task:** T14a (employee records, documents, monthly salaries)
**Migration:** `db/migrations/57_employees_salaries.sql`
**Depends on:** nothing — entirely greenfield, and independent of C/C2/D

---

## Starting point

Zero hits for `employee` or `salary` across every migration and all of `src/`.
This is the only batch with no existing behaviour to preserve, so the whole risk
is in _not reinventing_ things the repo already solves.

## Reuse, don't reinvent

| Need                                   | Clone from                                             |
| -------------------------------------- | ------------------------------------------------------ |
| Table + filters + CSV + dialog + pager | `admin.expenses.tsx` + `useExpenses.ts`                |
| Document upload / replace / signed URL | `TenantDocumentsManager.tsx` + `useTenants.ts:264-430` |
| Private storage bucket policies        | `49_company_documents_bucket.sql`                      |
| Mobile cards                           | `admin.payments.tsx`                                   |
| Permission seeding + role grants       | `09_phase7_electricity.sql:267-281`                    |

**Avatars use the private signed-URL pattern, not `uploadImageToBucket`.** That
helper (`ImageSourceInput.tsx:11`) returns **public** URLs, which is right for a
landing-page image and wrong for a photograph of a member of staff. Also do not
clone `tenants.avatar_media_id`, which routes avatars through the public
landing-media table.

## Schema (migration 57)

**`public.employees`** — `code`, `name`, `name_en`, `nickname`, `mobile`,
`email`, `notes`, `salary` (the current monthly figure), `avatar_path` (a
storage path, not a URL), `is_active`, `hired_on`, timestamps.

**`public.employee_documents`** — mirrors `tenant_documents` **plus the
`expiry_date` column `tenant_documents` lacks**. That column is the whole reason
this is not simply reused: a residency permit or a work licence expiring is the
thing HR needs to see coming, and Batch F's expiry digest can read it.

**`public.salaries`** — `employee_id`, `year`, `month`, `amount`, `delivered`,
`delivered_at`, `delivered_by`, `note`, `unique (employee_id, year, month)`.

The unique constraint is what makes monthly generation idempotent, exactly as
`unique (contract_id, period_year, period_month)` does for invoices. A cron job
that can run twice without doubling anyone's pay is not optional.

### `delivered` is a flag, not a payment

Marking a salary delivered deducts it from the budget. It creates no
`payments` row and no allocation — salaries are an outgoing cost like an
expense, not a tenant collection. `get_budget_summary` is **not** re-issued
again in this batch; the salary total is surfaced through its own query so the
budget function is not rewritten twice in two batches.

## Monthly generation

A `salaries` cron job creating one row per **active** employee for the current
month, amount copied from `employees.salary`. Idempotent on
`(employee_id, year, month)` via `on conflict do nothing`.

Registered in `src/fns/cronJobs.ts`'s `JOBS` map and documented in
`deploy/README.md`.

> **It will not run.** No cron entries exist on the production host at all —
> `crontab -l | grep -c 'public/cron'` returns 0, and there are no
> `/etc/cron.d` entries, systemd timers, or Dokploy schedules. Every existing
> job (`overdue`, `contract-expiry`, `scheduled-reports`, `notification-drain`,
> `gmail-sync`) is equally dormant. Registering this job correctly is still
> right; it just needs the separate ops decision to switch scheduling on, which
> also starts sending real email and WhatsApp to real tenants.

Because of that, the UI also offers a manual "generate this month" action, which
is the only way it runs today.

## RBAC

`employees.*` and `salaries.*` seeded across create/read/update/delete/export.
Admin gets all; accountant gets create/read/update/export, mirroring the shape
every other financial module uses. RLS mirrors `public.expenses`; the private
`employee-documents` bucket mirrors `company-documents`.

**Employee salary figures are staff-only.** RLS is `is_staff(auth.uid())` for
select — a tenant portal user must never see them. Unlike `gmail_connections`
no column-level revoke is needed, because no column here is a credential; the
whole row is simply staff-only.

## Tests

| #   | Kind | Assertion                                                                                               |
| --- | ---- | ------------------------------------------------------------------------------------------------------- |
| 1   | SQL  | generating salaries twice for the same month creates one row per employee                               |
| 2   | SQL  | generation skips inactive employees                                                                     |
| 3   | SQL  | `unique (employee_id, year, month)` rejects a duplicate                                                 |
| 4   | SQL  | `employee_documents.expiry_date` exists and is queryable by range — the column `tenant_documents` lacks |
| 5   | SQL  | a signed-in non-staff user cannot read employees or salaries                                            |
| 6   | SQL  | an accountant may record but not delete                                                                 |
| 7   | Unit | the salary job is registered in the cron registry                                                       |

## Verification

`lint` / `typecheck` / `test` / `test:sql` / `test:db` green; migration 57
applied and re-probed; both locales.
