# Bidirectional Table Alignment Design

## Status

Approved on 2026-07-17.

## Goal

Make every frontend table follow the active application direction. Arabic tables
must place the first declared column at the right edge and align headers and
cell content to the right. English tables must retain left-to-right column order
and left alignment. Telephone entry remains left-to-right in both locales.

## Root Cause

The application changes the document direction through `I18nProvider`, but the
shared table primitive does not set its own direction and `TableCell` does not
apply logical text alignment. Individual routes therefore depend on browser
inheritance and can render inconsistently inside nested layouts or scrolling
containers.

## Selected Approach

Centralize bidirectional behavior in shared UI primitives.

1. The shared `Table` component receives the locale direction from `useI18n`
   and renders it as the table `dir` attribute.
2. Both `TableHead` and `TableCell` use logical `text-start` alignment so Arabic
   content aligns right and English content aligns left.
3. Existing logical checkbox padding remains intact, so a selection column is
   positioned at the correct inline-start edge.
4. `Input` applies `dir="ltr"` to `type="tel"` when the caller does not supply
   an explicit direction. Existing explicit directions remain authoritative.
5. Route-level table direction overrides are removed when the shared primitive
   now provides the same behavior.

This approach fixes Properties, Notifications, Users, and all other tables at
their common implementation point. It does not alter table data order, queries,
permissions, form validation, or individual technical fields that intentionally
remain LTR.

## Deliberate LTR Exceptions

The following remain LTR regardless of locale:

- Telephone inputs (`type="tel"`), including mobile and WhatsApp numbers.
- Inputs, textareas, and table cells that already explicitly use `dir="ltr"`
  for codes, IDs, email addresses, JSON, dates, currency codes, or English-only
  content.

All other table and normal field content inherits the application locale.

## Implementation Plan

### 1. Add regression coverage

Create a focused Vitest test for the shared direction utility or rendered table
markup that proves an Arabic table has `dir="rtl"`, an English table has
`dir="ltr"`, and telephone inputs are LTR by default. The test must be observed
failing before the implementation change.

### 2. Update shared table primitives

Modify `src/components/ui/table.tsx` to obtain the active direction through
`useI18n`, apply it to the rendered `<table>`, and use `text-start` on table
headers and cells. Preserve callers' explicit `dir` prop as an override.

### 3. Update telephone input behavior

Modify `src/components/ui/input.tsx` so `type="tel"` defaults to `dir="ltr"`.
Do not override an explicit caller-provided `dir` value.

### 4. Remove redundant page fixes

Remove the temporary `dir` prop added to the Properties page after the shared
table owns direction. Confirm that Notifications and Users require no route
patch because they render the shared component.

### 5. Verify and deploy

Run targeted tests, lint, typecheck, build, and `graphify update .`. Inspect the
final diff and status, stage only intended source, test, documentation, and
Graphify changes, then commit and push the current branch without rewriting
history.

## Acceptance Criteria

1. In Arabic, the first declared column appears on the right in Properties,
   Notifications, Users, and all other shared tables.
2. Arabic headers and ordinary table cells align right; English aligns left.
3. Checkbox columns stay at the active inline-start edge with correct padding.
4. Phone fields remain LTR in Arabic and English.
5. Existing explicit LTR technical fields remain LTR.
6. No individual route needs a `dir` prop for ordinary shared tables.
