# Admin UI Improvements — 6 Tasks

**Date:** 2026-07-24
**Branch:** `feature/admin-ui-improvements`
**Base:** `main` (includes merged PR #4)

## Task 1 — Review: Concessions + Nationality (PR #4)

**Status:** MERGED, live. Code review passed. No further action.

## Task 2 — Inline "Send Message" Dialog on Tenant Detail Page

### Problem

Clicking "Send Message" on `/admin/tenants/$id` navigates away to
`/admin/settings/notifications?tenantId=...`. The user wants the same
dialog that lives on the notifications page to open inline, with the
same backend integration so the message appears in the Notification Pool.

### Solution

1. Extract the manual-message dialog from `admin.settings.notifications.tsx`
   into a new reusable component `src/components/admin/SendManualMessageDialog.tsx`.
   - Props: `open`, `onOpenChange`, optional `presetTenantId?: string`.
   - When `presetTenantId` is set, the tenant `<Select>` is **hidden** and
     `manualTenant` is auto-filled.
   - Uses `useSendManualNotification` (same hook → message lands in pool).
2. `admin.settings.notifications.tsx`: replace inlined dialog with the
   shared component.
3. `admin.tenants.$id.index.tsx`: replace the `<Link>` button with a
   `<Button onClick>` + `<SendManualMessageDialog presetTenantId={id} />`.

### Files

- `src/components/admin/SendManualMessageDialog.tsx` (new)
- `src/routes/admin.settings.notifications.tsx`
- `src/routes/admin.tenants.$id.index.tsx`

## Task 3 — Tenants: Row-Click Navigation + Card View

### 3a. Row-Click Navigation

Clone the properties-page pattern: clicking a table row navigates to the
tenant detail page. Remove the Eye (preview) icon from the actions column.
Keep the ExternalLink (portal) button.

- Add `useNavigate` + `openTenant(tenant)` helper.
- `<TableRow className="cursor-pointer" onClick={...}>`.
- `stopPropagation` on checkbox + actions cells.
- Remove `TableActionButton action="view"` (Eye) in desktop + mobile.

### 3b. Card View Mode

Clone the properties-page view toggle (cards/table) with enhancements:

- `view` state (`"cards" | "table"`) + toggle button group.
- Cards-per-line `<Select>`: options 2/3/4/5/6, default **3**, driving
  dynamic grid column count.
- Stylish colorful animated cards:
  - Lifecycle-based gradient accents (active=emerald, inactive=slate, etc.).
  - `hover:-translate-y-1 hover:shadow-lg transition-all`.
  - Shop logo/placeholder, overdue pulse badge.
  - Property/unit/category chips.

### Files

- `src/routes/admin.tenants.index.tsx`
- `src/i18n/dictionary.ts` (new keys: `tenants.cardView`, `tenants.tableView`, `tenants.cardsPerLine`)

## Task 4 — Units: Remove Pagination

Show all records on one screen (mirrors the tenants page approach).

- `useUnits` → `pageSize: 1000, page: 1`.
- Remove `<Pager>` component.
- Remove `page`/`setPage` state + `resetPage` page-reset wiring.
- Fix row numbering to `index + 1`.

### Files

- `src/routes/admin.units.index.tsx`

## Task 5 — Property Name Language Integration

### 5a. Units Page

The Property column and dropdowns always show `name_ar`. Fix to be
locale-aware: `locale === "ar" ? name_ar : (name_en ?? name_ar)`.

- Table cell (line ~204).
- Filter dropdown (line ~289).
- Form select (line ~444).

### 5b. Invoices Page

The property grouping header always uses `name_ar`. Fix to locale-aware.
Replace the plain header row with a centered colored-gradient banner.

- `grouped` label (line ~182) → locale-aware.
- Header `<TableRow>` (line ~624) → full-width centered colored pill.
- Mobile card header (line ~529) → same styled treatment.

### Files

- `src/routes/admin.units.index.tsx`
- `src/routes/admin.invoices.tsx`

## Task 6 — "common.auto" Literal Fix

### Problem

`admin.settings.notifications.tsx:861`:

```tsx
{
  t("common.auto") || "auto";
}
```

There is no `common.auto` key in the dictionary, so `t()` returns the
literal `"common.auto"` (truthy) and the fallback never fires. The
dropdown shows `لغة الرسالة · common.auto`.

### Solution

- Add `"common.auto"` → AR `"تلقائي"` / EN `"Auto"` to dictionary.
- Simplify to `{t("common.auto")}`.
- Handled inside the extracted `SendManualMessageDialog` component.

### Files

- `src/i18n/dictionary.ts`
- `src/components/admin/SendManualMessageDialog.tsx` (uses the new key)

## Verification

```
bun run lint
bun run typecheck
bun run test
bun run build
```

## Summary of Files

| File                                               | Action |
| -------------------------------------------------- | ------ |
| `src/components/admin/SendManualMessageDialog.tsx` | new    |
| `src/routes/admin.settings.notifications.tsx`      | edit   |
| `src/routes/admin.tenants.$id.index.tsx`           | edit   |
| `src/routes/admin.tenants.index.tsx`               | edit   |
| `src/routes/admin.units.index.tsx`                 | edit   |
| `src/routes/admin.invoices.tsx`                    | edit   |
| `src/i18n/dictionary.ts`                           | edit   |
