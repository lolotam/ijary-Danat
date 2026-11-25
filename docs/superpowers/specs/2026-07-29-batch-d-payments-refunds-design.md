# Batch D — T4 KNET link · T13 Payment & Refund restructure

**Date:** 2026-07-29
**Tasks:** T4 (KNET-only payment link), T13a (refunds), T13b (partial payments),
T13c (insurance payments)
**Migration:** `db/migrations/56_refunds_partial_insurance.sql`
**Depends on:** Batch C2 — KNET links break if invoice UUIDs churn, which C2 fixed

---

## T4 — KNET-only payment link

### The field, confirmed against the live docs

The plan flagged this as "confirm before writing code", because the repo has zero
references to any method-restriction field and guessing is how you ship a link
that silently ignores the constraint. Checked against MyFatoorah's current v3
documentation:

|                |                                                                                |
| -------------- | ------------------------------------------------------------------------------ |
| Field          | `PaymentMethod` — singular, PascalCase, string                                 |
| Required?      | **Optional**                                                                   |
| Omitted        | "creates a payment page that displays all enabled methods" — today's behaviour |
| Allowed values | `CARD`, `APPLE_PAY`, `GOOGLE_PAY`, `KNET`                                      |

So `createHostedPayment` (`createPayment.ts:288`) gains one optional field. No
fallback to the v2 `InitiatePayment`/`ExecutePayment` pair is needed — that
contingency in the plan is closed.

### The constraint that shapes the UI

`createPayment.ts:159-164` rejects any selection that is not the oldest payable
invoice(s):

```
"Invoices must be paid in chronological order." (409)
```

This is enforced server-side against `evaluate_portal_payable_invoices`, and it
is a money-integrity invariant, not an accident — it is what stops a tenant
cherry-picking a cheap recent month while an old debt ages.

**Decision: keep it.** The admin action mints a KNET link under the same rule
the portal uses.

The action is offered on any unpaid, non-cancelled invoice, and a 409 is
translated into "an older invoice is still outstanding" rather than shown raw.
Pre-disabling it would be nicer, but selectability comes from
`evaluate_portal_payable_invoices` **per tenant**, and the invoice list is
paginated and filtered — so the oldest row on screen is not reliably the oldest
outstanding one. Guessing client-side would disable the button on invoices that
are in fact payable, which is a worse failure than an explained refusal.

The link is copied to the clipboard (falling back to opening a tab when
clipboard access is denied) so an admin can send it to a tenant directly.

`invoiceActions` is shared by the table and the mobile card render paths, so a
single addition covers both.

### The payment method is deliberately not part of the idempotency key

`reservePaymentRequest` reuses an existing **pending** request for the same
tenant + invoices. Adding the method to `idempotencyKey` would make a KNET
request and an all-methods request distinct, so both could hold live payment
links for the same money — with only one webhook settling it. Reuse in the other
direction is safe: an all-methods page still offers KNET, so it is a superset of
what was asked for.

---

## T13 — Payment and Refund

Nav renames `Payments` → `Payment and Refund` (`AdminSidebar.tsx:64`, both
locales). Two top-level tabs: **Payment** | **Refund**. Payment has three
sections — Full (the existing screen), Partial, Insurance.

### T13a — Refunds

New `public.refunds`: `contract_id`, `tenant_id`, a `unit_id`/`building_id`
snapshot, `amount`, `reason`, `post_action`, `created_by`, timestamps.

`post_action` is a new enum `public.refund_post_actions`:

| Value     | Meaning                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `archive` | tenant + contract hidden from normal views, portal login disabled; **invoices, payments and receipts are kept intact** |
| `freeze`  | visible, read-only, no new invoices                                                                                    |
| `store`   | a flag only; nothing else changes                                                                                      |

**Archive is a new column, not a lifecycle value.** `tenants.archived_at` and
`contracts.archived_at` (both nullable `timestamptz`). Adding an `archived`
member to `tenant_lifecycle` would collide with Batch C: lifecycle is now derived
from contracts, and an archive state would have to be sticky, giving the enum a
second sticky value and reopening exactly the argument C settled. A separate
nullable timestamp is orthogonal, records _when_, and leaves T8 untouched.

**Freeze reuses what exists.** `contract_states` already contains `frozen`
(`04_phase2…:26`), and `generate_invoices_for_year` only generates for
`state = 'active'`, so a frozen contract stops producing invoices with no new
code. Do not invent a second freeze flag.

#### Refund totals must filter by payment status

`reverse_payment` writes **positive mirror allocations**
(`05_phase3_invoices_payments.sql:656-657`), so a naive
`sum(payment_allocations.amount)` double-counts a reversed payment.
`get_budget_summary` already does this correctly:

```sql
where p.status = 'confirmed' and p.reversed_by_payment_id is null
```

Every refund aggregate follows that predicate. Refunds deduct from the budget.

### T13b — Partial payments

Deliberately **inert records**. `public.partial_payments` holds
`contract_id`, `tenant_id`, `invoice_id` (nullable), `amount`, `note`,
`created_by`.

- No `payment_allocations` rows.
- No effect on `invoices.paid` or `invoices.state`.
- Excluded from `get_budget_summary`.

**The isolation is the feature, so the tests assert it directly**: creating a
partial payment must leave invoice balances and every budget figure unchanged.
Without that assertion this table would quietly drift into the money path the
first time someone "improves" it.

The form takes a contract, which auto-populates building/tenant/unit and that
contract's invoices.

### T13c — Insurance payments

Created when a contract with `deposit > 0` is activated; removed when
deactivated.

**Must not reuse `public.deposits`.** That table models _bank_ deposits —
`bank_name`, `deposit_date`, `attachment_path`, and **no tenant or contract
link** at all (`08_phase6…`). It answers "what did we bank this week", not "what
insurance is this tenant holding with us".

**Must not reuse the `deposits` key** in `get_budget_summary`'s JSON either —
that key already backs a shipped KPI card (`BudgetDashboard.tsx:139`). Reusing
it would silently change what an existing card means.

So: new table `public.insurance_payments`, new budget key
`insurance_collected`, new "Total Insurance Paid" card on both the dashboard and
the budget screen.

---

## `get_budget_summary` v2

The function is currently defined **only** in
`08_phase6_expenses_deposits_budget.sql`. Migration 56 re-issues it, which means
**56 becomes the live definition** — the same supersede-by-number pattern
migration 44 already uses for `build_scheduled_report_html`. Anyone reading 08
after this is reading a stale body.

Returned object gains two keys and changes one:

| Key                                                           | Change                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `refunds`                                                     | **new** — sum of refunds in range                                        |
| `insurance_collected`                                         | **new** — sum of insurance payments in range                             |
| `net`                                                         | was `collections - expenses`; becomes `collections - expenses - refunds` |
| `deposits`, `collections`, `expenses`, `categories`, `months` | unchanged                                                                |

`net` changing is a deliberate, visible behaviour change: a refund is money that
left, so a net that ignored refunds would overstate. Called out here because a
reviewer seeing the KPI move should know it is intended.

---

## RBAC

New permission codes, seeded and granted:

| Code                                               | admin | accountant         |
| -------------------------------------------------- | ----- | ------------------ |
| `refunds.create` / `.read` / `.update` / `.delete` | ✅    | create/read/update |
| `partial_payments.*`                               | ✅    | create/read/update |
| `insurance.*`                                      | ✅    | create/read/update |

Accountant already holds the `payments`/`deposits`/`expenses` create/read/update
/export family (`03_phase1…:296-311`), so these follow the same shape. RLS
policies mirror `public.expenses`.

---

## Tests

| #   | Kind | Assertion                                                                                                                       |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Unit | `PaymentMethod: "KNET"` appears in the gateway payload when a KNET link is requested, and is **absent** otherwise               |
| 2   | Unit | requesting a link for a non-selectable invoice still 409s (the chronological invariant is not bypassed)                         |
| 3   | SQL  | a refund deducts from `get_budget_summary`'s `net`                                                                              |
| 4   | SQL  | a refund against a **reversed** payment does not double-count                                                                   |
| 5   | SQL  | `archive` sets `archived_at` on both tenant and contract and disables the portal login, **while invoices and payments survive** |
| 6   | SQL  | `freeze` leaves the contract visible and generates no new invoices                                                              |
| 7   | SQL  | **creating a partial payment changes no invoice balance and no budget figure**                                                  |
| 8   | SQL  | insurance rows are separate from `public.deposits` and appear under `insurance_collected`, not `deposits`                       |
| 9   | SQL  | non-staff cannot read refunds                                                                                                   |

Tests 5 and 7 are the ones that matter: 5 proves "archived" never means "deleted
financial history", and 7 proves partial payments stay out of the money path.

---

## Verification

`lint` / `typecheck` / `test` / `test:sql` / `test:db` green; migration 56
applied to production and re-probed; both locales smoke-tested.
