# S09 — `src/components/admin`: root files, N–Z

**Lines read:** ~5,850 · **Files:** ~30 · **Date:** 2026-09-22

`TenantDocumentsManager` (680) · `ScheduledAndGeneratedReports` (597) · `PaymentSidePanels` (513) ·
`SendManualMessageDialog` (502) · `WorkflowTable` (444) · `TemplateEditorDialog` (371) ·
`Phase2FormFields` (345) · `ownedPageKpis` (335) · `UnitFormDialog` (333) ·
`SendBulkMessageDialog` (323) · `RecordPanelTable` (319) · `RecordPanelDialog` (278) ·
`TenantDocumentShareDialogs` (254) · `ProviderConfigCard` (196) · `PaymentFiltersBar` (193) ·
`PaymentDocumentPrint` (177) · `WorkflowsPanel` (161) · `ScheduledReportsTable` (150) ·
`TenantMultiSelect` (127) · `TenantPicker` (110) — plus ~10 smaller files.

**Overall:** same picture as S08 — mostly well-sized, well-factored components. Two files do
two jobs each; one of them says so in its own name.

---

## Findings

### 1 · Medium — `ScheduledAndGeneratedReports` is two screens in one component, and its name admits it

**Where:** `src/components/admin/ScheduledAndGeneratedReports.tsx:78-597` (**519 lines**,
**12 `useState`**)

The state comes in two disjoint sets that never interact:

| Schedules | Generated reports |
| --- | --- |
| `scheduleSearch`, `schedulePage` | `generatedSearch`, `generatedPage` |
| `scheduleOpen`, `scheduleTarget`, `scheduleDelete`, `scheduleDraft`, `extraEmailInput` | `selectedGenerated`, `generatedDelete`, `previewReport` |

Two searches, two paginations, two delete targets, two tables. The components they render —
`ScheduledReportsTable` (150) and `GeneratedReportsTable` (207) — are **already extracted**;
what remains in this file is two independent controllers sharing one scope.

**Which means:** changing the schedule editor means reading past the generated-report
selection logic to be sure `page`, `search` and `delete` refer to the half you intended —
the two sets are distinguished only by a prefix on the variable name. It is also where one
of S08 #1's ten error-discarding catches lives (`:254`).

**Fix:** split into `ScheduledReportsPanel` and `GeneratedReportsPanel`, each owning its own
six-or-fewer pieces of state, with a thin parent rendering both. The tables are already
separate, so this is moving state and JSX, not restructuring. Low risk, obvious seam.

---

### 2 · Medium — `TenantDocumentsManager` at 680 lines is the largest component outside `src/routes`

**Where:** `src/components/admin/TenantDocumentsManager.tsx:126-680` (**554 lines**,
6 `useState`, plus a `useRef` file input)

One component holding: the document list, upload (type + name + file), inline rename/edit,
delete with confirmation, preview, and multi-select with bulk actions. Six features. Its
sibling `TenantDocumentShareDialogs` (254) is already split out, which shows the intended
direction was there.

**Which means:** less acute than finding 1 — the six pieces of state are genuinely one
feature's worth of dialogs over one list — but it is 15% over the repo's file ceiling in a
file whose upload path touches Storage, where the xattr/content-type fragility documented in
`CLAUDE.md` lives. A 554-line component is not where you want that code to be hard to find.

**Fix:** extract `TenantDocumentUploadForm` and `TenantDocumentBulkBar`; keep the list,
preview and delete in the manager. Optional — lower priority than finding 1.

---

## Not reported, and why

- **`PaymentSidePanels.tsx` (513 lines)** — over the file ceiling, but **five** exported
  components (`RecordPanel`, `RefundsPanel`, `PartialPaymentsPanel`, `InsurancePanel`) plus a
  shared `useContractDirectory` hook. Correctly decomposed; the file is long because it holds
  a family, which is what the ceiling rule explicitly permits ("things that change together
  stay together"). Not a finding.
- **`ownedPageKpis.tsx` (335 lines, 0 `useState`)** — a pure list of KPI card definitions.
  Its **18** inline bilingual ternaries are the third-largest concentration in the repo and
  are counted in **S06 #1**; reporting them again here would be padding.
- **`SendManualMessageDialog` (502) / `SendBulkMessageDialog` (323)** — the obvious
  duplication candidate, and they are **already sharing** `MessagePreviewPanel`,
  `TemplateOptionLabel` and `useTenantEligibleTemplates`. What remains different is genuinely
  different (one tenant vs. a selected set). Correct as is.
- **`WorkflowTable.tsx` (444)** — one table, one job, 2 `useState`, and the best docblock in
  the component tree. Its divergent "benign skip reason" list is **S01 #7**, already counted.
- **`RecordPanelDialog` / `RecordPanelTable`** — a dialog and its table, split correctly.
- **`PaymentDocumentPrint.tsx:114,131`** — two of S08 #1's ten discarding catches. Counted
  there.

## Test coverage of this scope

Better than the route scopes: `WorkflowTable`, `PaymentSidePanels`, `TenantMultiSelect`,
`ProviderConfigCard` and several others have test files. Neither finding here is covered —
both are structural, and a split is verified by typecheck plus looking at the screen.

**Consequence for Pass 2:** finding 1 is a contained, low-risk split with the child tables
already extracted. Finding 2 is optional. Neither changes behaviour; both are typecheck-
verifiable and should be eyeballed in the running app.

## Ledger entries added

See `LEDGER.md` — the two-jobs components; `PaymentSidePanels` and the message dialogs
recorded as correctly factored.
