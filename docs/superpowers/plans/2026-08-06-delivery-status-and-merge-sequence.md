# Contract close-out — delivery status and merge sequence

**Date:** 2026-08-06
**Design:** `docs/superpowers/specs/2026-08-06-contract-closeout-design.md`
**Handover / open questions:** `docs/superpowers/plans/2026-08-06-handover-remaining-work.md`

---

# Part 1 — What is done

## 1.1 The defect that started this

Contract `CON-00008` was invisible in the Contracts list and fully billable at the same
time. `archiveRefundTarget()` (`src/hooks/useRefunds.ts`) stamped `archived_at` on the
tenant and contract but never changed `contracts.state`, so the row sat at
`state = 'active'`. Read paths filtered `archived_at`; **money paths did not** — that
asymmetry was the bug. Its refund rows were later hard-deleted, orphaning the archive
stamp, and no audit row was ever written for the archive itself.

Verified on production, fixed, and confirmed: `CON-00008` is now `terminated`, unit
`vacant`, **4 invoices and 300.000 KWD intact**, no longer billable.

## 1.2 Migrations applied to production

| #   | Contents                                                           | Verified on prod                                      |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| 82  | Billing safety: archived guards on 6 functions + idempotent repair | guards raise; repair `UPDATE 1`                       |
| 83  | Six permission codes                                               | all six in `permissions`; accountant scoped correctly |
| 84  | Four close-out tables, RLS, revoke-then-grant                      | `anon` denied at grant level                          |
| 85  | Refund `REF-` codes, status, void, reverse; delete policy narrowed | policy live as `status='draft'`                       |
| 86  | Invoice dispute flag, write-off, dispute RPCs                      | —                                                     |
| 87  | `close_out_contract`, `cancel`, `restore`, `preview`               | preview smoke-tested live                             |
| 90  | Archive-aware list summaries (drops old signatures)                | one version each, `pronargs=4`                        |
| 91  | `archived_count` made mode-independent                             | `1` across all three modes                            |

Financial totals were captured before and after **every** apply and were identical each
time: **94 invoices, 21770.000 paid, 25790.000 balance.**

## 1.3 Feature completeness

- Close-out is atomic: one transaction, lock order contracts → tenants → invoices, **no
  `units` lock** (taking it first inverts the trigger chain and is the deadlock)
- Three outcomes are real and distinct — `keep_terminated` and `freeze` leave
  `archived_at` null; only `archive` moves lists
- Outstanding invoices require an explicit decision — the RPC refuses when one with
  `balance > 0` is omitted (proven live)
- Settlement goes through `apply_payment_allocation`; nothing writes `invoices.paid`
- Unit release is the migration-76 trigger's job; nothing writes `units.status`
- Idempotency replays the stored `result` jsonb; staleness raises `40001`
- Preview and commit share `closeout_compute_settlement`, so they cannot disagree
- Posted refunds can no longer be hard-deleted (RLS, not a hidden button)
- Restore preserves terminated state, leaves the portal disabled, changes no occupancy,
  and generates no invoices
- Wizard, Current/Archived/All tabs via `?view=`, archived + disputed badges, statement
  via the Arabic-correct print path, and four notification events

## 1.4 Test and gate state

| Gate                          | Result                                 |
| ----------------------------- | -------------------------------------- |
| `bun run typecheck`           | clean                                  |
| `bun run test`                | **871 passed**                         |
| `bun run lint`                | **0 errors**, 17 pre-existing warnings |
| `bun run build`               | ✓                                      |
| SQL — 5 close-out suites      | **65/65**                              |
| SQL — close-out notifications | **10/10**                              |

`lint` had 4 prettier errors inherited from PR #74 for most of this work; those are now
fixed in their own commit.

---

# Part 2 — What remains

## 2.1 Migrations not yet on production — **4**

| File                                      | Must be applied  |
| ----------------------------------------- | ---------------- |
| `88_closeout_notification_types.sql`      | **alone, first** |
| `89_closeout_workflows_and_templates.sql` | after 88 commits |
| `92_invoice_event_notification_types.sql` | **alone, first** |
| `93_invoice_event_workflows.sql`          | after 92 commits |

> **The single most likely way to break this deploy:** applying 88+89 (or 92+93) in one
> transaction. Migrations run `--single-transaction`, and a new enum value **cannot be
> used in the transaction that added it** — Postgres raises
> `unsafe use of new value of enum type`. 88 and 92 contain nothing but `alter type`
> precisely so they can commit on their own. Apply them as four separate `psql` runs.

## 2.2 PRs not yet opened — **3**

`feat/closeout-server-hooks`, `feat/closeout-ui`, `feat/closeout-notify-docs`.

## 2.3 Open product decisions

Contract auto-expiry (CON-00003 / CON-00013) — **blocked**, see
`2026-08-06-handover-remaining-work.md` §B.5. The critical constraint: auto-expiring a
contract to `expired` makes `close_out_contract` **refuse it permanently**
(migration 87 line 448), stranding any deposit settlement.

## 2.4 Pre-existing failure, not ours

`src/db/workflowRegistry.sqltest.ts` fails on `manual-payment-invoice` (migration 80
seeded it; the test's expected list was never updated). Failing on `main` before this
work began. Fix separately.

---

# Part 3 — Deploy sequence

Do database first, then merge. The app tolerates a database that is ahead; it does not
tolerate a database that is behind.

## Step 1 — apply the four migrations, in four separate runs

Transfer each file, verify md5 against local, then:

```bash
# 1
docker exec danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction -f /tmp/88.sql
# 2  (only after 1 returns)
… -f /tmp/89.sql
# 3
… -f /tmp/92.sql
# 4  (only after 3 returns)
… -f /tmp/93.sql

docker exec … psql -U supabase_admin -d postgres -c "notify pgrst, 'reload schema';"
```

**Do not concatenate them.** Do not run 89 before 88 has committed.

Transfer note: the Dokploy checkout's GitHub App token is expired, so `git fetch` on the
server fails. Use gzip + base64 chunks (SSH exec caps at 1000 chars), reassemble, and
**verify md5 before applying**.

### Post-apply verification

```sql
select unnest(enum_range(null::public.notification_types));   -- 4 new values present
select key, kind, is_active from public.cron_jobs
 where key in ('contract-closeout-completed','contract-restored',
               'invoice-written-off','invoice-disputed');      -- 4 rows, kind='event'
select count(*) from public.notification_templates
 where code like 'contract-closeout%' or code like 'contract-restored%'
    or code like 'invoice-written-off%' or code like 'invoice-disputed%';  -- 8 rows
select count(*) invoices, sum(paid) paid, sum(balance) balance from public.invoices;
--  must still read 94 / 21770.000 / 25790.000
```

## Step 2 — open the three missing PRs

Base each on the branch below it, not on `main`:

| PR  | head                         | base                         |
| --- | ---------------------------- | ---------------------------- |
| new | `feat/closeout-server-hooks` | `feat/closeout-rpcs`         |
| new | `feat/closeout-ui`           | `feat/closeout-server-hooks` |
| new | `feat/closeout-notify-docs`  | `feat/closeout-ui`           |

## Step 3 — merge in strict order

```
#76  feat/closeout-schema            → main
#77  feat/closeout-refund-reversal   → main   (retarget after #76 merges)
#78  feat/closeout-rpcs              → main   (retarget after #77 merges)
     feat/closeout-server-hooks      → main   (retarget after #78 merges)
     feat/closeout-ui                → main   (retarget after server-hooks merges)
     feat/closeout-notify-docs       → main   (retarget after ui merges)
```

**Why order is load-bearing.** The stack is linear — each branch contains its parent's
commits. GitHub auto-retargets a stacked PR to `main` when its base merges, but it does
**not** reorder them. Merging `closeout-ui` before `closeout-rpcs` would drag migrations
87 and 90 in under a UI title, making the history unreadable and any future bisect
useless.

**Use a merge commit, never squash or rebase.** This repo is Lovable-connected;
`AGENTS.md` forbids rewriting published history. Squashing a stacked PR also duplicates
its parent's commits onto `main`.

**Do not use `gh pr merge --auto`** — it merges immediately and aborts the CodeRabbit run
rather than waiting for it.

After each merge, confirm the next PR's base flipped to `main` and its diff shrank to only
its own commits **before** merging it.

## Step 4 — after the last merge

1. `git checkout main && git pull` — confirm migrations 82–93 are all present
2. `bun run test:db` — proves 82–93 apply to a clean database in filename order, the one
   thing production apply cannot prove
3. Dokploy auto-deploys on push to `main`. The database is already ahead, so this is safe.
4. Smoke-test on `danat-future.com`: Contracts → Archived tab shows CON-00008; open a
   close-out; confirm the wizard blocks on an unpaid invoice with no action selected.

---

# Part 4 — Failure modes to avoid, ranked

1. **Applying 88+89 or 92+93 together** → `unsafe use of new value of enum type`, whole
   transaction rolls back. Four separate runs.
2. **Merging the stack out of order** → unreadable history, migrations landing under the
   wrong PR title.
3. **Squashing a stacked PR** → duplicated parent commits on `main`, and it rewrites
   published history, which `AGENTS.md` forbids.
4. **`gh pr merge --auto`** → aborts CodeRabbit.
5. **Applying a migration without an md5 check after a chunked transfer** → a truncated
   file that partially applies. Always verify before `psql`.
6. **Trusting `git status` to prove an agent did not commit** → a run that commits leaves
   the tree clean. Compare `git rev-parse HEAD` before and after.
7. **Editing an already-applied migration** → production never sees the change; the repo
   and database silently diverge. Supersede by number instead.
8. **Reading `ssh-Musalam-2-mcp`** → that is the **old, decommissioned** host
   (`danatkuwait-*`). Production is `ssh-danatfuture-mcp` /
   `danatfuture-supabase-ozoxsa-db-1`. Both stacks are currently running, which is a live
   foot-gun worth resolving.

---

# Part 5 — Rollback

**Migrations 88/92 (enum values):** Postgres cannot remove an enum value. There is nothing
to roll back and nothing to fear — an unused value is inert.

**Migrations 89/93 (workflow + template rows):** set `is_active = false` on the four
`cron_jobs` rows. Do not delete them; the senders fail open on a missing gate row and
would send rather than skip.

**Application code:** revert the merge commit. The database stays ahead, which is the safe
direction — every schema change in this stack is additive except migration 82's repair
(`state` for already-archived contracts), and that one is a correctness fix nobody should
want back.
