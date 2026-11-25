# S04 — `src/routes`: admin money (invoices, payments, contracts, deposits, expenses, close-out)

**Lines read:** ~4,820 · **Files:** 7 · **Date:** 2026-09-22

`admin.payments.tsx` (1177) · `admin.contracts_.$id.closeout.tsx` (1115) ·
`admin.expenses.tsx` (930) · `admin.invoices.tsx` (524) · `admin.deposits.tsx` (458) ·
`admin.contracts.tsx` (457) · `admin.contracts_.builder.tsx` (163).

**Overall:** the data layer is cleanly separated — only 4 of ~100 route files touch
`supabase` directly, and the money *rules* have genuinely been extracted to
`src/lib/invoiceSettlement.ts`. What has collapsed is **size**: three components of 924,
989 and 587 lines. And the rule that was extracted got extracted **six times**.

---

## Findings

### 1 · High — "settle oldest first" is implemented six times, and on the admin payment path it lives only in the browser

**Where:** `routes/admin.payments.tsx:364` is the enforcement point; the rule itself exists in:

| # | Implementation | Layer | Path it guards | Tiebreak on equal period |
| --- | --- | --- | --- | --- |
| 1 | `lib/invoiceSettlement.ts:38-40` (`settleableInvoices` sort) + `:86` (`isContiguousPrefix`) | TS, **browser** | admin full payment | `code.localeCompare` |
| 2 | `lib/depositInvoiceOptions.ts:44-56` (`cutoff` via `findIndex`) | TS, **browser** | deposit → invoice link | **none** |
| 3 | `lib/invoiceBulkSelection.ts:40-45` (`orderForBulkSettle`) | TS, **browser** | bulk mark-paid | **none** |
| 4 | `fns/createPayment.ts:277-295` (prefix check) | TS, server | portal + gateway | RPC's order |
| 5 | `evaluate_portal_payable_invoices` (migration 121) | SQL | portal | — |
| 6 | `set_invoice_paid_chronological` (migration 129) | SQL | mark-as-paid | `(year, month)` tuple |

The file states the consequence itself, at `admin.payments.tsx:355-364`:

> *"`apply_payment_allocation` — the function this path actually reaches — rejects an
> over-allocation but has NO chronological check… So on the full-payment path the ordering
> rule lives here."*

**Which means two separate things.**

**(a) The rule is unenforceable outside the browser on that path.** `applyAllocation` is a
server fn granted to `authenticated`, and neither it nor the RPC beneath it checks ordering.
Anyone holding `payments.create` who calls it directly — or who has a stale page open while
the invoice set changes — settles a newer month while older arrears stand, and nothing in
the audit trail marks it as out of order. This is the skill's canonical layer-collapse
shape: *the API accepts what the UI forbids.*

**(b) Three of the six sort comparators disagree.** #1 breaks a period tie on
`code.localeCompare`; #2 and #3 have **no tiebreak at all**, so two invoices in the same
`(year, month)` sort in whatever order the array arrived in — which for a paginated or
refetched query is not stable. Two screens can therefore offer different "oldest" invoices
for the same contract.

**Fix — and the documented objection does not block it.** The comment argues, correctly,
that making `apply_payment_allocation` raise would *"strand gateway money mid-webhook,
since the MyFatoorah callback and paymentReconcileJob call it too."* That argument applies
to the **RPC**, not to the **user-scoped server fn**: move `isContiguousPrefix` into
`fns/applyAllocation.ts`, where the webhook never goes. The rule then holds for every
browser and every direct call, and the gateway path is untouched. Separately, give #2 and #3
the same `(year, month, code)` comparator as #1 — one exported function, three call sites.

---

### 2 · Medium — three route components of 924, 989 and 587 lines

*(Medium by the skill's rubric — it costs time on every change rather than risking a wrong
answer — but it is the largest single maintainability win available in this audit.)*

**Where:** `admin.payments.tsx:165-1088` (`FullPaymentsPanel`, **924 lines**, 13 `useState`,
2 `useMemo`, 1 `useEffect`, 1 `useRef`) · `admin.contracts_.$id.closeout.tsx:126-1115`
(`CloseoutWizard`, **989 lines**, 8 `useState`, 5 `useEffect`) ·
`admin.expenses.tsx:133-719` (`ExpensesPage`, **587 lines**, 14 `useState`).

All three are 1.5–2× the repo's own 500–600 line **file** ceiling *as single components*.
Each holds more than one reason to change:

- `FullPaymentsPanel` — the payments table + filters + pagination, the create-payment form,
  the multi-invoice settlement loop (`settleInvoices`), the allocation dialog, the reversal
  dialog, and the receipt viewer. Six features, one function body, thirteen pieces of state
  with no grouping.
- `CloseoutWizard` — a five-step wizard where `FIELDS_BY_STEP`, step validation, the
  deduction editor, the invoice-action table, the refund prefill and the preview all share
  one scope. Five `useEffect`s in one component is where an ordering bug hides; one of them
  (`:279`) drives a preview from a `useMemo`'d draft, which is a render-order dependency
  nothing enforces.
- `ExpensesPage` — list, filters, create/edit form, attachment upload, CSV import, **and**
  the category manager, which then has its own `CategoryEditor` and `CategoryManager`
  components 100 lines further down the same file.

**Which means:** `admin.payments.tsx` churns 32× a year and `admin.contracts.tsx` 50× — this
is the size×churn intersection, and the practical cost is that a change to the reversal
dialog requires loading the settlement loop into your head to be sure you have not moved
state something else reads. It is also over the limit at which the repo's own `CLAUDE.md`
says an agent can edit a file reliably.

**Fix:** split by feature, not by layer, and lift the state with it. `FullPaymentsPanel` →
`PaymentsTable`, `CreatePaymentDialog` (owning `settleInvoices` and the form),
`AllocationDialog`, `ReversalDialog`. `ExpensesPage` → move `CategoryEditor` +
`CategoryManager` (160 lines, already separate components) into
`components/admin/expenses/`. `CloseoutWizard` → one component per step, with the wizard
owning only `step`, the form and `success`. This is the **largest single maintainability win
available in this audit** and it changes no behaviour.

---

### 3 · Medium — editing an imported expense silently rewrites its classification

**Where:** `routes/admin.expenses.tsx:83-92` (`classFromRecurrence`) and `:239`
(`class: classFromRecurrence(values.recurrence)`) vs `lib/bulkImportSchemas.ts:45` and
`db/migrations/08_phase6_expenses_deposits_budget.sql:3`

The `expense_classes` enum has **four** values —
`contractual_monthly`, `contractual_annual`, `regular_recurring`, `sudden_one_time`. The CSV
importer accepts all four (`bulkImportSchemas.ts:45`). `classFromRecurrence` can only ever
produce **three**: `contractual_monthly` is unreachable from the UI, and every save
overwrites `class` from `recurrence`.

**Which means:** an expense imported as `contractual_monthly` displays correctly (the
i18n keys exist, `dictionary.ts:931-933`… for three of them — `contractual_monthly` has no
label either). The first time anyone opens it and presses Save — to fix a typo in the payee,
say — its class is rewritten to `regular_recurring`, permanently and with no warning. Budget
and module summaries group by `class`, so an unrelated edit moves money between report
buckets.

The design decision ("recurrence is the single source of truth", stated at `:80-81`) is
defensible. Admitting a fourth value through the import path while the UI can neither show
nor preserve it is not.

**Fix:** either reject `contractual_monthly` in `bulkImportSchemas.ts` so the value cannot
enter, or extend `classFromRecurrence` and the recurrence options to cover it. **Business
decision — flagged, not chosen.** Whichever, the missing `expenseClass.contractual_monthly`
i18n key should be added or the enum value dropped.

---

### 4 · Medium — `FilterSelect` is byte-identical in two route files, `Field` near-identical in two more

**Where:** `routes/admin.deposits.tsx:428-458` and `routes/admin.expenses.tsx:742-772`
(**identical**, 31 lines) · `routes/admin.expenses.tsx:720-741` and
`components/admin/deposits/DepositFormDialog.tsx:364-389` (`Field`, differing only in a
comment and `React.ReactNode` vs `ReactNode`).

**Which means:** the filter-bar select and the labelled form field are shared UI primitives
that were copied instead of imported, so a styling change — the RTL label alignment, the
required asterisk, the touch target size the rest of the app standardises on
`pointer-coarse:min-h-11` — lands on one screen and not its neighbour. Deposits and expenses
are adjacent pages in the same sidebar group, so the divergence is visible side by side.

This is the one place in S04 where extraction obviously pays: two identical copies, one
clear job, no flag needed to serve both callers.

**Fix:** move both to `components/ui/` (or `components/admin/`) and import. ~60 lines removed.

---

### 5 · Low — form schemas live in route files on three paths and in `src/lib` on a fourth

**Where:** `admin.payments.tsx:137` (`paymentSchema`) · `admin.expenses.tsx:95`
(`expenseSchema`) · `admin.deposits.tsx` (inline) — versus `admin.contracts_.$id.closeout.tsx`,
which imports `closeoutSchema` from `lib/closeoutSchemas.ts`, shared with the server fn.

**Which means:** the close-out path validates the same shape on the client and the server
from one definition; the payment, expense and deposit paths validate only on the client,
with the server-side shape defined separately in `src/fns`. Nothing is wrong today — but it
means "add a required field" is a one-file change on one path and a two-file change with a
drift risk on the other three, and there is no signal in either file saying which kind you
are in.

**Fix:** low priority; if touched, follow the `closeoutSchemas.ts` pattern. Note the S01
caveat: a schema in `src/fns` is not covered by tests unless it is exported and asserted
directly.

---

## Not reported, and why

- **`LIST_LIMIT = 1000` in `admin.contracts.tsx:76`** — looks like the capped-fetch trap, is
  not: `listTruncated` (`:272,402`) renders a visible banner when the cap is hit, and the
  same pattern is wired in `admin.tenants.index.tsx:261` and `admin.units.index.tsx:188`.
  Handled honestly.
- **Money rules inside the components** — checked specifically and mostly *absent*:
  `settleableInvoices`, `buildInvoiceSettlements`, `settlementTotal` and `isContiguousPrefix`
  are all in `src/lib`. Finding 1 is about *where the rule is enforced*, not about arithmetic
  in a component.
- **Direct `supabase` imports in `admin.contracts.tsx`, `admin.deposits.tsx`,
  `admin.contracts_.$id.closeout.tsx`** — storage uploads only, not queries. The dashboard
  (`admin.index.tsx`, five inline table reads) is the real instance and belongs to S05.
- **`admin.invoices.tsx` at 524 lines** — `CLAUDE.md` names it a known offender to split. It
  is now marginally over the soft floor and cleanly organised. Doc is stale; recorded for S18.
- **13 `useState` in one component** — counted as evidence for finding 2, not reported
  separately. Splitting the component is the fix; a reducer would be a different-shaped
  koshary.

## Test coverage of this scope

Thin, and thinnest exactly where finding 1 lives.

- `admin.invoices.test.ts` (38 lines), `admin.contracts.test.ts` (31),
  `admin.payments.cards.test.ts` (21) — these are small structural/smoke tests, not
  behavioural coverage of the components.
- `admin.contracts.builder.test.tsx` (215) is the only substantial route test in the scope.
- **`lib/invoiceSettlement.ts` is well tested** — which is why finding 1 is a placement
  problem, not a correctness one: the rule is correct, it is simply enforced in a layer that
  cannot be trusted.
- Nothing tests that `apply_payment_allocation`'s callers agree on ordering, and nothing
  tests the three comparators against each other.

**Consequence for Pass 2:** finding 4 is safe to do on the current suite (pure UI move,
typecheck catches a mistake). Finding 2 is a large, behaviour-preserving refactor with almost
no test cover under it — do it in small commits, one dialog at a time, and verify each in the
running app. Finding 1 changes what the server accepts and needs a test at the
`applyAllocation` boundary written first. Finding 3 is a business decision.

## Ledger entries added

See `LEDGER.md` — the chronological-ordering rule (six implementations), `FilterSelect`,
`Field`, `classFromRecurrence`, route-local form schemas.
