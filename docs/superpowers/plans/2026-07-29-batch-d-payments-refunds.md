# Batch D — Implementation plan

**Spec:** `docs/superpowers/specs/2026-07-29-batch-d-payments-refunds-design.md`
**Branch:** `feature/batch-d-payments-refunds`
**Status:** Implemented 2026-07-29

Three commits: T4 on its own (small, independent), then the schema, then the UI.

---

## Commit 1 — T4: KNET-only payment link

**Files**

| File                            | Change                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/fns/createPayment.ts`      | optional `paymentMethod` on the input schema; pass `PaymentMethod` through to the gateway payload |
| `src/routes/admin.invoices.tsx` | KNET-link action, desktop row **and** mobile card                                                 |
| `src/fns/createPayment.test.ts` | tests 1–2                                                                                         |
| `src/i18n/dictionary.ts`        | both locales                                                                                      |

**Steps**

- [x] 1.1 Add `paymentMethod: z.enum(["KNET"]).optional()` to the validator. Deliberately narrow: `CARD`/`APPLE_PAY`/`GOOGLE_PAY` are not requested, and a wider enum invites passing a method the account has not enabled.
- [x] 1.2 Thread it into `createHostedPayment` and emit `PaymentMethod` **only when set** — omitting it is what produces today's all-methods page, so an unconditional key would change existing behaviour.
- [x] 1.3 Add the action to both render paths, disabled with an explanatory tooltip when the invoice is not the oldest payable one.
- [x] 1.4 Tests: the payload carries `PaymentMethod: "KNET"` when asked and has no such key otherwise; a non-selectable invoice still 409s.
- [x] 1.5 `lint && typecheck && test` green.

**Trap:** do not weaken the chronological check to make the admin action
convenient. It is what stops a tenant cherry-picking a cheap recent month while
an old debt ages.

---

## Commit 2 — Migration 56: refunds, partial payments, insurance

**Files**

| File                                             | Change                                        |
| ------------------------------------------------ | --------------------------------------------- |
| `db/migrations/56_refunds_partial_insurance.sql` | new                                           |
| `src/integrations/supabase/database.types.ts`    | hand-add three tables + the changed RPC shape |
| `src/db/refunds.sqltest.ts`                      | tests 3–9                                     |

**Steps**

- [x] 2.1 `public.refund_post_actions` enum via the `do $$ … exception when duplicate_object` idiom. **Never `create type if not exists`** — that is not valid Postgres and is precisely what made migration 52 unusable.
- [x] 2.2 `public.refunds`, `public.partial_payments`, `public.insurance_payments`. Each: `company_id`, the entity links, `amount numeric(14,3) check (amount > 0)`, `created_by`, timestamps, `tg_set_updated_at` trigger.
- [x] 2.3 `tenants.archived_at` and `contracts.archived_at`, both nullable `timestamptz`. **Not** a new `tenant_lifecycle` member — see the spec.
- [x] 2.4 Seed permissions + role grants; RLS policies mirroring `public.expenses`.
- [x] 2.5 Re-issue `get_budget_summary` with `refunds` and `insurance_collected`, and `net = collections - expenses - refunds`. Refund and insurance sums filter on `status = 'confirmed' and reversed_by_payment_id is null` where they join payments.
- [x] 2.6 Hand-write the `database.types.ts` entries. Never `gen:types` over it.
- [x] 2.7 SQL tests 3–9. Test 7 asserts a partial payment moves **nothing**.
- [x] 2.8 `bun run test:db && bun run test:sql` green.

**Trap 1:** new `public` tables arrive with `ALL` already granted to `anon` and
`authenticated` via Supabase's `alter default privileges`. RLS still applies, but
if any of these ever gains a secret column it needs an explicit `revoke` first.

**Trap 2:** `net` changes meaning. Update the SQL test that asserts the old
`collections - expenses` if one exists, rather than leaving it to fail
mysteriously.

---

## Commit 3 — The Payment and Refund UI

**Files**

| File                                       | Change                                                      |
| ------------------------------------------ | ----------------------------------------------------------- |
| `src/components/admin/AdminSidebar.tsx`    | rename to "Payment and Refund"                              |
| `src/routes/admin.payments.tsx`            | Payment \| Refund tabs; Full / Partial / Insurance sections |
| `src/hooks/useRefunds.ts`                  | new                                                         |
| `src/components/admin/BudgetDashboard.tsx` | "Total Insurance Paid" card                                 |
| `src/i18n/dictionary.ts`                   | both locales                                                |

**Steps**

- [x] 3.1 Clone the table/filter/CSV/dialog/pager skeleton from `admin.expenses.tsx` + `useExpenses.ts` rather than inventing one.
- [x] 3.2 Refund form: contract dropdown auto-populating building/tenant/unit, amount, reason, `post_action`.
- [x] 3.3 Applying `archive` stamps both `archived_at` columns and disables the portal login; `freeze` sets `contracts.state = 'frozen'`; `store` does nothing further.
- [x] 3.4 Partial-payment form; make its inertness visible in the UI copy so nobody expects it to settle an invoice.
- [x] 3.5 Insurance section + the new KPI card.
- [x] 3.6 Both locales for every key.
- [x] 3.7 `format`, then all four gates green.

---

## Landing

- [ ] 4.1 Push, PR describing the `net` change and the archive-is-not-delete semantics.
- [ ] 4.2 Merge. Never force-push, rebase, amend or squash.
- [ ] 4.3 Apply migration 56 to production; re-probe.
- [ ] 4.4 Cut Batch E from the updated `main`.
