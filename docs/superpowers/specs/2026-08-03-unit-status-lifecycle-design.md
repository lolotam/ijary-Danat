# Unit status lifecycle — design

**Date:** 2026-08-03
**Status:** approved, pending implementation

## Problem

`units.status` has never been connected to `contracts`. There is no trigger, no
function, and no server-fn write anywhere in `db/migrations/` or `src/fns/` that
touches a unit's status when a contract is created, activated, moved, ended or
deleted. The column is a free-standing manual field, and most of its current
values came from the mock-data seed at `db/migrations/15_mock_kuwait_data.sql:46`,
which stamps a fixed seven-occupied / two-available / one-under-maintenance
pattern onto every property's ten units without creating a single contract to
back any of it.

Measured in production on 2026-08-03 (70 units, 10 contracts, all `active`):

| unit status         | has active contract | count  |
| ------------------- | ------------------- | ------ |
| `available`         | no                  | 11     |
| `available`         | **yes**             | **3**  |
| `occupied`          | **no**              | **41** |
| `occupied`          | yes                 | 7      |
| `vacant`            | no                  | 2      |
| `under_maintenance` | no                  | 6      |

So 41 units claim to be occupied with no contract behind them, and 3 units with
a live contract claim to be available. The admin dashboard's occupancy tile
(`src/routes/admin.index.tsx:103`) counts `status = 'occupied'` and therefore
reports 48 where the truth is 10.

Separately, the `unit_statuses` catalog in production has `available` and
`reserved` marked `is_active = false`. `useOptionListItemsByCode`
(`src/hooks/useOptionLists.ts:52`) filters on `.eq("is_active", true)`, so the
units form cannot offer `available` — while the table badge at
`src/routes/admin.units.index.tsx:407` still renders "Available" for the 14 units
holding that value. A status that is visible but not selectable.

## Decisions

Four decisions were settled with the product owner before this design:

1. **`available` and `reserved` are retired**, not restored. Under the intended
   rules "available" and "vacant" name the same condition, so keeping both
   guarantees drift. Retiring them also dissolves the second symptom: no unit
   can display a status the catalog lacks.
2. **Occupancy means `state = 'active'` only.** A draft contract leaves the unit
   vacant. See _Known wart_ below.
3. **A maintenance flag does not survive a tenancy.** `under_maintenance` →
   contract signed → `occupied` → contract ends → `vacant`. No hidden column
   remembers the pre-contract status.
4. **Delivery is branch + PR**, with migration 76 applied to production only
   after merge.

## The rule

A unit is **occupied** if and only if there exists a contract with:

```sql
unit_id = unit.id and state = 'active' and archived_at is null
```

`archived_at` is part of the predicate because `useContracts` filters archived
contracts out of every list in the application; an archived contract must not
hold a unit occupied.

The predicate is **state-based, not date-based**. Nothing in this codebase ever
transitions a contract to `expired` — `contractExpiryJob` only sends reminders.
Because of that, every input to occupancy is a write to `contracts`, so an
`AFTER` trigger on that table is sufficient and no scheduled recompute is
needed. (That contracts never auto-expire is a real gap, but a pre-existing and
separate one. It is explicitly out of scope here; see _Out of scope_.)

Full recompute, applied to one unit:

```
if a matching active contract exists  -> 'occupied'
elsif current status in ('under_maintenance', 'archived') -> keep it
else -> 'vacant'
```

The middle branch is the whole reason this is a three-way decision rather than a
boolean. A naive `else 'vacant'` would wipe an operator's maintenance flag every
time an unrelated contract on that unit was touched.

## Status set after this change

| status              | written by      | notes                                         |
| ------------------- | --------------- | --------------------------------------------- |
| `occupied`          | derived only    | never manually selectable                     |
| `vacant`            | derived default | no active contract                            |
| `under_maintenance` | admin           | sticky — survives unrelated contract activity |
| `archived`          | admin           | sticky                                        |
| `available`         | retired         | nothing writes it; catalog stays inactive     |
| `reserved`          | retired         | nothing writes it; catalog stays inactive     |

The two retired values remain in the `public.unit_status` enum. Postgres cannot
drop a value from an enum type, and converting the column to `text` with a
`CHECK` constraint would be a large, risky change for no gain. They simply
become unreachable.

## Architecture

Enforcement lives in the database, not in application code. The reason is the
write-path inventory. Contracts are written from `useCreateContract`,
`useUpdateContract` and `useDeleteContract` (`src/hooks/useContracts.ts`), and
also — less obviously — from `useRefunds.ts:47-75`, which stamps `archived_at`
on a contract when a tenant is archived and sets `state = 'frozen'` elsewhere in
the same file. That last pair is the point: the first draft of this inventory
missed both, and named `bulk_import_phase6` as a contract writer when it is not
one at all (its entity list is expenses, deposits, tenants, properties,
buildings, units, maintenance — `db/migrations/16_admin_table_operations.sql:109-185`).

An inventory that was wrong in both directions on its first attempt is the
argument for not depending on inventories. Putting the rule in
`useCreateContract` would mean five or more places to remember, one of which was
already forgotten — the same failure mode `CLAUDE.md` records for event
workflows ("five scattered checks is where one gets missed, and a missed one is
invisible"). A trigger on `contracts` is the one point every writer must pass
through, including the ones nobody found.

### Unit 1 — `recompute_unit_status(p_unit_id uuid) returns void`

Applies the rule above to a single unit and writes only when the value actually
changes. Idempotent and safe to call redundantly.

- `security definer` with `set search_path = public, pg_temp`, because a user
  writing a contract does not necessarily hold `UPDATE` on `units`.
- Takes `select ... for update` on the unit row so two concurrent contract
  writes on the same unit cannot interleave into a stale value.
- Returns silently for a null id or a missing unit.

### Unit 2 — `contracts_sync_unit_status()` trigger on `contracts`

`AFTER INSERT OR DELETE OR UPDATE OF unit_id, state, archived_at ... FOR EACH ROW`.

Recomputes **both** `OLD.unit_id` and `NEW.unit_id`. Recomputing only `NEW` is
the classic omission in this pattern: moving a contract from unit A to unit B
would leave A stuck on "occupied" permanently. Because `recompute_unit_status`
no-ops when nothing changed, calling it for both sides unconditionally is
cheaper than branching on which one changed.

**Both affected units are locked first, in ascending UUID order, before either
is recomputed.** Recomputing old-then-new without that step is a deadlock:
`one_active_contract_per_unit` (`db/migrations/04_...:179-180`) is a partial
unique index covering only `draft`/`active`/`frozen`/`suspended`, so two
_terminal_ contracts may legally move A→B and B→A at the same time. One
transaction would hold A and wait for B while the other holds B and waits for A.
The existing `trg_contract_sync_tenant_lifecycle` establishes a tenant→unit
ordering that fires first by trigger-name order, but it does not help when the
two contracts belong to different tenants.

The column list on `UPDATE OF` keeps unrelated contract edits (notes, documents,
monthly amount) from doing pointless work — and, given the locking above, from
taking a row lock on the unit for no reason.

### Unit 3 — `units_enforce_derived_status()` trigger on `units`

`BEFORE INSERT OR UPDATE ... FOR EACH ROW`. Normalizes the incoming row:

1. `available` or `reserved` → `vacant`. Silent; these values are retired.
2. If the unit has an active contract and the incoming status is not
   `occupied` → **raise**, with a message naming the unit code. This is an admin
   actively trying to override a live contract, and they need to be told why it
   did not take, rather than watching the value snap back.
3. Otherwise, if the incoming status is `occupied` → `vacant`. Silent; occupancy
   is not something a caller gets to assert.

Branch 2 is unreachable on `INSERT`, because a brand-new unit id cannot yet be
referenced by any contract. That is what keeps bulk import working.

**This trigger is what removes the need to re-issue `bulk_import_phase6`.** Both
`db/migrations/08_...:219` and its superseding redefinition at
`db/migrations/16_...:169` hardcode
`coalesce(nullif(status, ''), 'available')::public.unit_status`. Re-issuing that
~120-line function to change one word would be pure risk; branch 1 normalizes
the value on the way in instead, and covers every future writer for free. A
comment in migration 76 must say this, or someone will "fix" the import RPC
later and wonder why nothing changed.

The two triggers do not recurse: `recompute_unit_status` writes `units`, which
fires `units_enforce_derived_status`, which only inspects and adjusts `NEW` and
never writes.

## Migration 76

`db/migrations/76_unit_status_lifecycle.sql`, containing in order:

1. `alter table public.units alter column status set default 'vacant'` —
   the default is currently `'available'` (`04_...:109`).
2. The two functions and two triggers above.
3. **Backfill**: every unit re-evaluated through the same rule, with
   `available`/`reserved` folding into `vacant` and `under_maintenance`/
   `archived` preserved. Expected production result: **occupied 10, vacant 54,
   under_maintenance 6.**

   The backfill is **not** production-only, and an early draft of this design
   wrongly said it was. Every seeding migration runs long before this one:
   migration 11 inserts four units and two `active` contracts, migration 15
   stamps its ten-unit pattern with no contracts at all, and migration 19 seeds
   five `occupied` units that no contract backs
   (`db/migrations/19_landing_page.sql:314-332`). None of those inserts can fire
   a trigger that does not exist yet, so a database built from scratch is just as
   wrong as production until this statement runs.

4. **Catalog**: set `is_active` for the six known enum values only — `available`
   and `reserved` false, the other four true — leaving any custom rows an admin
   added to the list untouched. This makes the intended state explicit in version
   control rather than an undocumented manual edit someone made in the admin UI.
5. **Invariant assertion**: a closing `do` block raising if any unit is
   `occupied` without a matching active contract, or has one and is not
   `occupied`. Data-independent, so the same statement is meaningful on
   production and on a clean `bun run test:db` build, whose seeded rows differ
   entirely.

Per `db/README.md` and the project's own history, migrations 04, 08 and 16 are
**not** edited in place — an in-place edit passes `bun run test:db` and changes
nothing in a database that has already run them.

## UI changes

The single status list splits in two. Filtering must still offer `occupied`
(you need to find occupied units); editing must not.

- `src/routes/admin.units.index.tsx` — `unitStatusValues` (:106) becomes
  `unitStatusFilterValues`; a new `unitStatusEditableValues` holds
  `vacant`, `under_maintenance`, `archived`. The default (:91) becomes `vacant`,
  the filter select (:312) keeps all four, and the form select (:483) offers the
  editable three.
- `src/routes/admin.properties.$id.tsx` — same treatment at :53 and :64.
- When the unit being edited is `occupied`, the status field renders **disabled**
  with a hint explaining that the status follows the active contract. This is the
  UX half of trigger branch 2: the admin is told before they try, not after.
- **The form's Zod enum keeps `occupied`** — it narrows only by dropping the two
  retired values. Narrowing it to the editable three forces the edit dialog to
  seed the field with something else for an occupied unit, and since
  `FormSelectField` renders the current form value
  (`src/components/admin/Phase2FormFields.tsx:128-141`), the disabled control
  would then read "Vacant" on a unit that is occupied. Disabling a control is not
  a licence to display a falsehood in it. The field shows `occupied`, offers only
  that one option while locked, and the payload omits `status` entirely.
- **`src/hooks/useUnits.ts:96-103` must gain `.is("archived_at", null)`.** It
  derives each unit's occupant from contracts with `state = 'active'` and no
  archived filter, so once the database predicate excludes archived contracts,
  archiving one would leave the unit `vacant` in the status column while the same
  table still displayed a tenant in the occupant column — and the property page's
  summary counts occupancy from `u.occupant`, not `u.status`
  (`src/routes/admin.properties.$id.tsx:127-134`), so it would disagree too.
- **`useCreateContract` and the refund archive/freeze path must invalidate
  `["units"]`.** `useUpdateContract` already does
  (`src/hooks/useContracts.ts:246-250`); `useCreateContract` (:202-205) and
  `useRefunds.ts:183-186` do not, so a contract created directly in the `active`
  state would flip the unit in the database while the units list kept showing the
  old status until a manual refresh.
- `src/lib/statusTone.ts` keeps its `available` and `reserved` cases. The
  `UnitStatus` type still includes them, and historical rows should still render
  a sensible badge rather than falling to the default.
- `src/i18n/dictionary.ts` — the new hint string is added to **both** locales.
  The dictionary is `Record<string, string>` per locale with no parity check, so
  a key added to only one locale ships as raw key text and `bun run typecheck`
  will not catch it.

`src/lib/bulkImportSchemas.ts:160-165` validates the units import status against
all six values and defaults to `"available"`. The **enum stays at six** so
existing import files keep validating (the trigger normalizes the retired values
on the way in); only the `.default()` changes to `"vacant"`.

`database.types.ts` needs no change — the `UnitStatus` union is unchanged, since
the retired values remain in the enum.

## Testing

`src/db/unitStatus.sqltest.ts`, using the existing harness (`withRollback`,
`actAs`, `actAsSuperuser` from `src/db/testDb.ts`) against real Postgres. This
is trigger behaviour; the mock suite cannot reach it.

Cases:

1. Inserting an active contract flips its unit to `occupied`.
2. Moving the contract to `state = 'terminated'` returns the unit to `vacant`.
3. Moving the contract's `unit_id` from A to B leaves A `vacant` and B
   `occupied` — the both-sides recompute.
4. Setting `archived_at` on an active contract returns the unit to `vacant`, and
   clearing it again returns the unit to `occupied`.
5. Deleting an **active** contract returns the unit to `vacant`. (A draft-only
   deletion proves nothing: the unit is already vacant before and after.)
6. A `draft` contract on an `under_maintenance` unit is edited — the unit stays
   `under_maintenance`. This actually fires the trigger for the unit being
   checked, unlike an unrelated-unit test, which only proves no global update ran.
7. `under_maintenance` → contract active → `occupied` → contract terminated →
   `vacant`, confirming decision 3.
8. `active` → `frozen` returns the unit to `vacant`, pinning decision 2 against
   the four-state `nonTerminalStates` list that `assertUnitAvailable` uses.
9. Updating an occupied unit to `under_maintenance` raises.
10. Renaming an occupied unit succeeds — the guard fires on every unit update and
    must not trip on one that leaves `status` alone.
11. Inserting a unit with `status = 'available'` lands as `vacant`.
12. `bulk_import_phase6('units', ...)` with a blank status lands as `vacant`.
13. A unit with a `draft`-only contract reads `vacant`, pinning decision 2.
14. **An accountant** (holding `contracts.update` but not `units.update`) changes
    a contract's state, and the unit still syncs. Without this the
    `security definer` on the sync function could be removed and every other test
    would still pass — RLS refuses by matching zero rows, silently. The existing
    `src/db/lifecycle.sqltest.ts:206-249` drives exactly this scenario for
    tenants but never asserts on the unit afterwards.
15. Applying the migration a second time is a no-op and raises nothing.

Gates before the PR: `bun run lint`, `bun run typecheck`, `bun run test`, and
`bun run test:db` (which rebuilds the database from scratch and is the only
thing that proves migration 76 applies cleanly in order).

## Applying it to production

The migration runs as **one transaction** (`--single-transaction`, plus
`ON_ERROR_STOP=1`). Statement-at-a-time autocommit would leave the functions,
triggers, default and catalog change committed while only the closing invariant
`do` block rolled back — the worst possible half-state, and the one an operator
is least equipped to unpick at speed.

Inside that transaction it takes a write lock on `contracts` and then `units`,
in that order, for the few seconds it needs. Without it there is a real window:
between the units guard being installed and the backfill running, an ordinary
edit to one of the 3 production units that is `available` **with** a live
contract would hit the guard's raise branch — a branch the design describes as
exceptional, surfacing to a user as an error on an unrelated save. The lock order
matches the trigger firing order so it cannot invert against normal traffic.

The pre-flight capture is **row-level** — unit id, code, status, and the id,
state and `archived_at` of any matching contract — not just the grouped counts.
Grouped counts prove the totals moved; only the row-level snapshot lets anyone
reconstruct what a specific unit was if the reconciliation is disputed later.

## Known wart, deliberately left

`assertUnitAvailable` (`src/hooks/useContracts.ts:166`) rejects a second
contract on any unit already carrying a `draft`, `active`, `frozen` or
`suspended` contract. Under decision 2, a unit whose only contract is a draft
displays as **vacant** but refuses a new contract with "This unit already has a
non-terminal contract."

This is pre-existing, and narrowing it here would change contract-booking
behaviour, which is not what was asked. It is recorded so the next person meets
it as a known item rather than a surprise. The natural fix, if it becomes
annoying, is a third derived state for "spoken for but not started" — which is
what `reserved` was presumably for.

## Out of scope

- **Contracts never auto-expire.** No job transitions a contract past its
  `end_date`, so a contract that ended in 2025 still reads `active` and still
  holds its unit occupied. Real, and worth a separate ticket; the trigger design
  here will pick up the correction for free once something does flip the state.
- Narrowing `assertUnitAvailable` (above).
- Any change to `buildings.status`, which is a different column with a different
  `CHECK` constraint and no relationship to contracts.
