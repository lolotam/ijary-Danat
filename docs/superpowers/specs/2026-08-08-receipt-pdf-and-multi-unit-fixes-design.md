# Receipt PDF attachments, receipt detail, and two multi-unit bugs — design

Date: 2026-08-08

Four items, landed together because two of them touch the same receipt document
and the other two are the same defect shape — a UI built before multi-unit
contracts existed, still assuming one unit and one dialog-less action.

None of the four needs a schema change. That is worth stating up front: there is
no migration to apply over SSH ahead of the deploy, so the usual
"apply schema before pushing to `main`" ordering hazard does not apply here.

## 1. Attach the receipt PDF to every payment-succeeded email

### 1.1 Current behaviour

Scheduled reports have carried a PDF attachment since migration 109:
`renderAndStorePdf` renders the report HTML through headless Chromium, uploads
it to the private `report-documents` bucket, and `attachmentPayload` writes
`attachment_bucket` / `attachment_paths` into the notification payload, which
`dispatchNotification.loadAttachments` reads at send time.

Payment receipts carry no attachment. The tenant gets an HTML summary — amount,
date, reference — and nothing they can file, print or forward to an accountant.

Meanwhile `buildPaymentReceiptHtml` already produces a full A4 receipt document
(logo, company, allocations table, bank details, footer) for the tenant portal's
Preview / Print / Download actions. Its own header comment anticipates this:
"Kept in `src/lib` (not a component) so the same bytes can later be reused
server-side for receipt emails if needed."

Migration 109's comment says the bucket holds the PDF "for each emailed report
**and receipt**". The bucket was provisioned for this; only the receipt half was
never wired.

### 1.2 One insertion covers every payment path

The task asks for the receipt on portal/MyFatoorah payments, manually approved
payments, and payment links alike. Those are not four code paths at the point
where the notification is built — they are one:

| Entry point                                                                  | Reaches                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `confirmGatewayPayment` (the callback-inquiry path production actually uses) | → `settleGatewayPayment` → `notifyPaymentSuccess` |
| `respondToMyFatoorahWebhook`                                                 | → `settleGatewayPayment` → `notifyPaymentSuccess` |
| webhook placeholder-adoption branch                                          | → `notifyPaymentSuccess`                          |
| `setInvoicePaid` (manual mark-as-paid)                                       | → `notifyManualPaymentInvoice`                    |

Both `notifyPaymentSuccess` and `notifyManualPaymentInvoice` are thin
`runEventWorkflow` wrappers over the same `enqueuePaymentSuccess`. The
attachment is therefore built **once, inside `enqueuePaymentSuccess`**, and every
path inherits it. Wiring each entry point separately is how one gets missed, and
a missed one is invisible — the same reasoning that put the workflow gate inside
the senders rather than at their call sites.

### 1.3 Where the render goes, and why the placement matters

After **both** the idempotency early-return and the recipient resolution,
because both decide whether anyone receives this at all:

- `enqueuePaymentSuccess` returns early when a prior non-cancelled notification
  already covers this exact payment-id set.
- A workflow aimed at an admin address that is not configured, or a tenant with
  neither an email nor reminders enabled, produces no notification either.

Rendering above either check would spawn a Chromium process and write a storage
object for a mail that is then not sent. This is why `needsReceipt` is hoisted
out of the tenant block: the render needs to know, before it runs, whether
either audience will receive anything.

### 1.4 One PDF per payment, not one per notification

`enqueuePaymentSuccess` handles a _set_ of payment ids — it sums the amounts and
joins the references, because a multi-month payment link settles several invoice
months at once. `buildPaymentReceiptHtml` documents one payment.

So: render one receipt per confirmed payment and attach all of them.
`attachment_paths` is already an array and `loadAttachments` already loops. The
allocations and invoices are already fetched; they are grouped by `payment_id`
and joined to the invoice rows. Only the company row needs a new query.

### 1.5 Failure is a degradation, never an outage

`renderAndStorePdf` returns `null` on a Chromium failure or a failed upload, and
`attachmentPayload(null)` contributes nothing to the payload. The email still
goes out as HTML. This behaviour is inherited unchanged — it is not re-derived,
not wrapped in a throw, and not hand-rolled. Losing an attachment is a
degradation; losing a payment receipt is an outage.

The same rule governs the enclosing call: `enqueuePaymentSuccess` already never
throws into the payment path, and adding a render must not change that.

### 1.6 Storage layout

Reuse `report-documents` under a `payment-receipts/` path prefix. Migration
109's policy is `bucket_id = 'report-documents'` — bucket-scoped, not
path-scoped — so a new prefix needs no policy and no migration. The bucket is
private and readable only by `service_role`; the renderer and the dispatcher
both run server-side with the service key.

Anyone copying this bucket between servers must use `rsync -aX` or
`tar --xattrs`: Supabase Storage keeps each object's content type in POSIX
extended attributes, and a plain copy leaves every file present on disk while
returning HTTP 500 `ENODATA` on read.

### 1.7 WhatsApp

The dispatch pipeline has **no** attachment support for WhatsApp:
`WhatsAppProviderMessage` has no `attachments` field, and a Meta document
message requires an approved template carrying a DOCUMENT header — every
template mapping is currently unset and only SMTP is enabled.

So WhatsApp document delivery is **not implemented here**. What is done is
cheap and makes the later change a provider-only one: the WhatsApp
notification's payload records the rendered PDF under `receipt_pdf_bucket` /
`receipt_pdf_paths`, so the document is already associated with the message and
nothing in the receipt path needs revisiting when document support lands.

Those key names are deliberate, and **not** the `attachment_*` pair the emails
use. `dispatchNotification` calls `loadAttachments` unconditionally, above the
line where it branches on channel, so `attachment_paths` on a WhatsApp row would
make every WhatsApp receipt download a ~100 KB PDF from Storage, discard it, and
log an attachment-download failure for a channel that cannot carry one. Reusing
a live contract to mark a future intent is how a future intent becomes a
present-day bug.

### 1.8 Recipients

Both the tenant receipt and the admin alert get the attachment, from the same
stored object — one render, two references. An admin answering "what did the
tenant actually receive?" should not have to reconstruct it.

## 2. Payment type and manual reason on the receipt document

Half of this already exists and is deliberately left alone:

- `buildPaymentReceiptHtml` renders a "Payment method" row from
  `payment.method`, and migration 108 made that column truthful — a bank
  transfer records `bank_transfer`, a cheque records `cheque`, instead of every
  manual settlement being stamped `cash`.
- The **email body** already renders a conditional "Reason of manual payment"
  row via `manualReasonListItem`, in both the receipt and the admin alert, and
  `notifyPaymentSuccess` already resolves the catalog slug to its Arabic or
  English label through `resolveManualPaymentReasonLabel`.

What is missing is the reason on the **receipt document** — the thing that
becomes the PDF. `buildPaymentReceiptHtml` gains an optional
`manualPaymentReason?: string | null` parameter and renders one more row beside
the method, only when a reason is present. Optional so that the tenant portal's
existing Preview / Print / Download calls compile and behave exactly as before.

**Known inconsistency, stated rather than hidden:** the portal's own downloaded
receipt will continue to show no reason. The portal has no client-side
equivalent of `resolveManualPaymentReasonLabel`, so it holds the raw catalog
slug, and rendering `audit_adjustment` to a tenant is worse than rendering
nothing. Resolving labels on the portal path is a separate change.

Gateway payments have no manual reason, so their receipts are unchanged — a
card payer must not see a reason row inviting them to ask what went wrong when
nothing did.

## 3. Mark-as-paid fails on the tenant detail page

### 3.1 The defect

Marking an invoice paid from Tenant detail → Monthly invoices → Actions returns:

```
[{ "code": "custom",
   "message": "A manual payment reason is required when marking an invoice paid.",
   "path": ["manualPaymentReason"] }]
```

`setInvoicePaidSchema` refines that a reason must be present whenever
`paid: true`. `admin.invoices.tsx` satisfies it by opening
`MarkInvoicePaidDialog` and passing the chosen reason. `InvoiceRowsTable`
— the same action column on the tenant detail page — still calls the server
function directly with `{ invoiceId, paid }` and no reason. It was written
before the dialog existed and was never updated when the reason became
mandatory.

The validator is correct and stays: it exists precisely so the reason cannot be
skipped by calling the server function directly.

### 3.2 The fix

`InvoiceRowsTable` opens `MarkInvoicePaidDialog` before marking paid, exactly as
`admin.invoices.tsx` does, and forwards the selected reason. Un-marking stays a
direct call — the schema only requires a reason when `paid` is true, and asking
for one to undo a mistake would imply the reversal is itself an accounting
event.

### 3.3 What this deliberately does not do

The two pages have two separate action-column implementations, and unifying them
is not part of this fix. `admin.invoices.tsx` is ~1470 lines and is already
flagged for splitting when next substantially touched; folding a second table's
actions into it is a refactor with its own risk, not a bug fix.

## 4. The tenants list shows one unit per contract

### 4.1 The defect

`useTenants.attachActiveLocations` builds one `TenantActiveLocation` per active
contract and resolves **the first unit only**:

```ts
const contractUnit = unitById.get(contract.unit_ids[0] ?? "") ?? null;
```

`connectedProperties` then derives from those single units. A contract covering
three units shows one; a contract whose units span two buildings shows one
building. The tenant detail page renders every unit through `UnitsCell` /
`PropertiesCell`, so the two screens disagree about the same contract.

The rendering is not at fault — the shape it is handed cannot express more than
one unit.

### 4.2 The fix

`TenantActiveLocation` gains:

- `units: Tables<"units">[]` — every unit on the contract, in `line_order`.
- `properties: Tables<"properties">[]` — the distinct buildings those units are
  in, deduped.

`unit` and `property` stay, as the primary (first by `line_order`). They are not
redundant: the list **sorts** on `connectingUnit` / `connectedProperty`, and a
sort key that is an array has no meaning. `connectedProperties` is recomputed
from the new per-contract `properties` rather than from the primary unit.

Rendering keeps one row per contract, with several units stacked inside the
contract's cell — matching `UnitsCell` on the detail page, and keeping contract
code, dates and state aligned with the units they belong to. One row per unit
would duplicate the contract columns down the page.

CSV export lists every unit rather than the first, since an export that silently
drops units is a worse failure than a crowded cell.

## 5. Files

| File                                                      | Change                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| `src/lib/paymentReceiptHtml.ts`                           | Optional `manualPaymentReason` → conditional row            |
| `src/lib/paymentReceiptPdf.ts`                            | New — shape rows, render, store under `payment-receipts/`   |
| `src/fns/notifyPaymentSuccess.ts`                         | Company query; render after idempotency; spread attachments |
| `src/components/admin/tenant-detail/InvoiceRowsTable.tsx` | `MarkInvoicePaidDialog` wiring                              |
| `src/hooks/useTenants.ts`                                 | `units[]` / `properties[]` on `TenantActiveLocation`        |
| `src/routes/admin.tenants.index.tsx`                      | Render every unit and property; CSV lists all units         |

No migration. No `database.types.ts` change — no new table, column or RPC.

## 6. Testing

- **Unit** — the reason row appears in the receipt document only when a reason
  is given, and never for a gateway payment; the receipt PDF path is spread into
  the tenant, admin and WhatsApp payloads; a `null` render leaves the payload
  without attachment keys and the notification is still enqueued; a duplicate
  notify renders nothing.
- **Unit** — one PDF per payment for a multi-payment settlement.
- **Unit** — `attachActiveLocations` returns every unit of a multi-unit
  contract and every distinct building across them, and `connectingUnit`
  remains the first by `line_order`.
- **Component/manual** — `InvoiceRowsTable` mark-as-paid submits the chosen
  reason and un-marking sends none.
- **i18n** — any new key lands in both locales; `dictionary.test.ts` fails the
  build otherwise.
- **Verification in the running app** — mark-as-paid from the tenant detail page
  (Radix dialog, safe for browser automation), then confirm against the
  database and storage that the notification payload carries
  `attachment_paths`, that the object exists, and — by **opening the rendered
  PDF** — that the logo, the Arabic shaping, the method row and the reason row
  are all really there. Chromium prints a page whether or not an `<img>`
  loaded, so a missing logo fails silently and looks identical to success.

## 7. Out of scope

- WhatsApp document delivery (needs Meta media upload and an approved
  DOCUMENT-header template; no template is currently mapped).
- Resolving manual-reason labels on the tenant portal so its own downloaded
  receipt shows the reason.
- Unifying the two invoice action columns, and the `admin.invoices.tsx` split.
- Backfilling receipts for payments confirmed before this change.
