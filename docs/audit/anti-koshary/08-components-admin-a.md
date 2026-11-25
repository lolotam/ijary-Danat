# S08 — `src/components/admin`: root files, A–M

**Lines read:** ~5,900 · **Files:** ~30 · **Date:** 2026-09-22

`AddWorkflowDialog` (232) · `AdminSidebar` (148) · `AssignTenantsDialog` (111) ·
`AttachmentPreviewDialog` (156) · `BudgetDashboard` (292) · `BulkDeleteBar` · `BulkMarkPaidBar` (110) ·
`ContractUnitsField` (236) · `CsvImportDialog` (193) · `DepositAttachmentField` (242) ·
`GeneratedReportPreviewDialog` (152) · `GeneratedReportsTable` (207) · `GmailMessageSheet` (314) ·
`ImageSourceInput` (188) · `InboxBell` (175) · `InvoicePrint` (174) · `InvoiceRowActions` (226) ·
`MarkInvoicePaidDialog` (131) · `MessagePreviewPanel` (283) — plus ~11 smaller files.

**Overall: this directory is the healthiest code in the repo.** Of ~60 root component files,
only 4 exceed 500 lines and only 2 touch `supabase` directly; the median is under 200 lines.
Reusable pieces are genuinely extracted and imported, not copied. One finding.

---

## Findings

### 1 · Medium — every print / PDF / bulk failure discards the reason before anyone can read it

**Where:** `InvoiceRowActions.tsx:106,118,136` · `InvoicePrint.tsx:130` ·
`GeneratedReportPreviewDialog.tsx:103` · `GmailMessageSheet.tsx:111` · `BulkDeleteBar.tsx:50`
— and, in S09's half, `PaymentDocumentPrint.tsx:114,131` and
`ScheduledAndGeneratedReports.tsx:254`. **Ten sites.**

Every one has the same shape:

```ts
} catch {
  toast.error(t("common.pdfFailed"));
}
```

The user *is* told — this is not a silently swallowed error in the usual sense. What is
discarded is the **error object**: no `console.error`, nothing written anywhere. `BulkDeleteBar`
is the sharper case, counting `fail += 1` across a loop and reporting "3 failed" with no
reason retained for any of the three.

**Which means:** when someone reports "the PDF button doesn't work", there is nothing in the
browser console to look at. That is not hypothetical for this codebase — the failure mode is
documented: after a deploy, the hashed lazy chunks behind the PDF, ZIP and Apple-Pay-QR
features 404 for anyone with a tab already open, and it *presents exactly as this toast*.
`staleChunkReload.ts` exists to mitigate it, and when it does not fire, the one artifact that
would name the cause is thrown away at these ten catch sites. The same is true of the
html2canvas raster path, which the repo has had to debug before.

**Fix:** `catch (error) { console.error("[invoice-pdf] …", error); toast.error(…) }` at all
ten. Ten one-line changes, no behaviour change for the user, and the next report of "PDF
failed" becomes answerable from a screenshot of the console.

---

## Not reported, and why

Checked because they are the usual suspects, and **correct** — recorded so later scopes and
Pass 2 do not re-flag them:

- **Reusable pieces are actually reused.** `SendManualMessageDialog` and
  `SendBulkMessageDialog` (S09) already share `MessagePreviewPanel`, `TemplateOptionLabel`
  and `useTenantEligibleTemplates` rather than each carrying a copy. This is the
  counter-example to S04 #4's `FilterSelect`.
- **Only two files touch `supabase` directly** — `AttachmentPreviewDialog.tsx` and
  `ImageSourceInput.tsx`, both for Storage signed-URL / upload work, which is not a query
  and has no hook layer to route through. Correct.
- **`BudgetDashboard` (292), `MessagePreviewPanel` (283), `GmailMessageSheet` (314)** — over
  250 lines but each with ≤4 `useState` and one clear job. Length without the symptoms;
  not a finding.
- **`AdminSidebar` (148)** — the navigation model for the whole admin app in 148 lines.
- **i18n ternaries here are sparse** (1–5 per file, 15 total in A–M) versus 57 and 53 in the
  two route files of S06 #1. Counted into that finding, not re-reported.

## Test coverage of this scope

Component tests exist for several of these (`InvoiceRowActions`, `MessagePreviewPanel`,
`CsvImportDialog` among others). The catch blocks in finding 1 are not asserted — a test
would have to check `console.error` was called, which is the kind of test the repo's
`test-guard` conventions would reasonably reject. Treat finding 1 as verified by reading,
not by test.

**Consequence for Pass 2:** finding 1 is ten additive one-line changes with no behavioural
effect. Safe on the current suite.

## Ledger entries added

See `LEDGER.md` — the discarding catch sites; the shared message-dialog pieces (recorded as
correct).
