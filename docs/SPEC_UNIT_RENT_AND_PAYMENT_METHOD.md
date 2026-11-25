# Spec — contract-driven unit rent, and payment-method integrity

Two independent features, one branch. Written against measured production state,
not assumption. Every claim below was verified over `ssh-danatfuture-mcp` or by
reading the highest-numbered migration that defines the object.

---

## Feature 1 — Unit rent is read-only when the unit is under an active contract

### Problem

`UnitFormDialog` exposes `default_rent` as a free-text number
(`src/components/admin/UnitFormDialog.tsx:282`). For a unit that is already let,
this invites an admin to type a rent that disagrees with what the tenant is
actually billed — the contract is what generates invoices, not this column.

### Verified facts

| Fact | Evidence |
| --- | --- |
| Per-unit rent lives in `contract_units.monthly_amount` | `useContracts.ts:171,202` selects it into `units[].monthlyAmount` |
| `contracts.monthly_amount` is the **sum across the contract's units** | `useContracts.ts:387` — "trigger-maintained total" |
| The unit detail page already displays the wrong number for multi-unit contracts | `admin.units.$id.tsx:200` renders `active.monthly_amount`, the contract total |
| `units.default_rent` has consumers beyond this form | `useReportPreview.ts:235`, `bulkImportSchemas.ts:174`, `adminTableSortValues.ts:167`, `get_units_summary` |

### Decisions

1. **Display-only. `default_rent` is never overwritten with the contract rent.**
   Duplicating a value that already has a source of truth is how the two drift.
2. **When the unit has an active contract:** the field renders disabled, showing
   that unit's `contract_units.monthly_amount`, and `default_rent` is **omitted
   from the submit payload** so the stale stored value is not silently rewritten
   by a form that was only displaying something else.
3. **When the unit has no active contract:** unchanged — editable, submitted,
   exactly as today.
4. **Per-unit, not contract total.** The field reads
   `activeContract.units.find(u => u.unit.id === unitId).monthlyAmount`. Using
   `contracts.monthly_amount` would show a 3-unit contract's full rent on each of
   its three units.
5. **The parent supplies the value.** `UnitFormDialog`'s own header comment
   already assigns the occupancy lookup to the parent; this extends that contract
   with an `activeContractRent: number | null` prop rather than making the dialog
   fetch contracts.
6. **Two active contracts on one unit** (overlaps have existed in this data): pick
   the most recent `start_date`, deterministically, and document it.

### Explicit non-goals

- **`get_units_summary.rent_potential` is not changed.** It sums
  `default_rent` across all units (migration 79, line 329) and will therefore
  diverge from what this form displays for occupied units. That is a different
  surface, the user did not ask for it, and changing an accounting metric as a
  side effect of a form change is scope creep. Flagged here so it is a known
  divergence rather than a discovered one.
- Bulk import, report previews and units-table sorting keep reading
  `default_rent`. The read-only rule is form-only.
- The pre-existing multi-unit bug at `admin.units.$id.tsx:200` is noted, not
  fixed, in this change.

---

## Feature 2 — The recorded payment method reflects how the money actually arrived

### Problem

Marking an invoice paid with reason **"Audit / data adjustment"** records the
settling payment as **Cash**. Reporting then cannot tell a real cash payment from
a bookkeeping correction.

### Root cause — measured, not guessed

Production `option_list_items` for `manual_payment_reasons`:

```
bank_transfer            | Bank transfer               | {"payment_method": "bank_transfer"}
complete_partial_payment | Complete / partial payment  | {"payment_method": "cash"}
cheque                   | Check                       | {"payment_method": "cheque"}
audit_adjustment         | Audit / data adjustment     | {"payment_method": "cash"}   ← the bug
```

`set_invoice_paid` (live body is **migration 129**, not 108 — 147 and 153 only
reference it) reads `metadata->>'payment_method'` from that list and falls back to
`cash`. So the reason is mapped to a method that cannot represent it, because
`public.payment_methods` has no such value:

```
payment_link, bank_transfer, cheque, cash, knet, applepay, googlepay, card
```

`complete_partial_payment → cash` looked wrong in the same way, and the first
draft proposed changing it. It is deliberately left alone: a complete or partial
payment handed over in person genuinely *is* cash, and once the admin can pick
the method directly that mapping is only a fallback for callers that still send
a reason. The defect was never the mapping itself — it was having no method that
could represent an adjustment.

### Decisions

1. **Collapse the indirection.** The reason→metadata→method hop is what produced
   the bug. The mark-paid dialog offers the **same catalog** as the Add Payment
   form's Payment Method dropdown, and the chosen value is recorded directly as
   `payments.method`. This is literally what the user asked for: *"By using the
   exact same options, the selected method will then display consistently."*
   **Amended after round 1:** gateway methods are filtered out of the mark-paid
   dialog only (objection 5) — an admin must not be able to hand-enter a KNET
   payment that has no MyFatoorah transaction behind it. Add Payment keeps the
   full catalog, and `manual_payment_reason` keeps being written (objection 4).
2. **One new enum value: `audit_adjustment`** on `public.payment_methods`. Named
   for the value already present in production reason data, so existing rows map
   without a data migration. Prior art for the DDL: migrations 06 and 18
   (`alter type … add value if not exists`).
3. **An `option_list_items` insert is required.** Production's `payment_methods`
   option list has exactly five active items (`payment_link`, `cash`,
   `bank_transfer`, `cheque`, `knet`) and `admin.payments.tsx:182` reads it via
   `useListDrivenOptions`. A new enum value alone would **not** appear in the
   dropdown.
4. **`set_invoice_paid` is re-issued in a new migration.** Editing 129 in place
   does not reach production. The new definition takes the method directly and
   keeps the reason-list lookup only as a backward-compatible fallback for callers
   that still pass a reason value.
5. **Gateway → "Payment link" is display-layer only.** `knet`, `card`, `applepay`
   and `googlepay` stay in the data — reconciliation against MyFatoorah needs the
   real instrument. The payments table and the invoice method column render all
   gateway-settled methods under one **Payment link** label. Retroactive for
   existing rows, no migration, and the webhook's recorded method is untouched.
   **Amended after round 1:** the label keeps the instrument — **"Payment link
   (KNET)"** — so the requested grouping does not destroy the distinction
   reporting needs (objection 6).
6. **The `sync_invoice_payment_method` trigger is re-issued** to exclude reversed
   payments. It filters `p.status = 'confirmed'`, but `reverse_payment` leaves the
   original row `confirmed` and flags it with `reversed_by_payment_id`, so a
   reversed payment's method stays glued to the invoice. Uses the predicate the
   codebase already established at `05_phase3_invoices_payments.sql:193`
   (objection 8). This is a pre-existing bug surfaced by the review.

### Client-side ripple (all four must change together)

| Location | Change |
| --- | --- |
| `admin.payments.tsx:110,115` | hardcoded `methods` array + Zod enum gain `audit_adjustment` |
| `src/integrations/supabase/database.types.ts` | `PaymentMethod` union — **hand-maintained**, never overwrite with `gen:types` |
| `src/i18n/` both locales | `paymentMethod.audit_adjustment` — `dictionary.test.ts` fails on a one-sided key |
| `MarkInvoicePaidDialog.tsx` | list source switches from `manual_payment_reasons` to `payment_methods` |

---

## Migration and deploy order

Schema change, so the ordering is not optional:

1. New migration (next free number — read `ls db/migrations | sort -V | tail`).
   `alter type … add value` first; jsonb/text writes after. A new enum value
   cannot be cast into an enum-typed column **in the same transaction** that adds
   it; the production apply path is autocommit-per-statement, so this holds.
2. `bun run test:sql` — builds a clean database from scratch and proves the whole
   set still applies in order.
3. Apply to live Supabase over **`ssh-danatfuture-mcp`** against
   `danatfuture-supabase-ozoxsa-db-1`, checksummed against the local file, then
   `notify pgrst, 'reload schema'` — without it PostgREST keeps a stale signature
   cache and the re-issued RPC 404s.
4. **Only then** merge to `main`. The merge auto-deploys via Dokploy, so new code
   must never reach production ahead of its schema.

---

## Feature 3 — Page size and filters on `/admin/payments`

### Problem

`src/routes/admin.payments.tsx:155` hardcodes `const pageSize = 10`, and the only
filter is a free-text search box.

### Verified facts

- `usePayments` **already accepts** `method`, `status`, `tenantId`, `search`,
  `page` and `pageSize`, and already keys the query on all of them
  (`usePayments.ts:47-49`). Date and amount ranges are the only genuinely new
  parameters.
- There is a deliberate design constraint recorded in the code
  (`admin.payments.tsx:1001-1003`): *"Payments has no page-level filter. The
  Full-tab search stays local so it cannot drive Refunds/Partial/Insurance
  totals (those ledgers have no code/status columns)."*

### Decisions

1. **Page size selector: 10 / 25 / 50 / 100**, replacing the hardcoded 10.
   Default stays 10 so nothing changes for anyone who does not touch it.
2. **Filters apply to the Full tab's table only — never to the summary cards.**
   This honours the existing constraint rather than overriding it: the KPI cards
   keep reading unfiltered totals, because a filtered "total payments" figure
   that still looks like a module total is a reporting trap.
3. **Filter set:** date from/to (on `payment_date`), payment method, tenant,
   amount min/max, status. Method and status reuse the same option-list-driven
   catalogs as everything else, so Feature 2's new value appears automatically.
4. **New hook parameters:** `dateFrom`, `dateTo`, `amountMin`, `amountMax` added
   to `PaymentListParams` and to the query key, so a filter change refetches.
   No migration — these are PostgREST range filters on existing indexed columns.
5. **Filters live in the URL search params**, matching how the rest of the admin
   surfaces persist table state, so a filtered view can be linked and survives a
   reload.

### Non-goals

- Refunds, Partial and Insurance tabs keep their current behaviour. Their ledgers
  lack the columns these filters target, which is exactly why the original design
  note kept the search local.

## Codex round-1 review — objections and resolutions

Codex **rejected** the first draft with 11 objections. Resolutions below; the
design above is amended accordingly.

**Adopted — the plan changes:**

| # | Objection | Resolution |
| --- | --- | --- |
| 4 | Switching the dialog to methods loses the reason semantics | `manual_payment_reason` keeps being written alongside the method. The dialog sends one value; the RPC records it as both the method and the reason, so nothing that reads the reason today breaks. |
| 5 | An admin could manufacture a gateway-attributed payment with no gateway evidence | **Gateway methods are filtered out of the mark-paid dialog** (`payment_link`, `knet`, `card`, `applepay`, `googlepay`). This is a deliberate, documented departure from "identical options": all four reasons the user named are non-gateway, and a hand-entered KNET payment with no MyFatoorah transaction behind it is a reconciliation hazard. Add Payment keeps the full catalog. |
| 6 | Collapsing four gateway methods to one label loses information | The label reads **"Payment link (KNET)"** — the requested grouping, with the instrument preserved rather than discarded. |
| 8 | Reversals were unspecified | Real gap, and a **pre-existing bug**: `sync_invoice_payment_method` filters `p.status = 'confirmed'`, but `reverse_payment` leaves the original row `confirmed` and marks it via `reversed_by_payment_id`. So a reversed payment's method stays glued to the invoice. The trigger is re-issued with the codebase's own established predicate — `status = 'confirmed' and reversed_by_payment_id is null` (the idiom already at `05_phase3_invoices_payments.sql:193`). |
| 9 | "Direct method with reason fallback" is ambiguous | Precedence stated explicitly: **method wins when supplied**; the reason-list lookup runs only when the method argument is null; `cash` remains the final fallback. A gateway method passed to the manual path is rejected by the RPC, not silently accepted. |
| 11 | Option-list insert needs idempotency | Uses migration 21's established idiom: `insert … on conflict (list_id, value) do nothing`, scoped to the list id, with `is_system = true`. A re-run must not resurrect an item an admin disabled. |

**Noted as known limitations, deliberately not fixed here:**

- **(7) `invoices.payment_method` cannot represent a mixed-method settlement.**
  True, and inherent to migration 108's design — it is defined as "the method of
  the most recent confirmed allocation". Changing that is a data-model change to
  an accounting field, far beyond this request.
- **(10) Contract closeout (87, 114) and deposit settlement (153) still hardcode
  `cash`.** Real inconsistency, genuinely out of scope: both are money-moving RPCs
  with their own semantics, and widening this change to touch closeout accounting
  would put the user's actual request behind a much riskier refactor.

**Acknowledged as a user-directed trade-off:**

- **(2, 3) `audit_adjustment` is an accounting reason, not a tender type**, and
  putting it in `payment_methods` conflates *why a balance changed* with *how
  money arrived*. Codex is right in the abstract. It is also precisely what was
  asked for — "add Manual Adjustment as a new option in this dropdown … make the
  selected reason appear under payment method" — and the alternative (a second
  column rendered as a method) delivers the same conflation with more machinery.
  Recorded here so the trade-off is owned, not stumbled into.

**Confirmed, no change needed:**

- **(1)** Adding an enum value and using it in *later* statements is safe under
  autocommit-per-statement; it would only fail inside a single transaction.

## Open questions for the Codex debate


1. Should the mark-paid dialog show the *whole* `payment_methods` catalog —
   including `payment_link` and `knet`, which are gateway instruments an admin
   settling by hand arguably should not be able to claim? "Identical options" is
   the user's literal request; a filtered subset would be safer but is no longer
   identical.
2. Is keeping `manual_payment_reason` written at all still worthwhile once the
   method carries the same information, or does it become a second source of
   truth for one fact?
3. Is `audit_adjustment` the right enum name, versus the user's own phrase
   "Manual Adjustment" (`manual_adjustment`)?
