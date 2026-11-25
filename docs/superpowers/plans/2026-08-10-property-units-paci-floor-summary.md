# Property detail PACI / floor / summary counts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show PACI No. and Floor on the property detail units table, Floor on the main units table, and commercial / shop / floor-count rows on the property detail Summary card.

**Architecture:** Display-only UI over existing columns (`units.paci_no`, `units.floor`, `properties.floor_count`). Extract a pure type-count helper for testable summary math. Catalogue labels for floor reuse `useCatalogueLabel("unit_floors", …)` so free-text floors never render as missing i18n keys.

**Tech Stack:** TanStack Start / React 19, Vitest, existing option-list hooks, Bun.

Spec: `docs/superpowers/specs/2026-08-10-property-units-paci-floor-summary-design.md`

## Global Constraints

- Package manager is **Bun**. Run `bun run lint`, `bun run typecheck`, and targeted `bun run test` on touched files before presenting; full suite preferred before commit.
- **No migrations.** Schema already has `units.paci_no` (105), `units.floor` (101), `properties.floor_count` (104).
- **Never run `bun run gen:types`.** No column changes → do not touch `database.types.ts`.
- `src/routeTree.gen.ts` is generated — never edit.
- Document every **new** function with an Arabic-leading doc comment above it.
- Type matching for summary counts is **exact** string equality: `"commercial"` and `"shop"` only. Do not fuzzy-match or include custom catalogue values.
- Feature branch only; never force-push / rebase / amend pushed history (Lovable). Pushing a feature branch does not deploy.
- Keep new files under 500–600 lines; this plan adds at most a small lib helper.

## File map

| File | Responsibility |
| ---- | -------------- |
| Create: `src/lib/unitTypeCounts.ts` | Pure `countUnitsByType(items, type)` |
| Create: `src/lib/unitTypeCounts.test.ts` | Unit tests for exact type counts |
| Modify: `src/i18n/dictionary.ts` | AR/EN `units.commercialCount`, `units.shopCount` |
| Modify: `src/i18n/dictionary.test.ts` | Label tests for the new keys |
| Modify: `src/routes/admin.properties.$id.tsx` | PACI + floor columns; summary rows |
| Modify: `src/routes/admin.units.index.tsx` | Floor column after type |

---

### Task 1: Pure commercial / shop count helper

**Files:**

- Create: `src/lib/unitTypeCounts.ts`
- Test: `src/lib/unitTypeCounts.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `countUnitsByType(items: ReadonlyArray<{ type: string }>, type: string): number`. Task 3 imports this for the Summary card.

- [ ] **Step 1: Write the failing test**

Create `src/lib/unitTypeCounts.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { countUnitsByType } from "./unitTypeCounts";

const sample = [
  { type: "shop" },
  { type: "shop" },
  { type: "commercial" },
  { type: "apartment" },
  { type: "commercial_unit" }, // custom catalogue value — must NOT count as commercial
];

describe("countUnitsByType", () => {
  test("counts exact type matches only", () => {
    expect(countUnitsByType(sample, "shop")).toBe(2);
    expect(countUnitsByType(sample, "commercial")).toBe(1);
    expect(countUnitsByType(sample, "apartment")).toBe(1);
  });

  test("does not treat commercial_unit as commercial", () => {
    expect(countUnitsByType(sample, "commercial")).toBe(1);
    expect(countUnitsByType(sample, "commercial_unit")).toBe(1);
  });

  test("returns 0 for empty list or no matches", () => {
    expect(countUnitsByType([], "shop")).toBe(0);
    expect(countUnitsByType(sample, "warehouse")).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/unitTypeCounts.test.ts`

Expected: FAIL — module not found / `countUnitsByType` not defined.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/unitTypeCounts.ts`:

```ts
/**
 * يعدّ الوحدات التي يطابق نوعها القيمة المعطاة تطابقاً حرفياً.
 *
 * Free-text `units.type` (migration 103). Exact equality only — do not treat
 * catalogue cousins like `commercial_unit` as `commercial`. Used by the
 * property detail Summary card for commercial / shop counts.
 */
export function countUnitsByType(
  items: ReadonlyArray<{ type: string }>,
  type: string,
): number {
  return items.filter((item) => item.type === type).length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/unitTypeCounts.test.ts`

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/unitTypeCounts.ts src/lib/unitTypeCounts.test.ts
git commit -m "feat: pure countUnitsByType for property summary commercial/shop rows"
```

---

### Task 2: i18n labels for commercial / shop summary rows

**Files:**

- Modify: `src/i18n/dictionary.ts` (Arabic block near `units.vacant` / `units.totalRent` ~L513–517; English block ~L2108–2112)
- Modify: `src/i18n/dictionary.test.ts` (after the `units.floor labels` describe ~L271–288)

**Interfaces:**

- Consumes: nothing.
- Produces: dictionary keys `units.commercialCount` and `units.shopCount` for Task 3.

- [ ] **Step 1: Write the failing dictionary tests**

Append to `src/i18n/dictionary.test.ts`:

```ts
describe("units.commercialCount and units.shopCount labels", () => {
  test("commercialCount exists in ar and en and differs", () => {
    expect(dictionaries.ar["units.commercialCount"]).toBe("الوحدات التجارية");
    expect(dictionaries.en["units.commercialCount"]).toBe("Commercial units");
    expect(dictionaries.ar["units.commercialCount"]).not.toBe(
      dictionaries.en["units.commercialCount"],
    );
  });

  test("shopCount exists in ar and en and differs", () => {
    expect(dictionaries.ar["units.shopCount"]).toBe("المحلات");
    expect(dictionaries.en["units.shopCount"]).toBe("Shop units");
    expect(dictionaries.ar["units.shopCount"]).not.toBe(dictionaries.en["units.shopCount"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test src/i18n/dictionary.test.ts -t "commercialCount|shopCount"`

Expected: FAIL — undefined keys / wrong values.

- [ ] **Step 3: Add dictionary entries**

In the **Arabic** object of `src/i18n/dictionary.ts`, immediately after `"units.vacant"` (or next to other `units.*` summary labels), add:

```ts
    "units.commercialCount": "الوحدات التجارية",
    "units.shopCount": "المحلات",
```

In the **English** object, same relative place:

```ts
    "units.commercialCount": "Commercial units",
    "units.shopCount": "Shop units",
```

Reuse existing keys (do not re-add): `units.paciNo`, `units.floor`, `properties.floorCount`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test src/i18n/dictionary.test.ts -t "commercialCount|shopCount"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/dictionary.ts src/i18n/dictionary.test.ts
git commit -m "i18n: commercial and shop unit count labels for property summary"
```

---

### Task 3: Property detail — PACI, Floor columns + Summary rows

**Files:**

- Modify: `src/routes/admin.properties.$id.tsx`
- Consumes: `countUnitsByType` from Task 1; i18n keys from Task 2; existing `useCatalogueLabel` from `@/hooks/useOptionLists`.

**Interfaces:**

- Consumes: `countUnitsByType`, `t("units.paciNo")`, `t("units.floor")`, `t("units.commercialCount")`, `t("units.shopCount")`, `t("properties.floorCount")`, `useCatalogueLabel("unit_floors", "unitFloor")`.
- Produces: updated property detail page UI (no new exports).

- [ ] **Step 1: Extend the summary `useMemo`**

Near L46–54, replace the summary computation with:

```ts
  const summary = useMemo(() => {
    const items = units.data?.items ?? [];
    return {
      total: items.length,
      occupied: items.filter((u) => u.occupant).length,
      vacant: items.filter((u) => !u.occupant).length,
      totalRent: items.reduce((s, u) => s + Number(u.default_rent ?? 0), 0),
      commercial: countUnitsByType(items, "commercial"),
      shop: countUnitsByType(items, "shop"),
    };
  }, [units.data]);
```

Add import:

```ts
import { countUnitsByType } from "@/lib/unitTypeCounts";
import { useCatalogueLabel } from "@/hooks/useOptionLists";
```

Inside the component (with other hooks):

```ts
  const unitFloorLabel = useCatalogueLabel("unit_floors", "unitFloor");
```

`translatePrefix: "unitFloor"` has no dictionary seeds; `catalogueLabelFor` falls back to the raw value when the catalogue is empty — correct for free-text floors. When the catalogue is loaded, seeded labels (Ground floor / الطابق الأرضي, …) show.

- [ ] **Step 2: Extend the Summary card rows**

Replace the Summary `CardContent` block (~L181–186) with:

```tsx
          <CardContent className="space-y-3 text-sm">
            <Row label={t("units.title")} value={summary.total} />
            <Row label={t("units.occupied")} value={summary.occupied} />
            <Row label={t("units.vacant")} value={summary.vacant} />
            <Row label={t("units.commercialCount")} value={summary.commercial} />
            <Row label={t("units.shopCount")} value={summary.shop} />
            <Row
              label={t("properties.floorCount")}
              value={p.floor_count != null ? p.floor_count : "—"}
            />
            <Row label={t("units.totalRent")} value={summary.totalRent.toFixed(3)} />
          </CardContent>
```

Note: `p` is only defined after the early returns. The Summary card is already below those returns, so `p.floor_count` is valid here. If the compiler complains about hook order for `unitFloorLabel`, keep the hook **before** early returns (with other hooks).

- [ ] **Step 3: Add PACI and Floor columns to the units table**

Table header (~L215–222) — insert PACI after code, Floor after type:

```tsx
                <TableRow>
                  <TableHead>{t("common.code")}</TableHead>
                  <TableHead>{t("units.paciNo")}</TableHead>
                  <TableHead>{t("common.name")}</TableHead>
                  <TableHead>{t("common.type")}</TableHead>
                  <TableHead>{t("units.floor")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead>{t("units.rent")}</TableHead>
                  <TableHead>{t("units.occupant")}</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
```

Table body cells (~L227–253) — after code cell, add PACI; after type cell, add Floor:

```tsx
                    <TableCell className="font-mono text-xs">{u.code}</TableCell>
                    <TableCell className="font-mono text-xs">{u.paci_no ?? "—"}</TableCell>
                    <TableCell>{u.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{u.type}</Badge>
                    </TableCell>
                    <TableCell>{u.floor ? unitFloorLabel(u.floor) : "—"}</TableCell>
                    <TableCell>
                      <Badge variant={u.status === "vacant" ? "default" : "secondary"}>
                        {u.status}
                      </Badge>
                    </TableCell>
```

(Keep the rest of the row — rent, occupant, actions — unchanged.)

- [ ] **Step 4: Typecheck the route file**

Run: `bun run typecheck`

Expected: clean (or only pre-existing issues unrelated to this file).

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.properties.\$id.tsx
git commit -m "feat(properties): PACI and floor columns plus commercial/shop/floor summary"
```

---

### Task 4: Main units table — Floor column

**Files:**

- Modify: `src/routes/admin.units.index.tsx`

**Interfaces:**

- Consumes: `useCatalogueLabel` (already imported for unit types).
- Produces: Floor column UI only.

- [ ] **Step 1: Add floor label resolver**

Near the existing `unitTypeLabel` (~L109):

```ts
  const unitFloorLabel = useCatalogueLabel("unit_floors", "unitFloor");
```

- [ ] **Step 2: Insert Floor header after type**

In the table header (~L340–345), after the type `SortableHead` and before status:

```tsx
                <SortableHead sortKey="type" sort={sort} toggle={toggle}>
                  {t("common.type")}
                </SortableHead>
                <SortableHead sortKey="floor" sort={sort} toggle={toggle}>
                  {t("units.floor")}
                </SortableHead>
                <SortableHead sortKey="status" sort={sort} toggle={toggle}>
                  {t("common.status")}
                </SortableHead>
```

`useTableSort` already reads arbitrary keys off the row object (`floor` exists on `Unit`). If the sort accessor does not handle `floor`, verify by reading the sort getter near L90–100; if it uses `unit[key]` style access, `floor` works without further changes.

- [ ] **Step 3: Insert Floor cell after type cell**

In the body (~L387–394), after the type `TableCell` and before status:

```tsx
                    <TableCell>
                      <Badge variant={unitTypeTone(unit.type)}>{unitTypeLabel(unit.type)}</Badge>
                    </TableCell>
                    <TableCell>{unit.floor ? unitFloorLabel(unit.floor) : "—"}</TableCell>
                    <TableCell>
                      <Badge variant={unitStatusTone(unit.status)}>
                        {t(`unitStatus.${unit.status}`)}
                      </Badge>
                    </TableCell>
```

Do **not** remove or reorder PACI — it already exists on this page.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`

Expected: clean for this change.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.units.index.tsx
git commit -m "feat(units): show floor column on the main units table"
```

---

### Task 5: Project gates + test-guard / clean-code-guard

**Files:** all of the above (review only).

- [ ] **Step 1: Run targeted tests**

```bash
bun run test src/lib/unitTypeCounts.test.ts src/i18n/dictionary.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run lint + typecheck**

```bash
bun run lint
bun run typecheck
```

Expected: no new errors from this work.

- [ ] **Step 3: clean-code-guard mindset (manual checklist)**

Confirm:

- No dead code, no unused imports.
- No fuzzy type matching.
- Empty PACI / floor render `—`, never blank or `null` stringified.
- Floor uses catalogue labels, never `t(\`unitFloor.${value}\`)` alone (that would flash the raw key).
- No new migrations, no `database.types.ts` edits, no `routeTree.gen.ts` edits.
- New function has Arabic-leading doc comment.

- [ ] **Step 4: test-guard mindset (manual checklist)**

Confirm:

- `countUnitsByType` tests assert real behavior (exact match, custom type not counted).
- Dictionary tests assert AR ≠ EN and exact strings from the plan.
- No tests that only mock and assert the mock was called.

- [ ] **Step 5: Optional empty commit message fix / final status**

If any uncommitted polish remains:

```bash
git status
git log --oneline -6
```

Report to the user: files changed, how to smoke-test (open a property with mixed unit types/floors/PACI).

---

## Spec coverage checklist

| Spec requirement | Task |
| ---------------- | ---- |
| PACI on property detail units table | Task 3 |
| Floor on main units table | Task 4 |
| Floor on property detail units table | Task 3 |
| Summary commercial count (`type === "commercial"`) | Tasks 1 + 3 |
| Summary shop count (`type === "shop"`) | Tasks 1 + 3 |
| Summary floor_count from property, always visible, `—` when null | Task 3 |
| i18n keys + dictionary tests | Task 2 |
| Pure count helper + tests | Task 1 |
| No migrations | Global Constraints |
| Empty cells → `—` | Tasks 3–4 |
| Catalogue labels for floor | Tasks 3–4 |

## Out of scope (do not implement)

- Properties list `floor_count` column
- Unit detail page floor display
- Floor filter on units list
- Per-floor breakdown
- Buildings table UI
- Any SQL migration
