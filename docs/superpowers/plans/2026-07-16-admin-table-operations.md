# Admin Table Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Maintenance module plus complete CSV operations, derived tenant location columns, icon-only table actions, and RTL/LTR alignment fixes across the admin application.

**Architecture:** Extend the existing TanStack Query/Supabase patterns instead of adding a grid or import framework. A focused maintenance vertical slice owns its schema, permissions, hooks, route, and translations. Shared table action, CSV-template, and phone-direction primitives remove duplicated page-level behavior while existing page hooks remain responsible for filters and mutations.

**Tech Stack:** TanStack Start, React 19, TanStack Query 5, TypeScript, Zod, Vitest, Tailwind CSS 4, shadcn/ui, self-hosted Supabase/Postgres 17.

---

## File map

| Path                                                                                                                                                                                                                     | Responsibility                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `db/migrations/16_admin_table_operations.sql`                                                                                                                                                                            | Adds the maintenance schema, policies, permissions, generator, and import branches.           |
| `db/README.md`                                                                                                                                                                                                           | Adds migration 16 to the documented manual run order.                                         |
| `src/integrations/supabase/database.types.ts`                                                                                                                                                                            | Generated Supabase types after migration 16. Never hand-edit.                                 |
| `src/lib/permissions.ts`                                                                                                                                                                                                 | Adds the `maintenance` permission module and `PERMISSIONS.MAINTENANCE_*` constants.           |
| `src/lib/bulkImportSchemas.ts`                                                                                                                                                                                           | Defines import contracts for properties, buildings, units by codes, and maintenance.          |
| `src/lib/bulkImportTemplates.ts`                                                                                                                                                                                         | Defines stable template headers and a template-download helper.                               |
| `src/lib/csv.ts`                                                                                                                                                                                                         | Adds an explicit header-only CSV download function.                                           |
| `src/fns/bulkImport.ts`                                                                                                                                                                                                  | Resolves relationship codes and validates parent-child hierarchy before the service-role RPC. |
| `src/hooks/useBulkImport.ts`                                                                                                                                                                                             | Invalidates all newly imported entity query keys.                                             |
| `src/components/admin/CsvImportDialog.tsx`                                                                                                                                                                               | Shows a matching template-download control in import dialogs.                                 |
| `src/components/admin/TableActionButton.tsx`                                                                                                                                                                             | Shared accessible icon action for View, Edit, Delete, and document actions.                   |
| `src/components/ui/table.tsx`                                                                                                                                                                                            | Applies logical padding to checkbox cells in both LTR and RTL.                                |
| `src/components/admin/Phase2FormFields.tsx`                                                                                                                                                                              | Makes telephone form fields LTR by default.                                                   |
| `src/lib/tenantLocations.ts`                                                                                                                                                                                             | Purely selects one active contract per tenant for table display.                              |
| `src/hooks/useTenants.ts`                                                                                                                                                                                                | Loads and attaches connected property and unit from active contracts.                         |
| `src/hooks/useProperties.ts`                                                                                                                                                                                             | Adds property type/status filters and an unpaginated filtered export query.                   |
| `src/hooks/useBuildings.ts`                                                                                                                                                                                              | Adds category/status filters and an unpaginated filtered export query.                        |
| `src/hooks/useUnits.ts`                                                                                                                                                                                                  | Adds an unpaginated filtered export query.                                                    |
| `src/hooks/useMaintenance.ts`                                                                                                                                                                                            | Owns maintenance list queries and audited CRUD mutations.                                     |
| `src/routes/admin.properties.index.tsx`                                                                                                                                                                                  | Adds Properties/Buildings views with filters and CSV controls.                                |
| `src/routes/admin.units.index.tsx`                                                                                                                                                                                       | Adds CSV controls and replaces action text with shared icons.                                 |
| `src/routes/admin.tenants.index.tsx`                                                                                                                                                                                     | Displays derived connected property/unit and icon actions without changing the form.          |
| `src/routes/admin.maintenance.index.tsx`                                                                                                                                                                                 | New Maintenance page.                                                                         |
| `src/components/admin/AdminSidebar.tsx`                                                                                                                                                                                  | Adds Maintenance navigation.                                                                  |
| `src/i18n/dictionary.ts`                                                                                                                                                                                                 | Adds all Arabic and English copy, including `common.view`.                                    |
| `src/routes/admin.contracts.tsx`, `src/routes/admin.deposits.tsx`, `src/routes/admin.expenses.tsx`, `src/routes/admin.properties.$id.tsx`, `src/routes/admin.reports.tsx`, `src/routes/admin.settings.notifications.tsx` | Replaces existing text View/Edit/Delete table actions with the shared icon control.           |
| `src/lib/bulkImportSchemas.test.ts`                                                                                                                                                                                      | Covers CSV template contracts and client-side parsing/validation.                             |
| `src/lib/tenantLocations.test.ts`                                                                                                                                                                                        | Covers active-contract selection and empty-location behavior.                                 |
| `src/lib/csv.test.ts`                                                                                                                                                                                                    | Covers header-only CSV serialization.                                                         |

### Task 1: Add the persistence and authorization foundation

**Files:**

- Create: `db/migrations/16_admin_table_operations.sql`
- Modify: `db/README.md`
- Modify (generated): `src/integrations/supabase/database.types.ts`
- Modify: `src/lib/permissions.ts`

- [ ] **Step 1: Add failing type-level expectations for maintenance imports and permissions**

Create `src/lib/bulkImportSchemas.test.ts` with the initial import-contract assertions. This test must fail because `maintenance` is not yet an import entity:

```ts
import { describe, expect, test } from "vitest";

import { importSchemas } from "@/lib/bulkImportSchemas";

describe("maintenance CSV validation", () => {
  test("accepts a request identified by property code", () => {
    const parsed = importSchemas.maintenance.safeParse({
      property_code: "PROP-001",
      title: "Repair lobby light",
      priority: "high",
      status: "open",
    });

    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected red state**

Run: `bun run test src/lib/bulkImportSchemas.test.ts`

Expected: FAIL because `maintenance` is absent from `importSchemas`.

- [ ] **Step 3: Write the idempotent migration**

Create `db/migrations/16_admin_table_operations.sql`. Follow the project migration convention: explicit grants, RLS, policies, idempotent permission inserts, and `security definer set search_path = public, auth, pg_temp` for functions.

The migration must create these enums and table exactly:

```sql
create type public.maintenance_priority as enum ('low', 'medium', 'high', 'urgent');
create type public.maintenance_status as enum ('open', 'in_progress', 'completed', 'cancelled');

create table if not exists public.maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default public.next_maintenance_request_code(),
  company_id uuid not null references public.companies(id) on delete restrict,
  property_id uuid not null references public.properties(id) on delete restrict,
  building_id uuid references public.buildings(id) on delete restrict,
  unit_id uuid references public.units(id) on delete restrict,
  title text not null check (length(trim(title)) > 0),
  description text,
  priority public.maintenance_priority not null default 'medium',
  status public.maintenance_status not null default 'open',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (building_id is null or property_id is not null),
  check (unit_id is null or property_id is not null)
);
```

Also create `public.next_maintenance_request_code()` using the existing code-generator style, add a `before update` timestamp trigger using the repository’s existing trigger helper, grant table access to `authenticated`, enable RLS, and add select/insert/update/delete policies gated by `maintenance.read`, `maintenance.create`, `maintenance.update`, and `maintenance.delete`.

Insert all five maintenance permission codes for each built-in role following the existing phase-3 permission seed pattern. Extend `public.bulk_import_phase6` with `properties`, `buildings`, `units`, and `maintenance` branches; its input records use resolved UUIDs, not the user-facing code columns. The unit and maintenance branches must insert `company_id` and `created_by` where those columns exist.

- [ ] **Step 4: Update the migration runbook and regenerate types**

Add the following line after migration 15 in `db/README.md` and include `db/migrations/16_*.sql` in the documented `psql` loop:

```md
db/migrations/16_admin_table_operations.sql # maintenance requests + expanded property/building/unit CSV imports
```

Apply migrations in a development Supabase database in numeric order, then run:

```bash
bun run gen:types
```

Expected: `src/integrations/supabase/database.types.ts` contains `maintenance_requests`, `MaintenancePriority`, and `MaintenanceStatus`; no generated file is edited by hand.

- [ ] **Step 5: Add maintenance permissions to the UI permission registry**

In `src/lib/permissions.ts`, add `"maintenance"` to `PERMISSION_MODULES` and add the constants below to `PERMISSIONS`:

```ts
MAINTENANCE_CREATE: "maintenance.create",
MAINTENANCE_DELETE: "maintenance.delete",
MAINTENANCE_EXPORT: "maintenance.export",
MAINTENANCE_READ: "maintenance.read",
MAINTENANCE_UPDATE: "maintenance.update",
```

- [ ] **Step 6: Re-run the focused test**

Run: `bun run test src/lib/bulkImportSchemas.test.ts`

Expected: still FAIL only until Task 2 adds `importSchemas.maintenance`; the failure must no longer be caused by missing generated database types or permission literals.

- [ ] **Step 7: Commit the foundation**

```bash
git add db/migrations/16_admin_table_operations.sql db/README.md src/integrations/supabase/database.types.ts src/lib/permissions.ts src/lib/bulkImportSchemas.test.ts
git commit -m "feat: add maintenance persistence foundation"
```

### Task 2: Make CSV templates and client validation testable

**Files:**

- Create: `src/lib/bulkImportTemplates.ts`
- Create: `src/lib/csv.test.ts`
- Modify: `src/lib/csv.ts`
- Modify: `src/lib/bulkImportSchemas.ts`
- Modify: `src/lib/bulkImportSchemas.test.ts`

- [ ] **Step 1: Write failing tests for template headers and new row contracts**

Append these tests to `src/lib/bulkImportSchemas.test.ts` and create `src/lib/csv.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { importTemplateHeaders } from "@/lib/bulkImportTemplates";

describe("bulk import templates", () => {
  test("uses codes instead of UUIDs for a unit relationship", () => {
    expect(importTemplateHeaders.units).toEqual([
      "code",
      "property_code",
      "building_code",
      "name",
      "type",
      "area",
      "status",
      "electricity_meter_ownership",
      "default_rent",
      "description_ar",
      "description_en",
    ]);
  });
});
```

```ts
import { describe, expect, test } from "vitest";

import { serializeCsvWithHeaders } from "@/lib/csv";

describe("serializeCsvWithHeaders", () => {
  test("returns a header row when no data rows exist", () => {
    expect(serializeCsvWithHeaders(["property_code", "title"], [])).toBe("property_code,title");
  });
});
```

Add validation cases that reject a missing `property_code`, unknown enum text, and an empty maintenance title.

- [ ] **Step 2: Verify red**

Run: `bun run test src/lib/bulkImportSchemas.test.ts src/lib/csv.test.ts`

Expected: FAIL because the template module and `serializeCsvWithHeaders` do not exist.

- [ ] **Step 3: Implement the pure template and CSV helpers**

Add `serializeCsvWithHeaders` and `downloadCsvTemplate` to `src/lib/csv.ts`:

```ts
export function serializeCsvWithHeaders(
  headers: readonly string[],
  rows: Array<Record<string, unknown>>,
): string {
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\r\n");
}

export function downloadCsvTemplate(filename: string, headers: readonly string[]): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob(["\uFEFF", serializeCsvWithHeaders(headers, [])], {
      type: "text/csv;charset=utf-8",
    }),
  );
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
```

Create `src/lib/bulkImportTemplates.ts` with a `satisfies Record<ImportEntity, readonly string[]>` map covering existing entities plus `properties`, `buildings`, `units`, and `maintenance`. Export `downloadImportTemplate(entity)` that calls `downloadCsvTemplate(`${entity}-template.csv`, importTemplateHeaders[entity])`.

- [ ] **Step 4: Extend import schemas with code-based relationships**

Extend `ImportEntity` to include `properties`, `buildings`, and `maintenance`. Replace the current unit import contract’s `property_id` and `building_id` inputs with these exact fields:

```ts
property_code: z.string().trim().min(1),
building_code: optionalText,
```

Define building and maintenance rows as follows:

```ts
buildings: z.object({
  code: optionalText,
  property_code: z.string().trim().min(1),
  category_code: optionalText,
  name_ar: z.string().trim().min(1),
  name_en: optionalText,
  address_ar: optionalText,
  address_en: optionalText,
  area: optionalNumber,
  floors: optionalNumber,
  image_url: optionalText,
  description_ar: optionalText,
  description_en: optionalText,
  status: z.preprocess(emptyToUndefined, z.enum(["active", "inactive", "under_maintenance", "archived"]).default("active")),
}),
maintenance: z.object({
  code: optionalText,
  property_code: z.string().trim().min(1),
  building_code: optionalText,
  unit_code: optionalText,
  title: z.string().trim().min(1),
  description: optionalText,
  priority: z.preprocess(emptyToUndefined, z.enum(["low", "medium", "high", "urgent"]).default("medium")),
  status: z.preprocess(emptyToUndefined, z.enum(["open", "in_progress", "completed", "cancelled"]).default("open")),
}),
```

Use the same `optionalText`, `optionalNumber`, and enum preprocessing conventions already in this file; do not introduce another validation library.

- [ ] **Step 5: Verify green and review test quality**

Run: `bun run test src/lib/bulkImportSchemas.test.ts src/lib/csv.test.ts`

Expected: PASS.

Apply Test Guard before continuing: retain one behavior per test, use `test.each` only for enum variants, and do not mock internal helpers.

- [ ] **Step 6: Commit the pure CSV layer**

```bash
git add src/lib/csv.ts src/lib/csv.test.ts src/lib/bulkImportTemplates.ts src/lib/bulkImportSchemas.ts src/lib/bulkImportSchemas.test.ts
git commit -m "feat: add reusable CSV import templates"
```

### Task 3: Resolve CSV relationship codes on the server and refresh imported data

**Files:**

- Modify: `src/fns/bulkImport.ts`
- Modify: `src/hooks/useBulkImport.ts`
- Modify: `src/components/admin/CsvImportDialog.tsx`
- Test: `src/lib/bulkImportSchemas.test.ts`

- [ ] **Step 1: Write failing resolver-focused tests before server changes**

Extract a pure row-shaping function from the server function into `src/lib/bulkImportRelations.ts` and create `src/lib/bulkImportRelations.test.ts`. Start with this exact contract:

```ts
import { describe, expect, test } from "vitest";

import { validateResolvedLocation } from "@/lib/bulkImportRelations";

describe("validateResolvedLocation", () => {
  test("rejects a building outside the selected property", () => {
    expect(
      validateResolvedLocation({
        propertyId: "property-a",
        building: { id: "building-b", property_id: "property-b" },
        unit: null,
      }),
    ).toBe("building_code does not belong to property_code");
  });
});
```

- [ ] **Step 2: Verify red**

Run: `bun run test src/lib/bulkImportRelations.test.ts`

Expected: FAIL because `validateResolvedLocation` does not exist.

- [ ] **Step 3: Implement relation resolution without client UUIDs**

Create `src/lib/bulkImportRelations.ts` with these exported types and pure hierarchy rule:

```ts
export interface ResolvedLocation {
  propertyId: string;
  building: { id: string; property_id: string } | null;
  unit: { id: string; property_id: string; building_id: string | null } | null;
}

export function validateResolvedLocation(location: ResolvedLocation): string | null {
  if (location.building && location.building.property_id !== location.propertyId) {
    return "building_code does not belong to property_code";
  }
  if (location.unit && location.unit.property_id !== location.propertyId) {
    return "unit_code does not belong to property_code";
  }
  if (location.unit && location.building && location.unit.building_id !== location.building.id) {
    return "unit_code does not belong to building_code";
  }
  return null;
}
```

In `src/fns/bulkImport.ts`, add `properties`, `buildings`, and `maintenance` to `permissionByEntity`. Fetch the needed property, building, category, and unit rows once per request using `supabaseAdmin`, index them by code, resolve each valid parsed row, and append a row-specific `ImportValidationError` for unknown codes or a non-null `validateResolvedLocation` result. Send only resolved UUID fields to `bulk_import_phase6`.

Preserve the current partial-import contract: valid rows are inserted, invalid rows are reported, and errors are never swallowed. Supply the current company ID server-side for properties and maintenance rather than trusting a CSV `company_id`.

- [ ] **Step 4: Add a template action to the import dialog**

In `CsvImportDialog`, import `downloadImportTemplate` and add this button before the file input:

```tsx
<Button type="button" variant="outline" onClick={() => downloadImportTemplate(entity)}>
  <Download className="size-4" />
  {t("import.downloadTemplate")}
</Button>
```

Import `Download` from `lucide-react`. The page headers in later tasks expose the same template command; the dialog command ensures a user who opened Import can still obtain the correct file.

- [ ] **Step 5: Invalidate every affected list after import**

Replace the entity-specific `onSuccess` branch in `useBulkImport` with this exact invalidation behavior:

```ts
onSuccess: (_importResult, input) => {
  queryClient.invalidateQueries({ queryKey: [input.entity] });
  if (input.entity === "properties" || input.entity === "buildings" || input.entity === "units") {
    queryClient.invalidateQueries({ queryKey: ["properties"] });
    queryClient.invalidateQueries({ queryKey: ["buildings"] });
    queryClient.invalidateQueries({ queryKey: ["units"] });
  }
  if (input.entity === "expenses" || input.entity === "deposits") {
    queryClient.invalidateQueries({ queryKey: ["budget"] });
    queryClient.invalidateQueries({ queryKey: ["report-preview"] });
  }
},
```

- [ ] **Step 6: Verify green**

Run: `bun run test src/lib/bulkImportRelations.test.ts src/lib/bulkImportSchemas.test.ts src/lib/csv.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit server import behavior**

```bash
git add src/fns/bulkImport.ts src/hooks/useBulkImport.ts src/components/admin/CsvImportDialog.tsx src/lib/bulkImportRelations.ts src/lib/bulkImportRelations.test.ts
git commit -m "feat: resolve CSV relationship codes securely"
```

### Task 4: Establish shared icon actions, RTL checkbox spacing, and LTR telephone fields

**Files:**

- Create: `src/components/admin/TableActionButton.tsx`
- Modify: `src/components/ui/table.tsx`
- Modify: `src/components/admin/Phase2FormFields.tsx`
- Modify: `src/routes/admin.tenants.index.tsx`
- Modify: `src/routes/admin.settings.index.tsx`
- Modify: `src/routes/index.tsx`
- Modify: `src/i18n/dictionary.ts`

- [ ] **Step 1: Add the missing View translations first**

In both locale dictionaries add these keys adjacent to the existing `common.edit` and `common.delete` keys:

```ts
"common.view": "عرض",
"import.downloadTemplate": "تنزيل نموذج CSV",
```

```ts
"common.view": "View",
"import.downloadTemplate": "Download CSV template",
```

- [ ] **Step 2: Create the shared action component**

Create `src/components/admin/TableActionButton.tsx` with a narrow API that supports today’s required actions only:

```tsx
import type { ComponentProps, ReactNode } from "react";
import { Eye, FileText, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";

export type TableAction = "view" | "edit" | "delete" | "documents";

const actionIcons = {
  view: Eye,
  edit: Pencil,
  delete: Trash2,
  documents: FileText,
} as const;

export function TableActionButton({
  action,
  children,
  ...buttonProps
}: ComponentProps<typeof Button> & { action: TableAction; children?: ReactNode }) {
  const { t } = useI18n();
  const Icon = actionIcons[action];
  const label = action === "documents" ? t("tenants.documents") : t(`common.${action}`);

  return (
    <Button
      size="icon"
      variant="ghost"
      className={action === "delete" ? "text-destructive" : undefined}
      title={label}
      {...buttonProps}
    >
      {children ?? <Icon className="size-4" />}
      <span className="sr-only">{label}</span>
    </Button>
  );
}
```

Use the existing app tooltip component around this button if it is already rendered by the application shell; otherwise `title` plus the screen-reader label is the accessible fallback. Do not introduce a new provider solely for this control.

- [ ] **Step 3: Fix checkbox gutter globally**

In `src/components/ui/table.tsx`, replace both physical checkbox padding overrides:

```tsx
[&:has([role=checkbox])]:pr-0
```

with logical padding that keeps the inline-start edge clear in both directions:

```tsx
[&:has([role=checkbox])]:ps-4 [&:has([role=checkbox])]:pe-2
```

Keep the checkbox vertical translation unchanged. This fixes every table from the shared primitive rather than patching individual pages.

- [ ] **Step 4: Make reusable telephone fields LTR**

Add a `dir?: "ltr" | "rtl" | "auto"` prop to `FormTextField`, then pass it through to the `Input`. Default telephone fields to LTR without changing text fields:

```tsx
<Input
  {...field}
  dir={dir ?? (type === "tel" ? "ltr" : undefined)}
  inputMode={type === "tel" ? "tel" : undefined}
  value={String(field.value ?? "")}
  type={type}
  readOnly={readOnly}
/>
```

Update the tenant mobile and WhatsApp fields to `type="tel"`. Update raw company phone, WhatsApp, and public contact-phone inputs in the listed routes with `type="tel" dir="ltr" inputMode="tel"`.

- [ ] **Step 5: Typecheck shared UI work**

Run: `bun run typecheck`

Expected: PASS. If an existing unrelated failure occurs, record it separately; do not mask it or loosen types.

- [ ] **Step 6: Commit shared table accessibility**

```bash
git add src/components/admin/TableActionButton.tsx src/components/ui/table.tsx src/components/admin/Phase2FormFields.tsx src/routes/admin.tenants.index.tsx src/routes/admin.settings.index.tsx src/routes/index.tsx src/i18n/dictionary.ts
git commit -m "feat: standardize table actions and alignment"
```

### Task 5: Derive tenant property and unit columns from active contracts

**Files:**

- Create: `src/lib/tenantLocations.ts`
- Create: `src/lib/tenantLocations.test.ts`
- Modify: `src/hooks/useTenants.ts`
- Modify: `src/routes/admin.tenants.index.tsx`

- [ ] **Step 1: Write failing active-contract selection tests**

Create `src/lib/tenantLocations.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { selectActiveContractByTenant } from "@/lib/tenantLocations";

describe("selectActiveContractByTenant", () => {
  test("selects the latest active contract for each tenant", () => {
    const selected = selectActiveContractByTenant([
      {
        id: "older",
        tenant_id: "tenant-1",
        unit_id: "unit-a",
        state: "active",
        start_date: "2025-01-01",
      },
      {
        id: "latest",
        tenant_id: "tenant-1",
        unit_id: "unit-b",
        state: "active",
        start_date: "2025-02-01",
      },
      {
        id: "draft",
        tenant_id: "tenant-2",
        unit_id: "unit-c",
        state: "draft",
        start_date: "2025-03-01",
      },
    ]);

    expect(selected.get("tenant-1")?.id).toBe("latest");
    expect(selected.has("tenant-2")).toBe(false);
  });
});
```

- [ ] **Step 2: Verify red**

Run: `bun run test src/lib/tenantLocations.test.ts`

Expected: FAIL because the selection helper does not exist.

- [ ] **Step 3: Implement the pure selector**

Create `src/lib/tenantLocations.ts`:

```ts
interface ActiveContractCandidate {
  id: string;
  tenant_id: string;
  unit_id: string;
  state: string;
  start_date: string;
}

export function selectActiveContractByTenant<T extends ActiveContractCandidate>(
  contracts: T[],
): Map<string, T> {
  return contracts
    .filter((contract) => contract.state === "active")
    .sort((left, right) => right.start_date.localeCompare(left.start_date))
    .reduce((byTenant, contract) => {
      if (!byTenant.has(contract.tenant_id)) byTenant.set(contract.tenant_id, contract);
      return byTenant;
    }, new Map<string, T>());
}
```

- [ ] **Step 4: Attach active locations in `useTenants`**

Change the public result type to include only derived display data:

```ts
export interface TenantWithActiveLocation extends Tenant {
  connectedProperty: Tables<"properties"> | null;
  connectingUnit: Tables<"units"> | null;
}
```

After fetching the tenant page, query active contracts for only those tenant IDs; use `selectActiveContractByTenant`; fetch the selected units and their properties in two batched queries; then map tenants to `connectedProperty` and `connectingUnit`. Keep the original tenant form type and all tenant mutation payloads untouched.

- [ ] **Step 5: Render the two derived columns**

In the Tenants table, insert headers immediately after the name column:

```tsx
<TableHead>{t("tenants.connectedProperty")}</TableHead>
<TableHead>{t("tenants.connectingUnit")}</TableHead>
```

Render `tenant.connectedProperty?.name_ar ?? "—"` and `tenant.connectingUnit?.name ?? "—"` with locale-aware English fallbacks. Add both translations in Arabic and English. Do not add any fields to `Values`, `defaults`, `schema`, or the Add Tenant dialog.

- [ ] **Step 6: Verify green and test behavior**

Run: `bun run test src/lib/tenantLocations.test.ts`

Expected: PASS.

Manually verify one tenant with an active contract and one with none. The Add Tenant form must contain exactly the same fields it did before this task.

- [ ] **Step 7: Commit tenant location display**

```bash
git add src/lib/tenantLocations.ts src/lib/tenantLocations.test.ts src/hooks/useTenants.ts src/routes/admin.tenants.index.tsx src/i18n/dictionary.ts
git commit -m "feat: show tenant active contract location"
```

### Task 6: Add filters and CSV operations to Properties, Buildings, and Units

**Files:**

- Modify: `src/hooks/useProperties.ts`
- Modify: `src/hooks/useBuildings.ts`
- Modify: `src/hooks/useUnits.ts`
- Modify: `src/routes/admin.properties.index.tsx`
- Modify: `src/routes/admin.units.index.tsx`
- Modify: `src/i18n/dictionary.ts`

- [ ] **Step 1: Extend list parameter contracts before rendering controls**

Add these filter fields to the existing hook parameter interfaces and query keys:

```ts
// PropertyListParams
status?: Property["status"];
type?: Property["type"];

// BuildingListParams
categoryId?: string;
status?: Building["status"];
```

Apply each field to the Supabase query using `.eq`, reset pagination in the page state setters, and preserve the current search normalization.

Add explicit export hooks such as `usePropertyExport(filters, enabled)` that query the same filtered collection with `pageSize: 500` only after `properties.export` permission is granted. Do the same for buildings and units. These export hooks must not reuse the paginated list’s ten-item page.

- [ ] **Step 2: Add Properties and Buildings views**

In `admin.properties.index.tsx`, add a `Tabs` control with `properties` and `buildings` values. Keep the existing property create/edit/detail flow in the Properties view. The Buildings view is a pageable table based on `useBuildings`, with search, property, category, and status filters.

Each view’s header exposes these controls in this order:

```tsx
<Button variant="outline" onClick={() => downloadImportTemplate("properties")}>
  <Download className="size-4" />
  {t("import.downloadTemplate")}
</Button>
<Button variant="outline" onClick={() => setImportOpen(true)}>
  <Upload className="size-4" />
  {t("common.import")}
</Button>
<Button variant="outline" disabled={!exportRows.length} onClick={exportCsv}>
  <Download className="size-4" />
  {t("export.csv")}
</Button>
```

Use entity-specific `importOpen` state or a single `importEntity: ImportEntity | null` state so the dialog receives the correct entity. Require `properties.create` / `buildings.create` for imports and `properties.export` / `buildings.export` for exports.

- [ ] **Step 3: Add Units CSV controls without changing its existing filters**

In `admin.units.index.tsx`, retain the six existing filters. Add the same template, import, and filtered export actions in `ModuleHeader.actions`, using `units` as the import entity and `PERMISSIONS.UNITS_EXPORT` for export. Format property and building export columns using the fetched lookup maps, not UUIDs.

- [ ] **Step 4: Replace local text actions on these pages**

Use `TableActionButton` for every View/Edit/Delete control in the Properties, Buildings, Units, and nested Property Detail tables. For links, retain `Button asChild` behavior by placing the `Link` inside the shared action component’s `asChild` path. Keep row click handlers working by stopping action-container propagation.

- [ ] **Step 5: Add exact new translations**

Add Arabic and English keys for `properties.tabProperties`, `properties.tabBuildings`, `buildings.title`, `buildings.search`, `maintenance`-independent filter labels, and `import.downloadTemplate`. Do not use raw English fallback strings in new UI.

- [ ] **Step 6: Run focused verification**

Run:

```bash
bun run typecheck
bun run lint
```

Expected: PASS.

Manually verify each CSV template downloads headers with no data, imported data appears after the dialog closes, filters affect exports, and building options narrow when a property is selected.

- [ ] **Step 7: Commit property/building/unit tooling**

```bash
git add src/hooks/useProperties.ts src/hooks/useBuildings.ts src/hooks/useUnits.ts src/routes/admin.properties.index.tsx src/routes/admin.units.index.tsx src/i18n/dictionary.ts
git commit -m "feat: add CSV tools to property management"
```

### Task 7: Deliver the Maintenance vertical slice

**Files:**

- Create: `src/hooks/useMaintenance.ts`
- Create: `src/routes/admin.maintenance.index.tsx`
- Modify: `src/components/admin/AdminSidebar.tsx`
- Modify: `src/i18n/dictionary.ts`

- [ ] **Step 1: Define the hook API before the page**

Create `src/hooks/useMaintenance.ts` using the repository’s `useProperties`/`useUnits` hook style. Export:

```ts
export type MaintenanceRequest = Tables<"maintenance_requests">;

export interface MaintenanceListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  propertyId?: string;
  buildingId?: string;
  unitId?: string;
  priority?: MaintenancePriority;
  status?: MaintenanceStatus;
}
```

Implement `useMaintenanceRequests`, `useMaintenanceExport`, `useCreateMaintenanceRequest`, `useUpdateMaintenanceRequest`, and `useDeleteMaintenanceRequest`. List queries use `count: "exact"`, newest-first ordering, every supplied filter, `normalizePostgrestSearch(search)` on code/title, permission checks, audit records named `maintenance_request.create`, `maintenance_request.update`, and `maintenance_request.delete`, and `maintenance` query invalidation after mutations.

- [ ] **Step 2: Build the form schema and dependent selectors**

At the top of `admin.maintenance.index.tsx`, create this Zod schema:

```ts
const maintenanceSchema = z.object({
  property_id: z.string().uuid(),
  building_id: z.string(),
  unit_id: z.string(),
  title: z.string().trim().min(1),
  description: z.string(),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  status: z.enum(["open", "in_progress", "completed", "cancelled"]),
});
```

On property selection, clear building and unit. Restrict building options to the selected property and unit options to the selected property/building. Convert the sentinel `"none"` to `null` in the mutation payload. Use the same `FormTextField`, `FormSelectField`, `DeleteConfirmation`, `Pager`, `TableState`, and toast patterns as Units.

- [ ] **Step 3: Build list, filters, CSV actions, and icon actions**

The table columns, in order, are checkbox, number, code, title, property, building, unit, priority, status, and actions. Its filters are search, property, building, unit, priority, and status. Module header actions expose template download, CSV export, import, and Add Maintenance Request, each gated by the matching maintenance permission.

Use `TableActionButton` for view/edit/delete. The view action opens a read-only dialog showing every maintenance field; edit reuses the form dialog; delete uses `DeleteConfirmation`. Do not add a separate detail route unless a current caller needs one.

- [ ] **Step 4: Add navigation and translations**

In `AdminSidebar`, add `Wrench` to Lucide imports, add `"admin.maintenance"` to `ItemKey`, and insert this primary navigation item after Units:

```ts
{ key: "admin.maintenance", to: "/admin/maintenance", icon: Wrench },
```

Add Arabic and English keys for the title, subtitle, form fields, priorities, statuses, filters, delete copy, and `maintenance.add` / `maintenance.edit` / `maintenance.view`. Use `t("maintenance.priority.${request.priority}")` and `t("maintenance.status.${request.status}")` rather than hardcoded labels.

- [ ] **Step 5: Generate the route tree and verify the route**

Run:

```bash
bun run dev
```

Open `/admin/maintenance`, verify it renders from file-based routing, then stop the server. Do not hand-edit `src/routeTree.gen.ts`; the router plugin updates it.

- [ ] **Step 6: Run type and behavior checks**

Run:

```bash
bun run typecheck
bun run lint
bun run test
```

Expected: PASS.

Manually exercise property-only, property-plus-building, and property-plus-building-plus-unit maintenance requests, then verify the CSV importer rejects a building or unit that belongs to another property.

- [ ] **Step 7: Commit maintenance**

```bash
git add src/hooks/useMaintenance.ts src/routes/admin.maintenance.index.tsx src/components/admin/AdminSidebar.tsx src/i18n/dictionary.ts src/routeTree.gen.ts
git commit -m "feat: add maintenance request management"
```

### Task 8: Sweep every remaining action column and protect the final quality bar

**Files:**

- Modify: `src/routes/admin.contracts.tsx`
- Modify: `src/routes/admin.deposits.tsx`
- Modify: `src/routes/admin.expenses.tsx`
- Modify: `src/routes/admin.properties.$id.tsx`
- Modify: `src/routes/admin.reports.tsx`
- Modify: `src/routes/admin.settings.notifications.tsx`
- Modify: `src/routes/admin.tenants.index.tsx`
- Modify: `src/routes/admin.properties.index.tsx`
- Modify: `src/routes/admin.units.index.tsx`
- Modify: any route returned by `rg -l 't\("common\.(view|edit|delete)"\)' src/routes --glob '*.tsx'`

- [ ] **Step 1: Inventory action labels before changing them**

Run:

```bash
rg -n 't\("common\.(view|edit|delete)"\)' src/routes --glob '*.tsx'
```

Record every result. The sweep is complete only when every table action using those three translations is an icon action backed by `TableActionButton`.

- [ ] **Step 2: Replace actions while preserving behavior**

For each result:

- replace textual View links with `action="view"` and preserve their exact route parameters;
- replace textual Edit buttons with `action="edit"`, preserving existing disabled permission checks and click handlers;
- replace textual Delete buttons with `action="delete"`, preserving confirmation state and destructive permissions;
- retain non-CRUD operations such as Retry, Cancel, Print, and Export as their existing semantic controls unless they are in a table action column and already have a matching icon;
- add `onClick={(event) => event.stopPropagation()}` only where the row itself is clickable.

Do not alter server mutations, filters, sort order, or confirmation copy during this visual-only sweep.

- [ ] **Step 3: Verify no translation-key leakage remains**

Run:

```bash
rg -n 'common\.view|common_view' src --glob '*.{ts,tsx}'
```

Expected: source references are only valid `t("common.view")` calls or translation dictionary entries. In the running Arabic and English applications, no button visibly renders `common.view` or `common_view`.

- [ ] **Step 4: Run Test Guard and Clean Code Guard**

Review changed test files with Test Guard:

- each test asserts observable parser/selector behavior;
- no mocked internal helpers;
- no duplicate enum tests that should be `test.each`;
- no snapshot or framework-guarantee tests.

Review the production diff with Clean Code Guard:

- action, relation, and import helper names reveal intent;
- no helper exceeds one responsibility;
- all imports and TanStack/Supabase APIs are verified against the installed versions and generated types;
- error handling returns row errors only for recoverable validation failures and propagates database failures;
- no new abstraction or feature flag lacks a current caller;
- no text-action duplication remains.

- [ ] **Step 5: Run final automated verification**

Run exactly:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
graphify update .
```

Expected: every command exits successfully. If a pre-existing failure is discovered, do not claim completion; isolate it with its command output and create a blocker task.

- [ ] **Step 6: Perform final manual acceptance checks**

Validate in both Arabic and English:

1. Maintenance CRUD, filters, CSV template, import, and filtered export work under permissions.
2. Properties, Buildings, and Units expose all requested CSV controls and filters.
3. Every View/Edit/Delete table action is an icon with a usable tooltip/screen-reader name.
4. Tenants display connected property and unit only from an active contract; the Add Tenant form has no new location fields.
5. Mobile and WhatsApp inputs and displayed numbers remain LTR in the Arabic UI.
6. The first checkbox column has visible spacing from the Arabic table edge on desktop and narrow mobile widths.

- [ ] **Step 7: Commit the final sweep**

```bash
git add src/routes src/components src/i18n src/hooks src/lib graphify-out
git commit -m "feat: complete admin table operations"
```

Do not stage unrelated files. Confirm `git status --short` contains only intentional changes before this commit.
