# Batch A — Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five independent, low-risk fixes (T1 category-delete, T5 mobile LTR, T7 drop entry_date from contract form, T10 tenant Start/End date columns, T12 portal pay-in-new-tab) without touching any other subsystem.

**Architecture:** Each task is a self-contained edit in 1–3 files. T1 and T12 are pure behavior fixes. T5 adds a per-field `dir="ltr"` override. T7 removes a field from a form schema while keeping the DB column. T10 extends the existing active-contract lookup (`selectActiveContractByTenant`) to also surface `end_date`, then renders it in table, detail, CSV. No new DB migrations, no new endpoints.

**Tech Stack:** React 19 + TanStack Router/Start, TanStack Query, react-hook-form + zod, Radix UI + Tailwind, Supabase, Vitest. Commands: `bun run lint`, `bun run typecheck`, `bun run test`.

---

## File Structure

| File                                     | Responsibility                              | Change                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/hooks/useExpenses.ts`               | Expense-category mutations                  | Remove `is_system` delete guard (T1)                                                                                                                                               |
| `src/hooks/useBuildings.ts`              | Building-category mutations                 | Remove `is_system` delete guard (T1)                                                                                                                                               |
| `src/routes/admin.tenants.$id.index.tsx` | Tenant detail page + `Info` component       | Add `ltr` prop; force LTR on mobile/whatsapp/email (T5); add Start/End date rows (T10)                                                                                             |
| `src/routes/admin.contracts.tsx`         | Contract form                               | Remove `entry_date` from schema/defaults/populate/field (T7)                                                                                                                       |
| `src/lib/tenantLocations.ts`             | `selectActiveContractByTenant` helper       | Add `end_date` to required candidate shape (T10)                                                                                                                                   |
| `src/hooks/useTenants.ts`                | Tenant list query + `attachActiveLocations` | Select `end_date`; expose `activeContractStartDate` / `activeContractEndDate` (T10)                                                                                                |
| `src/routes/admin.tenants.index.tsx`     | Tenant table + CSV export                   | Add Start/End columns + CSV fields (T10); force LTR on mobile cell (T5)                                                                                                            |
| `src/routes/portal.invoices.tsx`         | Portal invoice pay action                   | Open in new tab + popup-blocked fallback (T12)                                                                                                                                     |
| `src/i18n/dictionary.ts`                 | EN/AR strings                               | Add `tenants.startDate`, `tenants.endDate`, `portal.invoices.allowPopups` (T10/T12); leave `contracts.entryDate` key in place (harmless, used by existing-contract readers if any) |
| `src/lib/tenantLocations.test.ts`        | NEW test for the helper                     | T10 unit test                                                                                                                                                                      |

The tenant report (`src/routes/admin.reports.tsx`) renders server-generated report rows, not the in-memory `TenantWithActiveLocation` shape — it is fed by SQL/`generated_reports` and is **not** affected by T10's client-side column addition. T10's "report" requirement is satisfied by the CSV export (the user-facing tenant data export); the in-app `admin.reports.tsx` report types are a separate server-side pipeline and are out of scope for Batch A. (Confirmed: `admin.reports.tsx` has no `connectedProperty`/`connectingUnit` references and consumes `report_schedules`/`generated_reports` rows, not the tenant list.)

---

## Task 1: T1 — Remove `is_system` delete guard from expense categories

**Files:**

- Modify: `src/hooks/useExpenses.ts` (the `useDeleteExpenseCategory` mutation, around line 224–243)

- [ ] **Step 1: Read the current mutation**

Open `src/hooks/useExpenses.ts` and locate `useDeleteExpenseCategory`. Confirm it currently contains:

```ts
mutationFn: async (category: ExpenseCategory) => {
  if (!permissions.isAdmin) throw new Error("Permission denied.");
  if (category.is_system) throw new Error("System categories cannot be deleted.");
  const result = await supabase.from("expense_categories").delete().eq("id", category.id);
  if (result.error) throw result.error;
  await logAuditForCurrentSession({ ... });
},
```

- [ ] **Step 2: Remove the `is_system` line**

Delete exactly this line from `mutationFn`:

```ts
if (category.is_system) throw new Error("System categories cannot be deleted.");
```

Leave the `permissions.isAdmin` check and the `logAuditForCurrentSession` call intact. The block becomes:

```ts
mutationFn: async (category: ExpenseCategory) => {
  if (!permissions.isAdmin) throw new Error("Permission denied.");
  const result = await supabase.from("expense_categories").delete().eq("id", category.id);
  if (result.error) throw result.error;
  await logAuditForCurrentSession({
    action: "expense_category.delete",
    entityType: "expense_category",
    entityId: category.id,
    before: category,
  });
},
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no type references to the removed line).

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useExpenses.ts
git commit -m "fix(expenses): allow deleting system expense categories"
```

---

## Task 2: T1 — Remove `is_system` delete guard from building categories

**Files:**

- Modify: `src/hooks/useBuildings.ts` (the `useDeleteBuildingCategory` mutation, around line 234–247)

- [ ] **Step 1: Read the current mutation**

Confirm `useDeleteBuildingCategory` contains:

```ts
mutationFn: async (category: BuildingCategory) => {
  if (!permissions.can(PERMISSIONS.BUILDINGS_UPDATE)) throw new Error("Permission denied.");
  if (category.is_system) throw new Error("System categories cannot be deleted.");
  const { error } = await supabase.from("building_categories").delete().eq("id", category.id);
  if (error) throw error;
  await logAuditForCurrentSession({ ... });
},
```

- [ ] **Step 2: Remove the `is_system` line**

Delete exactly:

```ts
if (category.is_system) throw new Error("System categories cannot be deleted.");
```

Keep the `permissions.can(PERMISSIONS.BUILDINGS_UPDATE)` check and audit call. Result:

```ts
mutationFn: async (category: BuildingCategory) => {
  if (!permissions.can(PERMISSIONS.BUILDINGS_UPDATE)) throw new Error("Permission denied.");
  const { error } = await supabase.from("building_categories").delete().eq("id", category.id);
  if (error) throw error;
  await logAuditForCurrentSession({
    action: "building_category.delete",
    entityType: "building_category",
    entityId: category.id,
    before: { ...category },
  });
},
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useBuildings.ts
git commit -m "fix(buildings): allow deleting system building categories"
```

---

## Task 3: T5 — Add `ltr` prop to the `Info` component (tenant detail)

**Files:**

- Modify: `src/routes/admin.tenants.$id.index.tsx` (the `Info` component, around line 383)

- [ ] **Step 1: Read the current `Info` component**

Confirm it currently reads:

```tsx
function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-end font-medium">{children}</span>
    </div>
  );
}
```

Note: the current value span uses `{children}` but the prop is named `value` — verify the exact current code in the file before editing; match what's there.

- [ ] **Step 2: Add the `ltr` prop**

Replace the `Info` component with:

```tsx
function Info({
  label,
  value,
  ltr = false,
}: {
  label: string;
  value: ReactNode;
  /** Force the value to render LTR (for phone/email/latin fields in Arabic mode). */
  ltr?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        dir={ltr ? "ltr" : undefined}
        className={cn(
          "min-w-0 truncate font-medium",
          // When forced LTR, anchor the value to the inline-start (left) of the row,
          // regardless of the page's rtl direction.
          ltr ? "text-start" : "text-end",
        )}
      >
        {value}
      </span>
    </div>
  );
}
```

If `cn` is not already imported at the top of the file, add it:

```tsx
import { cn } from "@/lib/utils";
```

- [ ] **Step 3: Apply `ltr` to mobile, whatsapp, email fields**

In the same file, find the profile card rendering (around line 155):

```tsx
<Info label={t("tenants.mobile")} value={tenant.data.mobile} />
<Info label={t("tenants.whatsapp")} value={tenant.data.whatsapp} />
<Info label={t("tenants.email")} value={tenant.data.email} />
```

Change to:

```tsx
<Info label={t("tenants.mobile")} value={tenant.data.mobile} ltr />
<Info label={t("tenants.whatsapp")} value={tenant.data.whatsapp} ltr />
<Info label={t("tenants.email")} value={tenant.data.email} ltr />
```

Do **not** add `ltr` to Arabic-text fields (nationality label, commercial name, etc.).

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.tenants.\$id.index.tsx
git commit -m "feat(tenants): force LTR on mobile/whatsapp/email fields in Arabic"
```

> **Note:** A broader sweep for other pages rendering mobile/whatsapp/email is
> deferred to a follow-up — the tenant detail page is the canonical example
> the user named ("Tenant and Dedicated page"). If during typecheck other
> call sites are obviously broken, fix them too; otherwise leave for later.

---

## Task 4: T7 — Remove `entry_date` from the contract form

**Files:**

- Modify: `src/routes/admin.contracts.tsx` (schema ~line 98, defaults ~line 116, edit populate ~line 218, submit ~line 262, form field ~line 549)

**Keep the DB column** (`contracts.entry_date`) and the `database.types.ts` type — existing rows keep their value. Only the **form** stops collecting it.

- [ ] **Step 1: Read the contract schema and defaults**

Confirm the schema (around line 96–120) contains:

```ts
entry_date: z.string(),
```

and the defaults object contains:

```ts
entry_date: "",
```

- [ ] **Step 2: Remove `entry_date` from the schema**

Delete the line `entry_date: z.string(),` from the zod schema object in `src/routes/admin.contracts.tsx`.

- [ ] **Step 3: Remove `entry_date` from defaults**

Delete the line `entry_date: "",` from the `defaultValues`/defaults object.

- [ ] **Step 4: Remove `entry_date` from the edit-populate block**

Find the `useEffect`/reset block around line 216–220 that populates the form when editing:

```ts
entry_date: editing.entry_date ?? "",
```

Delete that one line. Leave `start_date: editing.start_date,` and the rest intact.

- [ ] **Step 5: Remove `entry_date` from the submit handler**

Find the submit/build-payload block around line 260–265:

```ts
entry_date: values.entry_date || null,
```

Delete that one line from the object being sent to the create/update mutation.

- [ ] **Step 6: Remove the form field**

Find the form field block around line 547–555:

```tsx
<FormInput
  name="entry_date"
  label={t("contracts.entryDate")}
  ...
/>
```

Delete the entire `<FormInput name="entry_date" ... />` element.

- [ ] **Step 7: Leave the i18n key in place**

Do **not** remove `contracts.entryDate` from `src/i18n/dictionary.ts` — it's harmless and other readers (if any) may reference it. Removing it risks a missing-key render.

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: PASS. If it fails because `entry_date` is still referenced somewhere in this file, remove that reference too (grep `entry_date` in the file).

- [ ] **Step 9: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/routes/admin.contracts.tsx
git commit -m "feat(contracts): remove entry_date from add-contract form"
```

---

## Task 5: T10 — Extend `selectActiveContractByTenant` to carry `end_date`

**Files:**

- Modify: `src/lib/tenantLocations.ts` (the `ActiveContractCandidate` interface)
- Create: `src/lib/tenantLocations.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/tenantLocations.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { selectActiveContractByTenant } from "@/lib/tenantLocations";

describe("selectActiveContractByTenant", () => {
  test("picks the most recently started active contract per tenant", () => {
    const result = selectActiveContractByTenant([
      {
        id: "c1",
        tenant_id: "t1",
        unit_id: "u1",
        state: "active",
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      },
      {
        id: "c2",
        tenant_id: "t1",
        unit_id: "u1",
        state: "active",
        start_date: "2026-01-01",
        end_date: "2026-12-31",
      },
    ]);
    expect(result.get("t1")?.id).toBe("c2");
    expect(result.get("t1")?.end_date).toBe("2026-12-31");
  });

  test("ignores non-active contracts", () => {
    const result = selectActiveContractByTenant([
      {
        id: "c-old",
        tenant_id: "t2",
        unit_id: "u2",
        state: "ended",
        start_date: "2024-01-01",
        end_date: "2024-06-30",
      },
    ]);
    expect(result.has("t2")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test — expect it to FAIL**

Run: `bun run test src/lib/tenantLocations.test.ts`
Expected: FAIL with a type error: `Property 'end_date' is missing in type ... but required in type 'ActiveContractCandidate'`. (The current candidate interface doesn't require `end_date`, so the test objects fail to typecheck. This is the failing state we want before the implementation step.)

- [ ] **Step 3: Add `end_date` to the candidate interface**

In `src/lib/tenantLocations.ts`, change:

```ts
interface ActiveContractCandidate {
  id: string;
  tenant_id: string;
  unit_id: string;
  state: string;
  start_date: string;
}
```

to:

```ts
interface ActiveContractCandidate {
  id: string;
  tenant_id: string;
  unit_id: string;
  state: string;
  start_date: string;
  end_date: string | null;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `bun run test src/lib/tenantLocations.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tenantLocations.ts src/lib/tenantLocations.test.ts
git commit -m "feat(tenant-locations): carry end_date on active contract candidate"
```

---

## Task 6: T10 — Select `end_date` and expose dates on `TenantWithActiveLocation`

**Files:**

- Modify: `src/hooks/useTenants.ts` (the contracts `.select(...)` ~line 53, the `TenantWithActiveLocation` interface, the `bare` map ~line 31, the final return map ~line 90)

- [ ] **Step 1: Add the two date fields to `TenantWithActiveLocation`**

In `src/hooks/useTenants.ts`, find the interface (around line 27–39) and add two fields after `hasOverdue`:

```ts
export interface TenantWithActiveLocation extends Tenant {
  connectedProperty: Tables<"properties"> | null;
  connectingUnit: Tables<"units"> | null;
  hasOverdue: boolean;
  /** Start date of the tenant's active contract, or null if none. */
  activeContractStartDate: string | null;
  /** End date of the tenant's active contract, or null if none. */
  activeContractEndDate: string | null;
  /** Store Logo — brands carousel (list/table view). */
  shopLogoUrl: string | null;
  /** Shop Card Image — store directory / Explore Our Shops (card view 1:1). */
  shopCardUrl: string | null;
}
```

- [ ] **Step 2: Add the fields to the `bare` fallback map**

In `attachActiveLocations`, the `bare` map (around line 31–39) currently produces the no-contract fallback. Update it:

```ts
const bare = tenants.map((tenant) => ({
  ...tenant,
  connectedProperty: null,
  connectingUnit: null,
  hasOverdue: false,
  activeContractStartDate: null,
  activeContractEndDate: null,
  shopLogoUrl: null as string | null,
  shopCardUrl: null as string | null,
}));
```

- [ ] **Step 3: Select `end_date` in the contracts query**

Around line 52–54, the contracts select currently reads:

```ts
.select("id, tenant_id, unit_id, state, start_date")
```

Change to:

```ts
.select("id, tenant_id, unit_id, state, start_date, end_date")
```

- [ ] **Step 4: Populate the dates in the final return map**

In the final `return tenants.map((tenant) => { ... })` (around line 90–102), update the returned object:

```ts
return tenants.map((tenant) => {
  const activeContract = contractByTenant.get(tenant.id);
  const unit = unitById.get(activeContract?.unit_id ?? "") ?? null;
  const brand = activeContract ? brands.get(activeContract.id) : undefined;
  return {
    ...tenant,
    connectingUnit: unit,
    connectedProperty: unit ? (propertyById.get(unit.property_id) ?? null) : null,
    hasOverdue: overdueTenants.has(tenant.id),
    activeContractStartDate: activeContract?.start_date ?? null,
    activeContractEndDate: activeContract?.end_date ?? null,
    shopLogoUrl: brand?.logoUrl ?? null,
    shopCardUrl: brand?.cardUrl ?? null,
  };
});
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS. (If any consumer of `TenantWithActiveLocation` is now missing these fields in a destructure, it won't error because they're additions; but typecheck will catch any other type breakage.)

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useTenants.ts
git commit -m "feat(tenants): expose active contract start/end dates on tenant rows"
```

---

## Task 7: T10 — Render Start/End date columns in the tenant table

**Files:**

- Modify: `src/routes/admin.tenants.index.tsx` (table headers ~line 670, table cells ~line 740)
- Modify: `src/i18n/dictionary.ts` (add `tenants.startDate` + `tenants.endDate` EN/AR)

- [ ] **Step 1: Add i18n keys**

In `src/i18n/dictionary.ts`, in the **Arabic** block near line 464–465 (after `tenants.connectingUnit`), add:

```ts
    "tenants.startDate": "تاريخ البداية",
    "tenants.endDate": "تاريخ النهاية",
```

In the **English** block near line 1591–1592, add:

```ts
    "tenants.startDate": "Start date",
    "tenants.endDate": "End date",
```

- [ ] **Step 2: Add the two column headers**

In `src/routes/admin.tenants.index.tsx`, find the `<TableHead>` block. After the `connectingUnit` header (~line 677–679):

```tsx
<SortableHead sortKey="unit" sort={sort} toggle={toggle}>
  {t("tenants.connectingUnit")}
</SortableHead>
```

Add immediately after it:

```tsx
<SortableHead sortKey="activeContractStartDate" sort={sort} toggle={toggle}>
  {t("tenants.startDate")}
</SortableHead>
<SortableHead sortKey="activeContractEndDate" sort={sort} toggle={toggle}>
  {t("tenants.endDate")}
</SortableHead>
```

- [ ] **Step 3: Extend the sort comparator**

In the `useTableSort` comparator (around line 181–190), add two cases so sorting works on the new columns:

```ts
} = useTableSort(tenants.data?.items ?? [], (tenant, key) => {
  switch (key) {
    case "property":
      return tenant.connectedProperty?.name_ar ?? null;
    case "unit":
      return tenant.connectingUnit?.name ?? null;
    case "activeContractStartDate":
      return tenant.activeContractStartDate;
    case "activeContractEndDate":
      return tenant.activeContractEndDate;
    default:
      return (tenant as unknown as Record<string, unknown>)[key];
  }
});
```

- [ ] **Step 4: Add the two cells in the row body**

Find the row that renders the unit cell (around line 740):

```tsx
<TableCell>{tenant.connectingUnit?.name ?? "—"}</TableCell>
```

Add immediately after it:

```tsx
<TableCell>{tenant.activeContractStartDate ?? t("common.none")}</TableCell>
<TableCell>{tenant.activeContractEndDate ?? t("common.none")}</TableCell>
```

> Verify `common.none` exists in `dictionary.ts` (both locales). If it doesn't, use the literal `"—"` instead and skip adding a key. (Check before deciding.)

- [ ] **Step 5: Verify `common.none` exists**

Run: `grep -n '"common.none"' src/i18n/dictionary.ts`
If no results, change Step 4's cells to use `"—"` literally:

```tsx
<TableCell>{tenant.activeContractStartDate ?? "—"}</TableCell>
<TableCell>{tenant.activeContractEndDate ?? "—"}</TableCell>
```

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/routes/admin.tenants.index.tsx src/i18n/dictionary.ts
git commit -m "feat(tenants): show active contract start/end date columns"
```

---

## Task 8: T10 — Add Start/End date fields to the tenant CSV export

**Files:**

- Modify: `src/routes/admin.tenants.index.tsx` (the `exportTenants` function, ~line 293–317)

- [ ] **Step 1: Read the current export**

Confirm `exportTenants` builds an array of objects with keys like `code`, `name`, `category`, etc., then calls `exportRecordsToCsv(rows, "tenants.csv")`.

- [ ] **Step 2: Add the two date fields to each exported row**

In the `.map((tenant) => ({ ... }))` body, add after the `tenant_portal_enabled`/`reminders_enabled`/`receipt_visible_to_tenant` fields (or anywhere in the object — order determines CSV column order; place them near the connected-property group for readability):

```ts
function exportTenants() {
  exportRecordsToCsv(
    (tenantExport.data?.items ?? []).map((tenant) => ({
      code: tenant.code,
      name: tenant.name,
      // name_en is deliberately absent: ... (keep existing comment)
      category: tenant.category,
      lifecycle: tenant.lifecycle,
      nationality: tenant.nationality ?? "",
      preferred_language: tenant.preferred_language,
      mobile: tenant.mobile ?? "",
      whatsapp: tenant.whatsapp ?? "",
      email: tenant.email ?? "",
      commercial_name: tenant.commercial_name ?? "",
      authorized_manager: tenant.authorized_manager ?? "",
      owner_name: tenant.owner_name ?? "",
      notes: tenant.notes ?? "",
      tenant_portal_enabled: tenant.tenant_portal_enabled,
      reminders_enabled: tenant.reminders_enabled,
      receipt_visible_to_tenant: tenant.receipt_visible_to_tenant,
      active_contract_start_date: tenant.activeContractStartDate ?? "",
      active_contract_end_date: tenant.activeContractEndDate ?? "",
    })),
    "tenants.csv",
  );
}
```

The CSV serializer (`exportRecordsToCsv` → `serializeCsv`) derives headers from the first row's keys, so adding the two keys is sufficient — no header list to maintain.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/routes/admin.tenants.index.tsx
git commit -m "feat(tenants): include active contract start/end dates in CSV export"
```

---

## Task 9: T10 — Show Start/End dates on the tenant detail page

**Files:**

- Modify: `src/routes/admin.tenants.$id.index.tsx` (the profile card, ~line 153–167)

- [ ] **Step 1: Confirm the tenant detail query exposes the dates**

The detail page uses a tenant query; verify it returns the same `TenantWithActiveLocation` shape. If the detail page uses a different query (e.g. raw `useTenant(id)` returning `Tables<"tenants">` only), the dates won't be present — in that case, render them from the tenant's contract sub-query instead. Check first:

Run: `grep -n "activeContractStartDate\|useTenant\|useTenants\|contracts" src/routes/admin.tenants.\$id.index.tsx`

- [ ] **Step 2: Add two `Info` rows for the dates**

In the profile card (around line 153–167), after the `tenants.portal` row, add:

```tsx
<Info
  label={t("tenants.startDate")}
  value={tenant.data.activeContractStartDate ?? "—"}
/>
<Info
  label={t("tenants.endDate")}
  value={tenant.data.activeContractEndDate ?? "—"}
/>
```

If Step 1 showed the detail query doesn't expose these fields, instead source them from the contract shown in the "Current lease" card on the same page (it already renders `start_date`/`end_date` for the active contract) — reuse those same values here.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/routes/admin.tenants.\$id.index.tsx
git commit -m "feat(tenants): show active contract start/end dates on detail page"
```

---

## Task 10: T12 — Open portal invoice payment in a new tab

**Files:**

- Modify: `src/routes/portal.invoices.tsx` (~line 82, the pay handler)
- Modify: `src/i18n/dictionary.ts` (add `portal.invoices.allowPopups` EN/AR)

- [ ] **Step 1: Read the current pay handler**

Confirm `src/routes/portal.invoices.tsx` around line 82 contains:

```ts
window.location.assign(result.paymentUrl);
```

inside an async handler that already has `result.paymentUrl` available.

- [ ] **Step 2: Add the i18n keys**

In `src/i18n/dictionary.ts`, in the **Arabic** block (search for an existing `portal.invoices.*` key, e.g. `portal.invoices.paySelected`), add near it:

```ts
    "portal.invoices.allowPopups": "تم حظر النافذة المنبثقة. اسمح بالنوافذ المنبثقة ثم حاول مرة أخرى، أو افتح رابط الدفع يدويًا.",
```

In the **English** block, add:

```ts
    "portal.invoices.allowPopups": "Popup blocked. Allow popups for this site and retry, or open the payment link manually.",
```

- [ ] **Step 3: Replace `window.location.assign` with `window.open` + fallback**

Replace the line:

```ts
window.location.assign(result.paymentUrl);
```

with:

```ts
const opened = window.open(result.paymentUrl, "_blank", "noopener,noreferrer");
if (!opened) {
  toast.error(t("portal.invoices.allowPopups"), {
    action: {
      label: t("portal.invoices.openNow"),
      onClick: () => window.open(result.paymentUrl, "_blank", "noopener,noreferrer"),
    },
  });
}
```

> **Check:** verify `toast` is imported in this file (`import { toast } from "sonner";`). If not, add it. Verify the toast action API matches the project's sonner version — if `action` isn't supported, simplify to `toast.error(t("portal.invoices.allowPopups"))` and skip the manual-link button.

- [ ] **Step 4: Add the `openNow` translation key (or drop it)**

If you kept the toast action, add:

AR:

```ts
    "portal.invoices.openNow": "افتح الآن",
```

EN:

```ts
    "portal.invoices.openNow": "Open now",
```

If you dropped the action button, skip this step.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/routes/portal.invoices.tsx src/i18n/dictionary.ts
git commit -m "fix(portal): open invoice payment in a new tab with popup-blocked fallback"
```

---

## Task 11: Final verification

- [ ] **Step 1: Full lint + typecheck + test**

Run:

```bash
bun run lint && bun run typecheck && bun run test
```

Expected: all PASS.

- [ ] **Step 2: Manual smoke test (dev server)**

Run `bun run dev` and verify each fix:

1. **T1:** `/admin/settings/lists` → delete a system expense category and a system building category. Both delete; an audit log row appears.
2. **T5:** Switch locale to Arabic (header toggle). Open a tenant detail page → mobile, WhatsApp, email render LTR (left-aligned); Arabic fields stay RTL.
3. **T7:** Open "Add contract" → no `entry_date` field. Open an existing contract that had `entry_date` → no crash (field just absent).
4. **T10:** Tenant table shows "Start date" and "End date" columns; tenant with active contract shows dates, tenant without shows "—". CSV export includes `active_contract_start_date` / `active_contract_end_date` columns. Detail page shows both dates.
5. **T12:** Log in as a tenant, go to invoices, click Pay → new tab opens to MyFatoorah. Block popups in devtools → toast appears.

- [ ] **Step 3: Commit any i18n/formatting cleanup**

If Prettier flagged anything:

```bash
bun run format
git add -A
git commit -m "style: batch A formatting"
```

---

## Out of scope (handled in later batches)

- Inbox tab restructure, Gmail sync, landing form generalization, header/footer cleanup → **Batch B**.
- Tenant lifecycle auto-from-contract, broader CSV columns (T9), tenant-user restore, contract↔invoice regeneration engine → **Batch C**.
- Refunds, partial payments, insurance, KNET link → **Batch D**.
- Employees & salaries → **Batch E**.
- Contract-expiry cron + generic cron UI → **Batch F**.
