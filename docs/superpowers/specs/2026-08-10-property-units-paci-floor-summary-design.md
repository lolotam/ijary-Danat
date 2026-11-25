# Property detail PACI / floor / summary counts — design

Date: 2026-08-10

## Problem

Operators need to see unit PACI numbers and floors when scanning a property’s
units, and need summary counts that match how buildings are discussed in Kuwait
real-estate work (commercial vs shop, plus declared floor count).

Several of these facts already exist in the database and forms but are not
shown on the property detail units table or the main units table, and the
property detail Summary card only shows total / occupied / vacant / total rent.

## Goals

1. Show **PACI No.** on the property detail units table (clone of the units-list
   column).
2. Show **Floor** on the main units table and on the property detail units
   table (which floor each unit sits on).
3. Extend the property detail **Summary** card with:
   - commercial unit count
   - shop unit count
   - property floor count (`properties.floor_count`)

## Non-goals

- New database columns or migrations (PACI and floor already exist).
- Changing how floor or PACI are stored or edited (unit form already handles
  both).
- Per-floor breakdown lists.
- Buildings admin table UI (no buildings list page).
- Properties list `floor_count` column.
- Reconciling `floor_count` / `unit_count` with live unit rows (see migration
  104 — drift is expected and intentional).

## Existing data (do not re-invent)

| Field | Table | Migration | Form | Currently shown |
| ----- | ----- | --------- | ---- | --------------- |
| `paci_no` | `units` | 105 | Unit form | Units list, unit detail; **not** property detail units table |
| `floor` | `units` | 101 | Unit form (`unit_floors` catalogue) | Form only; **not** list tables |
| `floor_count` | `properties` | 104 | Property form | Property detail info card; **not** Summary card |
| `type` | `units` | free text after 103 | Unit form (`unit_types`) | Both unit tables as badge |

## Design

### Approach: display-only

All work is UI + i18n. No schema change. Property detail already loads units for
the property (`useUnits({ propertyId, pageSize: 200 })`); summary counts are
derived from that list plus the loaded property row.

### 1. PACI No. on property detail units table

File: `src/routes/admin.properties.$id.tsx`

- Add a table head using existing `t("units.paciNo")`.
- Cell: `unit.paci_no` in mono small text, or `—` when null/empty.
- Placement: after **code**, matching the main units list order
  (`code` → `paci_no` → `name` → …).
- Main units list (`admin.units.index.tsx`) already has this column — no change
  unless a regression is found.

### 2. Floor column on both unit tables

Files:

- `src/routes/admin.units.index.tsx`
- `src/routes/admin.properties.$id.tsx`

- Head: existing `t("units.floor")`.
- Cell: display `unit.floor` when set, else `—`.
- Prefer catalogue labels when available (same pattern as unit type: map
  `unit_floors` option-list items for the current locale; fall back to the raw
  stored value if the catalogue has no match — free-text floor must never
  render as a missing i18n key).
- Placement on main units list: after **type** (physical attributes cluster:
  type / floor / status).
- Placement on property detail units table: after **type**, same reason.
- Sorting (main list only): optional; include `floor` in the existing
  `useTableSort` if other free-text columns already sort client-side, otherwise
  skip — not required for this feature.
- Filter by floor: out of scope.

### 3. Summary card extensions

File: `src/routes/admin.properties.$id.tsx` — the existing `summary` `useMemo`.

```
total, occupied, vacant, totalRent   // unchanged
commercial = count where type === "commercial"
shop       = count where type === "shop"
```

Display rows (after vacant / total rent, or grouped after unit counts):

| Label (i18n key) | Value |
| ---------------- | ----- |
| `units.commercialCount` | `summary.commercial` |
| `units.shopCount` | `summary.shop` |
| `properties.floorCount` | `p.floor_count` when non-null; `—` when null. **Always show this Summary row** (unlike the info card, which hides the row when null). |

**Type matching rule:** exact string equality on the free-text `units.type`
values seeded for commercial and shop (`"commercial"`, `"shop"`). Custom types
added in Settings → Lists (e.g. `commercial_unit`) are **not** counted as
commercial. This matches how filters and badges already treat type codes.
Document this in the plan so implementers do not invent fuzzy matching.

**Floor count source:** `properties.floor_count` only — the declared figure from
migration 104. Do **not** derive from distinct `units.floor` values or from
`buildings.floors`.

### 4. i18n

Add AR/EN keys (names final in implementation if dictionary conventions differ):

| Key | AR | EN |
| --- | -- | -- |
| `units.commercialCount` | الوحدات التجارية | Commercial units |
| `units.shopCount` | المحلات | Shop units |

Reuse:

- `units.paciNo`, `units.floor` (already present)
- `properties.floorCount` (already present) for the Summary floors row

Add dictionary tests for any new keys (mirror `units.floor` label tests).

### 5. Testing

- **Unit / component:** extend or add a small pure helper test if summary
  counting is extracted (recommended: `countUnitsByType(items, type)` or
  inline `useMemo` with a focused test of a pure function). Assert commercial /
  shop counts ignore other types and null floors do not affect type counts.
- **Dictionary:** new keys exist, AR ≠ EN.
- **No SQL suite changes** — schema unchanged.
- Manual smoke: open a property with mixed unit types and floors; confirm
  columns and summary numbers.

## Files expected to change

| File | Change |
| ---- | ------ |
| `src/routes/admin.properties.$id.tsx` | PACI + floor columns; summary commercial / shop / floor_count |
| `src/routes/admin.units.index.tsx` | Floor column |
| `src/i18n/dictionary.ts` | New summary labels |
| `src/i18n/dictionary.test.ts` | Cover new keys |
| Optional pure helper + test under `src/lib/` or next to the route | Summary type counts |

## Risks and edge cases

- **Empty PACI / floor:** always render `—`, never blank cells that look broken.
- **Free-text type drift:** operators who renamed or replaced `commercial` /
  `shop` in the catalogue will see zero in those summary rows until values
  match the stored codes.
- **pageSize 200 on property detail:** summary is only over loaded units. If a
  property ever exceeds 200 units, counts under-report. Accept for this change;
  same limit already applies to occupied/vacant/total.
- **Lovable / main:** feature branch only; no force-push; no auto-deploy until
  merge to `main`. No migration apply step.

## Success criteria

1. Property detail units table shows PACI No. and Floor for each unit.
2. Main units table shows Floor for each unit.
3. Property detail Summary shows commercial count, shop count, and property
   `floor_count`.
4. No new migrations; existing unit create/edit of PACI and floor unchanged.
5. Lint, typecheck, and unit tests pass for touched files.
