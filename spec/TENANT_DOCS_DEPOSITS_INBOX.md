# Spec — Tenant Documents, Deposit Attachments, Inbox Bug, Nav Reorder

**Status:** Approved (2026-07-19)
**Owner:** Engineering
**Source request:** Multi-feature batch from product owner.

---

## 1. Problem Statements

### A. Tenant documents dialog

The "Document" action button on the tenants table currently opens the generic tenant details dialog. It must open a dedicated documents management dialog where admins can:

- Upload all tenant documents (multi-type: civil_id, contract, etc.).
- View already-uploaded documents in both **card** and **records (table)** views.
- **Edit**, **delete**, and **preview** each document.
- A **dedicated page** per tenant containing their documents, with:
  - **Download single** and **download all selected as ZIP**.
  - **Share selected** via WhatsApp (custom number or tenant's WhatsApp) or email (custom address or tenant's email).

### B. Tenant → Admin inbox attachment bug

A tenant portal message sent **with an attachment** does not reach the admin inbox. Messages without attachments work fine.

### C. Admin navigation order

The **Inbox** item is currently position 3 in the primary nav. Move it down so it sits **right before the end title** group (the bottom "settings" group, which the user refers to as the company list).

### D. Deposit attachment delete + preview

- Cannot delete the attached receipt when editing a deposit (so it can be replaced with a different one).
- When editing, the attached file must be visible with a **preview** and a **file-type placeholder** (PDF icon vs. image thumbnail).

---

## 2. Confirmed Decisions

| Decision              | Choice                                                         |
| --------------------- | -------------------------------------------------------------- |
| Docs page route       | `/admin/tenants/$id/documents` (new TanStack file route)       |
| Sharing delivery      | `wa.me` + `mailto:` links now (provider integration later)     |
| ZIP library           | Add `jszip` + `file-saver`                                     |
| Deposit delete signal | Discriminated union `{ mode: "keep" \| "clear" \| "replace" }` |

---

## 3. Root Causes (from exploration)

### B. Inbox attachment bug

- **Code path:** `TenantMessageForm.submit` → `useSendTenantMessage.mutateAsync` →
  1. Build path `${tenantId}/${uuid}.${ext}` (`useTenantMessages.ts:64-71`)
  2. `supabase.storage.from("tenant-messages").upload(path, file)` (`useTenantMessages.ts:74-77`)
  3. `supabase.from("tenant_messages").insert({...})` (`useTenantMessages.ts:80-90`)
- **Failure point:** Storage INSERT RLS at `db/migrations/22_batch_features.sql:117-125` requires `profiles.tenant_id IS NOT NULL`. Staff previewing the portal have `tenant_id = null` → upload throws at step 2 → insert at step 3 never runs → no row appears in inbox.
- **Admin inbox has no filter** that excludes attachment messages (`useTenantMessages.ts:19-22` is `select("*")`).

### D. Deposit attachment delete

- `UpdateDepositInput['attachment']: File | null` cannot represent the "delete the existing receipt" intent (`useDeposits.ts:20-27`).
- `useUpdateDeposit` only branches on `if (attachment)` (`useDeposits.ts:179-189`) — null/undefined always preserve the existing path.
- Edit dialog has no remove button (`admin.deposits.tsx:461-477`).
- Uncontrolled file input — once a new file is selected, it cannot be deselected in-session.

---

## 4. Implementation Plan

### Workstream A — Tenant Documents

#### A1. Hook additions — `src/hooks/useTenants.ts`

- Add `useUpdateTenantDocument()` — modeled on `useUpdateDeposit`. Accepts `{ id, mode: "keep"|"clear"|"replace", file?, displayName?, type? }`. On replace: upload new → update row → remove old. On clear: set storage_path=null + remove file.
- Add `useTenantDocumentSignedUrl(path, download?)` — wraps `supabase.storage.from("tenant-documents").createSignedUrl(path, 300, ...)`.
- Add 10 MB + PDF/image validation to `useUploadTenantDocument` (mirror `useDeposits.ts:53-58`).

#### A2. Shared components

- `src/components/admin/FileTypeIcon.tsx` — renders Lucide icon by mime/extension (PDF → `FileText`, image → `Image`, default → `File`). Props: `{ mimeType?: string|null; path?: string; className? }`.
- `src/components/admin/AttachmentPreviewDialog.tsx` — accepts `{ bucket, path, name }`. Fetches signed URL on open. Renders `<iframe>` for PDF paths, `<img>` for images, file-type icon otherwise. Slots for footer actions (Download, Delete). Replaces duplicated preview code in `admin.deposits.tsx:494-532`.

#### A3. `<TenantDocumentsManager>` component

Extract to `src/components/admin/TenantDocumentsManager.tsx`. Props: `{ tenantId, companyId, tenant? }` (tenant optional — when present, shows share actions with tenant phone/email pre-fill).

- Tabs: **Card view** / **Records view**.
- Card view: grid; each card has preview thumbnail, name, type badge, size, date, action dropdown.
- Records view: table with columns # / Name / Type / Size / Date / Actions.
- Actions per document: Preview, Edit, Delete, Download.
- Upload row/dialog with multi-type selector (`TenantDocumentType`).
- Edit dialog: pre-fill name/type, optional file replace via union signal.

#### A4. New route `src/routes/admin.tenants.$id.documents.tsx`

- `createFileRoute("/admin/tenants/$id/documents")({ component: TenantDocumentsPage })`.
- Header: back link to tenant, tenant name, totals (count + size).
- Selection state `Set<string>`; bulk toolbar appears when count > 0.
- Bulk actions: Download ZIP, Share WhatsApp, Share Email, Clear selection.
- Share dialogs: pre-fill from `tenant.mobile` / `tenant.email` with override input.

#### A5. Wire documents button

In `src/routes/admin.tenants.index.tsx:367-370` and `:495-498`, change `TableActionButton action="documents"` onClick to `navigate({ to: "/admin/tenants/$id/documents", params: { id: tenant.id } })`.

#### A6. Sharing + ZIP helpers

- `src/lib/shareDocuments.ts` — `buildWhatsAppUrl(phone, docLinks)`, `buildMailtoUrl(email, subject, docLinks)`. Signed URLs 5-min expiry — UI warns recipient must open within window.
- `src/lib/downloadZip.ts` — `downloadTenantDocumentsZip(tenantId, docs[])`. Fetch signed URL → arrayBuffer → zip.file → generateAsync → file-saver.

#### A7. i18n additions (AR + EN)

`documents.cardView`, `documents.recordsView`, `documents.preview`, `documents.download`, `documents.downloadZip`, `documents.downloadSelected`, `documents.share`, `documents.shareWhatsApp`, `documents.shareEmail`, `documents.shareVia`, `documents.expiresIn`, `documents.edit`, `documents.editDescription`, `documents.noDocuments`, `documents.selected`, `documents.clearSelection`, `documents.sendNow`, `documents.customNumber`, `documents.customEmail`, `documents.useTenantContact`, `documents.linksExpireNote`.

### Workstream B — Inbox Attachment Bug

#### B1. New migration `db/migrations/28_tenant_messages_staff_upload.sql`

```sql
-- Allow staff to upload tenant-message attachments while previewing the portal
CREATE POLICY "tenant_messages_attachments_insert_staff"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'tenant-messages'
  AND EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid()
    AND p.is_staff = true
  )
);

-- Ensure staff can also insert tenant_messages rows (preview-send flow)
DROP POLICY IF EXISTS tenant_messages_insert_staff ON tenant_messages;
CREATE POLICY tenant_messages_insert_staff
ON tenant_messages FOR INSERT
TO authenticated
WITH CHECK (
  sender_profile_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = auth.uid() AND p.is_staff = true
  )
);
```

#### B2. Verification

Apply migration → log in as staff → preview tenant portal → send message + attachment → confirm row in `tenant_messages` AND paperclip in `admin.inbox.tsx:163-172`.

### Workstream C — Nav Reorder

#### C1. Edit `src/components/admin/AdminSidebar.tsx`

- Remove `{ key: "admin.inbox", to: "/admin/inbox", icon: Inbox }` from `primary` array (line 58).
- Insert as first entry of `secondary` array (before line 72, before `admin.reports`).

Final `secondary` order: Inbox, Reports, Audit, Settings.

### Workstream D — Deposit Attachment

#### D1. Type refactor — `src/hooks/useDeposits.ts:20-27`

```ts
export type DepositAttachmentInput =
  | { mode: "keep" }
  | { mode: "clear" }
  | { mode: "replace"; file: File };

export type CreateDepositInput = Omit<
  TablesInsert<"deposits">,
  "attachment_path" | "created_at" | "created_by" | "id" | "updated_at"
> & { attachment?: { mode: "replace"; file: File } | null };

export type UpdateDepositInput = Omit<
  TablesUpdate<"deposits">,
  "attachment_path" | "created_at" | "created_by" | "id" | "updated_at"
> & { attachment?: DepositAttachmentInput };
```

#### D2. Update mutation — `useDeposits.ts:171-218`

Branch on `attachment?.mode`:

- `undefined` / `"keep"` → preserve path.
- `"clear"` → set `attachment_path: null`, remove old file from storage.
- `"replace"` → upload new, set new path, remove old.

#### D3. Edit dialog — `admin.deposits.tsx:425-492`

Replace file input block (lines 461-477) with `<DepositAttachmentField>`:

- Existing attachment present: preview card (FileTypeIcon + name + Preview eye + Remove trash).
- No attachment: drop zone / file picker.
- New file selected: local `URL.createObjectURL(file)` thumbnail + Cancel selection.
- Reset input ref value on Remove / Cancel.

#### D4. Preview dialog — `admin.deposits.tsx:494-532`

- Add "Delete attachment" button next to Download — calls `useUpdateDeposit` with `{mode:"clear"}`, closes preview.
- Refactor to use shared `<AttachmentPreviewDialog>`.

#### D5. i18n additions

`deposits.attachment`, `deposits.attachmentPreview`, `deposits.removeAttachment`, `deposits.removeAttachmentConfirm`, `deposits.noAttachment`, `deposits.newAttachmentSelected`, `deposits.cancelSelection`, `deposits.replaceAttachment`.

---

## 5. Acceptance Criteria

| WS  | Criterion                                                                                        |
| --- | ------------------------------------------------------------------------------------------------ |
| A   | Documents button navigates to `/admin/tenants/$id/documents`.                                    |
| A   | Page shows card + records views; per-doc preview/edit/delete/download work.                      |
| A   | Multi-select + "Download ZIP" produces a valid .zip with all selected files.                     |
| A   | Share WhatsApp opens `wa.me` with selected doc URLs pre-filled; pre-fill uses tenant's mobile.   |
| A   | Share Email opens `mailto:` with selected doc URLs in body; pre-fill uses tenant's email.        |
| A   | Edit dialog supports name/type edit + optional file replace.                                     |
| B   | Staff can preview-send a tenant portal message with attachment; row appears in admin inbox.      |
| C   | Inbox appears at top of bottom nav group, not at position 3 of primary group.                    |
| D   | Edit deposit dialog shows preview of existing receipt with PDF/image placeholder.                |
| D   | Clicking Remove detaches the receipt (sets `attachment_path = null`, removes file from storage). |
| D   | New file can be selected, previewed locally, and cancelled before save.                          |
| All | `bun run typecheck` passes.                                                                      |
| All | `bun run lint` passes.                                                                           |

---

## 6. Risks & Callouts

- **Signed-URL expiry on shared links.** Sharing relies on 5-min signed URLs. Recipients must open within window. Future enhancement: server-side share with persistent token.
- **10 MB upload cap** is enforced client-side in JS. Server-side enforcement (storage policy or trigger) should be added as defense-in-depth in a future migration.
- **Nav reorder** changes admin muscle memory. Communicate via release notes.
- **Bucket/table naming asymmetry:** table is `tenant_documents` (underscore), bucket is `tenant-documents` (hyphen). Easy to mistype — keep helper functions centralized.
- **Shared links are unauthenticated (corrected).** An earlier draft of this spec claimed a
  recipient "cannot access it without auth" — that is wrong. `createSignedUrl` mints a
  bearer-token URL that **bypasses RLS by design**: anyone holding the link can fetch the
  file for the full 5-minute window, with no login. The feature works _because_ of this.
  The consequence is that WhatsApp/email sharing forwards civil IDs and other tenant PII
  to whoever holds the link, including via message forwarding. Accepted for now; the
  server-side share token in §8 should replace it before this is used at volume.
- **JSZip bundle weight:** ~120 KB gzipped. Acceptable; lazy-load the helper to keep initial bundle slim.

---

## 7. File Touch List

| Path                                                  | Action                                         |
| ----------------------------------------------------- | ---------------------------------------------- |
| `spec/TENANT_DOCS_DEPOSITS_INBOX.md`                  | **new** (this file)                            |
| `package.json`                                        | add `jszip`, `file-saver`, `@types/file-saver` |
| `src/components/admin/AdminSidebar.tsx`               | move inbox entry                               |
| `db/migrations/28_tenant_messages_staff_upload.sql`   | **new**                                        |
| `src/hooks/useDeposits.ts`                            | type refactor + clear branch                   |
| `src/hooks/useTenants.ts`                             | update + signed URL + validation               |
| `src/components/admin/FileTypeIcon.tsx`               | **new**                                        |
| `src/components/admin/AttachmentPreviewDialog.tsx`    | **new**                                        |
| `src/components/admin/DepositAttachmentField.tsx`     | **new**                                        |
| `src/components/admin/TenantDocumentsManager.tsx`     | **new**                                        |
| `src/components/admin/TenantDocumentShareDialogs.tsx` | **new**                                        |
| `src/lib/shareDocuments.ts`                           | **new**                                        |
| `src/lib/downloadZip.ts`                              | **new**                                        |
| `src/routes/admin.tenants.$id.documents.tsx`          | **new**                                        |
| `src/routes/admin.tenants.index.tsx`                  | wire documents button                          |
| `src/routes/admin.deposits.tsx`                       | use new field + preview refactor               |
| `src/i18n/dictionary.ts`                              | new keys (AR + EN)                             |
| `src/routeTree.gen.ts`                                | auto-regenerated by TanStack plugin            |

---

## 8. Out of Scope (Future)

- Server-side share tokens (persistent access for non-authed recipients).
- Twilio / Resend integration for actual sending.
- OCR / full-text search on tenant documents.
- Storage policy server-side file-size cap.
- Bulk delete + bulk edit on tenant documents page.
