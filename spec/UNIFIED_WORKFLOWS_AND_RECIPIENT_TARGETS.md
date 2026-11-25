# Unified Workflows Table & Recipient Targets — Specification

Status: approved for implementation
Date: 2026-08-03
Route: `/admin/settings/notifications` → **Workflows** tab

> Repo convention for design docs is `docs/superpowers/specs/`. This file lives at
> `spec/` because that path was requested explicitly.

---

## 1. Problem

The Workflows tab splits 16 `cron_jobs` rows across two sub-tabs — "Scheduled jobs"
and "Action trigger workflows" — that render the _same five columns_ through one
shared component (`WorkflowTable.tsx`), differing only in wording. The split costs a
click without adding information.

Neither tab shows who a workflow emails, and nothing lets an admin change it. Today
recipients are hardcoded per sender: `getAdminNotificationEmails()` returns
`companies.email ∪ admin profile emails` as one opaque list, and tenant sends are
unconditional `if (tenant.email)` branches. "Stop CC-ing the company on maintenance
requests" currently requires a code change and a deploy.

## 2. Two structural facts

These constrain everything below. Implementers must read them before writing code.

### 2.1 A `cron_jobs` row is a registry entry, not a runtime

Scheduled jobs execute only because `src/fns/cronJobs.ts` holds a hardcoded `JOBS` map
of 7 keys, dispatched by 7 crontab lines on the production host
(`deploy/README.md:79-87`, installed as `/etc/cron.d/danat-ermp`). Event workflows fire
only because a sender hardcodes its key into `runEventWorkflow`.

**Inserting a row from the UI executes nothing.** The Add-Workflow feature therefore
ships as a _registry-only_ entry with a visible "Not wired" state, an explicit warning
in the dialog, and a disabled Run-now button. This is a deliberate, documented
limitation — not an oversight to be papered over.

### 2.2 Targets gate at two different levels

`notifyPaymentSuccess` enqueues three notifications with **different templates**:

| #   | Template                      | Audience | Channel  |
| --- | ----------------------------- | -------- | -------- |
| 1   | `payment-admin-alert-{ar,en}` | admin    | email    |
| 2   | `receipt-{ar,en}`             | tenant   | email    |
| 3   | `receipt-{ar,en}`             | tenant   | whatsapp |

But `admin` and `company` are **not** separate blocks. `getAdminNotificationEmails()`
merges the company email and the admin profile emails into a single list that feeds a
single notification (`recipientAddress: adminEmails[0]`, `payload.recipients:
adminEmails` — `notifyPaymentSuccess.ts:116-155`). The other six senders share this
shape.

Therefore:

- **`tenant` is block-level.** Un-ticking it suppresses the tenant email _and_ the
  tenant WhatsApp send.

  One exception, deliberate: **credential mail to the account owner is never
  gated.** Sending someone their own login details is account provisioning, not a
  notification preference — suppressing it yields a user who can never sign in,
  with nothing on screen to explain why. So `user-credentials-managerial` exposes
  no tenant pill at all (its recipient is a staff user, not a tenant), and on
  `user-credentials-tenant` the pill gates only the WhatsApp copy of a message
  already sent by email.

- **`admin` / `company` are address-level.** They filter the recipient list inside the
  one admin block. The block runs whenever the filtered list is non-empty.

`resolveNotificationRecipients(targets)` is the **only** place admin/company is
decided. Wrapping the admin block in `if (targets.includes("admin"))` is wrong: it
silently kills the company email whenever `admin` is off and `company` is on.

## 3. Database schema

### 3.1 Migration `db/migrations/75_unified_workflow_recipient_targets.sql`

```sql
alter table public.cron_jobs
  add column if not exists recipient_targets text[] not null
    default array['admin','company']::text[];

-- Idempotent: applied by hand to the live database, where a retried run must not
-- fail on duplicate_object.
alter table public.cron_jobs
  drop constraint if exists cron_jobs_recipient_targets_check;
alter table public.cron_jobs
  add constraint cron_jobs_recipient_targets_check
  check (recipient_targets <@ array['admin','company','tenant']::text[]
         and cardinality(recipient_targets) > 0);
```

**Why the default is `['admin','company']` and not `['admin']`:**
`getAdminNotificationEmails()` already includes `companies.email`. Defaulting to
`admin` alone would silently drop the company from all 16 workflows the moment the
migration lands.

**Why `cardinality > 0`:** prevents an enabled workflow that sends to nobody — a state
that looks healthy in the UI and delivers nothing. Precedent for `cardinality(...)` at
`58_expiry_buckets_and_cron_registry.sql:109-113`.

**No `schedule_expression` column.** Nothing would ever _act_ on it — dispatch is the
host crontab — and it would duplicate `deploy/README.md:79-87` with nothing asserting
the two agree. That is the written-but-never-read defect shape, plus a false affordance
(an admin typing a cron expression for a row that will never fire). The schedule lives
in `WORKFLOW_CATALOG` (§4.1).

### 3.2 Per-key seeding

The same migration seeds each row with **exactly the targets it sends to today**, so
day-one behavior is unchanged and every later change is a deliberate admin action.

| Keys                                                                                                                                    | `recipient_targets`      | Justification                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `payment-succeeded`                                                                                                                     | `admin, company, tenant` | admin alert + tenant receipt + tenant WhatsApp                                          |
| `user-credentials-tenant`                                                                                                               | `admin, company, tenant` | tenant email (ungated) + admin copy; the pill gates only the WhatsApp duplicate         |
| `user-credentials-managerial`                                                                                                           | `admin, company`         | the new staff user's own credential mail always sends, and a staff user is not a tenant |
| `contract-expiry`                                                                                                                       | `admin, company, tenant` | admin digest + tenant emails                                                            |
| `overdue-reminders`                                                                                                                     | `tenant`                 | enqueues only `audience: "tenant"` rows; never calls the admin resolver                 |
| `deposit-confirmed`, `contact-inquiry-received`, `maintenance-request-created`, `refund-recorded`, `contract-created`, `contract-ended` | `admin, company`         | admin-only senders                                                                      |
| `overdue`, `scheduled-reports`, `notification-drain`, `gmail-sync`, `salaries`                                                          | `admin, company`         | column default                                                                          |

### 3.3 RLS — unchanged for the main feature

`db/migrations/58_expiry_buckets_and_cron_registry.sql:142-155` already grants:

- `cron_jobs_staff_read` — SELECT to staff
- `cron_jobs_admin_update` — UPDATE to admins
- `cron_jobs_service_role_all` — ALL to service_role

The recipient pills and the active toggle are UPDATEs, so **no new policy is needed**.
There is deliberately **no INSERT or DELETE policy for `authenticated`**: Add and Delete
go through a `supabaseAdmin` server fn (§5.2) so the built-in-key guard lives in one
place and cannot be bypassed by a direct PostgREST call.

Note: `db/policies/` is **not** applied by the SQL-test harness, which globs
`db/migrations/*.sql`. Any policy change belongs in a migration.

### 3.4 Types

`src/integrations/supabase/database.types.ts` is **hand-maintained** (see its header,
lines 1-12) despite looking generated. `cron_jobs` uses the compact `TableDefinition`
encoding, so this is one alphabetically-placed line in `CronJobRow` (L313-328):

```ts
recipient_targets: WorkflowRecipientTarget[];
```

`Insert` and `Update` derive automatically. Array precedent in the same file:
`provider_param_keys: string[]` (L557) — arrays are non-null `string[]`, matching a SQL
`text[] not null default`. **Never** run `bun run gen:types` over this file.

## 4. Server architecture

### 4.1 `src/lib/workflowCatalog.ts` (new) — single source of truth

```ts
export type WorkflowRecipientTarget = "admin" | "company" | "tenant";

export const WORKFLOW_CATALOG: Record<
  string,
  {
    kind: "scheduled" | "event";
    supportedTargets: WorkflowRecipientTarget[];
    runPermission?: PermissionCode; // scheduled only
    schedule?: string; // scheduled only; mirrors the deployed crontab
  }
>;

export function isBuiltInWorkflow(key: string): boolean;
```

`supportedTargets` records which send blocks a sender actually has, so the UI can
disable a pill that would be a silent no-op (`contact-inquiry-received` has no tenant
block, so its Tenant pill is disabled rather than settable-but-inert).

`runPermission` per scheduled key — every one maps to an existing code in
`src/lib/permissions.ts`:

| key                  | `runPermission`        | `schedule`     |
| -------------------- | ---------------------- | -------------- |
| `overdue`            | `invoices.update`      | `10 1 * * *`   |
| `overdue-reminders`  | `notifications.send`   | `15 1 * * *`   |
| `contract-expiry`    | `notifications.create` | `20 1 * * *`   |
| `scheduled-reports`  | `reports.read`         | `30 1 * * *`   |
| `notification-drain` | `notifications.send`   | `40 1 * * *`   |
| `gmail-sync`         | `notifications.read`   | `*/10 * * * *` |
| `salaries`           | `salaries.create`      | `30 1 1 * *`   |

Plus the 9 event keys (`contact-inquiry-received`, `contract-created`,
`contract-ended`, `deposit-confirmed`, `maintenance-request-created`,
`payment-succeeded`, `refund-recorded`, `user-credentials-managerial`,
`user-credentials-tenant`) with `kind: "event"` and no `runPermission`/`schedule`.

`schedule` is **documentation, not dispatch**. `deploy/README.md` gains a line saying
the crontab and this constant change together.

### 4.2 `src/fns/workflowRegistry.ts` — one gate read

`runEventWorkflow`'s existing doc comment explains why the pause check lives in one
shared gate: "a pause check at each of the five call sites is exactly where one gets
missed, and a missed one is invisible." Recipient targets have identical mechanics, so
they ride the same gate rather than adding a second lookup per sender.

```ts
export async function readWorkflowGate(key: string): Promise<{
  paused: boolean;
  targets: WorkflowRecipientTarget[];
}>;

export async function isWorkflowPaused(key: string): Promise<boolean>; // thin wrapper, kept

export async function runEventWorkflow<T>(options: {
  key: string;
  whenPaused: () => T;
  run: (targets: WorkflowRecipientTarget[]) => Promise<T>; // signature change
  outcomeOf?: (result: T) => { status: WorkflowRunStatus; error: string | null };
}): Promise<T>;
```

`readWorkflowGate` **fails open** — on any error it returns
`{ paused: false, targets: ["admin","company","tenant"] }`. This matches the existing
`isWorkflowPaused` contract: a registry outage must never stop a tenant receiving their
receipt. Observability must not become a single point of failure for the thing it
observes.

`isWorkflowPaused` stays exported because `src/fns/cronJobs.ts:79` calls it directly.

### 4.3 `src/fns/enqueueNotification.ts` — recipient resolution

```ts
export async function resolveNotificationRecipients(
  targets: WorkflowRecipientTarget[],
): Promise<string[]>;

export async function getAdminNotificationEmails(): Promise<string[]>; // preserved
```

Built from two private helpers, `companyEmail()` and `adminProfileEmails()`.
`getAdminNotificationEmails()` is refactored to delegate as
`resolveNotificationRecipients(["admin","company"])` — identical behavior, export kept
because it is mocked in 7 test files.

**The error asymmetry is deliberate and must survive the split.** The current body
(`enqueueNotification.ts:83-111`) _throws_ if the `companies` select errors, but
_swallows_ errors from `user_roles` / `profiles`. So:

- `companyEmail()` keeps the throw.
- `adminProfileEmails()` keeps the swallow.
- `resolveNotificationRecipients(["admin"])` must not query `companies` at all.

Otherwise un-ticking `company` quietly removes an existing failure mode, or leaving it
ticked adds a new one.

Output is deduplicated, lowercased, and filtered to strings containing `@` — unchanged
from today.

### 4.4 Dispatch resolution flow

```
sender (e.g. notifyPaymentSuccess)
  └── runEventWorkflow({ key: "payment-succeeded", ... })
        ├── readWorkflowGate("payment-succeeded")  ── one read of cron_jobs
        │     ├── paused?  → recordWorkflowRun("skipped") → whenPaused()
        │     └── targets: ["admin","company","tenant"]
        └── run(targets)
              ├── admin block
              │     └── resolveNotificationRecipients(targets ∩ {admin, company})
              │           ├── "company" → companies.email          (throws on error)
              │           └── "admin"   → profiles.email where user_roles.role='admin'
              │                                                     (swallows errors)
              │     └── if list non-empty → enqueueNotification({ audience: "admin", ... })
              └── tenant blocks — only if targets.includes("tenant")
                    ├── tenant email receipt  → enqueueNotification({ audience: "tenant", channel: "email" })
                    └── tenant WhatsApp       → enqueueNotification({ audience: "tenant", channel: "whatsapp" })
```

Downstream, `dispatchNotification.ts:194-201` unions `recipient_address`, the tenant
email (when `audience !== "admin"`), and `payload.recipients`. That union is unchanged —
this work decides what gets enqueued, not how a queued row is delivered.

### 4.5 Sender changes

Nine senders. Only the **tenant** blocks gain a guard; admin/company is handled entirely
inside `resolveNotificationRecipients`.

| File                          | Key(s)                                   | Change                                                                                    |
| ----------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `notifyPaymentSuccess.ts`     | `payment-succeeded`                      | admin block L115-155 → resolver; guard tenant email L182-201 and tenant WhatsApp L203-234 |
| `notifyUserCredentials.ts`    | `user-credentials-tenant`, `-managerial` | resolver + tenant guard                                                                   |
| `notifyDepositConfirmed.ts`   | `deposit-confirmed`                      | resolver only                                                                             |
| `notifyContactInquiry.ts`     | `contact-inquiry-received`               | resolver only                                                                             |
| `notifyMaintenanceRequest.ts` | `maintenance-request-created`            | resolver only                                                                             |
| `notifyRefundRecorded.ts`     | `refund-recorded`                        | resolver only                                                                             |
| `notifyContractLifecycle.ts`  | `contract-created`, `contract-ended`     | resolver only (two wrappers)                                                              |
| `contractExpiryJob.ts`        | `contract-expiry`                        | calls `readWorkflowGate` directly                                                         |
| `overdueRemindersJob.ts`      | `overdue-reminders`                      | calls `readWorkflowGate` directly                                                         |

The last two are scheduled jobs: `cronJobs.ts` inlines the pause/time/record pattern
rather than using `runEventWorkflow`, so they read the gate themselves.

## 5. Server actions & hooks

### 5.1 `src/hooks/useCronJobs.ts`

Existing `useCronJobs` and `useSetCronJobActive` are unchanged. Added:

- **`useSetWorkflowRecipients()`** — direct
  `supabase.from("cron_jobs").update({ recipient_targets })` under the existing
  admin-UPDATE policy. Mirrors `useSetCronJobActive`: `permissions.isAdmin` guard,
  `logAuditForCurrentSession({ action: "cron.recipients", entityType: "cron_job" })`,
  `invalidateQueries(["cron-jobs"])`. Optimistic update so pills feel instant, rolled
  back on error.
- **`useCreateWorkflow()` / `useDeleteWorkflow()` / `useTestRunWorkflow()`** — call the
  server fns below through the session-forwarding wrapper pattern in
  `src/lib/contractExpiryJob.ts` (reads the Supabase session, forwards
  `Authorization: Bearer <access_token>`).

### 5.2 `src/fns/manageWorkflow.ts` (new)

`createWorkflowFn` and `deleteWorkflowFn` — `createServerFn({ method: "POST" })` +
`requireSupabaseAuth`, Zod-validated, writing through `supabaseAdmin`.

Guards:

- caller holds `has_permission("notifications.update")` **and** `has_role(admin)`;
- `key` matches `^[a-z0-9-]+$`;
- create rejects a key present in `WORKFLOW_CATALOG` or already in the table;
- **delete refuses any built-in key** — seeded rows are recreated by migration replay
  and are asserted by the SQL tests.

Both write an audit row.

### 5.3 `src/fns/runWorkflowNow.ts` (new)

`createServerFn` + `requireSupabaseAuth`. Validates `key ∈ JOBS` (scheduled only —
an event row has no payload to replay), checks the catalog's `runPermission` via
`context.supabase.rpc("has_permission", …)`, then runs the same pause/time/record
sequence as `respondToCronRequest` (`cronJobs.ts:79-97`).

This preserves CLAUDE.md's rule: **admin-triggered job paths stay user-scoped and
`has_permission`-gated; only `/api/public/cron` runs as `service_role`.**

On denial, `throw new Error(...)` — **not** `throw new Response(403)`. A thrown Response
resolves client-side as a success through the `x-tss-raw` path, so a 403 would read as
"it worked".

## 6. UI architecture

### 6.1 `RecipientTargetsPicker.tsx` (new)

Three toggle pills built on `ToggleGroup type="multiple"`
(`src/components/ui/toggle-group.tsx`) styled with `Badge`.

```ts
{ value: WorkflowRecipientTarget[];
  supported: WorkflowRecipientTarget[];
  disabled: boolean;
  onChange: (next: WorkflowRecipientTarget[]) => void }
```

Unsupported targets render disabled with a `title` explaining the workflow has no such
send block. The component refuses to deselect the last remaining pill, so the
`cardinality > 0` constraint is unreachable from the UI rather than surfacing as a
database error toast.

### 6.2 `WorkflowTable.tsx` (rewrite)

One unified table. The `kind` prop and the `WorkflowKind` wording switch are dropped;
per-row wording derives from `job.kind`. The existing wording distinction stays — it is
deliberate (see the comment at L19-34): "Never run" reads as a fault for a nightly job
and is normal for an event workflow, and "duration" means _enqueue_ time for an event
workflow because delivery happens later in `notification-drain`.

| Column             | Content                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Status             | `Switch` bound to `is_active`                                                            |
| Workflow           | name (locale), description, `key` in mono                                                |
| Kind               | `Badge` — Scheduled / Event                                                              |
| Trigger / Schedule | `WORKFLOW_CATALOG[key].schedule` in `LtrText`; event key for events; `—` for custom rows |
| Recipients         | `RecipientTargetsPicker`                                                                 |
| Last run           | timestamp + status badge + duration                                                      |
| Actions            | Run now / Delete                                                                         |

Sortable headers via local `useState`. The `useIsMobile()` → `MobileCardList` branch,
the `statusBadge` logic, and the muted-vs-destructive `last_error` rendering all carry
over unchanged.

Rows absent from `WORKFLOW_CATALOG` get a "Not wired" outline badge, a disabled Run-now,
and an enabled Delete.

### 6.3 `WorkflowsPanel.tsx`

`Tabs` removed. Adds a filter toolbar — All | Scheduled | Event | Active | Inactive —
as a `ToggleGroup type="single"` with counts, plus an **"+ Add Workflow"** button gated
on `permissions.isAdmin`. The `useCronJobs` query, the `TableState` wrapper, and the
"nothing has ever run" banner (still scoped to scheduled rows) are kept.

`src/routes/admin.settings.notifications.tsx` needs no change — it mounts
`<WorkflowsPanel />` under a tab whose `value` stays `"jobs"` deliberately (renaming it
resets remembered tab state).

### 6.4 `AddWorkflowDialog.tsx` (new)

react-hook-form + `zodResolver`, following
`src/components/admin/electricity/MetersTab.tsx:232-337` — `form.register` for inputs,
`form.watch`/`setValue` for `Select`/`Switch`. That is the closest in-repo precedent; no
admin dialog currently uses RHF.

Fields: `key`, kind radio, `RecipientTargetsPicker`, `name_ar`/`name_en` (required by
the Insert type), `description_ar`/`description_en`.

**No cron-expression input** — there is nowhere to store one and nothing would read it.
Offering the field would promise scheduling the row cannot do.

**The dialog states plainly that the row is a registry entry and nothing will dispatch
it until a developer wires it up.** A badge on the table row is not sufficient warning
at the point of creation.

### 6.5 i18n

`src/i18n/dictionary.ts` is one flat `Record<string,string>` per locale. Every new key
goes in **both** `dictionaries.ar` (near L1238-1264) and `dictionaries.en` (near
L2621-2647). Now-unused `workflows.scheduledTab`, `workflows.eventTab`,
`workflows.scheduledHint`, `workflows.eventHint` are removed from both.

`src/i18n/dictionary.test.ts` enforces three guards that fail `bun run test` on a slip:
ar/en key parity, every `t("literal")` in `src/` resolving in both locales, and
non-empty interpolated key families.

## 7. Testing

| File                                        | Coverage                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/fns/workflowRegistry.test.ts`          | `readWorkflowGate` returns targets; fails open on error; targets threaded into `run`                                                                                                                                                                                                      |
| `src/fns/enqueueNotification.test.ts` (new) | `resolveNotificationRecipients` per target combination; `getAdminNotificationEmails()` output unchanged; `["admin"]` never queries `companies`; `["company"]` still throws on its error                                                                                                   |
| 7 sender tests                              | both tiers — tenant off ⇒ no receipt **and** no WhatsApp; admin off + company on ⇒ admin block still runs, addressed to the company email only. Each file's `vi.mock("@/fns/enqueueNotification")` block needs `resolveNotificationRecipients` added, or the new call returns `undefined` |
| `src/fns/runWorkflowNow.test.ts` (new)      | 403 without permission; event key rejected; paused key records `skipped`                                                                                                                                                                                                                  |
| `src/db/workflowRegistry.sqltest.ts`        | constraint rejects `['nobody']` and `'{}'`; every seeded row's targets match §3.2; `WORKFLOW_CATALOG` keys ≡ seeded built-in keys                                                                                                                                                         |

`src/db/newEventWorkflows.sqltest.ts:60-67` asserts a total of 16 registry rows and
`workflowRegistry.sqltest.ts` holds exhaustive `EVENT_KEYS`/`SCHEDULED_KEYS` arrays.
Both must stay accurate.

## 8. Out of scope

- Wiring an actual dispatcher for custom workflows.
- Changing the production crontab.
- Editing notification templates or the delivery path in `dispatchNotification.ts`.
