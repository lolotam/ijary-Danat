# Insurance Netting Rehearsal & Post-Deploy Tasks (Migration 216)

Written 2026-09-17, after PRs #211, #212, and #214 merged and were independently verified live.
This is an action list, not a record; delete it once the items are closed.

## What is already confirmed good — do not re-verify

| Check | Result |
|---|---|
| #211 / #214 / #212 | MERGED `58ef8041`, `1915fdd7`, `3a378397` |
| Deployed commit | `3a37839` — matches #212's merge, the last one |
| Container | `efbc30ffc401` |
| Site | `/` 200, `/portal` 200 |
| Migrations 215 + 216 | `record_failed_login`, `failed_login_is_milestone`, `portal_insurance_total`, `failed_login_attempts` all present |
| Ladder behaviour | `failed_login_is_milestone` → 1 `true`, 2 `false`, 25 `true`, 125 `true` |
| RPC signature | `portal_insurance_total(p_tenant_id uuid, p_contract_id uuid)` — the contract-scoped version shipped |
| Insurance card vs ledger | Exact match for all 5 tenants holding insurance |

Those were checked against the live database and the running container. They do
not need repeating.

---

## 1. PRIORITY — rehearse a close-out with a deduction

**The netting logic has never executed.**

```
contract_closeouts: completed = 3, of which disposed = 0
```

Every completed close-out in production has `deductions_total`,
`refund_total` and `settled_total` all at zero. The most intricate thing that
shipped — netting deductions, unreversed settlement payments and live linked
refunds against collected insurance, with voided or reversed items restoring
their portions — is currently a **no-op on every row**. It has never subtracted
anything from anything in production.

Its first real exercise will be a live close-out where the office keeps part of
a deposit, on a number a tenant reads as "insurance held by the office".

Two paths shipped equally untested:

- the legacy settlement-payment linking added by migration 216;
- the **refusal** path for ambiguous legacy settlements. Codex's own preflight
  found "no historical completed settlements requiring backfill", so neither
  branch has met real data.

### Rehearsal procedure

Do this on a restored copy, never on production.

1. Restore the post-216 dump into a scratch database:

   ```bash
   # on the production host, into a THROWAWAY database name
   docker exec danatfuture-supabase-ozoxsa-db-1 \
     createdb -U supabase_admin rehearsal_216
   docker exec danatfuture-supabase-ozoxsa-db-1 \
     pg_restore -U supabase_admin -d rehearsal_216 \
     /root/danat_pre_migration_216_20260917_f97a7f3.dump
   ```

   That dump is *pre*-216, so apply `db/migrations/216_*.sql` to the scratch
   database before testing, which also re-proves the migration applies cleanly
   to a real production snapshot rather than to a synthetic test database.

2. Pick one contract that holds insurance. As of writing, the five tenants with
   insurance are `DANA-000010` (3500), `DANA-000069` (2400), `DANA-000064`
   (1250), `DANA-000033` (750), `DANA-000027` (700).

3. Record the card's value before:

   ```sql
   select public.portal_insurance_total('<tenant_id>'::uuid);
   ```

4. Close the contract out with a **partial deduction** — say 300 of a 750
   deposit — via the real RPC, not a hand-written UPDATE:

   ```sql
   select public.close_out_contract(
     p_contract_id                 := '<contract_id>',
     p_move_out_date               := current_date,
     p_outcome                     := 'keep_terminated',
     p_final_contract_state        := 'terminated',
     p_archive_tenant              := false,
     p_deductions                  := '[{"amount": 300, "reason": "rehearsal"}]'::jsonb,
     p_invoice_actions             := '[]'::jsonb,
     p_refund_amount               := 0,
     p_note                        := 'rehearsal only',
     p_idempotency_key             := 'rehearsal-' || gen_random_uuid()::text,
     p_expected_contract_updated_at := (select updated_at from public.contracts where id = '<contract_id>')
   );
   ```

   Confirm the exact deduction payload shape against
   `db/migrations/114_closeout_multi_unit.sql` before running — the argument
   list above is from that migration, but the `p_deductions` element keys should
   be read from its body rather than trusted here.

5. **Assert the card dropped by exactly the deduction and no more:**

   ```sql
   select public.portal_insurance_total('<tenant_id>'::uuid);  -- expect 750 - 300 = 450
   ```

   The failure modes worth catching are double-counting (450 → 150, because a
   deduction and its settlement payment both subtract) and over-netting to zero.

6. Then reverse it — void the refund or reverse the settlement — and assert the
   total **returns to 750**. The restore-on-reversal behaviour is claimed in the
   handover and is the half least likely to have been exercised.

7. Drop the scratch database.

An hour of this now is cheaper than explaining a wrong deposit figure to a
tenant, and it is the only way to learn whether the netting is right before it
matters.

---

## 2. Record the draft-deposit divergence

A draft contract with a positive deposit creates an `insurance_payments` row
(`mirrorInsurance` in `ContractFormDialog.tsx` has no state gate). Three places
now treat that row differently, deliberately:

| Surface | Counts draft deposits? |
|---|---|
| Insurance tab | Yes |
| Budget `insurance_collected` KPI | Yes |
| **Portal insurance card** | **No** — migration 216 excludes `c.state = 'draft'` |

The reasoning — holding deposits are often collected on draft leases, so staff
views should count them, while a tenant should not be told the office holds
money against a lease that was never agreed — exists only in this session's
conversation and in migration 216's comment. It is not in `docs/`, and the next
person to touch either surface will read the divergence as a bug.

Add a short section to `docs/ARCHIVE_RESTORE.md` or a new `docs/INSURANCE.md`
stating the rule and why. One paragraph.

---

## 3. Housekeeping

### Stale worktrees — 12 of them

```
F:/Danat-Mostakbal-206          fix/audit-206-followups        (merged as #211)
F:/Danat-Mostakbal-portal-212   feat/portal-insurance-card     (merged as #212)
F:/Danat-Mostakbal-cc           feat/postora-status-and-error-handling
F:/Danat-Mostakbal-ga-sql       slice/ga-sql
F:/Danat-Mostakbal-ga-ts        slice/ga-ts
F:/Danat-Mostakbal-gb-sql       slice/gb-sql
F:/Danat-Mostakbal-gb-ts        slice/gb-ts
F:/Danat-Mostakbal-gc           feat/properties-portal-flags
F:/Danat-Mostakbal-gc-sql       feat/properties-portal-flags-sql
F:/Danat-Mostakbal-gd           feat/contract-builder
F:/Danat-Mostakbal-rec          test/landing-142
F:/Danat-Mostakbal-wa           fix/media-error-download
F:/Danat-Mostakbal/.kilo/worktrees/brick-beak   (detached at 104c740)
```

The first two are finished work and safe to remove. **Check the rest for
uncommitted changes before removing any of them** — several are on branches that
never merged, and `git worktree remove` will refuse only if the tree is dirty,
not if the branch is unmerged:

```bash
for w in /f/Danat-Mostakbal-*; do
  echo "== $w"; git -C "$w" status --porcelain | head -5
done
git worktree remove /f/Danat-Mostakbal-206
git worktree remove /f/Danat-Mostakbal-portal-212
git worktree prune
```

`.kilo/worktrees/brick-beak` is a Kilo-created second checkout of this repo
inside itself. PR #213 excluded it from vitest, so it is no longer doubling the
test suite (688 files → 344), but it is still a full tree on disk and will
reappear if Kilo runs again. Remove it only if you are not mid-Kilo-session.

### Disk

```
C:  476G total, 454G used, 23G free (96%)
```

This filled completely earlier in the week and surfaced as **all 339 test files
failing with "no tests"** — a failure that looks exactly like a broken test
runner, not a full disk. Docker's WSL disk had grown to ~50 GB from repeated
`test:db` rebuilds and was never pruned:

```bash
docker system prune -af --volumes
```

Check `df` before believing a mass test failure.

---

## 4. Still open, untouched

- **PR #207** — `fix/gmail-sync-quota-v2`
- **PR #208** — `feat/tenant-portal-account-badge`

Both are the owner's own work. Nothing in this session touched them, and
neither was reviewed here.

---

## 5. Known flake, not worth chasing yet

`src/db/moduleSummaries.structure.test.ts > contracts and tenants are
archive-mode aware (migration 90/91)` intermittently exceeds its 5 s timeout
under full-suite parallel load — observed at 8.7 s and 9.8 s, passing in 4.5 s
when run alone. It reproduces on `main` with no local changes, so it is
pre-existing and unrelated to anything that shipped. It reads and parses the
whole migration set synchronously, and the set now has 211 files, so it will get
slower. Raise its timeout when it next becomes annoying rather than treating a
red suite as a real failure.
