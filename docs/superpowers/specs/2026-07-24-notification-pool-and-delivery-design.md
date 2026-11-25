# Notification Pool & Invoice Email Delivery Design

**Date:** 2026-07-24  
**Branch:** `feature/admin-ui-improvements`  
**Status:** Approved direction (Approach A) — awaiting user review of this written spec  
**Route:** `/admin/settings/notifications` (Notification Pool tab)

## Goal

1. Make **Send invoice to tenant** and **manual messages** always create durable rows in the Notification Pool and actually attempt SMTP/email delivery when a provider is enabled.
2. Keep the pool as the **single audit surface** for all outbound notifications (email, WhatsApp, manual).
3. Polish the pool UI: **all filters on one horizontal line**, denser animated table, clear status/failure visibility.

## Problem (production findings)

| Finding                         | Detail                                                                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invoice send fails before queue | `sendInvoiceToTenant` sets `template_code` to `invoice-document-ar` / `invoice-document-en`, but those codes are **missing** from `notification_templates`. FK `notifications_template_code_fkey` rejects the insert. No pool row, no email. |
| Pool empty                      | `notifications` had 0 rows after bulk deletes on 2026-07-23; earlier SMTP sends did succeed (state `sent`, provider `smtp`).                                                                                                                 |
| SMTP is on                      | `provider_configs.smtp.is_enabled = true`; Resend off. Env vars `SMTP_*` present on app container. `from_email` column empty → code falls back to `SMTP_FROM`.                                                                               |
| Manual send incomplete rows     | `sendNotification` does not set `recipient_address`, so pool “To” often shows `—` even when delivery uses `tenants.email`.                                                                                                                   |
| Filter layout                   | Pool filters use a multi-column grid (`md:3` / `xl:4` / `2xl:8`) so controls wrap to a second line on typical admin widths.                                                                                                                  |

Target tenant email for re-test after deploy: `lolotam@gmail.com` (e.g. paid invoice `INV-0000143`, Jan 2026).

## Non-goals

- Switching production from SMTP to Resend (ops choice; mutual exclusivity already exists).
- Building a separate route for the pool.
- Redesigning Templates or Providers tabs beyond what the pool tab needs.
- Changing cron / drain job semantics.
- WhatsApp Cloud API template approval at Meta (out of band); seeds only prepare local mapping rows.

## Architecture (unchanged bus)

```
Admin action (invoice send | manual message | automated job)
        │
        ▼
  insert notifications row (state = queued)
        │
        ▼
  dispatchNotificationRecord(id)
        ├── email  → enabled Resend OR SMTP
        └── whatsapp → Cloud API OR Twilio
        ▼
  state: sent | failed | skipped | cancelled
  + write_audit (notification.dispatch)
        ▼
  Notification Pool UI (filters + table)
```

Every successful **insert** must appear in the pool. Delivery success is separate (`state` + `failure_reason`).

## Backend changes

### 1. Seed invoice document templates (migration `42_…`)

Add idempotent rows (mirror style of `32_notification_workflow_seeds.sql`):

| code                  | type            | channel | locale |
| --------------------- | --------------- | ------- | ------ |
| `invoice-document-ar` | `document_send` | `email` | `ar`   |
| `invoice-document-en` | `document_send` | `email` | `en`   |

- Subject/body placeholders may be minimal/static; **runtime body is still produced by** `invoiceDocumentTemplate()` in `sendInvoiceToTenant` and stored on the notification row.
- Rows exist primarily to satisfy FK and to hold future WhatsApp provider mapping columns (migration 38).
- Use `ON CONFLICT (code) DO NOTHING` (or equivalent) for idempotency.
- Respect unique `(type, channel, locale)`: only one `document_send` + `email` + `ar|en` pair; if a conflicting custom row already exists, migration must not break (prefer conflict-safe insert on `code` only when unique allows; if unique on type/channel/locale blocks, document manual resolution — currently prod has **no** `document_send` templates).

### 2. Manual send: complete pool fields

In `src/fns/sendNotification.ts`, when inserting:

- Resolve `recipient_address` from channel:
  - email / both → tenant email (required for email path; if missing and channel needs email, fail with a clear error)
  - whatsapp → tenant whatsapp or mobile
- Keep `template_code` null for free-text; set when a template is chosen.
- Optional: set `audience` explicitly to `tenant`.

No change to permission codes (`notifications.send`).

### 3. Invoice send path

- Keep `sendInvoiceToTenant` template codes and per-channel enqueue via `enqueueNotification`.
- After migration 42 is applied, insert succeeds and dispatch runs immediately (default `dispatch !== false`).
- Surface server errors in the invoices dialog toast (already does); ensure success only after server resolves (already does).
- Prefer returning enough detail for the UI if useful: `{ queued: string[] }` is already returned; no hard requirement to show pool link in v1.

### 4. Query invalidation (light)

- After successful invoice send in `admin.invoices.tsx`, invalidate React Query key `["notifications"]` so the pool is fresh if the admin navigates there without a full reload.
- Manual send hook already invalidates notifications if wired; verify `useSendManualNotification` / `sendNotification` success path invalidates `["notifications"]`.

## Pool UI changes

File: `src/routes/admin.settings.notifications.tsx` (pool tab only primarily).

### Filters — one line

- Replace multi-row grid on `CardHeader` with a **single horizontal toolbar**:
  - `flex flex-nowrap items-center gap-2 overflow-x-auto`
  - Compact controls: fixed/min widths on selects and date inputs so they fit one row and scroll horizontally on narrow viewports instead of wrapping.
- Keep all existing filters: search, audience, recipient (to), sender (from), type, channel, state, date from, date to.
- Reset page to 1 on any filter change (already).
- Export button stays near the table (toolbar end or above table), not forced onto a second filter row.

### Table — polish + motion

Keep data columns and actions; improve presentation:

- Sticky table header while scrolling the overflow container.
- Subtle row enter animation (CSS/`animate-in` / short `fade-in` + `slide-in-from-bottom-1` staggered lightly, or a single shared class — avoid heavy libraries).
- Status badges: clearer variants; soft pulse for `queued` only.
- Failure reason: truncated cell + full text via `title` or tooltip.
- Dense but readable cells (mono for addresses / provider id).
- Preserve: row select + bulk delete, retry, cancel, pager, CSV export, RTL via existing i18n layout.

### Accessibility

- Toolbar remains keyboard-scrollable; controls keep labels via placeholders/`aria-label` already used on dates.
- Do not remove sr-only labels on icon actions.

## i18n

- No new product concepts required; reuse existing keys under `notifications.*`, `notificationState.*`, etc.
- Add keys only if new UI chrome needs them (e.g. “Scroll for more filters” is optional YAGNI — horizontal scroll is enough).

## Testing

| Area                 | What                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit / existing      | Extend or add a focused test if invoice enqueue / template code path is testable without live SMTP; keep `dispatchNotification.test.ts` green.                                                                                        |
| Manual after migrate | Apply migration 42 on production; send invoice email for `INV-0000143` (or any paid invoice with tenant email); open pool; expect a `document_send` row with recipient `lolotam@gmail.com` and `sent` or a concrete `failure_reason`. |
| Manual UI            | Confirm filters stay on one scrollable line at ~1280px and ~768px widths; table sticky header works.                                                                                                                                  |
| Gates                | `bun run lint`, `bun run typecheck`, `bun run test` before push.                                                                                                                                                                      |

## Deployment / ops

1. Merge/push branch → Dokploy rebuild.
2. **Apply SQL migration 42** on production Postgres (manual migrations per project rules).
3. Re-send one invoice email; inspect pool row.
4. If `failed` with Gmail `535 BadCredentials`, fix `SMTP_USER` / app password in Dokploy (not a code bug). If `sent` and inbox empty, check spam and SPF/DKIM for the From domain.

## Files expected to change

| Path                                              | Change                                               |
| ------------------------------------------------- | ---------------------------------------------------- |
| `db/migrations/42_invoice_document_templates.sql` | New seed migration                                   |
| `src/fns/sendNotification.ts`                     | Set `recipient_address` (+ audience) on insert       |
| `src/hooks/useSendManualNotification.ts`          | Invalidate notifications query if missing            |
| `src/routes/admin.invoices.tsx`                   | Invalidate `["notifications"]` after successful send |
| `src/routes/admin.settings.notifications.tsx`     | One-line filters + table polish                      |
| Optional: small CSS in component or Tailwind only | Animation classes                                    |

## Success criteria

1. Sending an invoice by email creates a Notification Pool row with `type=document_send`, correct `recipient_address`, and terminal `state` after dispatch.
2. Sending a free-text manual email creates a pool row with non-null `recipient_address` when tenant has email.
3. Pool filters render as a single horizontal line (scroll if needed), not a second wrapped row of “extra” filters.
4. Table feels clearer (status, failure, sticky header, light motion) without losing filters or actions.
5. Lint, typecheck, and tests pass; work is committed and pushed on `feature/admin-ui-improvements`, then merged per user request.

## Out of scope follow-ups

- Set `provider_configs.from_email` in UI for SMTP so From is visible without env inspection.
- Soft-delete / archive for pool instead of hard delete (current bulk delete removes audit trail from the table).
- Dedicated deep-link “View in pool” from invoices after send.
