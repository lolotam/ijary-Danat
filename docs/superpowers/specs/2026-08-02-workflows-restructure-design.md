# Workflows restructure — scheduled and event-triggered automations in one registry

**Date:** 2026-08-02
**Piece:** 1 of 3
**Migration:** `db/migrations/69_workflow_registry.sql`
**Branch:** `feat/workflows-registry`
**Depends on:** `806328b` (the Automations tab), which is on
`fix/credentials-template-and-login-session` and **not yet in `main`**. This
branch is cut from there, not from `main`.

---

## Where this piece sits

The user asked for two things in the same conversation:

1. Rename "Scheduled Jobs" to "Workflows" and split it into two tabs —
   scheduled-trigger jobs and action-trigger workflows — both monitorable and
   switchable, both showing last run, duration and status.
2. An HTML editor and live Arabic/English preview in the template editor, with
   the stored template actually controlling the sent email.

These share the Automations screen and nothing else. They touch different
tables, different code paths, and carry very different blast radius. They were
therefore split into three pieces:

| Piece | Scope                                                                          | Risk |
| ----- | ------------------------------------------------------------------------------ | ---- |
| **1** | **This spec.** Two tabs; register the four event workflows that already exist. | Low  |
| 2     | HTML source editor, AR/EN preview, templates become authoritative.             | High |
| 3     | Four new event workflows, template-driven from birth.                          | Med  |

Piece 1 ships the visible restructure without touching what any email says.
Piece 2 rewires what every tenant-facing email says and is reviewed on its own.
Piece 3 depends on piece 2 so its four new senders are template-driven from the
start rather than written as hardcoded builders and immediately rewritten.

**Out of scope here:** the template editor, any change to email copy, and the
four new triggers (contact inquiry, maintenance request, refund/reversal,
contract created/ended).

---

## 1. The problem

Tab one is a rename plus a filter. Tab two does not exist at any layer.

The Scheduled Jobs tab is backed by a real registry — `cron_jobs`, from
migration 58 — carrying exactly the columns the user asked for:

```
key, name_ar, name_en, description_ar, description_en,
is_active, last_run_at, last_status, last_duration_ms, last_error
```

The event-driven senders have no registry row at all. They fire unconditionally
from their call sites:

| Sender                         | Call site                                        |
| ------------------------------ | ------------------------------------------------ |
| `notifyUserCredentials`        | `createAppUser.ts:133`                           |
| `notifyDepositConfirmedRecord` | `useDeposits.ts:171`, `useDeposits.ts:233`       |
| `notifyPaymentSuccess`         | `myfatoorahWebhook.ts:531`, `usePayments.ts:160` |

There is no `is_active` to consult, no `last_run_at` to show, no duration and no
status. "Let users turn them on or off and monitor them" therefore means
creating the registry those rows would live in. Everything else follows from how
that registry is created.

---

## 2. Decision: extend `cron_jobs` rather than add a second table

`record_cron_run` is a plain update:

```sql
update public.cron_jobs
   set last_run_at = now(), last_status = _status,
       last_duration_ms = _duration_ms, last_error = _error
 where key = _key;
```

Nothing in it assumes cron. Neither do the three RLS policies — staff read,
admin update, service_role all — which are already exactly the access model an
event workflow needs (staff may watch; only an admin may change what the system
does unattended).

So one table with a `kind` discriminator reuses, verbatim: the RPC, the three
policies, the `updated_at` trigger, `useCronJobs`, `useSetCronJobActive`, and the
`CronJob` type. A second table would mean a parallel RPC, parallel policies, a
parallel hook, and two table renderers that must be kept from drifting.

### The table keeps the name `cron_jobs`

Renaming to `workflows` would churn three RLS policies, `record_cron_run`, the
`updated_at` trigger, `useCronJobs`, `database.types.ts` and
`expiryBuckets.sqltest.ts` for no functional gain, on a table production already
depends on. The UI says "Workflows"; the table keeps its name, and the migration
carries a comment saying why so the next reader is not misled.

### Adding rows cannot make them runnable

`respondToCronRequest` validates with `isCronJobName`, which tests
`value in JOBS` — the hardcoded map in `src/fns/cronJobs.ts`. An event key is not
in that map, so a `POST /api/public/cron` naming `deposit-confirmed` gets a 400,
not a dispatch. Registering event rows therefore cannot widen the cron endpoint's
surface. **A test must pin this**, because it is the property that makes the
shared table safe.

---

## 3. Schema

`db/migrations/69_workflow_registry.sql`:

```sql
alter table public.cron_jobs
  add column if not exists kind text not null default 'scheduled'
  check (kind in ('scheduled', 'event'));
```

`default 'scheduled'` means the seven existing rows classify themselves and the
column is backfill-free.

Four seed rows, `on conflict (key) do update` on the name and description columns
so the migration stays re-runnable in the style of 58:

| key                           | name_en                        | name_ar                    |
| ----------------------------- | ------------------------------ | -------------------------- |
| `user-credentials-managerial` | Managerial account credentials | بيانات دخول حساب إداري     |
| `user-credentials-tenant`     | Tenant portal credentials      | بيانات دخول بوابة المستأجر |
| `deposit-confirmed`           | Deposit confirmed              | تأكيد الإيداع              |
| `payment-succeeded`           | Payment succeeded              | نجاح الدفع                 |

Descriptions state the trigger, not a schedule — "Emails the admin recipients
when a deposit is confirmed, attaching its document" rather than a cron
expression.

The `insert` must set `kind = 'event'` explicitly, and the `do update` clause
must **not** touch `is_active` — re-running the migration must never silently
re-enable a workflow an admin switched off.

---

## 4. The gate, and the failure mode it is designed against

The real risk in this piece is shipping a switch that is written and never read.
This repository has produced that shape repeatedly — `is_system`, `archived_at`,
the `LtrText` pairs — and a toggle that nothing consults looks correct in the UI
and passes any test that only asserts the mutation succeeded.

### The gate lives inside the notify functions

Not at the five call sites. Five scattered checks is precisely where one gets
missed, and the miss is invisible.

`isJobPaused` and `recordRun` move out of `src/fns/cronJobs.ts` into a new
`src/fns/workflowRegistry.ts`, exporting:

```ts
export async function isWorkflowPaused(key: string): Promise<boolean>;
export async function recordWorkflowRun(
  key: string,
  status: "success" | "error" | "skipped",
  durationMs: number,
  errorMessage: string | null,
): Promise<void>;
```

`cronJobs.ts` then imports these rather than defining its own, so the cron path
and the event path share one implementation that cannot drift.

### It fails open

If the registry cannot be read, the send proceeds. This matches the convention
already stated at `cronJobs.ts:107` — "observability must never become a single
point of failure for the thing it observes" — and matters more here, because
`notifyPaymentSuccess` sits on the MyFatoorah path. A registry outage must not
stop a tenant receiving their receipt.

`recordWorkflowRun` swallows its own failures for the mirror-image reason:
recording that a workflow ran must never make the workflow report failure.

### Where each gate goes, and what it returns

Each sender wraps its existing body in start-time capture, the pause check, and
a `recordWorkflowRun` on both the success and error paths.

| Function                       | Key                                                                               | Paused return                                  |
| ------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| `notifyUserCredentials`        | `user-credentials-managerial` / `user-credentials-tenant`, chosen by `input.kind` | `{ ids: [], skipped: true, reason }`           |
| `notifyDepositConfirmedRecord` | `deposit-confirmed`                                                               | `{ skipped: true, reason }`                    |
| `notifyPaymentSuccess`         | `payment-succeeded`                                                               | `{ ok: true, skipped: true, reason, ids: [] }` |

Two of the three already have a compatible shape:
`notifyDepositConfirmedRecord` returns `{ skipped: true, reason }` for its
existing idempotency check, and `notifyPaymentSuccess` already returns
`{ ok, skipped, ids }`. Only `notifyUserCredentials`, which returns `{ ids }`,
gains fields — and it gains them additively, so existing callers that read
`.ids` keep working.

`notifyUserCredentials` is one function serving two workflows. The managerial and
tenant paths already branch on `input.kind`, so the key is chosen from the same
branch — the two rows stay independently switchable without splitting the
function.

---

## 5. What "duration" and "last run" honestly mean on the event tab

Decided rather than assumed, because reusing the scheduled tab's meanings would
mislead:

**Duration measures building and enqueueing the notification, not delivering
it.** Delivery happens later, in the `notification-drain` job. An event row
reading 40 ms is not a send time, and the column is labelled so that is clear.

**"Never run" is a fault for a cron job and normal for an event workflow.** No
deposit has been confirmed yet is not a misconfiguration. Event rows therefore
get their own empty state — "Not triggered yet" — rather than reusing
`cron.neverRun`.

**The amber banner is scoped to the scheduled sub-tab.** `CronJobsPanel.tsx:54`
computes `nothingHasEverRun` and renders "nothing is scheduled on the host",
which is a real and useful warning for cron and actively wrong for events. Its
`rows` input must be the scheduled rows only, not the whole registry — otherwise
a fleet of never-triggered event rows would suppress a genuine cron warning, or
raise a false one.

---

## 6. UI

`CronJobsPanel` splits in two:

- **`WorkflowsPanel`** — owns the outer heading and the nested `Tabs`, and holds
  the admin check. Renders both sub-tabs.
- **`WorkflowTable`** — takes `kind` and the rows, renders the columns. One
  renderer for both tabs, so the identical column set the user asked for is
  structural rather than a thing two components happen to agree on.

Both tabs show: Workflow, Last run, Status, Duration, Enabled — plus the mobile
`MobileCardList` variant the existing panel already has.

One `useCronJobs` query serves both tabs, filtered client-side by `kind`. The
registry is a handful of rows; a second query would buy nothing and would make
the two tabs able to disagree about what they had just seen.

The inner `TabsList` gets distinct visual treatment so it does not read as a
fifth sibling of the outer Automations tabs.

`src/routes/admin.settings.cron.tsx` renders `WorkflowsPanel`, so existing links
land on the fuller screen rather than a now-partial one.

---

## 7. Also touched

- **`database.types.ts`** — `kind` added by hand to the `cron_jobs` Row, Insert
  and Update. Never `gen:types` over this file: it is hand-maintained despite
  looking generated, and exports 73 aliases the generator does not emit.
- **`src/i18n/dictionary.ts`** — new `workflows.*` keys in both locales.
  The `cron.*` keys stay; they still label the scheduled sub-tab.
  New keys: `workflows.title`, `workflows.subtitle`, `workflows.scheduledTab`,
  `workflows.eventTab`, `workflows.workflow`, `workflows.trigger`,
  `workflows.neverTriggered`, `workflows.enqueueDuration`.
- **`src/routes/admin.settings.notifications.tsx`** — the `jobs` tab trigger
  label becomes `t("workflows.title")` and renders `WorkflowsPanel`.

---

## 8. Tests

The test that matters most is the one that catches the write-only toggle:

1. **A paused event workflow does not enqueue.** For each of the three senders:
   set `is_active = false`, call it, assert the explicit return flag is
   `skipped: true` **and** that no new `notifications` row was written. Asserting
   on the return flag rather than on a throw is deliberate — in this codebase a
   thrown `Response` resolves as _success_ on the client, so a test asserting on
   throws would pass vacuously.
2. **An active workflow still enqueues**, so the gate cannot pass by rejecting
   everything.
3. **A registry read failure still sends** — the fail-open property, which is
   the one that protects the MyFatoorah path.
4. **The cron endpoint rejects an event key** — `POST` with
   `job: "deposit-confirmed"` returns 400. This pins the property that makes one
   shared table safe.
5. **sqltest**: the `kind` check constraint rejects a third value; the four seeds
   land with `kind = 'event'`; the seven existing rows are `kind = 'scheduled'`;
   re-running the migration does not reset `is_active`.

Gates before presenting: `bun run lint`, `bun run typecheck`, `bun run test`, and
`bun run test:db` for the migration — the last builds a clean database from
scratch, which is the only way to catch a migration that is not re-runnable.

---

## 9. Risks

| Risk                                          | Mitigation                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| Toggle written, never read                    | Gate inside the senders, not the call sites; test 1 asserts no notification row |
| Registry outage stops receipts                | Fail open, matching `isJobPaused`; test 3                                       |
| Migration re-run re-enables a paused workflow | `do update` excludes `is_active`; test 5                                        |
| Event key dispatched as a cron job            | `isCronJobName` already rejects it; test 4 pins it                              |
| `gen:types` clobbers hand-maintained types    | Hand-edit `database.types.ts` only                                              |
| Amber banner misreads event rows              | Banner scoped to scheduled rows                                                 |
