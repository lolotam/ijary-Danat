# Archive and restore semantics

## Archive (close-out outcome)

When a close-out is committed with outcome **`archive`**:

1. Contract `state` becomes the chosen final state (`terminated` or `expired`).
2. `contracts.archived_at` is set to `now()`.
3. Optionally `tenants.archived_at` is set and `tenant_portal_enabled` is forced
   off when **archive tenant** was checked (DB CHECK requires outcome =
   archive).
4. Unit status is updated by existing triggers when the contract leaves
   `active` (typically toward vacant / available — see unit status lifecycle).

`keep_terminated` and `freeze` leave `archived_at` null. `freeze` sets `frozen`
and stays on the operational Contracts list; `keep_terminated` sets
`terminated`, which since migration 211 counts as ended — see below.

## What “archived” means in lists

A contract is archived when it was archived **or** when its state says it ended.
Migration 211 added the second half: `close_out_contract` stamps `archived_at`
only for the `archive` outcome, so splitting on that column alone left every
contract closed out as `terminated` sitting in Current, still offering a
Close-out action for a contract that was already closed.

- **Current** view: `archived_at is null` **and** `state not in (expired, terminated)`.
- **Archived** view: `archived_at is not null` **or** `state in (expired, terminated)`.
- **All** view: both (admin summary cards expose an archived count as of
  migrations 90–91).

`public.contract_is_ended` (migration 211) is the database’s statement of the
rule; `isContractEnded` / `endedStatesFilter` in `src/lib/contractLifecycle.ts`
are the client’s, and the tab badge counts through the first.

A contract archived by **state alone** has no Restore action:
`restore_contract` refuses a contract whose `archived_at` is null with
“Contract is not archived”, and the button is hidden to match. Change its state
through the contract edit form instead. The `keep_terminated` outcome is the
one that produces this — `freeze` sets `frozen`, which is not an ended state.

Rows are **hidden, never deleted**. Payments, invoices, close-outs, and audit
history remain queryable.

## Restore

`restore_contract` (permission `contracts.restore`):

| Parameter        | Meaning                                                 |
| ---------------- | ------------------------------------------------------- |
| `target_state`   | State to set after un-archiving. **Must not be ended.** |
| `restore_tenant` | If true, clears tenant `archived_at` when safe.         |
| `reason`         | Required non-blank free text (audit + notification).    |

### Target state is a choice, and it cannot be an ended one

The RPC accepts any `contract_states` value, including `expired` and
`terminated`. Passing one back means the restore clears `archived_at` and the
contract is _still_ archived by the state rule above — it never leaves the
Archived tab, while the UI reports success. The restore dialog therefore offers
only `RESTORE_TARGET_STATES` (the ended states removed) and defaults to
`suspended`.

`suspended` is the default because every **automatic** invoice path tests
`c.state = 'active'` — `generate_invoices` (migration 05), the consolidated
generator (112) and contract-expiry reminders (07) — so it returns the lease to
the operational lists without billing it, which is what restore means here.
`draft`, `frozen` and `renewed` are equally unbilled and remain available.
`active` is offered too, and it is the one choice that _does_ resume automatic
billing; the dialog says so.

The one path that still reaches a restored contract is an admin explicitly
running **Generate** for that single contract: migration 112 accepts
`p_include_past and p_contract_id is not null` in place of the `active` test.
Restore does not invoice, but it does put the contract back within reach of a
deliberate one-off generation.

### Unit-conflict rule

Restore will **fail** if the contract’s unit already has another **active**
contract. Operators must free the unit or choose a different disposition before
restore can succeed. This prevents two live leases on one unit.

### Portal behaviour

- Archive-with-tenant turns the portal off for that tenant.
- Restore does **not** automatically re-enable the portal. Re-enabling portal
  access is a separate deliberate tenant setting change.
- The restore itself creates **no** invoices. Whether the contract is billed
  afterwards is the target state's doing: `active` puts it back into every
  automatic generation run, and no other offered state is picked up by one. An
  admin explicitly generating for that single contract reaches it in any state
  (see above).
- Restore **does** change unit occupancy when the target state holds the unit.
  `occupies_unit` is derived from `state in (draft, active, frozen, suspended)`
  (migration 110), so restoring out of an ended state re-occupies the unit. This
  is what the unit-conflict rule above exists to catch.

### Notifications

Successful restore fires the `contract-restored` event workflow (email to
admin/company). Failure to send email does not roll back the restore.

## Undoing a full close-out

1. Reverse any posted close-out refund (`reverse_refund`) if money went out.
2. Restore the contract if it was archived (`restore_contract`).
3. Invoice dispositions (write-offs, cancels, settlements) are **not**
   automatically reversed by restore — treat those as separate financial
   corrections if needed.

See [CLOSEOUT.md](./CLOSEOUT.md) and [REFUND_ACCOUNTING.md](./REFUND_ACCOUNTING.md).
