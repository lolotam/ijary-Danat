# S11 — `src/components/admin`: whatsapp, compose, inbox, notifications, electricity, landing-page, backup, properties

**Lines read:** ~9,560 · **Files:** 53 · **Date:** 2026-09-22

`whatsapp/` (22 files, 2749) · `electricity/` (5 files, 1662) · `compose/` (6 files, 1597) ·
`landing-page/` (6 files, 1513) · `backup/` (4 files, 930) · `inbox/` (4 files, 629) ·
`notifications/` (3 files, 531) · `properties/` (3 files, 175).
Largest: `AdminBrandDialog` (588) · `ShopsTable` (543) · `GmailComposeDialog` (533) ·
`ChargesTab` (420) · `RichTextEditor` (399) · `SignatureManager` (390).

**Overall: `whatsapp/` is the model the rest of the repo should copy** — 22 files, 2,749
lines, an average of **125 lines per file**, with the media renderers split one per type
under `messageMedia/`. Nothing in this scope exceeds 588 lines. Two findings, both small.

---

## Findings

### 1 · Medium — `ChargesTab` is a filter bar and a generation wizard sharing one scope

**Where:** `src/components/admin/electricity/ChargesTab.tsx` (420 lines, **12 `useState`**)

Two disjoint sets, distinguishable only by a naming prefix:

| Browsing the charges | Generating new charges |
| --- | --- |
| `search`, `page`, `periodYear`, `periodMonth`, `unitId`, `status`, `ownership` | `generateDialogOpen`, `generateConfirmOpen`, `generationYear`, `generationMonth`, `generationUnitId` |

plus `pendingTransition` for the status change. **Two period selections** live in the same
component — `periodYear/periodMonth` (what you are looking at) and
`generationYear/generationMonth` (what you are about to create) — which is precisely the
kind of pair that gets crossed in an edit.

**Which means:** the densest state-per-line in the repo (12 `useState` in 420 lines), and the
one confusion it invites is "generate charges for the month I am filtering on" — a
money-generating action. `generateElectricityCharges` is idempotent per
`(unit, period)`, so a mistake here is recoverable, which is why this is Medium and not High.

**Fix:** extract `<GenerateChargesDialog>` owning its five pieces of state. `ChargesTab`
keeps the filters and the table. Same shape as S09 #1 and S10 #1.

---

### 2 · Medium — the landing-page components carry a third of the i18n bypass, and one touches Storage directly

**Where:** `landing-page/AdminBrandDialog.tsx` (588 lines, 9 `useState`, **13** inline
bilingual ternaries) · `landing-page/ShopsTable.tsx` (543 lines, **19** ternaries) ·
`landing-page/{GalleryTable,SlidesTable}.tsx` (3 + 2) · plus
`compose/SignatureManager.tsx`, the only file in this scope reaching `supabase` directly

**37 of S06 #1's 306 inline bilingual strings** are in `landing-page/`, on top of the 57 in
`admin.settings.landing-page.tsx` itself. That one feature accounts for **94 of the 306** —
just under a third.

**Which means:** the landing-page feature is where the "inline ternary instead of a
dictionary key" habit actually lives. Fixing S06 #1 for this feature alone removes 31% of the
problem, and these six component files are the natural companions to the route-file work
already described there. `SignatureManager`'s direct Storage access is the one data-layer
exception in 53 files — acceptable for an upload (there is no hook layer for Storage), and
noted only so it is not mistaken for drift later.

**Fix:** treat `landing-page/` (route file + 6 components) as **one unit of work** for S06 #1
and S06 #2 together. Do not split the string migration from the component extraction — both
touch the same lines.

---

## Not reported, and why

- **`whatsapp/` (22 files, 125 lines average)** — nothing to report, and it is worth saying
  why: the message-media renderers are one file per type under `messageMedia/`, the thread,
  list, composer and session controls are separate, and no file exceeds 300 lines. This is
  the decomposition S04 #2, S05 #4 and S06 #2 are asking for, already done, in the same repo.
- **`messageMedia/MediaPdf.tsx:96,107,112`** — three `catch {}`. The two at `:107,112` are
  cleanup guards with Arabic comments explaining that cancelling a task that never started is
  expected — correct. The one at `:96` sets `failed` state and discards the error; it belongs
  to **S08 #1**'s list of ten and is counted there.
- **`RichTextEditor` (399) and `SignatureManager` (390)** — rich-text editing is
  irreducibly stateful; both are one job.
- **`backup/` (4 files, 930)** — `BackupHeroCard`, `BackupList`, and the restore dialogs,
  cleanly separated. The admin gate is enforced server-side (S03), correctly.
- **`notifications/` (3 files)** — `NotificationLogTable` and `NotificationTemplatesTable`
  both use `adminTableSortValues`. Consistent.
- **`properties/` (3 files, 175 lines)** — the smallest and tidiest directory in the tree.

## Test coverage of this scope

Mixed. `whatsapp/` and `landing-page/` carry test files (including `ShopsTable.test.tsx`);
`electricity/` does not, which is the directory finding 1 is in. Neither finding is covered.

**Consequence for Pass 2:** finding 1 is a contained extraction — but `electricity/` has no
tests at all, so verify the generate dialog against the running app and confirm a generated
charge lands on the period you asked for, not the one you were filtering. Finding 2 is
mechanical and the dictionary test verifies it as you go (see S06).

## Ledger entries added

See `LEDGER.md` — `ChargesTab`'s two period selections; the landing-page i18n concentration;
`whatsapp/` recorded as the decomposition model.
