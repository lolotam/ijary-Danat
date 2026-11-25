# Implementation plan — UI density, form persistence, landing-page cards, inbox & contract fixes

Spec: `docs/specs/ui-density-and-form-persistence.md` (revision 3).
Branch: `feat/ui-font-sizes-and-form-persistence` (cut from `origin/main` @ `fee1632`).

## Ordering rationale

Task 1 edits `table.tsx` / `button.tsx` / `label.tsx` / `select.tsx`, which
nearly every other task's files import. It runs **alone and last**, as its own
commit, so a tuning revert is one `git revert` rather than a surgical unpick from
the functional work.

Tasks 2 and 8 land **together** — spec §2.5: keeping the contract form open turns
task 8's millisecond flash into a permanent *and submit-blocking* error, and
§2.3's `createdId` is the single fix for both. Because task 8's occupancy query
consumes `createdId`, the form work now runs **first**: what was step 3 is now
step 2. In revision 2 the occupancy step came first and referenced a variable the
form step had not yet introduced, so `typecheck` failed between them.

Tasks 3 and 4 both own `admin.settings.landing-page.tsx`. **One slice, one
agent**, or they collide.

One structural prerequisite (spec §2.4) comes before the step that needs it.

## Steps

### Step 0 — Prerequisite for step 2

There is **no contract-hydrate prerequisite**. Revision 2 called for extracting
`fetchContractWithRelations`; spec §2.3 replaces that with a `createdId` flag, so
no page reassigns `editing` and no relation join is needed. (The extract was also
mis-scoped: the hydrate spans `useContracts.ts:161–235`, not `160–175`, and
`useContract` @240 returns a bare `Contract` that must not be reused.)

**0a. `UnitFormDialog` gains `onSaved?: (unit: Unit) => void`** —
`src/components/admin/UnitFormDialog.tsx`. Fired after a successful create *or*
update with the saved row; both mutations already return `Unit`
(`useUnits.ts:189–199`, `241–255`). Two call sites: `admin.units.index.tsx:395`
and `admin.properties.$id.tsx:323–330`.

Gate: `bun run typecheck` clean with no behaviour change yet.

### Step 1 — Reports locale fix (task 7)

Files: `src/hooks/useReportPreview.ts`, `src/routes/admin.reports.tsx`.

1. Add `locale: Locale` to `ReportPreviewParams`; thread it into the React Query
   `queryKey`.
2. `payment_report`, `overdue_aging`, `tenant_report`/`tenant_status`: select
   `name,name_en`, resolve via `tenantDisplayName(row, locale)`.
3. Add `name_en` to the tenant search `or()` at @254.
4. `overdue_aging`'s post-join text filter matches the **resolved** name.
5. `fetchReportExport` takes the same locale; update the call site in
   `admin.reports.tsx`.

Out of scope, documented in spec §7.1: scheduled/emailed reports
(`build_scheduled_report_html`) stay Arabic-only — that needs a migration.

### Step 2 — Forms stay open after save (task 2; closes task 8 part 2)

Files: the eleven in spec §2.2. The same six-step recipe (spec §2.3) applies to
each — no per-form hydrate:

1. add `const [createdId, setCreatedId] = useState<string | null>(null)`;
2. drop the close call, keep the toast;
3. `form.reset(values)` from the submitted values;
4. on create, `setCreatedId(saved.id)`;
5. submit reads **one local** — `const id = editing?.id ?? createdId` — and
   branches on it; `if (editing?.id ?? createdId) update({ id: editing.id })`
   throws after a create;
6. opening the dialog clears `createdId`.

Two exceptions:

- **Employees** (`admin.employees.tsx:86`) uses `useState<EmployeeForm>`, not
  react-hook-form. Step 3 there is `setForm(values)` — `form.reset` does not
  exist and would throw.
- **Contracts** additionally passes that same local as
  `useUnitsActiveContracts`' exclusion argument (@346). That single change is
  what closes task 8's flashing banner. It also already reads the id twice —
  `regenerateInvoices({ contractId: editing.id })` @484 — so the coalesce has to
  cover both.
- **Expenses and deposits** hold their upload in a sibling `useState`
  (`admin.expenses.tsx:163`, `admin.deposits.tsx:139`) that `form.reset` does not
  touch. Clear it after a successful save, or the next Save re-uploads the same
  file — and `useDeposits.ts:198–221` also deletes the previous object, so a
  no-op second Save becomes a storage rewrite.

No mutation returns `void` — all eleven return the saved row via
`.select("*").single()`, verified. The four `…WithRelations` pages
(contracts, expenses, meters, readings) never assign it, so their type mismatch
never arises.

Verify by hand: create → Save → Save again inserts **one** row. Readings is the
sharpest test — a duplicate there hits the
`unique (meter_id, period_year, period_month)` constraint
(`09_phase7_electricity.sql:58`) and surfaces as a save error.

### Step 3 — Contract occupancy badge (task 8, part 1)

Files: `src/components/admin/ContractUnitsField.tsx`, `src/routes/admin.contracts.tsx`.

1. Compute `union(aggregateUnitsForProperties(units.data ?? [], propertyIds),
   selectedUnitIds)` — the union, because `useUnits` is paginated and a reopened
   contract can hold a unit outside the fetched page (spec §8.1).
2. Cap that id list behind a named constant with a comment, **retaining every
   selected unit id** (spec §8.1); pass it to
   `useUnitsActiveContracts(..., editing?.id ?? createdId)`.
3. Intersect the returned map with `selectedUnitIds` and let that intersection
   **be** `conflicts` — all three consumers (save guard @450, banner @1144,
   submit-disable @1162) read the same value, so behaviour is identical to today.
   Intersecting at only some call sites would disable Save because a *sibling*
   unit of a chosen property is occupied.
4. `ContractUnitsField` gains `occupiedUnitIds: Set<string>`; render
   `<Badge variant="destructive">` beside each occupied unit. Still selectable.
5. New key in **both** locales.

### Step 4 — Bulk mark read / unread (task 5)

File: `src/routes/admin.inbox.tsx`.

Two buttons beside the **existing header delete button** at @641–650, under the
same `selectedGmailIds.size > 0` condition. There is no `BulkDeleteBar` in this
route. Iterate `useMarkGmailRead`, tally `ok`/`fail` into one toast, clear the
selection. New keys in both locales.

### Step 5 — Signature injection (task 6)

Files: `src/components/admin/compose/RichTextEditor.tsx`,
`GmailComposeDialog.tsx`, `src/lib/signatureHtml.ts`.

**Not** a custom atom node — it would serialise to a custom tag, and once the
append at @177 is removed that tag *is* the Gmail body (spec §6.2). Extend the
`Table` node already in the schema:

1. The editor registers `TableKit` (`RichTextEditor.tsx:3, 93`), a bundle — not a
   raw `Table` node, so it cannot be extended in place. Use
   `TableKit.configure({ table: false })` to drop the bundled table node, then
   register `Table.extend({ addAttributes })` alongside it; `Table` is exported
   from `@tiptap/extension-table` (v3.30.0). The attribute parses from and
   renders to `data-signature`, so output stays a real
   `<table data-signature="1">`.
2. Carry `wrapSignature`'s divider styling on a **declared** attribute.
   `Table.parseHTML` is only `[{ tag: 'table' }]` and the node declares no
   `style`, so a bare `<table style="…">` is stripped on `setContent` exactly
   like the `<div>` was. Declare `style` in `addAttributes` as well, or emit the
   divider from the signature attribute's own `renderHTML`.
3. Select → insert or replace the table carrying that attribute, one transaction;
   select none → delete it. Match on the attribute, never on "the only table" —
   a pasted table must not be destroyed.
4. Remove the append in `submit()` (@177).
5. Reset `signature` to `null` in the reseed effect at @132–137.
6. Rewrite the stale comment at @378–383.

Verify: select twice → one table; send → one signature and no custom tag in the
payload; reopen → no phantom selection; paste a table → still there after
selecting a signature.

### Step 6 — Landing-page cards + eye preview (tasks 3 & 4)

Files: `src/routes/admin.settings.landing-page.tsx` (1809 lines, over the
ceiling), new `SlidesTable.tsx` / `GalleryTable.tsx` beside `ShopsTable.tsx`, new
`src/components/admin/ImagePreviewDialog.tsx`.

1. Extract the slides and gallery tab bodies — the split `CLAUDE.md` asks for
   when a file you are already in is over the ceiling.
2. `grid gap-4 sm:grid-cols-2 xl:grid-cols-3` of `Card` per tab. Not
   `MobileCardList` (single-column stack).
3. Actions → `DropdownMenu` behind a chevron pinned `top-2 end-2`. **Only the
   actions each tab has today** (spec §3 table): shops edit/delete, slides
   edit/delete, gallery toggle + conditional delete. No reorder — it does not
   exist.
4. `ImagePreviewDialog` takes `{ url, alt }` and renders it directly. No
   `createSignedUrl` — these are public URLs, not storage paths.
5. `Eye` overlay on shops `logo`+`card`, slides `image`, gallery `image`, with
   `stopPropagation`.
6. Strings follow this file's inline `locale === "ar" ? … : …` pattern.

Verify by DOM/DB reads — this file's native `confirm()` (@568) freezes browser
automation.

### Step 7 — Type scale and table headers (task 1) — LAST, own commit

Spec §1.3, rows 1a–1i. Note 1h is a second location for the "title + details"
ask, separate from `InfoField`.

Browser-verify at `bun run dev`:

- an admin table — header bold, light background, RTL alignment unchanged;
- the invoice month overview and a month detail;
- a tenant detail page (`InfoField` pairs) and the invoice send dialog (1h);
- **the printed A4 invoice** — `buildInvoiceDocument` output must be unchanged.
  The print page's on-screen toolbar buttons *will* grow; that is expected and
  documented in spec §1.2.

## Gates

After every step: `bun run lint`, `bun run typecheck`, `bun run test`.
After all steps: `clean-code-guard` over the production diff, `test-guard` over
the tests, then the browser pass for tasks 1/3/4.

`bun run format` rewrites all markdown — revert `AGENTS.md` / `CLAUDE.md` /
unrelated docs before staging.

## Deploy

No migration; `ssh-danatfuture-mcp` not needed. Merge to `main` auto-deploys via
Dokploy — flagged to the owner before merging.
