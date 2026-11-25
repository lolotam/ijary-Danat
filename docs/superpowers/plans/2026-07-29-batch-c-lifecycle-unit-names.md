# Batch C — Implementation plan

**Spec:** `docs/superpowers/specs/2026-07-29-batch-c-lifecycle-unit-names-design.md`
**Branch:** `feature/batch-c-lifecycle-unit-names` (cut fresh from updated `main`)
**Status:** Implemented 2026-07-29 — commits 3579b87, 596747a, a98b7b1

Three commits. Each leaves `lint`, `typecheck`, `test` and `test:sql` green, so
the branch is bisectable and any one commit can be reverted alone.

---

## Commit 1 — Migration 54 + the lifecycle engine

The database half. Nothing in the UI depends on it yet, so it lands and is
tested on its own.

**Files**

| File                                                   | Change                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `db/migrations/54_tenant_lifecycle_and_unit_names.sql` | new                                                                      |
| `src/integrations/supabase/database.types.ts`          | hand-add `units.name_en`; add `sync_tenant_lifecycle_for` to the RPC map |
| `src/db/lifecycle.sqltest.ts`                          | new — tests 1–8                                                          |

**Steps**

- [x] 1.1 Write `public.sync_tenant_lifecycle_for(_tenant uuid) returns public.tenant_lifecycle`, `security definer`, `set search_path = public`. Returns `blocked` unchanged when the tenant is already blocked; otherwise `active` / `contract_ended` / `inactive` per the rule table. Updates `public.tenants` only `where lifecycle is distinct from` the computed value.
- [x] 1.2 Write `public.tg_contract_sync_tenant_lifecycle()`, resolving **both** `old.tenant_id` and `new.tenant_id` and recomputing each distinct non-null id. Return `coalesce(new, old)`.
- [x] 1.3 Attach `after insert or update or delete on public.contracts for each row`. No `when` clause.
- [x] 1.4 Backfill every tenant through the same function.
- [~] 1.5 **Superseded during implementation.** Re-issuing `admin_bulk_insert` would copy ~110 lines of unrelated SQL into migration 54 and leave migration 16 no longer authoritative — the "superseded by number" trap. Replaced by a `before insert` trigger on `tenants`, which covers every insert path in fifteen lines. `admin_bulk_insert` is left untouched. See the spec section "De-drifting the writers".
- [x] 1.6 `alter table public.units add column if not exists name_en text;`
- [x] 1.7 Hand-add `name_en: string | null` to the `units` TableDefinition in `database.types.ts`. Never run `gen:types` over the real file.
- [x] 1.8 Write `src/db/lifecycle.sqltest.ts`: tests 1–8 from the spec. Test 7 runs `actAs(client, "authenticated", accountant)` and asserts both that the contract update succeeded and that the tenant's lifecycle changed.
- [x] 1.9 `bun run test:db` — a clean database provisions with 54 applied.
- [x] 1.10 `bun run test:sql` green.

**Trap:** an accountant needs `contracts.update` for test 7 to exercise the real
path. Seed the role with `seedUserWithRole` and confirm the contract UPDATE
itself returns a row — if RLS blocks the contract write, the test proves nothing
about the trigger.

---

## Commit 2 — De-drift the writers, block/unblock action, tenant picker

The application half of T8, plus the T11 coupling fix.

**Files**

| File                                         | Change                                                         |
| -------------------------------------------- | -------------------------------------------------------------- |
| `src/lib/bulkImportSchemas.ts`               | drop the tenant `lifecycle` field                              |
| `src/lib/bulkImportTemplates.ts`             | drop `"lifecycle"` from the tenants header                     |
| `src/lib/csvHeaders.ts`                      | drop the now-unused `lifecycle` header if nothing else uses it |
| `src/components/admin/TenantMultiSelect.tsx` | `includeInactive?: boolean`                                    |
| `src/routes/admin.settings.users.tsx`        | pass `includeInactive` from both dialogs                       |
| `src/routes/admin.tenants.index.tsx`         | block / unblock row action                                     |
| `src/hooks/useTenants.ts`                    | `useSetTenantBlocked` mutation                                 |
| `src/i18n/dictionary.ts`                     | `ar` **and** `en` keys for block/unblock                       |

**Steps**

- [x] 2.1 Remove `lifecycle` from the bulk-import schema and template header. Confirm no import fixture still sends the column.
- [x] 2.2 Add `includeInactive` to `TenantMultiSelect`; omit the `lifecycle` filter when set. Default `false` so existing callers are unchanged.
- [x] 2.3 Pass `includeInactive` from the create-user dialog and the assign dialog in `admin.settings.users.tsx`.
- [x] 2.4 Add `useSetTenantBlocked` — writes `lifecycle = 'blocked'`, or calls `sync_tenant_lifecycle_for` to unblock so the tenant lands on its true state.
- [x] 2.5 Add the row action to the tenants table (desktop dropdown **and** mobile card), gated on `tenants.update`.
- [x] 2.6 Add both locales' strings. Every new key exists in `ar` and `en`.
- [x] 2.7 `bun run lint && bun run typecheck && bun run test` green.

**Trap:** unblock must not write `'active'` blindly — a tenant with no contract
would then read `active` until their next contract write, reintroducing exactly
the drift T8 removes.

---

## Commit 3 — `units.name_en` in the UI, CSVs, and the LTR sweep

**Files**

| File                                         | Change                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/components/ui/ltr-text.tsx`             | new primitive                                                                |
| `src/components/ui/ltr-text.test.tsx`        | new render assertion                                                         |
| `src/routes/admin.units.index.tsx`           | English-name form field; CSV emits `name_en`                                 |
| `src/routes/admin.tenants.index.tsx`         | CSV `connected_unit_name_en: unit.name_en ?? unit.name`; LtrText at 523, 793 |
| `src/routes/admin.tenants.$id.documents.tsx` | LtrText at 56-62                                                             |
| `src/routes/admin.inbox.tsx`                 | LtrText at 564, 678                                                          |
| `src/routes/admin.invoices.tsx`              | LtrText at 767                                                               |
| `src/routes/admin.settings.users.tsx`        | LtrText at 422                                                               |
| `src/routes/admin.settings.integrations.tsx` | migrate the existing `dir="ltr"` to the primitive                            |
| `src/hooks/useUnits.ts`                      | select and write `name_en`                                                   |
| `src/lib/csvHeaders.ts`                      | `name_en` header, both locales                                               |
| `src/i18n/dictionary.ts`                     | `units.nameEn`, both locales                                                 |

**Steps**

- [x] 3.1 Write `LtrText` mirroring `formatted-date.tsx`; render `dir="ltr"` + `text-start`, accept `className` and an `as` element.
- [x] 3.2 Test it renders `dir="ltr"`, in the style of `components/ui/input.test.tsx`.
- [x] 3.3 Replace the bare phone/email/WhatsApp renders at all sites in the table above.
- [x] 3.4 Add `name_en` to the unit form, `useUnits` select/insert/update, and the units CSV.
- [x] 3.5 Fix the tenants CSV to emit `unit.name_en ?? unit.name` for the English column, and delete the stale comment at `admin.tenants.index.tsx:305-307`.
- [x] 3.6 Unit tests 10–12.
- [x] 3.7 `bun run format`, then `lint && typecheck && test && test:sql` — all green.

---

## Landing

- [ ] 4.1 Push the branch, open a PR whose body states the **17 → 5 active-tenant drop** explicitly and shows the before/after lifecycle table.
- [ ] 4.2 Merge to `main`. Never force-push, rebase, amend or squash — the repo is Lovable-connected.
- [ ] 4.3 Apply migration 54 to production via `ssh-danatfuture-mcp`, then re-probe: expect 5 active / 14 inactive / 1 blocked / 0 contract_ended.
- [ ] 4.4 Cut Batch C2's branch fresh from the updated `main`.
