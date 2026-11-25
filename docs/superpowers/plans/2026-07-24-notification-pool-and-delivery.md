# Notification Pool & Invoice Email Delivery Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix invoice email enqueue (missing template seeds), complete manual notification pool rows, and polish the Notification Pool filters/table on one line.

**Architecture:** Keep the existing `notifications` bus. Seed FK-safe template codes; set `recipient_address` on manual insert; compact pool toolbar + light table motion in the settings notifications route.

**Tech Stack:** TanStack Start, Supabase SQL migrations, React Query, Tailwind/shadcn, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-24-notification-pool-and-delivery-design.md`

---

### Task 1: Seed invoice document templates

**Files:**

- Create: `db/migrations/42_invoice_document_templates.sql`

- [ ] Insert `invoice-document-ar` and `invoice-document-en` idempotently (`ON CONFLICT (code) DO NOTHING`).

### Task 2: Manual send recipient_address

**Files:**

- Modify: `src/fns/sendNotification.ts`
- Modify: `src/hooks/useSendManualNotification.ts` (invalidate notifications if needed)

- [ ] Resolve recipient from channel; fail clearly if email required but missing.
- [ ] Invalidate `["notifications"]` on success.

### Task 3: Invoice send cache invalidation

**Files:**

- Modify: `src/routes/admin.invoices.tsx`

- [ ] After successful `sendInvoiceToTenant`, invalidate `["notifications"]`.

### Task 4: Pool UI — one-line filters + table polish

**Files:**

- Modify: `src/routes/admin.settings.notifications.tsx`

- [ ] Single horizontal scrollable filter bar.
- [ ] Sticky header, status pulse for queued, failure tooltip/title, row enter animation.

### Task 5: Gates, commit, push, merge

- [ ] `bun run lint && bun run typecheck && bun run test`
- [ ] Commit, push branch, merge to main (no force-push).

---
