# Spec — free months bill nothing; a fully-discounted month may waive its service charges

Status: revision 3 — Codex round 2 objections resolved
Branch: `feat/free-months-zero-and-waive-extras`
Supersedes part of: migration 168 (free month bills its extras), migration 169 (fixed discount capped at subtotal)

## Why

Migrations 168/169 shipped two money rules the operator has since revised:

- 168 made a free month bill its recurring service charges. The operator wants a
  free month to bill **nothing** — "the total of these free months will be zero".
- 169 left a percentage discount off the rent only, so a 100% discount still left
  the service charges due. The operator wants the app to **ask** in that case,
  because a fully-discounted month is free "by any means".

Neither rule has ever moved a real invoice: `contract_extra_charges` is empty in
production (verified 2026-08-30), so no invoice carries a service charge yet.

## Requirement 1 — a free period generates nothing

**Every** free month, wherever it falls in the term. Operator's explicit choice
over "only free months at the start"; production holds 56 active free-month
concessions, 55 at the contract start and 1 mid-contract, and one uniform rule
was preferred over a distinction affecting a single contract.

This is a revert of 168 — restoring the bodies 164/165 shipped, which already
skip a free month entirely and add extras to every non-free month:

| function | restore from |
| --- | --- |
| `contract_period_amounts` | 164 |
| `generate_invoices_for_year` | 164 |
| `regenerate_contract_invoices` | 165 |
| `sync_contract_invoice_schedule` | 165 |

169's `append_extra_charge_items` is **not** touched — it stays as 169 left it so
extra-charge lines keep setting `is_extra_charge`. 170 must not re-issue it.

### The invariant, stated correctly (Codex round 1)

"Every free month emits no invoice at all" is **false** and must not be written
that way. The restored bodies preserve money and human decisions:

- **Paid / partially-paid invoices survive untouched** — regenerate at
  `165:74`, sync at `165:291`, already pinned by `contractScheduleSync.sqltest.ts:263`.
- **A concession-linked invoice is never deleted** (`165:91`); sync reports it
  `blocked` when its month becomes free (`165:316`), pinned at
  `contractScheduleSync.sqltest.ts:317`.
- **An unpaid invoice with allocations or a pending payment request is
  cancelled, not deleted** (`165:152` regenerate, `165:381` sync).
- **A closeout-referenced invoice is protected in `sync` ONLY** (`165:376`, which
  documents why: `contract_closeout_invoice_actions.invoice_id` is
  `ON DELETE RESTRICT`, so an unguarded delete raises 23503 and takes the whole
  reconciliation with it). `regenerate_contract_invoices` has **no** such check
  (`165:152`) and will attempt the delete.

So the real invariant is:

> **No new invoice is generated for a free period. When a period becomes free,
> only a clean, fully-unpaid, undiscounted invoice is removed; paid,
> partially-paid, discounted and otherwise-referenced invoices are preserved or
> cancelled exactly as they are today.**

Correspondingly, the earlier claim that any 168-era extras-only invoice "will be
deleted or cancelled" is **false** where that invoice carries a
`concession_invoices` link. No such invoice exists in production; a database
where one does must be inspected before applying 170.

**Pre-existing gap, deliberately not fixed here (Codex round 2).** The missing
closeout check in `regenerate_contract_invoices` is a defect that ships in 165
today, unrelated to free months and unrelated to extras. 170 is a *revert*, and
bundling a bug fix into a revert would make the diff impossible to read against
164/165 — the one property that makes a verbatim restore reviewable. Recorded
here so it is a decision rather than an oversight; it deserves its own migration
and its own test.

## Requirement 2 — ask, per invoice, before waiving service charges

When a discount fully covers a month's rent and that invoice carries service
charges, the admin is asked whether to waive those too.

- **No** (default) — unchanged from 169. The discount covers the rent; the
  invoice total equals the service charges.
- **Yes** — the discount widens to the full subtotal, total becomes 0. The charge
  lines stay on the invoice, so it still records what was charged and what was
  forgiven, and deleting the concession restores the amounts through the existing
  delete trigger (`127:640`).

### Per invoice, not per batch (Codex round 1 — accepted)

A single boolean for the batch is unsafe: one fixed concession can fully cover
rent on one invoice and only partially on another, meet extras on some months and
not others, and represent different intent per month. Prompting when *any*
invoice qualifies and applying the answer to *every* selected invoice is exactly
how the wrong month gets silently waived.

**The RPC therefore takes ids, not a flag:**

```sql
apply_concession_to_invoices(
  p_concession_id uuid,
  p_invoice_ids uuid[],
  p_waive_extra_charge_invoice_ids uuid[] default '{}'
)
```

The UI stays one dialog: the qualifying invoices are listed with an individual
toggle each, plus a select-all.

### The client asks; the locked row decides (Codex round 1 — accepted)

The client helper decides only what to *show*. It cannot authorize a waiver —
the data can change between selection and submit. Inside the loop, **after**
`select … for update`, the function recomputes `rent_base` from the locked row
and widens **only if** that invoice is genuinely fully covered and genuinely
carries extras. An id passed in `p_waive_extra_charge_invoice_ids` that does not
qualify at lock time is ignored, never applied blindly.

### Fixed-discount cap — decision

Cap a fixed discount at the **rent base**, matching percentage. Today (169) it is
capped at the whole `subtotal`, so a fixed discount silently eats service charges
and there is no clean "rent fully covered" trigger for it: a fixed 520 on a
500 + 50 invoice leaves 30 with no prompt ever shown.

After this change both discount types are rent concessions and **the prompt is
the only way a service charge is ever discounted** — which is the auditable
property requirement 2 is asking for. Cost: it revises 169's documented fixed
behaviour one day after it shipped, affecting no production invoice (0 active
percentage discounts, 0 service charges in existence).

*Codex: confirm or reject this in round 2.*

### Trigger condition (client-side display only)

```
rent_base        = subtotal - sum(amount where is_extra_charge)
extras           = subtotal - rent_base
discount_on_rent = percentage ? round(rent_base * pct/100, 3) : min(rent_base, fixed)
qualifies        = (rent_base - discount_on_rent == 0) AND extras > 0
```

`DiscountableInvoice` currently exposes only id, code and period
(`useConcessionInvoices.ts:8`). It must also carry `subtotal` and the flagged
extras total — an explicit data-loading change, not an afterthought.

**Row-cap safety (Codex round 2).** The existing invoice query already guards
against PostgREST silently truncating a wide page (`useConcessionInvoices.ts:33`).
Aggregating `invoice_items` for the extras total is a *second*, larger read —
several lines per invoice — so it must carry the same guard. An extras total
short by a truncated page reads as "this invoice has no service charges", which
hides the prompt and silently bills them.

## Known interaction, documented not fixed

Deleting a percentage/fixed concession does not run schedule sync; only
free-month deletion does (`ConcessionsDialog.tsx:294`). So a discounted invoice
that sits inside a free period has its rent **and** extras restored by the delete
trigger even though the month is free. This predates the change and is the same
`blocked` conflict the sync already surfaces for a human to settle. Out of scope;
recorded here so the next reader does not mistake it for a regression.

## Plan

| # | Step | Artifact |
| --- | --- | --- |
| 1 | Migration 170 — restore the four pricing functions from their 164/165 bodies. Do **not** touch `append_extra_charge_items`. | `db/migrations/170_*.sql` |
| 2 | Migration 171 — `apply_concession_to_invoices` gains `p_waive_extra_charge_invoice_ids uuid[]`. **DROP then CREATE** (a new parameter under `create or replace` makes an overload and PostgREST 404s on ambiguity — the migration-142 shape), re-issue the grants the drop takes with it, `notify pgrst`. Verify exactly one `pg_proc` row **and** inspect `proacl`. Fixed cap moves to rent base. Eligibility recomputed under the row lock. | `db/migrations/171_*.sql` |
| 3 | `useApplyConcessionToInvoices` passes the id array; `DiscountableInvoice` gains subtotal + extras | `src/hooks/useConcessionInvoices.ts` |
| 4 | Pure helper: which invoices qualify for the prompt | `src/lib/` + unit test |
| 5 | Per-invoice toggles in the confirm step, both locales | `ConcessionsDialog.tsx`, `src/i18n/dictionary.ts` |
| 6 | SQL tests — see below | `src/db/*.sqltest.ts` |
| 7 | Rewrite `freeMonthAndDiscountSemantics.sqltest.ts`; its 168 assertions now assert the opposite | same file |
| 8 | Bump `billingSafety.structure.test.ts` live-migration pin to 170 | that file |

## Tests required (Codex round 1)

Requirement 1:
- free period generates nothing, on all four paths;
- a **paid** and a **partially-paid** invoice in a newly-free month survive, both regenerate and sync;
- a **concession-linked** invoice in a newly-free month is preserved / reported `blocked`;
- an unpaid invoice with an allocation or pending request is **cancelled, not deleted**.

Requirement 2:
- waive id present and the invoice qualifies → discount = subtotal, total 0;
- waive id present but the invoice is only **partially** covered → ignored, never widened;
- waive id absent → 169 behaviour (discount = rent only);
- mixed batch: extras/no-extras and fully/partially-covered invoices each get the correct independent result;
- a later invalid invoice in the batch **rolls back** earlier loop mutations;
- deleting the concession after a widened waiver restores rent **and** extras, the original charge lines, and leaves no concession line or link — across a multi-invoice concession.

## Verification

Every splice mutation-tested. `test:db`, `test:sql`, `test`, typecheck, lint.
Guards: `clean-code-guard`, `test-guard`, `docs-guard`.

**Migrations are run manually by the operator.** Merging auto-deploys, so 170 and
171 must be applied to production *before* the PR merges.

## Non-goals

- No change to how free months are created or to `period_in_free_months`.
- No backfill; no invoice carries a service charge yet.
- The delete-without-sync interaction above is documented, not fixed.
