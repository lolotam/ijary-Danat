# Batch E — Implementation plan

**Spec:** `docs/superpowers/specs/2026-07-29-batch-e-employees-salaries-design.md`
**Branch:** `feature/batch-e-employees-salaries`
**Status:** Implemented 2026-07-29

Two commits: schema + job, then the UI.

---

## Commit 1 — Migration 57 and the salary job

**Files**

| File                                          | Change                          |
| --------------------------------------------- | ------------------------------- |
| `db/migrations/57_employees_salaries.sql`     | new                             |
| `src/integrations/supabase/database.types.ts` | three tables + the generate RPC |
| `src/fns/salariesJob.ts`                      | new                             |
| `src/fns/cronJobs.ts`                         | register `salaries`             |
| `src/db/employees.sqltest.ts`                 | tests 1–6                       |
| `deploy/README.md`                            | seventh job + crontab line      |

**Steps**

- [x] 1.1 `public.employees`, `public.employee_documents` (**with `expiry_date`**), `public.salaries` with `unique (employee_id, year, month)`.
- [x] 1.2 A `next_employee_code()` sequence helper matching `next_tenant_code()`.
- [x] 1.3 RLS mirroring `public.expenses`; a private `employee-documents` bucket mirroring `company-documents` in migration 49.
- [x] 1.4 Permissions + role grants, following `09_phase7_electricity.sql:267-281`.
- [x] 1.5 `public.generate_salaries_for_month(p_year, p_month)` — one row per **active** employee, `on conflict do nothing`. The unique constraint is what makes the cron job safe to run twice.
- [x] 1.6 Register the job; hand-write the types entries.
- [x] 1.7 SQL tests 1–6, plus the unit test that the job is in the registry.
- [x] 1.8 `test:db` then `test:sql` green.

**Trap:** `amount` must be copied from `employees.salary` at generation time, not
joined at read time — otherwise raising someone's salary silently rewrites
history, including months already marked delivered.

---

## Commit 2 — The Employees UI

**Files**

| File                                       | Change                         |
| ------------------------------------------ | ------------------------------ |
| `src/routes/admin.employees.tsx`           | new — Employee \| Salary tabs  |
| `src/hooks/useEmployees.ts`                | new                            |
| `src/components/admin/AdminSidebar.tsx`    | nav entry                      |
| `src/components/admin/BudgetDashboard.tsx` | Employee count + Salaries paid |
| `src/i18n/dictionary.ts`                   | both locales                   |

**Steps**

- [x] 2.1 Clone the expenses skeleton; do not invent a new table shell.
- [x] 2.2 Employee tab: list, create/edit dialog, avatar via the **private** signed-URL pattern, documents with `expiry_date`.
- [x] 2.3 Salary tab: year/month dropdowns, a delivered toggle, and the manual "generate this month" action — which is the only way generation runs today, since no cron is scheduled in production.
- [x] 2.4 Dashboard/budget cards.
- [x] 2.5 Both locales; `format`; all four gates.

---

## Landing

- [ ] 3.1 Push, PR noting that the cron job is registered but nothing schedules it.
- [ ] 3.2 Merge. Never force-push, rebase, amend or squash.
- [ ] 3.3 Apply migration 57; re-probe.
