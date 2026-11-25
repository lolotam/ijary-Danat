# Admin Table Operations Design

**Status:** Approved

## Goal

Complete the operational tooling for Maintenance, Properties & Buildings, and Units while making table actions, tenant contract context, phone directionality, and Arabic table alignment consistent throughout the admin application.

## Scope

### New Maintenance module

Create a persisted `/admin/maintenance` module for property maintenance requests.

A maintenance request has:

- a generated code and company ownership;
- a required property;
- an optional building and unit constrained to the selected property;
- a required title;
- an optional description;
- a priority: `low`, `medium`, `high`, or `urgent`;
- a status: `open`, `in_progress`, `completed`, or `cancelled`;
- created and updated timestamps.

The page provides search plus property, building, unit, priority, and status filters. It supports create, view, edit, delete, CSV import, CSV export, and CSV-template download subject to maintenance permissions. No vendor, assignment, cost, attachment, or scheduling fields are included because no current requirement needs them.

### Properties and Buildings

Keep Properties and Buildings within the existing management area, but expose them as distinct list views so each entity has its own searchable, pageable table and tools.

- **Properties** support search, type and status filters, CSV import/export/template, and view/edit/delete actions.
- **Buildings** support search, property, category, and status filters, CSV import/export/template, and view/edit/delete actions.
- Existing property detail behavior remains available and continues to show nested buildings and units.

### Units

Retain the existing search and property, building, status, type, and meter-ownership filters. Add CSV import, export of the currently filtered result set, and a CSV-template download.

### CSV contract

CSV templates use user-facing codes for relationships rather than database UUIDs:

- Properties: optional `code`, `name_ar`, `name_en`, `type`, `address_ar`, `address_en`, `location_url`, `area`, `description_ar`, `description_en`, `image_url`, `status`.
- Buildings: optional `code`, required `property_code`, optional `category_code`, `name_ar`, `name_en`, address fields, area, floors, image, descriptions, and status.
- Units: optional `code`, required `property_code`, optional `building_code`, name, type, area, status, meter ownership, rent, and descriptions.
- Maintenance: optional `code`, required `property_code`, optional `building_code` and `unit_code`, title, description, priority, and status.

The client parses and previews CSV data before submission. The server validates required fields and enum values, resolves every supplied relationship code inside the current company, and returns row-specific validation errors. It must reject a building or unit that does not belong to the supplied parent relationship. The import procedure records its audit event and invalidates the relevant query keys after success.

Exports use the active filters, use display labels appropriate for the active locale, and never include internal IDs. Template downloads always include headers even when the system has no records.

## Shared table behavior

### Actions

Create a reusable, permission-aware table action primitive. It renders icon-only controls for View, Edit, and Delete using `Eye`, `Pencil`, and `Trash2`; links retain router navigation. Every icon has a localized accessible name and visible tooltip. The primitive is used anywhere the current action column presents those operations as text, including tables nested in dialogs and detail views. Related document actions use their existing semantic icon rather than a text label.

Add `common.view` to both translation dictionaries. This removes the fallback behavior that currently exposes the translation key in the UI.

### RTL selection spacing

Set logical inline-start padding for the first table header and table data cell in the shared table primitive. This provides a consistent safe gutter for selection checkboxes in Arabic and English without per-page directional CSS hacks.

### Telephone direction

Enhance the reusable form text field so callers can mark telephone inputs as `type="tel"`; telephone fields always render with `dir="ltr"`. Update every mobile, WhatsApp, and company phone input to use this path. Number display cells are also rendered LTR where necessary so Arabic pages preserve phone-number order.

## Tenant contract context

Add `Connected Property` and `Connecting Unit` columns to the Tenants list only. The tenant form and the `tenants` table schema are unchanged.

The tenant list data query derives these display values from the tenant's contract whose state is exactly `active`. It resolves the contract unit and its property using existing relations. When there is no active contract, both cells display an em dash. The application already prevents a unit from having more than one non-terminal contract; if historic data contains multiple active contracts for a tenant, choose the most recent contract deterministically and preserve a single displayed property and unit.

## Architecture

- Keep page routes thin and keep query, mutation, and relation resolution in hooks.
- Extend the existing CSV parser, validation, import dialog, bulk-import server function, and SQL import procedure rather than creating a second import framework.
- Add small focused shared components for table actions and CSV template generation; do not introduce a grid dependency.
- Add the maintenance schema, RLS policies, permission codes, generated database types, hooks, route, navigation item, and translations as a cohesive vertical slice.
- Continue to use TanStack Query invalidation after mutations and imports.
- Do not hand-edit `src/routeTree.gen.ts`.

## Error handling and edge cases

- A CSV with only headers, malformed quoting, unknown relationship codes, invalid enum values, or inconsistent property/building/unit hierarchy returns understandable row errors and creates no invalid records.
- Client-side import preview identifies invalid rows before upload; server validation remains authoritative.
- Export and import controls are disabled when permission is missing. Export is disabled only when there is nothing to export; template download remains available whenever import is permitted.
- Property and building filters reset pagination and ensure dependent building/unit options are limited to the selected parent.
- Action buttons stop row-click propagation where rows open a detail view.
- Action icons preserve disabled permission states and are keyboard accessible.

## Verification strategy

Follow test-driven development for every new pure helper and server-side validation rule:

1. Test CSV template header generation, including header-only downloads.
2. Test client validation for each new import entity and valid/invalid relationship-code scenarios.
3. Test server-side relation resolution and hierarchy rejection with real Supabase test infrastructure or the project’s established server-function test seam.
4. Test active-contract selection for tenant property/unit display, including no active contract and deterministic handling of multiple active contracts.
5. Test shared action configuration and accessible labels without testing implementation details.
6. Manually verify desktop and narrow-mobile tables in Arabic and English, including the first checkbox gutter and LTR phone input/display behavior.
7. Run `bun run lint`, `bun run typecheck`, and `bun run test` before delivery.
8. Run Test Guard on new or changed tests and Clean Code Guard on the final production diff before delivery.

## Non-goals

- Do not add property/unit fields to the Add Tenant form.
- Do not duplicate a tenant’s connected property or unit in the tenant database row.
- Do not add a third-party data-grid library.
- Do not change unrelated financial, contract, or tenant-portal behavior.
