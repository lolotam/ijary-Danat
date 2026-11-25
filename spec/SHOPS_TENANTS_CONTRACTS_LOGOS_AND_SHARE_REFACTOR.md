# Spec — Shops / Tenants / Contracts Logo Columns, Share Dialog Refactor, Phone Prefix

**Status:** Ready for implementation planning (2026-07-19)
**Owner:** Engineering
**Source request:** Product owner — "Two smaller things I noted but left: normalizePhone won't route a local 8-digit Kuwaiti number through wa.me, and TenantDocumentsManager is 737 lines. Plus: add a first column for the logo image for every shop on the shops list, and a Store Logo field on the add new store form — and apply the same first-column treatment to `/admin/tenants` and `/admin/contracts`."

---

## 1. Problem Statements

### A. WhatsApp share cannot route 8-digit Kuwait numbers

`src/lib/shareDocuments.ts:22-28` strips non-digits but never prepends the country code. A local 8-digit number produces a `wa.me/12345678?…` URL which WhatsApp does not accept. The current code only handles `+96512345678` correctly.

### B. `TenantDocumentsManager.tsx` is 741 lines

The previous spec's own file list called for a separate `TenantDocumentShareDialogs.tsx` that was never created. The share dialog (lines 670-738) plus its 4 useState cells and `openShare` / `sendShare` handlers (lines 118-121, 184-228) are a single-purpose unit and should live in their own file. The manager should remain focused on the documents list, upload row, edit dialog, delete confirmation, and bulk bar.

### C. Shops list has no logo column

The brands tab in `src/routes/admin.settings.landing-page.tsx` renders columns `Name | Slug | Hours | Featured | Actions`. Every brand has a `logo_media_id` already returned by `useLandingBrands`, but it is never displayed. The Add New Store dialog already has a "Store Logo (upload or URL)" field — the missing surface is the list itself.

### D. Tenants list has no avatar column

`src/routes/admin.tenants.index.tsx` (and the underlying tenant list view) shows only `Name | Code | Lifecycle | …` — no visual identity. Admins scanning the list have no quick way to associate a row with a face.

### E. Contracts list has no shop column

`src/routes/admin.contracts.tsx` lists contracts by `Code | Tenant | Unit | …`. A contract can be linked to a storefront brand via `commercial_brands.contract_id` (the `useLinkedBrand` hook already does this lookup one at a time) but the list view never shows the brand logo, so staff have to drill in to know which shop occupies a unit.

---

## 2. Confirmed Decisions

| Decision                     | Choice                                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone rule                   | Hard-validate — accept only `+965` + 8 digits or bare 8 digits. Block the share button with an inline error otherwise.                                                             |
| Share dialog scope           | Only the share dialog moves out of `TenantDocumentsManager`. Edit dialog stays.                                                                                                    |
| Tenant avatar source         | Reuse `landing_media` with a new permitted category `'tenant_avatar'` and a new FK `tenants.avatar_media_id`.                                                                      |
| Tenant avatar workflow       | Show the control only while editing an existing tenant. Create the tenant first, then edit it to attach an avatar; this avoids orphaned media records from an unsaved create form. |
| Contracts logo source        | `useContracts` fetches linked active brands in one batched query through a private non-hook helper.                                                                                |
| Multiple brands per contract | Display the active brand with the lowest `display_order`; use its logo.                                                                                                            |
| Thumbnail size               | `h-10 w-16 object-cover rounded border bg-muted/30` (16:9 thumbnail) — uniform across all three lists.                                                                             |
| Fallback                     | Initials badge (tenants) or `Building` lucide icon (shops, contracts, missing brand) when no logo is set.                                                                          |
| Migration                    | New `db/migrations/30_tenant_avatar.sql` (idempotent).                                                                                                                             |

---

## 3. Root Cause Notes (from exploration)

### A. Phone prefix

`normalizePhone` knows nothing about country codes. The function is private to `shareDocuments.ts` and has no other call site. `buildWhatsAppUrl` removes a leading `+` from the result, so the only missing piece is the 8-digit prepending and validation.

### B. Share dialog extraction

`TenantDocumentsManager` has the following internal structure (approximate line ranges):

- 1-100: imports + types + props
- 101-141: state declarations + memoized selected docs
- 142-263: handlers (`handleUpload`, `handleDownload`, `handleDownloadZip`, `openShare`, `sendShare`, `openEdit`, `saveEdit`, `confirmDelete`)
- 264-450: render helpers (upload row, card view, records view, bulk bar)
- 451-573: main return (header, badges, tabs)
- 574-647: edit dialog
- 648-668: preview + delete dialog
- 669-738: share dialog (the bit that moves out)

The share state is only consumed by the dialog + the bulk-bar share buttons. A single `useShareDialogState()` hook in the new dialog module will own the state and share submission logic; the manager will only open the dialog and render it.

### C / D / E. Logo columns

- `commercial_brands.logo_media_id` already returns the storage_path via the existing `useLandingBrands` select. No new join needed for shops.
- `tenants` has no `avatar_media_id` column. The migration adds one nullable FK and extends the existing `landing_media` category constraint to permit `'tenant_avatar'`.
- `contracts → commercial_brands` is a back-link (`commercial_brands.contract_id = contracts.id`). For the list view, query all active brands for the page's contract IDs once, order by `display_order`, and retain the first brand for each contract.

---

## 4. Implementation Plan

### Workstream A — Phone prefix (`src/lib/shareDocuments.ts`)

1. Change `normalizePhone` to return a tagged result:
   - `{ ok: true, digits: "96512345678" }` when input matches `+965` + 8 digits or 8 digits.
   - `{ ok: false, error: "Invalid Kuwait phone — use +965 8 digits or 8 digits only" }` otherwise.
2. Update `buildWhatsAppUrl` to throw the tagged validation error on `!result.ok`; it must not return a malformed URL.
3. Surface that error in the share dialog as an inline `<p className="text-xs text-destructive">` and do not call `window.open`. Clear the inline error when the recipient input changes or the dialog closes.
4. Extend `src/lib/shareDocuments.test.ts`:
   - `+965 1234-5678` → `https://wa.me/96512345678?…`
   - `12345678` → `https://wa.me/96512345678?…`
   - `+971…` / `1234567` / `1234567890` → `buildWhatsAppUrl` throws the Kuwait phone validation error
   - existing tests for `mailto` unchanged
5. Perform the manual browser regression check because the current test stack has no React DOM test harness: enter `+971…`, submit, confirm the inline error appears, and confirm no new tab opens.

### Workstream B — Share dialog extraction

#### B1. New module `src/components/admin/TenantDocumentShareDialogs.tsx`

- Export `useShareDialogState()`, which exclusively owns `shareOpen`, `shareRecipient`, `shareSubject`, `shareBusy`, and the inline phone-validation error.
- The hook receives the selected documents, tenant contact values, and resolved i18n labels. It exposes `openShare(channel)`, close/input setters, and `sendShare()`; `sendShare()` resolves links, builds the URL, opens it only on success, and retains phone-validation errors for the dialog.

#### B2. Dialog component in the same module

- Export `<TenantDocumentShareDialogs />`, the single source of truth for the markup currently at `TenantDocumentsManager.tsx:670-738`. It receives only the hook state and actions; it does not receive a competing `onSend` callback.

#### B3. Slim down `src/components/admin/TenantDocumentsManager.tsx`

- Replace the four `useState` calls, `openShare`, and `sendShare` with one `useShareDialogState()` call.
- Remove the share Dialog JSX.
- Import the new component, render it once at the end.
- File target: ≤ 620 lines after extraction (741 - ~118 lines moved out).

### Workstream C — Logo columns

#### C1. Migration `db/migrations/30_tenant_avatar.sql`

```sql
alter table public.landing_media
  drop constraint if exists landing_media_category_check;

alter table public.landing_media
  add constraint landing_media_category_check
  check (category in (
    'exterior', 'interior', 'shops', 'facilities', 'events', 'parking', 'logo', 'tenant_avatar'
  ));

alter table public.tenants
  add column if not exists avatar_media_id uuid
    references public.landing_media(id) on delete set null;

create index if not exists tenants_avatar_media_id_idx
  on public.tenants (avatar_media_id);
```

No RLS changes are required: the existing `landing_media` staff policy permits reads and writes. Extend the `useLandingMedia` category union to include `'tenant_avatar'`.

#### C2. Shops list — `src/routes/admin.settings.landing-page.tsx`

- New first data `<TableHead>` with `t("shops.logo")` (AR + EN).
- New first data `<TableCell>` per brand: `<img src={brand.logo?.storage_path} …/>` with the same h-10 w-16 pattern; `Building` icon fallback. Use `common.logoPlaceholder` as the fallback accessible label.
- No data-layer change — the brand row already carries the joined logo.

#### C3. Tenants list

- Extend `useTenants` in `src/hooks/useTenants.ts` to select `avatar:avatar_media_id ( storage_path )`.
- Add the Avatar column immediately after the selection checkbox and row number, preserving those existing utility columns. The mobile card view remains unchanged.
- New avatar `<TableCell>` per tenant: image with first-character initials fallback (`h-10 w-16 flex items-center justify-center rounded bg-muted text-xs font-semibold` showing the first character of the tenant name).
- Add `useUpdateTenantAvatar` in `src/hooks/useTenants.ts`. It resolves the URL to an existing `landing_media` row or creates one with category `'tenant_avatar'`, then writes only `avatar_media_id` for the existing tenant and invalidates both tenant query keys.
- Add an `ImageSourceInput` block at the top of the edit dialog in `src/routes/admin.tenants.index.tsx` for "Tenant Avatar (upload or URL)" with `bucket="landing"` and `folder="tenants"`. Render it only for an existing tenant, so a failed or cancelled create form cannot leave an unattached `landing_media` row.

#### C4. Contracts list — `src/hooks/useContracts.ts` and `src/routes/admin.contracts.tsx`

- Add a private `fetchActiveBrandsByContractIds()` helper in `useContracts.ts`, not a React hook. It makes one `.in("contract_id", ids)` query for active brands, orders by `display_order`, and returns the first brand for each contract ID.
- Extend `ContractWithRelations` and `useContracts` so each row carries `brandLogoUrl: string | null`, populated by that helper inside the existing query function.
- New first `<TableHead>` with `t("contracts.shop")` and new first `<TableCell>` per contract: image with `Building` icon fallback. Use `common.logoPlaceholder` as the fallback accessible label.

#### C5. i18n additions (`src/i18n/dictionary.ts`)

- `shops.logo` (AR + EN)
- `tenants.avatar` (AR + EN)
- `contracts.shop` (AR + EN)
- `common.logoPlaceholder` (AR + EN)
- `common.phoneInvalidKuwait` (AR + EN) — for the inline error
- `tenants.tenantAvatar` (AR + EN) — the form label "Tenant Avatar (upload or URL)"

### Workstream D — Verification

- `bunx prettier --write` on touched files
- Apply `db/migrations/30_tenant_avatar.sql` to the development database, then `bun run gen:types` to update `src/integrations/supabase/database.types.ts`
- `bun run typecheck` — 0 errors
- `bun run lint` — 0 errors (report pre-existing Fast-Refresh warnings separately)
- `bun run test` — all green (new tests in Workstream A must pass)
- `bun run build:dev` — succeeds
- `graphify update .` — graph reflects the new component split and hooks

---

## 5. Acceptance Criteria

1. WhatsApp share with input `12345678` opens `wa.me/96512345678?text=…` instead of `wa.me/12345678?…`.
2. WhatsApp share with input `+971…` shows an inline error and does not open a tab.
3. `TenantDocumentsManager.tsx` is ≤ 600 lines and renders `<TenantDocumentShareDialogs />` for the share UI.
4. The new file `src/components/admin/TenantDocumentShareDialogs.tsx` exists and exports the dialog component + the single state hook that owns share submission.
5. `/admin/settings/landing-page/shops` shows a logo thumbnail as the first column of every brand row.
6. `/admin/tenants` shows an avatar thumbnail as the first data column after its existing selection and row-number columns, with an initials fallback when no avatar is set.
7. `/admin/contracts` shows the linked brand's logo as the first column of every contract row, with a `Building` icon fallback.
8. The existing-tenant edit dialog has a "Tenant Avatar (upload or URL)" control at the top, wired to `useUpdateTenantAvatar`; the create dialog omits it.
9. All 6 new i18n keys render in both Arabic and English.
10. All verification gates in §4 D pass.

---

## 6. Risks

- **Landing media category constraint**: `tenant_avatar` must be added to the existing database check constraint and frontend category union before avatar media can be created.
- **Batch size for contract brands**: query all brand links for the visible contract IDs once with `.in("contract_id", ids)`; never issue a query per row.
- **Multiple brands per contract**: the schema permits more than one brand link. Order active links by `display_order` and use the first one consistently.
- **WhatsApp on desktop**: `window.open` is fine; same as today's behavior.

---

## 7. File Touch List

### New files

- `db/migrations/30_tenant_avatar.sql`
- `src/components/admin/TenantDocumentShareDialogs.tsx`

### Modified files

- `src/lib/shareDocuments.ts` — replace `normalizePhone`; update `buildWhatsAppUrl`
- `src/lib/shareDocuments.test.ts` — add phone-rule cases
- `src/components/admin/TenantDocumentsManager.tsx` — slim down; import new dialog
- `src/routes/admin.settings.landing-page.tsx` — add first logo column
- `src/routes/admin.tenants.index.tsx` — add first avatar column
- `src/hooks/useTenants.ts` — extend `useTenants` query; add `useUpdateTenantAvatar`
- `src/hooks/useContracts.ts` — extend each row with `brandLogoUrl`
- `src/routes/admin.contracts.tsx` — add first shop column
- `src/hooks/useLandingSettings.ts` — add `tenant_avatar` to the landing-media category union
- `src/i18n/dictionary.ts` — 6 new keys × 2 locales
- `src/integrations/supabase/database.types.ts` — regenerated after the migration

### Out of scope

- Bulk avatar upload, image cropping, multi-image galleries per tenant.
- Removing the legacy `tenants` upload form.
- Public landing page changes (the public `/shops` page already shows logos).
- Avatar selection during tenant creation; create the tenant first, then edit it to attach an avatar.

---

## 8. Out-of-Scope (explicit)

- Multi-tenant avatar crops / focal points.
- Branded email templates (still uses `mailto:`).
- Removing the current `brandDialogOpen` form (kept as-is — it already has the logo field).
- Resizing or compressing uploaded images.
