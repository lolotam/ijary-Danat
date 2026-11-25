# Batch F — Implementation plan

**Spec:** `docs/superpowers/specs/2026-07-29-batch-f-expiry-cron-design.md`
**Branch:** `feature/batch-f-expiry-cron`
**Status:** Implemented 2026-07-29

Two commits: migration + job wiring, then the management UI.

---

## Commit 1 — Migration 58 and the job changes

**Files**

| File                                                    | Change                                 |
| ------------------------------------------------------- | -------------------------------------- |
| `db/migrations/58_expiry_buckets_and_cron_registry.sql` | new                                    |
| `src/fns/contractExpiryJob.ts`                          | bucket-based wording                   |
| `src/fns/cronJobs.ts`                                   | record runs, skip paused               |
| `src/integrations/supabase/database.types.ts`           | `cron_jobs` + the changed RPC row type |
| `src/db/expiryBuckets.sqltest.ts`                       | tests 1–7                              |

**Steps**

- [x] 1.1 Rewrite `identify_contract_expiry_reminders` as a single `case` over `c.end_date - v_as_of` producing one of eight day buckets. Exclusivity must be structural, not a set of predicates that happen not to overlap.
- [x] 1.2 **The OUT row type changes, so `create or replace` will not work.** CLAUDE.md documents this exact failure across 07/31/33: `create or replace function` cannot change an OUT parameter's name or type. `drop function if exists` first.
- [x] 1.3 Re-seed `contract-expiry-ar`/`-en` onto bucket wording, reconciling the placeholder with the job's payload key.
- [x] 1.4 Seed `provider_template_name` / `provider_param_keys` so the WhatsApp leg can send at all.
- [x] 1.5 `public.cron_jobs` seeded with the seven keys from `cronJobs.ts`.
- [x] 1.6 Update `contractExpiryJob.ts` wording to derive from the bucket.
- [x] 1.7 `respondToCronRequest`: skip paused jobs (a `skipped` result, not an error) and record `last_run_at` / `last_status` / `last_duration_ms` / `last_error`. Add `durationMs` to the error response.
- [x] 1.8 SQL tests 1–7; unit tests 8–9.
- [x] 1.9 `test:db`, `test:sql` green.

**Trap 1:** the RPC's returned columns are consumed by `contractExpiryJob.ts` —
change both together or the job reads `undefined`.

**Trap 2:** recording a run must never make the cron endpoint fail. Observability
must not break the thing it observes, so the registry write is wrapped and
swallowed.

---

## Commit 2 — Cron management UI

**Files**

| File                                 | Change                                   |
| ------------------------------------ | ---------------------------------------- |
| `src/routes/admin.settings.cron.tsx` | new                                      |
| `src/hooks/useCronJobs.ts`           | new, modelled on `useReportSchedules.ts` |
| `src/i18n/dictionary.ts`             | both locales                             |

**Steps**

- [x] 2.1 List with `last_run_at`, `last_status`, duration and error.
- [x] 2.2 Row-level pause `Switch` — the control `report_schedules` lacks.
- [x] 2.3 Say plainly when a job has never run, rather than rendering an empty cell that merely looks idle. On production that is currently every job.
- [x] 2.4 Both locales; `format`; all four gates.

---

## Landing

- [ ] 3.1 Push, PR describing the overlap fix and the dead WhatsApp leg.
- [ ] 3.2 Merge. Never force-push, rebase, amend or squash.
- [ ] 3.3 Apply migration 58; re-probe.
