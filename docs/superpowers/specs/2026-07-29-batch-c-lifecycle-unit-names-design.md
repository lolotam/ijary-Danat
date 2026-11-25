# Batch C — Tenant lifecycle, unit English names, tenant picker, LTR sweep

**Date:** 2026-07-29
**Tasks:** T8 (automatic tenant lifecycle), T9 completion (real EN/AR unit names),
T11 completion (tenant picker coupling), T5 (app-wide LTR sweep)
**Migration:** `db/migrations/54_tenant_lifecycle_and_unit_names.sql`
**Depends on:** Gate 1 (SQL integration harness) — every lifecycle assertion here is SQL

---

## Why this batch exists

`tenants.lifecycle` is a `public.tenant_lifecycle` enum
(`04_phase2_properties_tenants_contracts.sql:17`) with four values —
`active`, `inactive`, `contract_ended`, `blocked` — and **nothing has ever
maintained it**. It is set by hand on the tenant form, by the bulk importer, and
by `admin_bulk_insert`, then never revisited. The column defaults to `'active'`,
so every tenant created since launch reads `active` regardless of whether they
hold a contract.

Production confirms the drift exactly:

| stored `lifecycle` | contract reality        | count  |
| ------------------ | ----------------------- | ------ |
| `active`           | has an active contract  | 5      |
| `active`           | **no contracts at all** | **12** |
| `inactive`         | no contracts            | 1      |
| `contract_ended`   | no contracts            | 1      |
| `blocked`          | no contracts            | 1      |

Twelve tenants claim to be active and hold nothing. T8 makes the column derived
so it cannot drift again.

### Expected, deliberate consequence

**The visible active-tenant count drops from 17 to 5 the moment migration 54 is
applied.** That is the task working, not a regression. It must be stated in the
PR body and told to the user before the migration reaches production, because it
changes the dashboard KPI, the weekly report, and the tenant list default view
on the same tick.

Because lifecycle becomes purely derived, the backfill is **recomputable** —
running it twice produces the same answer — which is what makes the change
reversible in practice: the input data (`contracts`) is untouched.

---

## C.1 — T8: lifecycle becomes trigger-owned

### The rule table

Resolved in priority order, first match wins:

| Result           | Condition                                               |
| ---------------- | ------------------------------------------------------- |
| `blocked`        | the tenant is **already** `blocked` — never overwritten |
| `active`         | ≥ 1 contract in state `active`                          |
| `contract_ended` | has ≥ 1 contract, none in state `active`                |
| `inactive`       | has no contracts at all                                 |

`blocked` is the one sticky state: a manual admin override meaning "do not deal
with this tenant", which no automatic process may clear. Everything else is a
pure function of `contracts`.

**`contract_ended` is deliberately _not_ sticky.** The one production row
holding it has no contracts, so the backfill rewrites it to `inactive`. Making
it sticky would mean a contractless tenant keeps `contract_ended` forever while
a newly created contractless tenant gets `inactive` — identical data wearing two
different labels, permanently. One sticky state is the coherent design.

### Shape

Two objects, mirroring the existing portal-deactivation trigger in
`21_settings_integrations.sql:51-77`, which is the closest precedent in the repo
and already solves the same problems:

```sql
-- Recomputes one tenant. Callable directly, which is what makes the backfill
-- and the tests share exactly one code path with production.
create or replace function public.sync_tenant_lifecycle_for(_tenant uuid)
returns public.tenant_lifecycle
language plpgsql
security definer
set search_path = public
as $$ ... $$;

-- Fires for insert, update and delete on contracts.
create or replace function public.tg_contract_sync_tenant_lifecycle()
returns trigger ...
```

Three design points, each of which is a bug if got wrong:

1. **`security definer` with `set search_path = public`.** The trigger sits on
   `contracts` and writes `public.tenants`. Without definer rights an accountant
   holding `contracts.update` but not `tenants.update` is stopped by RLS — and
   **RLS updates zero rows silently rather than raising**, so lifecycle would
   simply stop syncing for some users while every test still passed. This is
   migration 52's fatal in-trigger-RBAC mistake inverted, and it is why the test
   below runs as an accountant rather than as superuser.

2. **Both sides of a `tenant_id` change must resync.** The trigger resolves
   `old.tenant_id` and `new.tenant_id` and recomputes each distinct non-null id.
   Moving a contract from tenant A to tenant B must leave A correct too;
   `coalesce(old.tenant_id, new.tenant_id)` — what migration 21 does — is
   sufficient there but _not_ here, because migration 21 only ever needed the
   one tenant.

3. **The update is guarded on an actual change** (`where lifecycle is distinct
from _next`) so a no-op contract save does not bump `tenants.updated_at` and
   does not churn `set_updated_at`.

Trigger timing: `after insert or update or delete on public.contracts for each
row`. Unlike migration 21's trigger it carries **no `when` clause** — it must run
for every transition, not only departures from `active`.

### Backfill

```sql
update public.tenants t
   set lifecycle = public.sync_tenant_lifecycle_for(t.id)
 where t.lifecycle is distinct from public.sync_tenant_lifecycle_for(t.id);
```

`blocked` survives because the function returns `blocked` for an already-blocked
tenant, so the `where` clause excludes it.

### De-drifting the writers — a third trigger, not a rewritten RPC

The contracts trigger only fires on contract writes. A tenant inserted with an
explicit `lifecycle` and _no_ contract would keep that asserted value forever,
because nothing ever revisits it. Three code paths do exactly that:
`admin_bulk_insert` (`16_admin_table_operations.sql:128-141`), the bulk-import
schema, and the column default `'active'`.

The obvious fix — re-issue `admin_bulk_insert` in migration 54 without the
column — means copying ~110 lines of unrelated SQL for expenses, deposits,
properties, buildings and units into a new migration, after which migration 16
silently no longer holds the live definition. That is the "superseded by number"
trap this repo already has a memory about, and it would be introduced
deliberately.

Instead, make the _table_ enforce it:

```sql
create trigger tenants_derive_lifecycle
  before insert on public.tenants
  for each row execute function public.tg_tenant_default_lifecycle();
```

The trigger runs the same rule table against the row being inserted. At insert
time no contract can reference the new tenant yet, so the answer is `inactive` —
unless the caller asked for `blocked`, which stays sticky here too. Fifteen
lines, and it covers every insert path including any this review did not find.

`admin_bulk_insert` is therefore left **untouched**: it may keep passing
`lifecycle`, and the value is simply overwritten. Migration 16 remains the live
definition of that function.

Two application-side changes still happen, because offering a column that is
silently ignored is worse than not offering it:

| Site                                | Change                                              |
| ----------------------------------- | --------------------------------------------------- |
| `src/lib/bulkImportSchemas.ts:91`   | drop the `lifecycle` field from the tenant schema   |
| `src/lib/bulkImportTemplates.ts:28` | drop `"lifecycle"` from the tenants template header |

`15_mock_kuwait_data.sql` keeps its explicit values: seed rows land `inactive`
(or `blocked`), and the contracts it seeds afterwards promote them correctly.

### Where `blocked` now gets set

`blocked` left the tenant create/edit form in Gate 0 (correctly — a manual field
fighting a trigger is exactly what T8 removes). It needs somewhere to live, so it
returns as a **row action** on the tenants table: "Block tenant" / "Unblock
tenant", gated on `tenants.update`.

It writes through a dedicated RPC rather than a direct table update:

```sql
public.set_tenant_blocked(_tenant uuid, _blocked boolean) returns public.tenant_lifecycle
```

**The RBAC check lives in this RPC, never in a trigger.** That is the single
most important structural lesson from migration 52, whose in-trigger permission
check meant an accountant editing a contract got a `42501` that aborted the
contract save itself. Gate at the server boundary; let triggers run with definer
rights and no opinion about who called them.

Unblocking calls `sync_tenant_lifecycle_for`, so a tenant with an active contract
unblocks straight to `active`. Writing `'active'` blindly would reintroduce
exactly the drift T8 exists to remove.

### Consumers that change on the same tick

Enumerated so none drifts unnoticed. None of these needs a code change — they
read the column and will simply report the corrected numbers — but each is a
place a reviewer might otherwise mistake the new figure for a bug:

- `src/routes/admin.index.tsx:86` — dashboard active-tenant KPI
- `44_scheduled_report_email_design.sql:129-131` — weekly report active/blocked/contract_ended counts
- `07_phase5_notifications_reports.sql:278` and `31_notification_workflows.sql:319` — group-by-lifecycle HTML table
- `src/routes/admin.tenants.index.tsx` — lifecycle badge and sort column
- `src/components/admin/TenantMultiSelect.tsx` — **does** need a change; see C.3

**No cascade exists.** Verified by grep: no policy, trigger, or RPC reads
`tenants.lifecycle`. Portal access is gated on `contracts.state` directly
(`deactivate_portal_users_without_active_contract`), not on lifecycle, so the
backfill cannot revoke anyone's portal login.

---

## C.2 — T9 completion: `units.name_en`

T9 asked for "Connected Unit English Name" and "Connected Unit Arabic Name" CSV
columns. `units` has a single `name` column
(`04_phase2_properties_tenants_contracts.sql`), so both columns currently emit
the same value — `admin.tenants.index.tsx:304-309` says so in a comment.

Migration 54 adds:

```sql
alter table public.units add column if not exists name_en text;
```

Nullable, mirroring `properties.name_en`. Existing rows keep `name` as their only
name, and the English column falls back to it, so nothing displays blank.

| Surface                                         | Behaviour                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Unit create/edit form (`admin.units.index.tsx`) | new optional "English name" field beside `name`                                          |
| Units CSV                                       | `name` (Arabic) and `name_en` emitted as separate columns                                |
| Tenants CSV (`admin.tenants.index.tsx:308-309`) | `connected_unit_name_ar: unit.name`, `connected_unit_name_en: unit.name_en ?? unit.name` |
| `database.types.ts`                             | hand-add `name_en: string \| null` to the `units` TableDefinition                        |

The `?? name` fallback is what stops an English-locale export going blank for the
existing 100% of units that have no English name yet.

---

## C.3 — T11 completion: the T8 ↔ T11 coupling

`TenantMultiSelect` queries `useTenants({ lifecycle: "active" })`
(`TenantMultiSelect.tsx:27`). Today every tenant defaults to `active`, so the
picker lists all of them and the filter is invisible.

After migration 54, **12 of 17 tenants disappear from that picker** — and they
are exactly the ones an admin needs, because the normal order of work is _create
the tenant → create their portal login → then activate the contract_. A tenant
with no contract yet is `inactive` by definition, so creating a portal login
before contract activation would become impossible.

Fix: an `includeInactive?: boolean` prop that omits the lifecycle filter. The
create-user dialog and the assign dialog both pass it. The prop is required, not
cosmetic — without it T8 breaks T11 the day it ships.

---

## C.4 — T5: the LTR sweep

Batch A applied LTR to two places by two different mechanisms: an `ltr` boolean
on the local `Info` component (`admin.tenants.$id.index.tsx:389-399`) and an
automatic `dir="ltr"` on `Input type="tel"` (`components/ui/input.tsx:10`).
Neither generalises.

Add **one primitive**, mirroring `components/ui/formatted-date.tsx`:

```tsx
// src/components/ui/ltr-text.tsx
export function LtrText({ children, className, as }: …)
```

It renders `dir="ltr"` plus `text-start`, so a Latin phone number or email keeps
its digit order and its logical alignment inside an RTL page. Then replace the
bare renders at every phone/WhatsApp/email site:

| File                                         | Lines                                                |
| -------------------------------------------- | ---------------------------------------------------- |
| `src/routes/admin.tenants.index.tsx`         | 523 (mobile card), 793 (table cell)                  |
| `src/routes/admin.tenants.$id.documents.tsx` | 56-62 (mobile + email badges)                        |
| `src/routes/admin.inbox.tsx`                 | 564, 678 (inquiry / lead email)                      |
| `src/routes/admin.invoices.tsx`              | 767 (WhatsApp recipient)                             |
| `src/routes/admin.settings.users.tsx`        | 422 (profile email)                                  |
| `src/routes/admin.settings.integrations.tsx` | 108 (already `dir="ltr"` — migrate to the primitive) |

A scattered twenty-site `dir="ltr"` diff is unreviewable and untestable; one
primitive is both, and gets a render assertion in the style of
`components/ui/input.test.tsx`.

---

## Tests

| #   | Kind | Assertion                                                                                                                                                                                      |
| --- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SQL  | inserting an `active` contract sets the tenant `active`                                                                                                                                        |
| 2   | SQL  | moving that contract to `expired` sets the tenant `contract_ended`                                                                                                                             |
| 3   | SQL  | deleting the last contract sets the tenant `inactive`                                                                                                                                          |
| 4   | SQL  | a tenant with no contracts is `inactive`                                                                                                                                                       |
| 5   | SQL  | **`blocked` survives** an insert, an update and a delete of its contracts                                                                                                                      |
| 6   | SQL  | reassigning `contract.tenant_id` from A to B recomputes **both** A and B                                                                                                                       |
| 7   | SQL  | **as an accountant** (`actAs`, not superuser): updating `contracts.state` succeeds _and_ the tenant's lifecycle actually changed — the discriminating test for the `security definer` decision |
| 8   | SQL  | backfill is idempotent: running it twice yields the same lifecycle set                                                                                                                         |
| 9   | SQL  | `units.name_en` accepts null and survives a round-trip                                                                                                                                         |
| 10  | Unit | tenants CSV emits `name_en ?? name` for the connected unit                                                                                                                                     |
| 11  | Unit | units CSV emits `name` and `name_en` as distinct columns                                                                                                                                       |
| 12  | Unit | `LtrText` renders `dir="ltr"`                                                                                                                                                                  |

Test 7 is the one that proves the design. Tests 1–6 would all pass under a
non-definer trigger when run as superuser, which is precisely the false-pass
class that made every RLS assertion in this repo vacuous until 2026-07-29.

---

## Verification

1. `bun run lint && bun run typecheck && bun run test` — green
2. `bun run test:sql` — green, including the seven new lifecycle assertions
3. `bun run test:db` — a clean database provisions from `db/migrations/` with
   migration 54 in place
4. Migration 54 applied to production via `ssh-danatfuture-mcp`, then re-probed:
   lifecycle counts become 5 active / 14 inactive / 1 blocked / 0 contract_ended
   (20 tenants: the 12 contractless `active` rows, the existing `inactive` row
   and the existing `contract_ended` row all resolve to `inactive`)
5. Manual smoke in both locales: the unit form's English name field, the tenant
   block/unblock row action, and LTR rendering of phone numbers in Arabic
