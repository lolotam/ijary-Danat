# Handover — remaining work

**Date:** 2026-08-06
**Design:** `docs/superpowers/specs/2026-08-06-contract-closeout-design.md`
**Execution plan:** `docs/superpowers/plans/2026-08-06-contract-closeout.md`

Two workstreams: finishing the close-out delivery (A), and the contract auto-expiry
question raised by CON-00003 (B). B is **blocked on a product decision** — see B.5.

---

# A. Close-out delivery — what is left

## A.1 Migrations not yet on production

83–87, 90 and 91 are applied and verified. These are **not**:

| File                                      | Contents                                                      | Apply order      |
| ----------------------------------------- | ------------------------------------------------------------- | ---------------- |
| `88_closeout_notification_types.sql`      | `alter type` only — `contract_closeout`, `contract_restored`  | **first, alone** |
| `89_closeout_workflows_and_templates.sql` | 2 `cron_jobs` event rows + 4 templates                        | after 88 commits |
| `92_invoice_event_notification_types.sql` | `alter type` only — `invoice_written_off`, `invoice_disputed` | **first, alone** |
| `93_invoice_event_workflows.sql`          | 2 `cron_jobs` event rows + 4 templates                        | after 92 commits |

> **88 and 92 must each be applied in their own transaction, before their companion.**
> Migrations run `--single-transaction` and a new enum value cannot be used in the
> transaction that added it (`unsafe use of new value of enum type`). This is why 71 and
> 72 are two files. Applying 88+89 together will fail.

**Transfer method:** the Dokploy git checkout at
`/etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code` has an expired GitHub App
token, so `git fetch` fails. Until Dokploy rotates it, use gzip + base64 chunks (the SSH
exec cap is 1000 chars):

```
gzip -9 -c <file> | base64 -w0 > /tmp/x.b64 && split -b 900 -d -a 1 /tmp/x.b64 c_
# send each chunk to its own /tmp/p_N, then:
cat /tmp/p_0 /tmp/p_1 … | base64 -d | gunzip > /tmp/x.sql && md5sum /tmp/x.sql
```

Verify the md5 against local **before** applying. Apply with
`psql -v ON_ERROR_STOP=1 --single-transaction -f`, then `notify pgrst, 'reload schema'`.

## A.2 Branches needing PRs

| Branch                          | Contents                                        | PR           |
| ------------------------------- | ----------------------------------------------- | ------------ |
| `feat/closeout-schema`          | 83–84                                           | #76 open     |
| `feat/closeout-refund-reversal` | 85–86                                           | #77 open     |
| `feat/closeout-rpcs`            | 87                                              | #78 open     |
| `feat/closeout-server-hooks`    | 90, types, 8 server fns, hooks, SQL harness fix | **none yet** |
| `feat/closeout-ui`              | 91, wizard, tabs, badges                        | **none yet** |
| `feat/closeout-notify-docs`     | 88–89, 92–93, statement, senders, docs          | **none yet** |

The stack is **linear** — each branch bases on the previous. Merge in order
#76 → #77 → #78 → server-hooks → ui → notify-docs, or retarget each to `main` as the one
below it merges. Merging out of order produces a misleading diff.

## A.3 Known-failing test that is not ours

`src/db/workflowRegistry.sqltest.ts` fails on `manual-payment-invoice` — migration 80
seeded that workflow and the test's expected list was never updated. **Pre-existing on
`main`**, failing before this work started. Worth a separate one-line fix; do not fold it
into the close-out stack.

## A.4 Verification standing

- Fast suite and build: green (859 tests, 0 lint errors at last run)
- SQL suite for the five close-out files: **65/65 green**, verified independently
- Everything applied to production was verified by querying production, not by trusting
  the migration output — financial totals were identical before and after every apply
  (94 invoices, 21770.000 paid, 25790.000 balance)

---

# B. Contract auto-expiry (CON-00003)

## B.1 The diagnosis is correct — verified independently

The submitted analysis is right on root cause. Confirmed here:

- No SQL anywhere sets `state = 'expired'` — grep over `db/migrations/` returns nothing.
- `JOBS` in `src/fns/cronJobs.ts` has seven entries; none is an auto-expire.
- `identify_contract_expiry_reminders` returns `milestone = null` once `end_date - as_of < 0`,
  so a contract past its end date stops producing reminders and nothing else happens.
- `get_contracts_summary` counts "ended" as `state in ('expired','terminated')` only, so
  the card correctly reads 0 while the state never moved.

**Conclusion stands: this is a missing feature, not a data bug and not a failed cron.**

## B.2 Correction — the production scope is two contracts, not one

```
 code      | state     | end_date   | days_past
-----------+-----------+------------+-----------
 CON-00013 | suspended | 2026-04-30 |        98
 CON-00003 | active    | 2026-07-31 |         6
```

The submitted plan recommends auto-expiring `state = 'active'` only. That leaves
**CON-00013 stale forever** — 98 days past its end date and still holding whatever
`suspended` implies. The "frozen/suspended" line in the plan's checklist is not
hypothetical; decide it with this row in front of you.

## B.3 Addition — auto-expiry silently disables tenant portal logins

Not mentioned in the submitted plan. `trg_contract_deactivate_portal`
(`db/migrations/21_*.sql:72-77`) fires:

```sql
after update of state or delete on public.contracts
for each row when (old.state = 'active')
```

So flipping `active → expired` runs `deactivate_portal_users_without_active_contract()`
and sets `profiles.is_active = false` for that tenant's portal users. A scheduled job
would therefore **lock tenants out of the portal overnight with no notice and no audit
trail from the job itself**.

That may well be desired — a tenant whose lease ended arguably should lose portal access.
But it must be a stated decision, and the job should emit an audit row per affected
profile so support can answer "why can't I log in".

Note the trigger is **one-way**: nothing re-enables `is_active`. `restore_contract`
(migration 87) has to do it explicitly for exactly this reason.

## B.4 Blocking conflict — auto-expiry locks the contract out of close-out

**This is the most important review finding and it is not in the submitted plan.**

`close_out_contract` (`db/migrations/87_contract_closeout_rpcs.sql:448`):

```sql
if v_contract.state in ('expired', 'terminated', 'renewed') then
  raise exception 'Contract is already ended (state = %)', v_contract.state;
end if;
```

A close-out is the flow that settles the deposit, records deductions, calculates the
refund and produces the statement. If a nightly job flips CON-00003 to `expired` first,
the wizard **refuses it permanently**. The operator's only route back is to hand-edit the
state to `active` — precisely the manual state-poking this feature exists to remove.

CON-00003 has a tenant, a unit and (potentially) a held deposit. Auto-expiring it before
close-out would strand the settlement.

**Options, in preference order:**

1. **Auto-expire only contracts with nothing to settle.** Exclude any contract with a
   non-zero `insurance_payments.amount`, any unpaid invoice, or an open close-out draft.
   Those stay `active` and appear in a "needs close-out" list instead. Keeps the wizard
   reachable for exactly the cases that need it.
2. **Relax the close-out guard** to accept `expired` when `archived_at is null`, so an
   auto-expired contract can still be closed out. Larger blast radius — the guard also
   protects against double close-out.
3. **Do not auto-expire; add the UI-only "past end date, still active" filter** from the
   plan's lighter alternative. Zero risk, makes the gap visible, leaves units occupied.

Option 1 is the recommendation: it fixes the KPI truthfulness for the boring cases and
routes the interesting ones to the flow that was just built for them.

## B.5 Decision required before any implementation

1. Auto-expire, UI-only, or leave manual?
2. If auto-expiring: `active` only, or `suspended`/`frozen` too (CON-00013)?
3. Is silent portal deactivation acceptable, or should the job notify?
4. Which of B.4's three options for the close-out conflict?

**Do not implement until 1 and 4 are answered.** 2 and 3 can default to
"active only" and "notify" if no answer comes.

## B.6 If it is built — implementation notes

Beyond the submitted plan's design, which is otherwise sound:

- Job key `contract-auto-expire`, registered in **all** of: `JOBS` (`src/fns/cronJobs.ts`),
  `WORKFLOW_CATALOG` (`src/lib/workflowCatalog.ts`) with a `runPermission` and `schedule`,
  a `cron_jobs` row, and the crontab in `deploy/README.md`. A row without a catalog entry
  dispatches nothing.
- Set `state = 'expired'` only. **Never** set `archived_at` — archive stays an operator
  decision made through close-out.
- Let migration 76's trigger free the unit. Never write `units.status`;
  `trg_unit_enforce_derived_status` rejects it anyway.
- Idempotent by construction: the predicate excludes `expired`, so a re-run matches zero rows.
- One `write_audit` row per contract (`contract.auto_expire`) plus a
  `contract_operational_events` row, so the change is explicable months later.
- Backfill for already-past rows goes in the **same migration**, using the same predicate,
  so the first cron tick is not a surprise mass-update.
- Tests: SQL integration for the flip + unit vacated + idempotency + the exclusion
  predicate from B.4 option 1; a fast-suite test for the job gate.

## B.7 Immediate operator workaround — no code needed

For CON-00003 today: **run the close-out wizard** (`/admin/contracts/<id>/closeout`). It
settles any deposit, records deductions, produces the statement, sets `terminated`, and
frees the unit through the trigger. That both fixes the KPI and does the accounting
properly — and it is available now, since 83–87 are live.

For CON-00013 (suspended, 98 days): same, or edit the state directly if there is nothing
to settle.
