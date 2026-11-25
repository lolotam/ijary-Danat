# Audit contract

## Model

- **App-level audit only** for normal mutations: the client (or server function)
  calls `logAudit` / `write_audit` **after** the business write succeeds.
- **Zero database triggers** write to `audit_logs` for ordinary tables. History
  is an application concern, not a silent side effect of every UPDATE.
- Action names use **`singular_entity.verb`** (e.g. `contract.close_out`,
  `refund.reverse`, `invoice.write_off`).

This **differs** from permission codes, which use **plural** module names
(`contracts.close_out`, `refunds.reverse`, `invoices.write_off`). Do not mix the
two namespaces when filtering audit rows or checking RBAC.

## Columns (conceptual)

Typical payload: `action`, `entity_type`, `entity_id`, optional `before` /
`after` JSON, actor from `auth.uid()` / session user.

## Documented exception: `close_out_contract`

**`close_out_contract` calls `write_audit` from inside SQL** for atomicity.

Reasons:

1. Close-out mutates contracts, invoices, payments, allocations, refunds, and
   close-out child tables in one transaction.
2. An app-level audit after the RPC would be a **second round-trip** that can
   fail after money has already committed — leaving a silent hole in the audit
   trail for the highest-stakes operation.
3. Calling `write_audit` inside the same transaction guarantees the audit row
   commits or rolls back with the settlement.

This follows the existing **`erase_all_data`** pattern (destructive / multi-table
paths that must not leave partial truth).

`close_out_contract` is the **first user-facing path** to write audit rows from
SQL via `write_audit`. Other close-out-adjacent RPCs may also call `write_audit`
for the same reason; app hooks still log restore / reverse / void for UI-driven
paths that stay single-RPC and low-risk.

## What not to do

- Do not add “audit everything” triggers casually — they fight RLS, bulk jobs,
  and service-role maintenance.
- Do not rename permission codes to match audit actions (or vice versa) without
  a migration of both seeds and call sites.
- Do not edit `audit_logs` by hand to “fix” history.

## Related

- Migration 03: `write_audit()`, `audit_logs`
- Migration 87: `close_out_contract` audit calls
- [CLOSEOUT.md](./CLOSEOUT.md)
