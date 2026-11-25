# Multiple units under a single contract — design

**Date:** 2026-08-07
**Status:** approved; no migration written yet (next number: 110)

## Problem

A tenant renting three units today needs three contracts. `contracts.unit_id` is
`not null` (`db/migrations/04_phase2_properties_tenants_contracts.sql:141`) and there is
exactly one `monthly_amount` per contract (`:144`), so the unit is not a
property _of_ the contract — it _is_ the contract's identity.

Everything downstream inherits that shape. Three contracts produce three
invoices per month, three payment pathways, three balances and three overdue
evaluations, for one tenant who thinks of it as one tenancy and pays it with one
transfer. The operator reconciles by hand.

Danat's tenants commonly rent across properties — a shop in one building, storage
in another — so this is the normal case, not an edge case.

### What already works

Three parts of the existing schema are already shaped for consolidation, which
is why this change is smaller than it appears:

| Requirement                     | Already true                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| One invoice per contract, month | `unique (contract_id, period_year, period_month)` on `invoices` (`db/migrations/05_phase3_invoices_payments.sql:54`) |
| Per-unit lines on that invoice  | `invoice_items` is a real line-item table (`05:57-70`), and the generator already writes a variable number of lines  |
| One payment across many charges | `payments.tenant_id` is tenant-level (`05:72-77`); allocation to invoices runs through `payment_allocations`         |

The consolidated invoice is therefore not a new concept. It is the existing
concept, which today only ever carries one rent line because a contract can only
carry one unit.

## Decisions taken

Settled with the product owner on 2026-08-07. Each of these closes an
alternative that is **not** to be reopened during implementation.

| #   | Decision                                                                               | Rejected alternative                                          |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Migrate every existing contract into the new model; `contracts.unit_id` is **dropped** | Keeping `unit_id` as a "primary unit" beside a second table   |
| 2   | No contract-merge tool. Tenants with two split contracts are recombined by hand        | Building a merge action that moves invoices between contracts |
| 3   | The consolidated invoice carries **one rent line per unit**                            | A single combined "Monthly rent" line                         |
| 4   | All units share the contract's start and end date. No per-unit exit                    | Per-unit `start_date`/`end_date` inside the contract          |
| 5   | `invoices.unit_id` becomes **nullable**; attribution moves to `invoice_items.unit_id`  | Dropping `invoices.unit_id`, or pointing it at the first unit |
| 6   | `contracts.monthly_amount` stays as a **trigger-maintained total**                     | Dropping it and summing at every read site                    |

A seventh was settled while writing this spec:

| #   | Decision                                                                   | Rationale                                                                                                                         |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 7   | Bulk import stays single-unit. An imported row creates a one-unit contract | Still valid in the new model, so nothing regresses. Multi-unit contracts are created through the UI. Avoids inventing a CSV shape |

Decision 7 keeps the **CSV format** unchanged; it does not make the importer
free. `bulk_import_phase6` (live in `db/migrations/103_unit_property_types_free_text.sql`,
which supersedes 78) writes `contracts.unit_id` directly and must instead write
the contract and its single `contract_units` row.

## Schema

### New table

```sql
create table public.contract_units (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete restrict,
  monthly_amount numeric(14,3) not null check (monthly_amount >= 0),
  line_order integer not null default 1,
  occupies_unit boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_id, unit_id)
);
```

`on delete cascade` on `contract_id` mirrors `concessions` (`04:152`). `on delete
restrict` on `unit_id` mirrors the column it replaces (`04:141`) — a unit that is
on a contract cannot be deleted.

`unique (contract_id, unit_id)` stops the same unit appearing twice on one
contract, which would double its rent silently.

`occupies_unit` is **not** a business field. It exists only to carry the
double-booking constraint; see below. Application code never writes it.

### Changed columns

| Table           | Column           | From               | To                                                           |
| --------------- | ---------------- | ------------------ | ------------------------------------------------------------ |
| `contracts`     | `unit_id`        | `uuid not null`    | **dropped**                                                  |
| `contracts`     | `monthly_amount` | written by the app | trigger-maintained `sum(contract_units.monthly_amount)`      |
| `invoices`      | `unit_id`        | `uuid not null`    | `uuid null` — set when the contract has exactly one unit     |
| `invoice_items` | `unit_id`        | —                  | new `uuid null references units(id)`; set on rent lines only |

`contracts.monthly_amount` keeps its `check (monthly_amount >= 0)` (`04:144`), which
a sum of non-negative parts always satisfies.

`invoice_items.unit_id` is null on concession lines because a concession applies
to the contract, not to a unit (decision 4 rules out per-unit concessions).

## The double-booking constraint

This is the highest-risk part of the change and the reason the schema carries a
denormalized boolean.

A unit cannot currently be rented twice because of a partial unique index
(`db/migrations/04_phase2_properties_tenants_contracts.sql:179-180`):

```sql
create unique index one_active_contract_per_unit on public.contracts (unit_id)
  where state in ('draft', 'active', 'frozen', 'suspended');
```

This index is the **sole authority**. `db/migrations/78_bulk_import_contracts.sql:12-16`
states that the importer deliberately skips its own availability check because
"the index is the real authority". The client-side check in
`src/routes/admin.contracts.tsx:438` is a nicety on top of it.

Once `unit_id` moves to `contract_units`, the index cannot follow: a Postgres
index predicate cannot reference a column in another table, and `state` remains
on `contracts`.

**Resolution.** Mirror the predicate onto the join table as `occupies_unit`, kept
correct by a trigger on `contracts`, and rebuild the index there:

```sql
create unique index one_active_contract_per_unit
  on public.contract_units (unit_id) where occupies_unit;
```

`occupies_unit` is defined as `contracts.state in ('draft','active','frozen','suspended')`
— the predicate copied **exactly**, deliberately excluding `archived_at`, so the
new guarantee is identical to the old one rather than merely similar. (Occupancy
in migration 76 does consider `archived_at`; the uniqueness index never has. The
two predicates differ today and must go on differing.)

It must be maintained from two directions:

1. `after insert or update of state on contracts` → rewrite `occupies_unit` on that
   contract's rows.
2. `before insert on contract_units` → seed `occupies_unit` from the parent
   contract's current state.

**`archived_at` is deliberately absent from that column list**, and the migration
must carry a comment saying so. It looks like an omission and it is not:
`occupies_unit` mirrors the _uniqueness_ predicate, which has never considered
`archived_at`, so an `archived_at` write cannot change the boolean and firing on
it would be dead work. Adding `archived_at` "for consistency" — the obvious next
edit, and the one migration 76's own comment invites for the occupancy trigger —
would silently change uniqueness semantics and let a second live contract be
created on a unit held by an archived one.

The two predicates in this system genuinely differ and must stay different:

| Concern                             | Predicate                                          | Archived contract |
| ----------------------------------- | -------------------------------------------------- | ----------------- |
| `units.status` occupancy (76)       | `state = 'active' and archived_at is null`         | releases the unit |
| `one_active_contract_per_unit` (04) | `state in ('draft','active','frozen','suspended')` | still holds it    |

Chosen over an `EXCLUDE` constraint or a pure trigger check because it remains a
unique index — enforced by the storage engine under concurrency, with no window
between check and insert.

## Unit occupancy status

`db/migrations/76_unit_status_lifecycle.sql` keeps `units.status` in step with
tenancy. Two pieces must move, and missing either produces a silent fault —
units displaying as **vacant while rented**, with nothing to revisit them.

**`unit_has_active_contract(_unit)`** (`76:71-85`) currently reads
`contracts.unit_id`. It becomes a join through `contract_units`, preserving its
predicate exactly (`state = 'active' and archived_at is null`).

**`trg_contract_sync_unit_status`** (`76:228`) currently fires
`after insert or delete or update of unit_id, state, archived_at on contracts`.
It splits in two:

- On `contracts`, for `update of state, archived_at` — recompute every unit on the contract.
- On `contract_units`, for `insert or delete` — recompute the affected unit.

Migration 76 documents that each firing takes a row lock on the unit, and locks
every affected unit **up front in ascending uuid order** to avoid an A→B / B→A
deadlock between two contracts. That ordering discipline must be carried into
both new triggers; it is not optional and not incidental.

The `update of` column list in 76 is deliberate and its comment says so
explicitly: "If a column that affects occupancy is ever added, it MUST be added
here too." `contract_units.unit_id` is exactly such a column.

## Invoice generation

The live definition of `generate_invoices_for_year` is in
**`db/migrations/82_billing_safety_archived_contracts.sql`** — not 05, 23 or 37.
Migrations supersede by number, and 82's own header explains why the newest file
is the only one that matters.

Its signature and `returns table (...)` row type are **unchanged**, so plain
`create or replace` is legal. `db/README.md` warns that a changed OUT-parameter
row type requires a drop; that hazard does not apply here.

Two changes only:

**Subtotal.** `v_subtotal := v_contract.monthly_amount;` becomes
`select coalesce(sum(monthly_amount), 0) from contract_units where contract_id = v_contract.id`.
Because `contracts.monthly_amount` is the trigger-maintained total of exactly
that sum, this is the same number — the explicit sum is preferred so the
generator does not depend on the trigger having fired.

**Rent lines.** The single `insert into invoice_items (... line 1 ...)` becomes a
loop over `contract_units` ordered by `line_order`, then `unit_id` as a tiebreak
for determinism, emitting one line per unit with that unit's `monthly_amount` and
`unit_id`. `v_line` continues from the count of rent lines, so the existing
concession loop is untouched.

The `insert into invoices` gains a nullable `unit_id`: the sole
`contract_units.unit_id` when the contract has one, otherwise null.

Line descriptions keep the existing Arabic/English pair and append the unit code:
`'قيمة استثمار شهرية — ' || u.code` / `'Monthly investment value — ' || u.code`.

Everything else is untouched: the `on conflict on constraint
invoices_contract_id_period_year_period_month_key do nothing` idempotency, the
free-months skip, concession application to the contract total, and the archived
contract guards 82 exists to enforce.

### Every other SQL reader of `contracts.unit_id`

Enumerated by grep across `db/migrations/`, resolved to the **highest-numbered**
definition of each function. This list is the authority for what migration 110
must re-issue; anything missed here fails at `drop column` time, which is the
desired outcome (loud, not silent).

| Function                             | Live in | What it does with `contracts.unit_id`                                                         |
| ------------------------------------ | ------- | --------------------------------------------------------------------------------------------- |
| `generate_invoices_for_year`         | **82**  | Reads the unit and the rent (above)                                                           |
| `validate_electricity_charge_insert` | **09**  | `where c.unit_id = v_meter.unit_id and c.state = 'active'` — resolves who owes a meter charge |
| `bulk_import_phase6`                 | **103** | Inserts contracts with a `unit_id` (note: 103 supersedes 78)                                  |
| `close_out_contract` and siblings    | **87**  | 12 references — see close-out below                                                           |
| `unit_has_active_contract`           | **76**  | Occupancy predicate (above)                                                                   |

Deliberately **not** re-issued:

- `db/migrations/23` and `37` hold older `generate_invoices_for_year` bodies, superseded by 82.
- `db/migrations/67` is a one-time `insert ... select` that backfilled contract insurance and has already run. It is historic DML, not a function, so it is left exactly as it is.

**Correction, 2026-08-07.** An earlier draft of this spec said the regeneration
path (`55`, `94`, `95`, `97`) "does not reference `unit_id` at all — verified by
grep — and needs no change." The grep was accurate and the conclusion was wrong.
Those functions do not read `unit_id`, but they read **`monthly_amount`** and
write rent lines, which is the same requirement wearing a different column name:

| Function                       | Live in | Problem                                                                         |
| ------------------------------ | ------- | ------------------------------------------------------------------------------- |
| `contract_period_amounts`      | **55**  | `v_subtotal := v_contract.monthly_amount;` (55:90) — must sum `contract_units`  |
| `regenerate_contract_invoices` | **95**  | calls the above (95:88) and writes one un-attributed rent line (95:100, 95:127) |

Left alone, regenerating a three-unit contract's invoice replaces its three
attributed rent lines with **one** line carrying no `unit_id` — the correct total
with the per-unit attribution silently destroyed. Worse than a crash, because
nothing fails.

The lesson is the grep itself: `unit_id` was the wrong search term. The property
that matters is "reads the contract's rent or writes a rent line", and the
authoritative sweep is `grep -n "monthly_amount\|insert into public.invoice_items"`
across `db/migrations/`.

## Payments, allocation and the portal

**No change to the payment engine.** `payments` is tenant-level, allocation runs
through `payment_allocations` against invoice ids, and a 1,200 invoice behaves
exactly as a 400 one. `createPayment`, `applyAllocation`, `reversePayment`,
`evaluateOverdue` and the MyFatoorah paths are untouched by this feature.

The portal displays a consolidated invoice with three rent lines because it
renders `invoice_items`; no per-unit payment pathway exists to build, which was
the point of the feature.

### Portal RLS does change

`db/migrations/17_tenant_portal_units_rls.sql:14-19` gates `units` visibility with
`where c.unit_id = units.id`, and `:38-44` gates `properties` by joining
`units u on u.id = c.unit_id`. Both become joins through `contract_units`.

If this is missed, a tenant sees **none** of their units and none of their
properties. It therefore ships inside migration 110, not as a follow-up.

## Payments

The payment engine needs **no change**, and one detail makes that true:
`payments.unit_id` is already **nullable** (`db/migrations/05_phase3_invoices_payments.sql:83`,
`references units(id) on delete set null`).

`set_invoice_paid` — live in `db/migrations/108_manual_payment_reason.sql:165-168` —
copies `v_invoice.unit_id` into the payment it creates. When a multi-unit invoice
is marked paid, that copy is null, which is the correct answer: the payment
settles a consolidated invoice and genuinely does not belong to one unit. The
reversal path (`05:634-638`) copies `v_original.unit_id` and is null-safe for the
same reason. Neither function is re-issued.

## Contract close-out

More coupled than the rest of the system. `db/migrations/87_contract_closeout_rpcs.sql`
reads `v_contract.unit_id` in **12 places** across close-out, cancel and restore.
Three distinct kinds of use, each needing different treatment:

1. **Recording the unit on the close-out row** (`87:477`, `:499`) and in audit payloads
   (`:722`, `:1075`, `:1162`) — `contract_closeouts.unit_id` becomes nullable and is
   populated like `invoices.unit_id`: the single unit when there is one, null
   otherwise. Audit payloads gain a `unit_ids` array alongside, so a multi-unit
   close-out is not recorded as having no unit at all.
2. **Resolving the building for the statement** (`87:466`, `:674`, `:1068`, `:1155`) —
   `select ... from units u where u.id = v_contract.unit_id`. With several units
   there may be several buildings; the close-out takes the building of the
   lowest-`line_order` unit, and the statement lists every unit.
3. **Restore's pre-flight unit check** (`87:1030-1038`) — asks whether another live
   contract already holds this unit, so restore raises a readable error instead of
   a raw `23505` from `one_active_contract_per_unit`. This must fan out over
   **all** the contract's units and name the first conflict found. If it is
   missed, restoring a multi-unit contract surfaces a bare constraint-violation
   code to the operator.

No behavioural change beyond those. Decision 4 means every unit on a contract
ends when the contract ends, and the deposit is a single contract-level figure
(`04:146`), so close-out still settles the whole contract in one action.

## Electricity

The `electricity_charges` table is unaffected — it is keyed by `unit_id` and
`tenant_id` (`db/migrations/09_phase7_electricity.sql:61-73`) and never enters
`invoices`. It remains a per-unit billing stream.

**But the trigger that decides _who owes_ a charge is affected.** For a
`tenant_owned` meter it resolves the tenant by finding the active contract on the
meter's unit (`09:407-414`):

```sql
select c.tenant_id into v_tenant_id
  from public.contracts c
 where c.unit_id = v_meter.unit_id and c.state = 'active'
   ...
```

That becomes a join through `contract_units`. Missed, every tenant-owned meter
charge on a multi-unit contract fails to find a tenant — the function's existing
`if v_tenant_id is null` branch then decides the outcome, so the failure is
handled but the charge is misattributed.

## Application layer

### Contract form (`src/routes/admin.contracts.tsx`)

`property_id` is already a form-only field: it filters the unit dropdown
(`:310`, `:335`) and is stripped before insert (`:441`). That machinery extends
rather than being replaced.

- `property_id` becomes `property_ids: string[]`, a multi-select.
- The unit dropdown becomes a multi-select whose options are the union of units
  across every selected property, each labelled with its property so duplicates
  across properties are distinguishable.
- Each selected unit renders a titled section with the unit's name and its own
  `Monthly Amount` field, generated and removed as units are selected and
  deselected.
- Deselecting a property removes its units and their amount fields.
- Validation: at least one unit; every unit has an amount `>= 0`.
- On save, the contract and its `contract_units` rows are written together
  through a single RPC so a contract can never exist with zero units.

The file is 1,469 lines. The multi-unit selector and its rent sections are
extracted to `src/components/admin/ContractUnitsField.tsx` rather than added
inline — this is a focused improvement to code being changed, not an unrelated
refactor.

### Types

`src/integrations/supabase/database.types.ts` is **hand-maintained** despite
looking generated. `ContractUnitRow` and its `TableDefinition` entry are added by
hand; `ContractRow.unit_id` is removed; `InvoiceRow.unit_id` and
`ContractCloseoutRow.unit_id` become nullable. `bun run gen:types` writes a
reference file only and must never overwrite the real one.

### Readers

`contracts.unit_id` is referenced across the TypeScript layer — `useContracts`,
`useTenants`, `tenantLocations.ts`, the tenant detail `ContractTabPanel`, CSV
export headers and the contracts table itself. Dropping the column (decision 1)
makes `bun run typecheck` enumerate every one, which is precisely why dropping it
is safer than leaving it nullable.

`src/lib/tenantLocations.ts` needs the most thought: `selectActiveContractsByTenant`
takes a contract with a single `unit_id` and its `dedupeById` comment reasons
that "two contracts really are two units". With multi-unit contracts, one
contract can now be several units, so the selectors fan out over
`contract_units` and the dedupe operates on the flattened unit list.

## Migration and backfill

One migration file, `db/migrations/110_multi_unit_contracts.sql`, in this order:

1. Create `contract_units`.
2. Backfill one row per existing contract: `insert ... select id, unit_id, monthly_amount, 1 from contracts`.
3. Set `occupies_unit` from each parent contract's current state.
4. Add `invoice_items.unit_id`; backfill it on existing non-concession lines from `invoices.unit_id`.
5. Make `invoices.unit_id` and `contract_closeouts.unit_id` nullable.
6. Create the new `one_active_contract_per_unit` on `contract_units`; drop the old one.
7. Re-issue `unit_has_active_contract`; install the two occupancy triggers; drop the old one.
8. Install the `contracts.monthly_amount` total trigger.
9. Replace the portal RLS policies on `units` and `properties`.
10. Re-issue every SQL reader in the table above: `generate_invoices_for_year`,
    `validate_electricity_charge_insert`, `bulk_import_phase6`, and the close-out
    and restore RPCs.
11. Drop `contracts.unit_id` **last**, after every reader in SQL has moved.

**Step 11 is not a safety net.** PostgreSQL does not track column references
inside `plpgsql` (or old-style `$$`-quoted `sql`) function bodies as
dependencies, so `drop column contracts.unit_id` succeeds even if a function
body still names it — and that function then fails at _runtime_, on a money
path, with `record "v_contract" has no field "unit_id"`. There are no views over
`contracts` to catch it either (verified: the migration set defines none).

The only thing that catches an omission is the SQL test suite. That is why the
test list below exercises every re-issued function rather than only the invoice
generator.

Steps 2 and 3 must run before step 6, or the new unique index will be built
against empty data and enforce nothing on existing rows.

Existing invoices keep the `unit_id` they already have. Every existing contract
becomes a one-unit contract; **single-unit is the n=1 case, not a second code
path.**

### Production data is disposable

Confirmed with the product owner on 2026-08-07: every tenant, contract, invoice
and payment on production was **mock data**. Properties and units are real.
**The purge was carried out the same day** on
`danatfuture-supabase-ozoxsa-db-1`, after a full `pg_dump` to
`/root/danat-prepurge-2026-08-07.sql` (3.8 MB, completion marker verified):

| Table               | Before | After | Note                                        |
| ------------------- | ------ | ----- | ------------------------------------------- |
| `tenants`           | 1      | 0     |                                             |
| `contracts`         | 2      | 0     |                                             |
| `invoices`          | 17     | 0     | + 17 `invoice_items`                        |
| `payments`          | 8      | 0     | + 8 allocations, 3 partial, 1 insurance     |
| `payment_requests`  | 3      | 0     |                                             |
| `notifications`     | 22     | 0     |                                             |
| `properties`        | 10     | 10    | **kept**                                    |
| `units`             | 14     | 14    | **kept** — all now `vacant`                 |
| `commercial_brands` | 52     | 52    | **kept** — `contract_id` FK is `SET NULL`   |
| `profiles`          | 4      | 3     | 3 admins kept; the tenant portal login gone |

So migration 110 runs against zero contracts: the backfill is a no-op in
production and dropping `contracts.unit_id` destroys nothing.

Two findings from that operation are worth keeping:

- **`TRUNCATE ... CASCADE` would have been a disaster.** `profiles → tenants` is
  `ON DELETE SET NULL`, but `TRUNCATE CASCADE` ignores FK actions and truncates
  every referencing table — it would have wiped all three admin profiles along
  with the tenant. The purge used ordered `DELETE` inside one transaction instead.
  The same hazard sits inside `erase_all_data()` today.
- **The occupancy trigger works.** Deleting the two contracts flipped all 14 units
  to `vacant` with no manual intervention, which is exactly the behaviour
  migration 110 must preserve when that trigger moves to `contract_units`.

**The migration is still written to be correct with data present**, and is not
allowed to assume an empty table. It runs against seeded databases in
`bun run test:db` (migration 11 loads mock data) and against any developer
database, so an emptiness assumption would be a latent bug that only fires
off-production. The mock-data purge is a separate, earlier operational step —
not a licence to write a weaker migration.

`erase_all_data()` is **not** the tool for that purge: its truncate list
(`db/migrations/45_security_hardening_wsr.sql:71-94`) includes `units`,
`buildings` and `properties`, which must survive.

### Idempotency

`db/README.md` records that the migration set is mostly but not universally
idempotent. Step 11 is a destructive one-way step, so 110 guards it with
`if exists` on the column and is verified by `bun run test:db`, which builds a
clean database from scratch.

## Testing

Money paths are covered by SQL integration tests against a real Postgres
(`bun run test:sql`), which is where this feature's risk lives.

**New SQL tests** (`src/db/multiUnitContracts.sqltest.ts`):

- A three-unit contract at 400/400/400 generates **one** invoice per month with `total = 1200`.
- That invoice has three rent lines, each carrying its own `unit_id` and amount, plus concession lines after them.
- A single-unit contract still produces one rent line and a non-null `invoices.unit_id`.
- Generating twice is idempotent — the `(contract_id, period_year, period_month)` conflict still holds.
- A concession applies to the contract total once, not once per unit.
- Adding a unit to a contract already held by another live contract is **refused** by `one_active_contract_per_unit`.
- The same unit twice on one contract is refused by `unique (contract_id, unit_id)`.
- `units.status` flips to occupied when a `contract_units` row is added and back to vacant when it is removed.
- Setting a contract to a terminal state releases **all** of its units.
- A portal tenant sees all three of their units and all their properties, and none belonging to another tenant.
- `contracts.monthly_amount` equals the sum of its unit rents after insert, update and delete.

**The shared SQL fixture is the biggest single edit.** `src/db/testDb.ts:199-204`
inserts `contracts (code, tenant_id, unit_id, ..., monthly_amount, ...)` in one
statement, and every one of the 30 `*.sqltest.ts` files builds its world through
it. It becomes: insert the contract without a unit, then insert one
`contract_units` row per unit, with the helper taking either a single unit (the
existing call shape, preserved so 30 files do not all change) or a list of
`{ unitId, monthlyAmount }`.

**The backfill is exercised, but only there.** Production now has zero contracts,
so step 2 of the migration moves nothing in production and would be untested if
nothing else seeded contracts. `db/migrations/11_mock_data.sql:78` does seed
`contracts (id, tenant_id, unit_id, ...)`, and because migrations replay in
numeric order, those rows exist when 110 runs during `bun run test:db`. That
replay is therefore the **only** coverage the backfill gets — it must not be
skipped or stubbed, and a test must assert that every seeded contract came out
of migration 110 with exactly one `contract_units` row carrying its original
unit and amount.

**New unit tests:** the rent-section generator in `ContractUnitsField` — units
added and removed produce matching amount fields; the aggregated unit list is the
union across selected properties. Per the repo's own finding, a Zod schema in a
server fn is never exercised through the `createServerFn` mock, so the contract
validation schema is exported and asserted directly.

**Regression guard:** the existing `src/db/unitStatus.sqltest.ts` and
`archivedBillingSafety.sqltest.ts` must pass unchanged in substance — archived
contracts stay unbillable, and occupancy still derives from contract state.

Gates before merge: `bun run lint`, `bun run typecheck`, `bun run test`,
`bun run test:sql`.

## Deployment sequence

Dokploy auto-deploys on push to `main`, and migrations do **not** auto-apply. The
order is therefore mandatory:

1. Apply migration 110 to the live Supabase Postgres (`danatfuture-supabase-ozoxsa-db-1`) over SSH.
2. `notify pgrst, 'reload schema';` so PostgREST picks up the new table and the changed function signatures.
3. Only then merge to `main` and let Dokploy rebuild.

Reversed, the new code deploys against the old schema and every contract screen
fails.

## Out of scope

Explicitly cut, with the reason each was rejected:

- **Per-unit start/end dates** — decision 4. Would make the monthly total vary by billing period and complicate regeneration and close-out.
- **Contract merge tool** — decision 2. Moving part-paid invoices between contracts is a money-path risk with no safe default.
- **Per-unit deposits** — the deposit is one contract-level figure and close-out settles it once.
- **Per-unit concessions** — concessions apply to the contract total.
- **Multi-unit bulk import** — decision 7.
- **Per-unit rent changes over time** — no present-day caller.

## Risks

1. **Dropping `contracts.unit_id` is irreversible.** Mitigated by running the whole migration against a clean database via `bun run test:db` first, and by taking a database backup before applying to production.
2. **The occupancy trigger split is the silent failure.** A missed firing shows units as vacant while rented, and nothing revisits them. Covered by explicit `unitStatus` tests on both trigger paths.
3. **Portal RLS is all-or-nothing.** Wrong, and tenants see no units at all. Covered by an RLS test asserting both visibility and isolation. Note the repo's existing pitfall: the SQL test image reads `request.jwt.claim.sub`, so an RLS test that sets only the JSON claims passes vacuously.
4. **`generate_invoices_for_year` is the money path.** Its archived-contract guards (migration 82) and free-months skip must survive the edit; both are asserted by existing tests that must keep passing.
5. **Concurrent work in this repo.** The branch can move underneath this work; re-check the branch before every commit and merge.
