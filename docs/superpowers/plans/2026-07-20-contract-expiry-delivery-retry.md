# Contract Expiry Delivery Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retry contract-expiry deliveries independently without duplicating sent or queued channels.

**Architecture:** The expiry RPC returns contracts throughout each milestone's retry window. The job creates a stable delivery key per audience/channel/recipient/milestone and uses it both to skip completed work and to make concurrent enqueues idempotent. The notifications table has a partial unique index for active expiry deliveries.

**Tech Stack:** PostgreSQL, Supabase JS, TanStack Start, TypeScript, Vitest.

---

### Task 1: Contract Expiry Retry Schema

**Files:**

- Modify: `db/migrations/33_contract_expiry_retry_failed.sql`
- Modify: `src/integrations/supabase/database.types.ts`

- [ ] **Step 1: Extend the migration**

Add `delivery_key text` to `public.notifications` and a partial unique index that applies only to queued and sent contract-expiry rows:

```sql
alter table public.notifications add column if not exists delivery_key text;

create unique index if not exists notifications_contract_expiry_delivery_idx
  on public.notifications(delivery_key)
  where type = 'contract_expiry'
    and state in ('queued', 'sent')
    and delivery_key is not null;
```

Replace exact-date expiry predicates with retry windows: `4m` through `1m` remain eligible until the next milestone, and `7d` remains eligible through the end date. Remove the global notification `not exists` filters because delivery-level deduplication moves into application code.

- [ ] **Step 2: Update generated database types**

Add `delivery_key: string | null` to `NotificationRow` and the matching `Tables` aliases so notification inserts can include the stable key.

### Task 2: Delivery-Level Job Logic

**Files:**

- Modify: `src/fns/enqueueNotification.ts`
- Modify: `src/fns/contractExpiryJob.ts`

- [ ] **Step 1: Write failing tests**

Create `src/fns/contractExpiryJob.test.ts` with one test proving an existing sent admin-email delivery does not prevent a failed tenant-email delivery from being enqueued, and a second test proving a sent tenant-email delivery is not duplicated.

- [ ] **Step 2: Run the focused test**

Run: `bun run test src/fns/contractExpiryJob.test.ts`

Expected: failure because per-delivery completion and delivery keys do not exist.

- [ ] **Step 3: Add idempotent enqueue recovery**

Add an optional `deliveryKey` to `EnqueueNotificationInput`. On a unique-index conflict, fetch and return the existing queued or sent notification with the same key rather than failing the cron run.

- [ ] **Step 4: Add delivery completion checks**

In `runContractExpiryJob`, load sent and queued expiry notifications for each candidate milestone. Before each tenant email, tenant WhatsApp, and admin email enqueue, skip only an existing row with the same audience, channel, recipient address, and milestone. Pass a stable delivery key to each enqueue.

- [ ] **Step 5: Run focused tests**

Run: `bun run test src/fns/contractExpiryJob.test.ts`

Expected: pass with no duplicate enqueue for a completed delivery and a retry for the failed independent delivery.

### Task 3: Documentation And Release Validation

**Files:**

- Modify: `deploy/README.md`
- Modify: `docs/HANDOFF_NOTIFICATION_WORKFLOWS_2026-07-20.md`
- Modify: `spec/AUTOMATED_NOTIFICATION_WORKFLOWS.md`

- [ ] **Step 1: Update retry documentation**

Document the per-delivery identity and milestone retry windows. Mark migration 33 as mandatory before enabling the contract-expiry cron.

- [ ] **Step 2: Run all checks**

Run:

```bash
bun run test
bun run typecheck
bun run lint
bun run build
git diff --check
```

- [ ] **Step 3: Deploy and smoke-test**

Push the commit, redeploy `danatkuwait-danatkuwait-puktku`, then call all four jobs through `/usr/local/sbin/danat-cron` and verify each returns JSON success.
