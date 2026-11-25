# Batch A — Quick Wins (T1, T5, T7, T10, T12)

**Status:** Approved 2026-07-27
**Scope:** Five independent, low-risk fixes that ship together. Each is fully
specified here; the implementation plan will follow.

---

## A.1 — T1: Allow deleting `is_system` catalog items

### Problem

The Lists settings page (`/admin/settings/lists`) lets admins manage catalog
categories inside dropdown lists, but deleting any item flagged `is_system`
fails with `"System categories cannot be deleted."`. The user wants these
deletable.

### Root cause

Two client mutations hard-fail on the `is_system` flag:

- `useDeleteExpenseCategory` — `src/hooks/useExpenses.ts:228`
- `useDeleteBuildingCategory` — `src/hooks/useBuildings.ts:238`

Both throw `if (category.is_system) throw new Error("System categories cannot be deleted.")`
before reaching the Supabase delete.

### Change

Remove the `is_system` guard from both mutations. Keep the existing
admin-permission check (`permissions.isAdmin` / `permissions.can(...)`) and
the audit log call (`logAuditForCurrentSession`). The confirmation dialog
already prompts before delete, so no UI change is required.

### Why this is safe

These are user-managed catalog rows in `expense_categories` and
`building_categories`. Deletion is admin-gated and audit-logged. The DB does
not enforce `is_system` immutability (the guard lives only in client code),
so removing it aligns client behavior with the data model.

### Files touched

- `src/hooks/useExpenses.ts`
- `src/hooks/useBuildings.ts`

---

## A.2 — T5: Force LTR on phone / mobile / email fields in Arabic

### Problem

In Arabic (RTL) mode, latin/numeric fields — mobile, WhatsApp, email —
inherit `dir="rtl"` from the page, which mis-aligns phone numbers and makes
them hard to read. They should always render left-to-right.

### Root cause

The `Info` component in `src/routes/admin.tenants.$id.index.tsx:383` renders
its value inside the page's RTL flow; no per-field directionality override.

### Change

1. Add an optional `ltr?: boolean` prop to the `Info` component (default
   `false`). When true, the value's container gets `dir="ltr"` and
   `text-align` is forced to the inline-start (left) for that value only.
2. Set `ltr` on the three latin/numeric fields in the tenant profile card:
   `tenants.mobile`, `tenants.whatsapp`, `tenants.email`.
3. Sweep other admin pages that render these same fields and apply the same
   `ltr` flag, so the rule is consistent app-wide. (Identified during the
   plan; tenant detail is the canonical example.)

### Non-goal

This does **not** touch the `MobileCardList` responsive component
(`src/components/admin/MobileCardList.tsx`) — it has no RTL issue. Only the
phone/mobile/email value rendering is affected. Arabic text fields stay RTL.

### Files touched

- `src/routes/admin.tenants.$id.index.tsx` (canonical)
- Other admin pages rendering mobile/whatsapp/email (sweep during plan)

---

## A.3 — T7: Remove `entry_date` from the Add Contract form

### Problem

The Add Contract form has an `entry_date` field the user no longer wants
collected manually.

### Change

Remove `entry_date` from:

- the contract Zod schema in `src/routes/admin.contracts.tsx`,
- the form default values,
- the edit-form populate (when editing an existing contract).

**Keep the `entry_date` column in the database** — existing rows retain their
stored value and the column stays nullable. New contracts simply leave it
unset.

### Check during plan

Grep for every reader of `entry_date` (reports, exports, detail pages). If
any view currently displays it for new contracts, hide it there too; if it's
only historical, leave the reader alone. Surface findings in the plan.

### Files touched

- `src/routes/admin.contracts.tsx`
- Possibly report/export readers (identified during plan)

---

## A.4 — T10: Tenant Start Date / End Date columns

### Problem

The tenant table needs two new columns — **Start Date** and **End Date** —
showing the start/end dates of the tenant's active contract. Same shape as
the existing "Connected Property" / "Connected Unit" columns.

### Rules

1. Only show dates for tenants with an **active** contract. When a contract
   is activated or created, the dates populate immediately.
2. Tenants without an active contract show `"None"`.
3. No new field in the tenant form — these columns are derived.
4. Add the columns to: the tenant table, the tenant detail page, the tenant
   report, and the tenant CSV export.

### Implementation

Reuse the existing active-contract lookup already wired into `useTenants.ts`
(`selectActiveContractByTenant`). The hook already fetches each tenant's
contracts and resolves the active one; expose `activeContract.start_date`
and `activeContract.end_date` alongside the existing `connectedProperty` /
`connectedUnit` derived fields. The table, detail page, report, and CSV
render them the same way they render the connected property/unit columns.

### Files touched

- `src/hooks/useTenants.ts` (expose the two dates)
- `src/routes/admin.tenants.index.tsx` (table columns)
- `src/routes/admin.tenants.$id.index.tsx` (detail page)
- Tenant report + CSV export paths (identified during plan)

---

## A.5 — T12: Portal "Pay this invoice" opens in a new tab

### Problem

In the tenant portal, clicking **Pay this invoice now** opens MyFatoorah in
the **same tab** (`window.location.assign`). The user wants it in a **new
tab**.

### Change

In `src/routes/portal.invoices.tsx:82`, replace:

```ts
window.location.assign(result.paymentUrl);
```

with:

```ts
const opened = window.open(result.paymentUrl, "_blank", "noopener,noreferrer");
if (!opened) {
  // Popup blocker — fall back to a manual link so the user is not stuck.
  toast.error(t("portal.invoices.allowPopups"), { ... });
}
```

Add the `portal.invoices.allowPopups` translation key (EN + AR) with a
clickable manual link in the toast description.

### Non-goal

The `/portal/payments/callback` automation (payment record creation,
existing automation trigger, invoice-show after success) is unchanged.

### Files touched

- `src/routes/portal.invoices.tsx`
- `src/i18n/dictionary.ts` (new `portal.invoices.allowPopups` key, EN + AR)

---

## Testing & verification

Run before commit:

```bash
bun run lint && bun run typecheck && bun run test
```

Per-task manual checks:

- **T1:** Delete a system-flagged expense category and a building category
  from `/admin/settings/lists`. Confirm the row is gone and an audit log
  entry was written.
- **T5:** Switch to Arabic, open a tenant detail page. Mobile, WhatsApp, and
  email render LTR; Arabic text fields stay RTL.
- **T7:** Add Contract form has no `entry_date` field. An existing contract
  with a stored `entry_date` still displays its value where readers exist.
- **T10:** A tenant with an active contract shows correct Start/End dates in
  the table, detail page, report, and CSV. A tenant without an active
  contract shows "None".
- **T12:** Click Pay in the portal → new tab opens to MyFatoorah. With
  popups blocked → toast appears with a manual link.

---

## Out of scope for Batch A

- Gmail sync, inbox tab restructure (Batch B).
- CSV column additions beyond T10's tenant dates — the broader T9 export
  columns land in Batch C.
- Any payments, refunds, employees, or cron work.
