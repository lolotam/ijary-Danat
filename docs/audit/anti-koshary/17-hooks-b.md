# S17 — `src/hooks`: N–Z

**Lines read:** ~6,800 · **Files:** ~45 · **Date:** 2026-09-22

`useTenants` (507) · `usePortalData` (447) · `useWhatsAppInbox` (420) ·
`useReportPreview` (370) · `useProperties` (309) · `useUnits` (297) ·
`attachTenantLocations` (284) · `useConcessionInvoices` (280) · `usePayments` (263) ·
`useUsers` (249) · `useWhatsAppContactsData` (234) · `useTenantMessages` (234) ·
`useNotifications` (203) · `useOptionLists` (195) · `useRefunds` (166) ·
`useReportSchedules` (125) · `useNotificationTemplates` (111) · `useShopDetails` (110) ·
`usePaymentAllocations` (110) · `useReceipts` (106) — plus ~25 smaller.

**Overall:** same consistent CRUD shape as S16, plus the portal data layer. One finding, and
it is the kind this audit exists to catch: a problem solved correctly **four separate times**
for four specific cases, with no fifth case covered.

---

## Findings

### 1 · Medium — the portal preview goes stale after most admin mutations, and the fix has been written four different ways

**Where:** `lib/portalQueryKeys.ts` · `hooks/useConfirmPayment.ts:12-14` ·
`hooks/useContractPortalVisibility.ts:19-23` · `hooks/usePortalData.ts:264`

Staff open a tenant's portal as that tenant via `/portal?tenant=<id>`. That page runs in the
**same React Query cache** as the admin app, so an admin mutation that does not invalidate
the `portal-*` keys leaves the preview showing pre-mutation data for the shared 30-second
`staleTime` (focus refetching is off). `lib/portalQueryKeys.ts:5-9` records that this already
happened:

> *"Adding a discount and then switching to that preview showed the pre-discount lease and
> totals, because the concession mutations invalidated only the admin-side keys."*

Four independent solutions are now in the tree:

| # | Mechanism | Covers | Used by |
| --- | --- | --- | --- |
| 1 | `invalidatePortalConcessionViews()` — a shared helper over 3 keys | concessions | **2 hooks**: `useConcessionInvoices`, `useContractRelations` |
| 2 | An inline array of 3 portal keys | gateway payment confirmation | `useConfirmPayment.ts:12-14` |
| 3 | An inline array of 5 portal keys | portal visibility toggles | `useContractPortalVisibility.ts:19-23` |
| 4 | Nesting the query *under* an admin key (`["insurance_payments", "portal-total", …]`) so it rides the existing sweep | insurance totals | `usePortalData.ts:264` |

Solution 4's comment is explicit that it was chosen **because** a standalone `portal-…` key
*"went stale for the shared thirty seconds… which on a staff preview means showing a total
the office has just changed."*

**Which means:** the same defect has been diagnosed and fixed four times, and the admin
mutations still **not** covered are the most frequent ones —
recording a payment (`useCreatePayment`), reversing one (`useReversePayment` invalidates
`payments`, `invoices`, `invoice-month-summary`, `payment-allocations`, `insurance_payments`
— **no `portal-*`**), marking an invoice paid, writing one off, flagging a dispute,
generating or regenerating invoices, and closing out a contract. An admin who records a
payment and immediately checks what the tenant sees is shown the old balance.

**Fix:** promote `lib/portalQueryKeys.ts` from "the concession keys" to **the** portal key
list — `PORTAL_QUERY_KEYS` covering all six (`portal-identity`, `portal-lease`,
`portal-invoices`, `portal-invoice-summary`, `portal-contracts`, `portal-payments`) — with
one `invalidatePortalViews(queryClient)`, and call it from every hook that already
invalidates `invoices` or `payments`. Replace solutions 2 and 3 with it. **Leave solution 4
alone** — nesting under `insurance_payments` is a different and defensible trick, and
unpicking it would reintroduce the bug its comment describes.

---

## Not reported, and why

- **`attachTenantLocations.ts` (284)'s four unbounded reads** — reported once, as **S05 #3**.
  Not repeated here.
- **69 distinct query-key prefixes, in two naming conventions** — kebab-case
  (`invoice-month-summary`, `option-list-items`) alongside snake_case (`landing_settings`,
  `insurance_payments`, `partial_payments`, `role_permissions`, `custom_roles`,
  `commercial_brands`). Ugly, and near-miss pairs exist (`contract` / `contracts`,
  `linked-brand` / `linked-brands`, `tenant` / `tenants`). Checked for an actual
  mis-invalidation and **found none** — React Query matches by prefix, and every pair in the
  tree is used deliberately (`["contract", id]` for one row, `["contracts", params]` for the
  list). A rename would be churn without a consequence to name. **Not a finding**, but it is
  why finding 1 is easy to get wrong, and a reason to route portal invalidation through one
  named helper rather than more inline arrays.
- **`useReportPreview.ts:93`** — uses `fetchAllPages` correctly. The counter-example to
  S16 #1, in the same directory.
- **`usePortalData.ts` (447)** — seven portal queries in one file, each small, each with its
  own documented scoping. The `?tenant=` preview semantics are handled carefully throughout.
- **`useWhatsAppInbox` (420) / `useWhatsAppContactsData` (234)** — real-time inbox state;
  complex because the domain is, not because it is stirred.
- **`useUsers` (249)** — the hook behind **H5**'s screen. The hook is fine; the
  authorization split is in the server fns.
- **27 hooks touch `supabase.storage` or `supabase.rpc` directly** — correct: that *is* the
  data layer. The finding elsewhere was about **components** and **routes** doing it.

## Test coverage of this scope

`useTenants`, `usePortalData`, `useReportPreview`, `usePaymentAllocations` and others have
suites. Finding 1 is **not** covered and is awkward to cover — it needs two cache consumers
in one test. The cheaper guard is structural: one helper, one list, and a test asserting the
list contains all six keys, so a seventh portal query cannot be added without noticing.

**Consequence for Pass 2:** finding 1 is additive — adding invalidations cannot make data
staler. The only risk is over-invalidating (an extra refetch), which is cheap. Verify by
recording a payment in the admin app and switching to `/portal?tenant=` in the same session.

## Ledger entries added

See `LEDGER.md` — the four portal-invalidation mechanisms and the admin mutations they miss;
the query-key naming split (recorded as *checked, not a finding*).
