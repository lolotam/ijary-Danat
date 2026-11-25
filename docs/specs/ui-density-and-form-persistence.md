# Spec — UI density, form persistence, landing-page cards, inbox & contract fixes

Eight requests from the owner, batched into one branch because task 1 touches
shared primitives every other task's files import.

Goal: **merge to `main`**. Nothing short of that closes this work.

> Revision 2. Revision 1 was rejected in adversarial review with 17 objections,
> every one of which was verified against the source and is fixed below. The
> sections that changed most are 2 (form persistence — the original recipe did
> not typecheck), 6 (signature — the original marker is discarded by ProseMirror)
> and 4 (image preview — the dialog named cannot take a URL).

---

## Task 1 — Larger type, bold table headers

### 1.1 Approach: component-level, not a root font-size bump

Tailwind v4 sizes *spacing* in `rem` too — `p-4`, `gap-2`, `max-w-md`, `size-10`.
Bumping `html { font-size }` enlarges the whole layout. Editing the shared
primitives instead is both safer and broader, because they are centralised.

### 1.2 What "shared" honestly means

`button.tsx`, `label.tsx` **and `select.tsx`** are imported by
`src/routes/index.tsx` (public landing), every `portal.*` route — including the
tenant portal's language switcher (`portal.tsx:18–24`) — and the on-screen chrome
of `InvoicePrint.tsx` / `ReceiptPrint.tsx`. **All of those grow too.** Revision 1
claimed they would not; that was false.

What is genuinely protected is the **printed A4 document**: `InvoicePrint.tsx:36`
delegates to `buildInvoiceDocument` (`src/lib/invoiceDocument.ts:31`), which
builds an HTML string with its own inline styles and never renders a React
`Button`. Same for `paymentDocument.ts` and the receipt renderer.

So the verification claim is: **the A4 document output is byte-identical**; the
print *page's* on-screen toolbar buttons get slightly larger, which is harmless
and consistent with the rest of the app.

### 1.3 Edits

| # | File | Change |
|---|---|---|
| 1a | `ui/table.tsx` | `Table`: `text-sm` → `text-base`. `TableHead`: `font-medium text-muted-foreground` → `font-semibold text-foreground`, `h-10` → `h-11`. `TableHeader`: add `bg-muted/60`. |
| 1b | `ui/button.tsx` | base `text-sm` → `text-base`; `size.sm` `text-xs` → `text-sm` and `min-h-9` → `min-h-10`; `size.lg` gains `text-lg`. |
| 1c | `admin/InfoField.tsx` | label `text-xs` → `text-sm`; value wrapper gains `text-base`. |
| 1d | `ui/select.tsx`, `ui/dropdown-menu.tsx` | trigger/item `text-sm` → `text-base` (task 1.3's "drop-down lists"). |
| 1e | `ui/label.tsx` | `text-sm` → `text-base`. |
| 1f | `admin/MobileCardList.tsx` | `CardField` label `text-sm` → `text-base`. |
| 1g | `routes/admin.invoices.tsx` | month-overview and month-header `text-xs` runs at ~582, ~624, ~665–677, ~816, ~848 → `text-sm`. |
| 1h | `routes/admin.invoices.tsx` **lines 1103 and 1118** | The invoice send dialog's own label/value pair — custom `text-xs`, *not* `InfoField`. This is the literal "WhatsApp + phone number" case the owner named. |
| 1i | `admin/Phase2Ui.tsx` (`ModuleHeader`, `TableState`, `Pager`) | body copy `text-sm` → `text-base`; genuine captions stay small. |

Task 1.4 ("title and its details both bigger") is therefore covered in two
places, not one: `InfoField` for the detail grids, and 1h for the send dialog.

**RTL invariant:** `TableHead`'s doc comment (lines 66–77) forbids physical
alignment classes — `text-start` stays. No change may introduce `text-left`,
`text-right` or `text-center`.

### 1.4 Header background

`bg-muted/60` — `--muted` is a light sand in the light theme and a dark slate in
the dark theme, so one token reads as "light header" in both without a hardcoded
hex that inverts badly.

---

## Task 2 — Forms stay open after Save

### 2.1 The unstated requirement

Keeping the form open is safe for **edit**. For **create** it is not: the form
stays mounted bound to a create mutation, and a second Save inserts a **duplicate
row**. This is the one item in the eight that corrupts data rather than just
looking wrong.

After a successful create the form must stop behaving like a create form — the
next Save has to UPDATE the row it just inserted. §2.3 does that with a
`createdId` flag rather than by promoting `editing` to the saved row, which does
not typecheck on four of these pages.

### 2.2 Scope — record forms only (owner-confirmed)

| Route / component | Real close call |
|---|---|
| `routes/admin.contracts.tsx` | `setDialog(false)` @534 |
| `routes/admin.tenants.index.tsx` | `setDialog(false)` @426 |
| `routes/admin.properties.index.tsx` | `setPropertyDialog(false)` @**197** |
| `routes/admin.maintenance.index.tsx` | `setDialog(false)` @205 |
| `routes/admin.employees.tsx` | `setOpen(false)` @141 |
| `routes/admin.expenses.tsx` | `setFormOpen(false)` @**251** |
| `routes/admin.deposits.tsx` | `setFormOpen(false)` @204 |
| `components/admin/UnitFormDialog.tsx` | `onOpenChange(false)` @144 |
| `components/admin/electricity/MetersTab.tsx` | `setFormOpen(false)` @135 |
| `components/admin/electricity/TariffsTab.tsx` | `setFormOpen(false)` @175 |
| `components/admin/electricity/ReadingsTab.tsx` | `setFormOpen(false)` @139 |

Revision 1 cited `admin.expenses.tsx:777` — that is `CategoryEditor` (code /
name_ar / name_en), a different dialog, and it stays out of scope. Deposits and
the three electricity tabs are the same record-form shape and were missing.

**Out of scope** (actions, not record forms): `SendManualMessageDialog`,
`SendBulkMessageDialog`, `CsvImportDialog`, `MarkInvoicePaidDialog`,
`TemplateEditorDialog`, `GmailComposeDialog`, `PaymentSidePanels`,
`CategoryEditor`, the data-reset dialog in `admin.settings.index.tsx`.

### 2.3 Per-form contract — a `createdId`, not a promoted `editing`

The obvious recipe — "set `editing` to the saved row" — does not work, because
four of these pages type `editing` as a **`…WithRelations`** while their mutation
returns the bare row:

| Page | `editing` / `target` type | Mutation returns |
|---|---|---|
| Contracts (`admin.contracts.tsx:221`) | `ContractWithRelations` | `Contract` (`useContracts.ts:470`) |
| Expenses (`admin.expenses.tsx:161`) | `ExpenseWithRelations` | `Expense` (`useExpenses.ts:278`) |
| Meters (`MetersTab.tsx:92`) | `ElectricityMeterWithRelations` | `ElectricityMeter` |
| Readings (`ReadingsTab.tsx:86`) | `MeterReadingWithRelations` | `MeterReading` |

Assigning the returned row fails `tsc`; casting past it crashes the reset effect
(`admin.contracts.tsx:367` does `editing.units.map`). Hydrating four different
relation joins just to keep a dialog open is a great deal of machinery for a
UI-persistence change.

**Instead, add one piece of state per form: `createdId`.** It exists only to
answer "has this form already inserted its row?".

1. Keep `toast.success(...)` — it is now the *only* signal the save happened.
2. Do not close the dialog.
3. `form.reset(values)` from the values just submitted, so dirty state clears and
   an unmodified re-save is a no-op. The submitted values are sufficient: the
   fields the server defaults (`id`, `code`, `updated_at`) are not editable form
   fields, so there is nothing to read back.
4. On create only: `setCreatedId(saved.id)`.
5. The submit handler reads **one local** — `const id = editing?.id ?? createdId`
   — and branches on it. Writing `if (editing?.id ?? createdId) update({ id: editing.id })`
   throws after a create, because `editing` is still null.
6. Opening the dialog resets `createdId` to `null`.

`editing` is never reassigned, so no page needs a `WithRelations` hydrate, and
the reset-on-open effect stays untouched. The same six steps apply to all eleven
forms, which is the point.

Verified across all eleven: every submit handler branches on
`if (editing|target)` and reads nothing off it but `.id`, so
`editing?.id ?? createdId` substitutes cleanly with no other change.

**Employees is the one shape exception.** `admin.employees.tsx:86` holds
`useState<EmployeeForm>`, not react-hook-form — there is no `form.reset`. Step 3
there is `setForm(values)`.

**Expenses and deposits carry a file outside the form.** Both hold the upload as
separate `useState<File | null>` (`admin.expenses.tsx:163`) rather than a form
field, and their create mutation uploads it. A form that stays open would
re-upload the same file on the next Save, orphaning a storage object and
repointing `attachment_path`. Clear that state after a successful save, the same
way the close used to clear it by unmounting.

Cancel/Close and the dialog's own `onOpenChange` keep working — that is the
manual close the owner asked to be the only way out.

### 2.4 Units — the dialog cannot promote itself

`editing` is a prop (`UnitFormDialog.tsx:37–42`) with no callback, so the dialog
cannot tell its parent that a row now exists. `createdId` lives inside the
dialog, which covers the duplicate-insert risk on its own; the parents still need
to know so their list state and their own `editing` stay coherent.

Add `onSaved?: (unit: Unit) => void`, fired after create *or* update. Both
mutations already return `Unit` (`useUnits.ts:189–199`, `241–255`). Two call
sites, no more: `admin.units.index.tsx:395` and
`admin.properties.$id.tsx:323–330` (whose close handler also clears
`editingUnit`, and does not fight `onSaved`).

### 2.5 Coupling with task 8

`admin.contracts.tsx:346` calls `useUnitsActiveContracts(selectedUnitIds, editing?.id)`.
On create, `editing` is undefined, so nothing is excluded. After a create,
`useSaveContractWithUnits` invalidates `["units-active-contracts"]` and the
refetch matches the contract that was *just created* — so `conflicts.data.size > 0`
and the form reports its own units as occupied. Today `setDialog(false)` unmounts
the form a frame later, which is exactly the "red message that flashes for a
millisecond" in task 8.

Keeping the form open makes that flash **permanent and blocking** — with
`conflicts.data.size > 0` the submit button is disabled (@1162) and the banner
(@1144) is pinned open, so the form cannot be saved again.

§2.3's `createdId` is the fix, and it is one line here: the exclusion argument
becomes `editing?.id ?? createdId`, so after a create the query excludes the
contract's own `contract_units` rows exactly as it does when editing. Tasks 2
and 8 must land together.

---

## Task 3 — Card view for landing-page shops / slides / gallery

`routes/admin.settings.landing-page.tsx` is 1809 lines — past the 500–600
ceiling, so splitting the three tab bodies out is in scope per `CLAUDE.md`:

- `components/admin/landing-page/ShopsTable.tsx` — exists.
- `components/admin/landing-page/SlidesTable.tsx` — new.
- `components/admin/landing-page/GalleryTable.tsx` — new.

**Container:** an explicit `grid gap-4 sm:grid-cols-2 xl:grid-cols-3` of `Card`.
Not `MobileCardList` — that is a `space-y-3` single-column stack
(`MobileCardList.tsx:29–35`) and would give one column, not a grid.

**Actions:** a `DropdownMenu` behind a chevron pinned `top-2 end-2` — logical
utilities, so the corner follows the language with no locale branch.

The menu holds **exactly** the actions that tab has today. Revision 1 claimed
"edit, toggle active, reorder, delete" for all three; that was false — there is
no reorder control anywhere, and shops' gold dot (`ShopsTable.tsx:155–158`) is a
featured *indicator*, not an action.

| Tab | Menu items (unchanged capability) |
|---|---|
| Shops (`ShopsTable.tsx:159–177`) | edit, delete |
| Slides (`landing-page.tsx:1421–1463`) | edit, delete |
| Gallery (`landing-page.tsx:1584–1612`) | show-in-gallery toggle; delete **only** when `category === "gallery"` |

**Strings:** this file uses inline `locale === "ar" ? … : …`, not the i18n
dictionary. New strings follow that pattern and therefore do not touch
`dictionary.test.ts`.

---

## Task 4 — Preview eye icon on images

Same three tabs: shops `logo` + `card` columns, slides `image`, gallery `image`.

**`AttachmentPreviewDialog` cannot be reused.** It calls
`supabase.storage.from(bucket).createSignedUrl(path, 300)`
(`AttachmentPreviewDialog.tsx:60`). These thumbnails render a **public URL**
(`ShopsTable.tsx:80, 97`; `landing-page.tsx:1394, 1586`) written by
`ImageSourceInput`, which accepts an upload *or* a pasted URL. Passing a URL as a
storage path 500s.

So: a new `components/admin/ImagePreviewDialog.tsx` — takes `{ url, alt }`,
renders the image in a `Dialog` at natural size with a max viewport bound. No
storage call, no bucket, no signing.

An `Eye` button overlays each thumbnail (visible on hover, always visible on
touch via `pointer-coarse:`). It must `stopPropagation` so it does not fire the
card's own click target.

---

## Task 5 — Bulk mark read / unread

`routes/admin.inbox.tsx` already has the selection machinery: a checkbox column,
`selectedGmailIds`, `onToggleAll`.

**There is no `BulkDeleteBar` in this route** — revision 1 said there was; zero
imports. Gmail bulk delete is a header button rendered at @641–650 under
`selectedGmailIds.size > 0`. The two new buttons — "Mark read" / "Mark unread" —
go **beside that existing button**, same conditional.

They iterate `useMarkGmailRead` over the selection, tally `ok` / `fail` and
report both in one toast (the pattern `BulkDeleteBar.runDelete` uses) rather than
swallowing failures, then clear the selection.

New i18n keys go in **both** locales or `dictionary.test.ts` fails the suite.

---

## Task 6 — Signature injects into the compose body

Today `GmailComposeDialog` *selects* a signature and `submit()` appends it once
(@177). The owner wants it visible in the body instead.

### 6.1 A marker attribute does not survive

Revision 1 put `data-signature-block` on `wrapSignature`'s `<div>`. ProseMirror
discards nodes its schema does not know, and there is no `div` node in this
editor's schema — `RichTextEditor.tsx:71–75` documents exactly this, which is why
`Table` and `Image` were registered so the signature's `<table>`/`<img>` survive
at all. The `<div>` and its attribute are dropped on `setContent`, re-selection
finds nothing, and a second signature is appended.

The sanitiser allow-list (`sanitizeHtml.ts:41–52`) is the wrong layer to blame.

### 6.2 A custom node is also wrong — the body *is* the email

A bespoke `signatureBlock` atom holding the HTML in an attribute would survive
the schema, but it serialises to `<signature-block html="&lt;table…&gt;">`. Once
the append at @177 is removed, **that string is the Gmail body**, and Gmail will
not render a custom tag. The editor is fully controlled — `onChange(getHTML())`
(@99) out, `setContent(value)` (@110–113) in — so whatever the node serialises to
is what gets sent, and any `parseHTML`/`renderHTML` pair that is not an exact
inverse also leaves `setContent` firing on every keystroke.

### 6.3 Design: extend the Table node that is already registered

`buildSignatureHtml` emits a `<table>` (`signatureHtml.ts:130`), and `Table` is
already in the schema — registered for this exact purpose
(`RichTextEditor.tsx:71–75`).

1. `Table.extend()` adding one attribute that parses from and renders to
   `data-signature`. Output stays a real `<table data-signature="1">` — ordinary
   email HTML that Gmail renders, and every mail client already handles a table.
2. Selecting a signature inserts, or replaces, the table carrying that attribute
   — one transaction, so re-selecting never duplicates. Selecting none deletes
   it.
3. The attribute, not "the only table in the document", is the discriminator. The
   toolbar exposes no table button, but a paste can introduce one, and deleting
   the admin's pasted table would be a data-loss bug.
4. `wrapSignature`'s divider styles must ride on an attribute the node declares.
   `Table.parseHTML` is only `[{ tag: 'table' }]` and the node defines no `style`
   attribute, so styles moved onto `<table style="…">` are dropped on
   `setContent` — the same failure as the discarded `<div>`, one level down.
   Either declare `style` in `addAttributes` too, or have the signature
   attribute's `renderHTML` emit the divider styles itself.
5. `submit()` no longer appends — the body already carries it.
6. Reopening the dialog reseeds `draft` (`GmailComposeDialog.tsx:132–137`) but
   **not** `signature`. Reset `signature` to `null` there too, or a reopened
   dialog shows a signature selected that the reseeded body no longer contains
   and — with the append removed — sends without one.
7. Update the now-stale comment at @378–383 documenting the old design.

Trade-off, stated plainly: the admin can now delete the signature before sending.
That is what "shown in the message body" means, and it is what was asked for.

---

## Task 7 — Reports tenant name follows the UI language

`/admin/reports` renders **client-side** from `useReportPreview` — PostgREST
queries in the browser. Client fix, no migration.

`tenants` has `name` (Arabic, always present) and `name_en` (optional).
`src/lib/tenantDisplayName.ts` already encodes the rule; the hook selects only
`name`, which is why English shows Arabic.

Fix in every report that surfaces a tenant:

- `payment_report` → `tenant`
- `overdue_aging` → `tenant` (the `code — name` composite)
- `tenant_report` / `tenant_status` → `name`

Three things that must move together, or the fix is half-done:

1. **`locale` joins the React Query `queryKey`**, or switching language serves
   the cached Arabic rows.
2. **`fetchReportExport` shares `fetchReportRows`** — same locale, or the CSV
   contradicts the screen.
3. **Search must match what the user can see.** `useReportPreview.ts:254` filters
   `code.ilike,name.ilike,email.ilike` — Arabic `name` only. `name_en` joins that
   `or()`, and `overdue_aging`'s post-join text filter runs against the resolved
   name.

### 7.1 Explicitly out of scope

**Scheduled/emailed reports are not fixed by this.** They render server-side
through the `build_scheduled_report_html` RPC (`src/fns/runReportSchedule.ts:48`),
out of the client hook's reach. Making those bilingual needs a SQL migration to
that function — a schema change with its own deploy sequencing.

The owner's request named the `/admin/reports` screen, so that is what this
delivers. Flagged rather than silently omitted; say the word and it becomes its
own migration.

---

## Task 8 — Occupied-unit badge, and the flashing warning

### 8.1 Badge

No schema change. `useUnitsActiveContracts(unitIds, excludeContractId)`
(`useContracts.ts:385`) already returns `Map<unitId, Contract>` for non-terminal
contracts. It is called with the **selected** ids; call it with the units of the
**selected properties** (`aggregateUnitsForProperties(units, propertyIds)`) so
every occupied option can be badged, and derive the existing conflict check by
intersecting that map with the selected ids — the save guard's behaviour must not
change.

**Replace `conflicts` wholesale, do not intersect at some call sites.** The one
query today feeds all three of the save guard (@450), the banner (@1144) and the
submit-disable (@1162). The intersected map must become *the* `conflicts` value
those three read. Intersecting only at @450 and @1162 would leave the banner
reporting a vacant unit's occupied sibling, and disable Save for a property the
operator legitimately picked.

**Query the union, not just the property's units.** The subset relation
`selectedUnitIds ⊆ aggregateUnitsForProperties(...)` holds for anything the user
clicks — `unitsAfterPropertyChange` (`ContractUnitsField.tsx:51–60`) drops a
unit's row when its property is unchecked — but it does **not** hold by
construction. `aggregateUnitsForProperties` filters the client-side `units` array
(`contractUnits.ts:13–20`), which comes from a *paginated*
`useUnits({ pageSize: 500 })`. A contract whose unit falls outside that page
reopens with a `selectedUnitId` that is not in `availableUnits`, and an
intersection would silently drop its conflict check — turning a robustness tweak
into a missing save guard.

So the id list sent to the hook is `union(propertyUnitIds, selectedUnitIds)`.
Then `occupancy(union) ∩ selected ⊇ occupancy(selected)`: today's guard is
preserved for certain, and the badge still covers every visible option.

**Bound the request.** `useUnitsActiveContracts` does `.in("unit_id", unitIds)`
(@390–393) in a GET query string, and `useUnits` is loaded with `pageSize: 500`
(`admin.contracts.tsx:300`). The set is already narrowed to the selected
properties' units, and this deployment holds ~70 units in total, so the realistic
worst case is a few KB of URL. It is still unbounded by construction, so the id
list is capped behind a named constant with a comment — and **the cap must retain
every selected unit id**. A plain sort-and-slice could drop a selected unit and
silently skip the save guard, turning a robustness tweak into a correctness hole.

`ContractUnitsField` gains `occupiedUnitIds: Set<string>` and renders a
`<Badge variant="destructive">` next to each occupied unit. The unit stays
selectable — the owner asked for the badge *in addition to* the existing error.

New label key in **both** locales.

### 8.2 The flashing red message

Root cause in §2.5; fix in §2.3 — the `createdId` fed to `useUnitsActiveContracts`
as `editing?.id ?? createdId`. Not suppression — the message is correct and
must keep firing for a genuinely occupied unit. What stops is it firing against
the contract's own just-saved rows.

---

## Verification

`bun run test` is **silent** on tasks 1, 3 and 4 — type size, header background,
card layout and the eye overlay are visual. Those get browser verification
against `bun run dev`, and the PR body says so rather than implying the suite
covered them.

Landing-page tabs call native `confirm()` (`landing-page.tsx:568`), which
hard-freezes browser automation. Verify those by reading the DOM and the
database, never by clicking delete.

| Task | Test |
|---|---|
| 2 | create → second save PATCHes, does not INSERT; `editing?.id ?? createdId` is read into one local before use; expense/deposit attachment state clears so a second save does not re-upload |
| 5 | bulk toggle marks every selected id; a mid-list failure is counted, not swallowed |
| 6 | selecting twice yields one `<table data-signature>`; submit does not append; reopen clears the selection; a pasted table survives |
| 7 | English resolves `name_en` and falls back to `name`; locale is in the query key; search matches the resolved name; export agrees with preview |
| 8 | occupied set derives from the selected properties' units; own units excluded when editing; id list capped |

Gates: `bun run lint`, `bun run typecheck`, `bun run test`, then
`clean-code-guard` over the production diff and `test-guard` over the tests.

Two project traps: new i18n strings must land in **both** locales, and
`bun run format` rewrites all markdown — revert `AGENTS.md` / `CLAUDE.md` /
unrelated docs before staging.

## Deploy

No migration; `db/migrations/` untouched, so `ssh-danatfuture-mcp` is not needed.
Merging to `main` auto-deploys via Dokploy — a production deploy, surfaced to the
owner before the merge.
