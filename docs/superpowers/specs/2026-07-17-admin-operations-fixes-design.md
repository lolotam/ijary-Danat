# Admin Operations Fixes Design

## Status

Approved on 2026-07-17.

## Scope

This change set improves tenant administration, property-table RTL behavior,
contract location selection, manual-payment reliability, and role-permission
localization.

## Tenant Operations

The tenant list will expose the existing CSV workflow: download the tenant
template, import valid CSV rows, and export the filtered tenant list. The UI
will use the existing tenant import schema, template, and server function.

## RTL Tables

Shared table headers must inherit document direction instead of forcing
left-aligned text. Arabic property and building tables must render columns and
cell alignment right-to-left; English must remain left-to-right.

## Tenant Locations

Each tenant row will resolve its own active contract, unit, and property. The
query must preserve the latest active contract per tenant when a tenant has
more than one active contract. A regression case covers three tenants with
separate active contracts and locations.

## Contracts

The contracts table will display the property associated with each contract's
unit. The contract editor will use a dependent location flow:

1. Select tenant.
2. Select property.
3. Optionally select a building in that property.
4. Select a unit filtered by the chosen property and, when selected, building.

Changing a parent location clears selections that no longer belong to it. The
editor derives the property and building from the existing unit when editing.

## Payments

Manual payment creation depends on a database receipt trigger. The work will
identify whether the payment insert, receipt trigger, or receipt lookup fails.
The confirmed root cause will be fixed with a forward-only migration or a
client-side recovery path that does not misreport a successfully persisted
payment as failed.

## Roles And Permissions

The custom-role editor and the built-in permission matrix will be fully Arabic
in Arabic locale. Permission modules, actions, and special permissions will
have Arabic display labels while their technical codes remain visible as
secondary identifiers. The role editor, permission cards, and matrix will use
RTL layout in Arabic and retain LTR layout in English.

## Verification

Regression coverage will target tenant-location selection, contract location
filtering, permission labels, and the confirmed payment failure. The completed
change will pass targeted Vitest suites, lint, typecheck, build, and a Graphify
incremental update.
