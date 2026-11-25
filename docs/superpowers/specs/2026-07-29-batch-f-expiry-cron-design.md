# Batch F — T14b: expiry buckets, daily digest, cron management

**Date:** 2026-07-29
**Task:** T14b
**Migration:** `db/migrations/58_expiry_buckets_and_cron_registry.sql`
**Depends on:** nothing — independent of C/C2/D/E

---

## F.1 — The thresholds are not mutually exclusive today

The live definition is in `34_contract_expiry_delivery_retries.sql` (07, 31 and
33 are all superseded — read the highest number). It emits:

```sql
cross join (values (4), (3), (2), (1)) as threshold(months_until)
where c.end_date <= (v_as_of + make_interval(months => threshold.months_until))::date
  and c.end_date >  (v_as_of + make_interval(months => threshold.months_until - 1))::date
union all
select … '7d' … where c.end_date between v_as_of and v_as_of + 7
```

The **month** buckets are exclusive of each other. The `7d` arm is not: a
contract expiring in 3 days satisfies both `1m` and `7d`. It therefore fires
twice, with contradictory wording — one message says "in 1 month(s)".

Adding six more overlapping thresholds on top of that multiplies the problem, so
the rewrite is not "extend the `values` list".

### Eight exclusive buckets, in days

| Bucket | Fires when days-to-expiry is |
| ------ | ---------------------------- |
| `180d` | 151–180                      |
| `150d` | 121–150                      |
| `120d` | 91–120                       |
| `90d`  | 61–90                        |
| `60d`  | 31–60                        |
| `30d`  | 8–30                         |
| `7d`   | 2–7                          |
| `1d`   | 0–1                          |

Implemented as a single `case` over `c.end_date - v_as_of`, so exclusivity is
**structural** — a contract cannot land in two buckets because a `case` returns
one value. That is stronger than a set of range predicates that merely _happen_
not to overlap, which is what the current code is and how it drifted.

Contracts already expired (`end_date < v_as_of`) produce no bucket.

**Days, not months, throughout.** The existing mixture of month arithmetic and
day arithmetic is what let the two arms overlap in the first place.

### The per-tenant reminders stay

Per the decision, tenant email/WhatsApp reminders continue, re-cut onto the new
buckets. The wording derives from the bucket, so "in 1 month(s)" for a
three-day-out contract disappears along with the overlap.

## F.2 — Two live defects fixed while here

**The WhatsApp placeholder never resolves.** Migration 07 seeds
`contract-expiry-ar`/`-en` with `{{months_until_expiry}}`, but
`contractExpiryJob.ts:106` puts `months_until` in the payload. Reconciled by
re-seeding the bodies onto bucket-based wording with a matching key.

**No migration ever seeds `provider_template_name` / `provider_param_keys`** for
these templates — columns migration 38 added, and which the WhatsApp sender
refuses to send without. Seeded here so the WhatsApp leg stops being dead.

## F.3 — Daily digest

One admin report per day listing every contract crossing any threshold: tenant,
unit, building, start and end dates, and the bucket.

It reuses the existing `notifications` pool rather than adding a fifth inbox
source. The inbox already renders notification rows; a new source would mean new
tabs, new badges and new bell entries for a single report.

**Suppressed entirely when nothing crosses.** A daily "nothing to report" email
trains people to ignore the channel, which defeats the digest.

## F.4 — Cron management UI

There is **no cron-run table anywhere**. The only observability is per-job
`write_audit`, and not every job writes one.

New `public.cron_jobs` registry, modelled on `report_schedules`
(`07_phase5…:89-102`) plus the row-level pause switch that table lacks:
`key`, `name_ar`, `name_en`, `is_active`, `last_run_at`, `last_status`,
`last_duration_ms`, `last_error`, timestamps.

Seeded with the seven keys in `cronJobs.ts`: `overdue`, `overdue-reminders`,
`contract-expiry`, `scheduled-reports`, `notification-drain`, `gmail-sync`,
`salaries`.

`respondToCronRequest` records each run and **skips paused jobs**, returning a
`skipped` result rather than an error — a paused job is a deliberate state, not
a failure. `durationMs` is added to the error response, which today carries it
only on success.

> **Context worth stating in the UI:** none of these jobs currently runs. No
> crontab entries, cron.d files, systemd timers or Dokploy schedules exist on
> the production host. The registry is the first place an admin can _see_ that,
> because `last_run_at` will read empty for every job.

## Tests

| #   | Kind | Assertion                                                                           |
| --- | ---- | ----------------------------------------------------------------------------------- |
| 1   | SQL  | a contract 3 days out appears in `7d` only — **never** in a month-scale bucket      |
| 2   | SQL  | each of the 8 buckets fires at its midpoint                                         |
| 3   | SQL  | every contract yields **at most one** bucket, asserted across a spread of end dates |
| 4   | SQL  | an already-expired contract yields nothing                                          |
| 5   | SQL  | only `active` contracts are considered                                              |
| 6   | SQL  | the contract-expiry templates now carry a `provider_template_name`                  |
| 7   | SQL  | `cron_jobs` is seeded with all seven registry keys                                  |
| 8   | Unit | a paused job is skipped, not run                                                    |
| 9   | Unit | a run records `last_run_at`, `last_status` and `last_duration_ms`                   |
| 10  | Unit | the digest is suppressed when nothing crosses                                       |

Test 3 is the one that matters: it asserts the _property_ rather than eight
individual cases, so a future ninth bucket cannot silently reintroduce an
overlap.

## Verification

`lint` / `typecheck` / `test` / `test:sql` / `test:db` green; migration 58
applied and re-probed; both locales.
