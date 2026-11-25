# Implementation Plan — Unified Workflows & Recipient Targets

Companion to [`spec/UNIFIED_WORKFLOWS_AND_RECIPIENT_TARGETS.md`](spec/UNIFIED_WORKFLOWS_AND_RECIPIENT_TARGETS.md).
Read the spec's §2 (the two structural facts) before starting any task — both are easy
to get wrong in a way that compiles and passes a naive test.

Branch: `feat/unified-workflows-recipient-targets`.

---

## Task 1 — Migration 75 + types

**Files:** `db/migrations/75_unified_workflow_recipient_targets.sql` (new),
`src/integrations/supabase/database.types.ts`

1. Write the migration exactly as in spec §3.1 — `add column if not exists`, then
   `drop constraint if exists` before `add constraint`. Idempotency matters: this
   migration is applied by hand to the live database, where a retried run must not fail
   on `duplicate_object`.
2. Seed per-key targets per spec §3.2 with `update … where key = …` statements.
3. Add one line to `CronJobRow` (L313-328), alphabetically placed:
   `recipient_targets: WorkflowRecipientTarget[];`. Nothing else — `cron_jobs` uses the
   compact `TableDefinition` encoding, so `Insert`/`Update` derive automatically.

**Do not** run `bun run gen:types`; that file is hand-maintained.

**Done when:** `bun run typecheck` passes and `bun run test:sql` builds a clean database
from `db/migrations/*.sql` without error.

## Task 2 — Catalog, gate, resolver, senders

**Files:** `src/lib/workflowCatalog.ts` (new), `src/fns/workflowRegistry.ts`,
`src/fns/enqueueNotification.ts`, 9 sender files (spec §4.5)

1. Create `WORKFLOW_CATALOG` and `isBuiltInWorkflow` per spec §4.1. Populate the 7
   scheduled keys from the `JOBS` map in `src/fns/cronJobs.ts:25-35`, with the
   `runPermission` and `schedule` values in the spec's table, plus the 9 event keys.
   Set `supportedTargets` from what each sender actually does.
2. Add `readWorkflowGate(key)` to `workflowRegistry.ts`, returning
   `{ paused, targets }` from one `cron_jobs` read. Keep `isWorkflowPaused` exported as
   a thin wrapper — `cronJobs.ts:79` calls it. **Fail open** to
   `{ paused: false, targets: ["admin","company","tenant"] }`.
3. Change `runEventWorkflow`'s `run` to `(targets) => Promise<T>` and pass the gate's
   targets through.
4. Add `resolveNotificationRecipients(targets)` to `enqueueNotification.ts`, built from
   `companyEmail()` and `adminProfileEmails()`. Refactor `getAdminNotificationEmails()`
   to delegate as `resolveNotificationRecipients(["admin","company"])`.
   **Preserve the error asymmetry** (spec §4.3): `companyEmail()` throws,
   `adminProfileEmails()` swallows, and `["admin"]` alone never touches `companies`.
5. Update the 9 senders. **Only tenant blocks get a new guard** — admin/company is
   handled entirely inside the resolver. See spec §2.2 for why
   `if (targets.includes("admin"))` around the admin block is wrong.
6. Update the affected unit tests, including the `vi.mock("@/fns/enqueueNotification")`
   blocks that must now also export `resolveNotificationRecipients`.

**Done when:** `bun run test` passes with new cases covering both tiers.

## Task 3 — Server fns and hooks

**Files:** `src/fns/manageWorkflow.ts` (new), `src/fns/runWorkflowNow.ts` (new),
`src/hooks/useCronJobs.ts`

1. `manageWorkflow.ts` — `createWorkflowFn` / `deleteWorkflowFn` per spec §5.2, using
   `supabaseAdmin` because `cron_jobs` has no INSERT/DELETE policy for `authenticated`.
   Delete refuses built-in keys.
2. `runWorkflowNow.ts` — per spec §5.3. Scheduled keys only, gated on the catalog's
   `runPermission`. `throw new Error(...)`, never `throw new Response(403)`.
3. Add `useSetWorkflowRecipients`, `useCreateWorkflow`, `useDeleteWorkflow`,
   `useTestRunWorkflow` to `useCronJobs.ts`, mirroring `useSetCronJobActive`'s
   permission guard + audit log + query invalidation.

**Done when:** `bun run typecheck && bun run test` pass, including
`runWorkflowNow.test.ts`.

## Task 4 — UI

**Files:** `src/components/admin/RecipientTargetsPicker.tsx` (new),
`src/components/admin/AddWorkflowDialog.tsx` (new),
`src/components/admin/WorkflowTable.tsx`, `src/components/admin/WorkflowsPanel.tsx`,
`src/i18n/dictionary.ts`

1. `RecipientTargetsPicker` per spec §6.1 — disables unsupported targets, refuses to
   clear the last pill.
2. Rewrite `WorkflowTable` as one unified sortable table with the seven columns in spec
   §6.2. Keep the mobile `MobileCardList` branch and the existing status/error rendering.
3. Replace `WorkflowsPanel`'s `Tabs` with the filter toolbar and the "+ Add Workflow"
   button (spec §6.3).
4. `AddWorkflowDialog` per spec §6.4 — RHF + zod, no cron field, explicit "this row is
   not wired to anything" warning.
5. Add every new i18n key to **both** locales; remove the four now-unused
   `workflows.*Tab` / `*Hint` keys from both.

**Done when:** `bun run lint && bun run test` pass — the dictionary parity guard runs in
the test suite.

## Task 5 — SQL tests and docs

**Files:** `src/db/workflowRegistry.sqltest.ts`, `deploy/README.md`

1. Assert the constraint rejects `array['nobody']` and `'{}'`.
2. Assert every seeded row's `recipient_targets` matches spec §3.2.
3. Assert `WORKFLOW_CATALOG` keys ≡ the seeded built-in keys, so the catalog and the
   database cannot drift.
4. Add a line to `deploy/README.md` noting that the crontab block and
   `WORKFLOW_CATALOG[...].schedule` change together.

**Done when:** `bun run test:sql` passes (requires Docker).

---

## Gates

```bash
bun run lint
bun run typecheck
bun run test
bun run test:sql   # Docker required; rebuilds the test database from db/migrations/*.sql
```

## Manual verification

See the spec's §7 plus:

1. All 16 rows in one table; each filter chip narrows correctly; sorting works.
2. Turn the Tenant pill off on `payment-succeeded`, confirm `recipient_targets`
   persisted in the database, then record a payment and confirm **no** `receipt` row was
   queued while the `payment_admin_alert` row was.
3. Run-now on `notification-drain` updates `last_run_at` / `last_status`; the button is
   disabled on every event row.
4. Create `test-not-wired`, confirm the Not-wired badge, disabled Run-now, and enabled
   Delete; delete it; confirm Delete refuses `overdue`.
5. Switch to Arabic and re-check the table, pills, and dialog for RTL and missing keys.

Note: delete buttons in this admin area use native `confirm()`, which hard-freezes
browser automation. Verify step 4 by hand or assert against the database.
