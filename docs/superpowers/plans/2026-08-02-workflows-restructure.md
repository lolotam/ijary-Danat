# Workflows Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the Automations screen's "Scheduled Jobs" tab into a "Workflows" tab with two sub-tabs — scheduled-trigger jobs and action-trigger workflows — and register the four event-driven senders that today fire unconditionally with no switch and no run history.

**Architecture:** Extend the existing `cron_jobs` registry with a `kind` discriminator (`'scheduled' | 'event'`) rather than adding a second table, because `record_cron_run` is key-shaped only and the three RLS policies are already the access model event workflows need. The pause check and run recording move into a shared `src/fns/workflowRegistry.ts` used by both the cron endpoint and the event senders, so one implementation serves both and they cannot drift. The gate lives **inside** the three notify functions, never at their five call sites.

**Tech Stack:** TanStack Start (React 19), Bun, Vitest, self-hosted Supabase (Postgres 17), Tailwind 4 + shadcn/ui, manual SQL migrations.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-02-workflows-restructure-design.md`. Read it before Task 1.
- **Branch:** `feat/workflows-registry`, cut from `fix/credentials-template-and-login-session` (which holds `806328b`, the Automations tab, and is **not** in `main`). Do not rebase onto `main`.
- **The table keeps the name `cron_jobs`.** Do not rename it.
- **`src/integrations/supabase/database.types.ts` is hand-maintained** despite looking generated. Edit it by hand. **Never run `bun run gen:types` over it** — it would clobber 73 aliases the generator does not emit.
- **Never edit an already-applied migration.** New behaviour goes in a new numbered file. Migration 69 is the only new SQL file in this plan.
- **`src/routeTree.gen.ts` is generated.** Never edit it.
- **The registry fails open.** Every read failure must let the send proceed. Never fail closed.
- **Gates before presenting any task as done:** `bun run lint`, `bun run typecheck`, `bun run test`. Tasks touching SQL additionally run `bun run test:db` (needs Docker).
- **Every new user-facing string needs both locales** in `src/i18n/dictionary.ts` — the `ar` map (around line 1222) and the `en` map (around line 2579).
- Commit after every task. Never force-push, rebase, amend or squash.

---

## File Structure

| File                                          | Responsibility | Task                                                                          |
| --------------------------------------------- | -------------- | ----------------------------------------------------------------------------- | --- |
| `db/migrations/69_workflow_registry.sql`      | Create         | The `kind` column, its constraint, and the four event seed rows               | 1   |
| `src/db/workflowRegistry.sqltest.ts`          | Create         | Proves the constraint, the seeds and the re-run safety                        | 1   |
| `src/fns/workflowRegistry.ts`                 | Create         | `isWorkflowPaused`, `recordWorkflowRun`, `runEventWorkflow` — the shared gate | 2   |
| `src/fns/workflowRegistry.test.ts`            | Create         | The gate's behaviour, tested once for all senders                             | 2   |
| `src/fns/cronJobs.ts`                         | Modify         | Import the shared helpers instead of defining its own                         | 2   |
| `src/fns/cronJobs.test.ts`                    | Modify         | Pin that an event key is not dispatchable                                     | 2   |
| `src/fns/notifyDepositConfirmed.ts`           | Modify         | Wire the `deposit-confirmed` gate                                             | 3   |
| `src/fns/notifyDepositConfirmed.test.ts`      | Create         | Paused ⇒ nothing enqueued                                                     | 3   |
| `src/fns/notifyPaymentSuccess.ts`             | Modify         | Wire the `payment-succeeded` gate                                             | 4   |
| `src/fns/notifyPaymentSuccess.test.ts`        | Create         | Paused ⇒ nothing enqueued; `ok:false` records an error                        | 4   |
| `src/fns/notifyUserCredentials.ts`            | Modify         | Wire two gates, chosen by `input.kind`                                        | 5   |
| `src/fns/notifyUserCredentials.test.ts`       | Create         | Each kind consults its own row                                                | 5   |
| `src/integrations/supabase/database.types.ts` | Modify         | `kind` on `CronJobRow`                                                        | 6   |
| `src/i18n/dictionary.ts`                      | Modify         | The `workflows.*` keys, both locales                                          | 6   |
| `src/components/admin/WorkflowTable.tsx`      | Create         | One renderer, both tabs — the identical column set made structural            | 6   |
| `src/components/admin/WorkflowsPanel.tsx`     | Create         | Query, permissions, nested tabs, banner scoping                               | 7   |
| `src/components/admin/CronJobsPanel.tsx`      | Delete         | Superseded by the two above                                                   | 7   |
| `src/routes/admin.settings.notifications.tsx` | Modify         | Tab label and body                                                            | 7   |
| `src/routes/admin.settings.cron.tsx`          | Modify         | Render the full panel                                                         | 7   |

---

## Task 1: The registry gains a kind

**Files:**

- Create: `db/migrations/69_workflow_registry.sql`
- Create: `src/db/workflowRegistry.sqltest.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `public.cron_jobs.kind text not null default 'scheduled'`, constrained to `'scheduled' | 'event'`. Four rows with `kind = 'event'` and keys `user-credentials-managerial`, `user-credentials-tenant`, `deposit-confirmed`, `payment-succeeded`. Tasks 3–5 use those keys verbatim; Task 6 reads the column.

- [ ] **Step 1: Write the failing sqltest**

Create `src/db/workflowRegistry.sqltest.ts`:

```ts
import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 69 — one registry serving both the jobs the cron endpoint
 * dispatches and the workflows an application event fires, told apart by
 * `kind`.
 *
 * The table keeps the name `cron_jobs` deliberately; see the migration header.
 */

/** The four senders that until now fired with no row, no switch, no history. */
const EVENT_KEYS = [
  "deposit-confirmed",
  "payment-succeeded",
  "user-credentials-managerial",
  "user-credentials-tenant",
];

/** The keys of the JOBS map in src/fns/cronJobs.ts. */
const SCHEDULED_KEYS = [
  "contract-expiry",
  "gmail-sync",
  "notification-drain",
  "overdue",
  "overdue-reminders",
  "salaries",
  "scheduled-reports",
];

describe("the kind discriminator", () => {
  test("the four event workflows are registered as events", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ key: string }>(
        `select key from public.cron_jobs where kind = 'event' order by key`,
      );
      expect(rows.map((row) => row.key)).toEqual(EVENT_KEYS);
    });
  });

  test("the seven cron jobs classify themselves as scheduled", async () => {
    // The column defaults to 'scheduled', so migration 58's rows need no
    // backfill — this asserts that default actually reached them.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ key: string }>(
        `select key from public.cron_jobs where kind = 'scheduled' order by key`,
      );
      expect(rows.map((row) => row.key)).toEqual(SCHEDULED_KEYS);
    });
  });

  test("a third kind is rejected", async () => {
    await withRollback(async (client) => {
      await expect(
        client.query(
          `insert into public.cron_jobs (key, kind, name_ar, name_en)
             values ('bogus', 'webhook', 'x', 'x')`,
        ),
      ).rejects.toThrow(/cron_jobs_kind_check/);
    });
  });
});

describe("re-running the seed", () => {
  test("does not re-enable a workflow an admin paused", async () => {
    // Migrations get replayed. A replay that silently switched a workflow back
    // on would undo a deliberate admin decision, with no trace.
    await withRollback(async (client) => {
      await client.query(
        `update public.cron_jobs set is_active = false where key = 'deposit-confirmed'`,
      );

      await client.query(
        `insert into public.cron_jobs (key, kind, name_ar, name_en, description_ar, description_en)
           values ('deposit-confirmed', 'event', 'تأكيد الإيداع', 'Deposit confirmed', 'د', 'd')
         on conflict (key) do update
           set kind = excluded.kind,
               name_ar = excluded.name_ar,
               name_en = excluded.name_en,
               description_ar = excluded.description_ar,
               description_en = excluded.description_en`,
      );

      const { rows } = await client.query<{ is_active: boolean }>(
        `select is_active from public.cron_jobs where key = 'deposit-confirmed'`,
      );
      expect(rows[0].is_active).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test:db && bun vitest run src/db/workflowRegistry.sqltest.ts`
Expected: FAIL — `column "kind" does not exist`.

- [ ] **Step 3: Write the migration**

Create `db/migrations/69_workflow_registry.sql`:

```sql
-- ---------------------------------------------------------------------------
-- 69 — one registry for scheduled jobs and event-triggered workflows
-- ---------------------------------------------------------------------------
--
-- The table keeps the name `cron_jobs` deliberately. Renaming it to `workflows`
-- would churn three RLS policies, record_cron_run, the updated_at trigger,
-- useCronJobs, database.types.ts and expiryBuckets.sqltest.ts for no functional
-- gain, on a table production already depends on. The UI says "Workflows"; the
-- table keeps its name.
--
-- Event rows are NOT dispatchable by the cron endpoint. respondToCronRequest
-- validates with isCronJobName, which tests membership of the hardcoded JOBS
-- map in src/fns/cronJobs.ts, and no event key appears there. Registering these
-- rows therefore cannot widen that endpoint's surface — cronJobs.test.ts pins
-- it.

alter table public.cron_jobs
  add column if not exists kind text not null default 'scheduled';

-- A separate, dropped-and-recreated constraint so a re-run over a database that
-- already has the column still ends up constrained.
alter table public.cron_jobs drop constraint if exists cron_jobs_kind_check;
alter table public.cron_jobs
  add constraint cron_jobs_kind_check check (kind in ('scheduled', 'event'));

comment on column public.cron_jobs.kind is
  'scheduled = dispatched by the cron endpoint; event = fired by an application trigger.';

-- The four event-driven senders. Descriptions state the trigger, not a
-- schedule, because that is the only thing an admin can act on here.
--
-- `do update` deliberately does NOT touch is_active: replaying this migration
-- must never silently re-enable a workflow an admin switched off.
insert into public.cron_jobs (key, kind, name_ar, name_en, description_ar, description_en)
values
  ('user-credentials-managerial', 'event',
   'بيانات دخول حساب إداري', 'Managerial account credentials',
   'يرسل بيانات الدخول عند إنشاء حساب مستخدم إداري، مع نسخة إلى مستلمي الإدارة.',
   'Emails login details when a managerial user account is created, with a copy to the admin recipients.'),
  ('user-credentials-tenant', 'event',
   'بيانات دخول بوابة المستأجر', 'Tenant portal credentials',
   'يرسل بيانات دخول البوابة بالبريد وواتساب عند إنشاء حساب بوابة للمستأجر.',
   'Emails and WhatsApps portal login details when a tenant portal account is created.'),
  ('deposit-confirmed', 'event',
   'تأكيد الإيداع', 'Deposit confirmed',
   'يرسل إلى مستلمي الإدارة عند تأكيد الإيداع، مع إرفاق مستنده.',
   'Emails the admin recipients when a deposit is confirmed, attaching its document.'),
  ('payment-succeeded', 'event',
   'نجاح الدفع', 'Payment succeeded',
   'يرسل الإيصال للمستأجر وتنبيهاً لمستلمي الإدارة عند نجاح الدفع.',
   'Emails the receipt to the tenant and an alert to the admin recipients when a payment succeeds.')
on conflict (key) do update
  set kind = excluded.kind,
      name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      description_ar = excluded.description_ar,
      description_en = excluded.description_en;
```

- [ ] **Step 4: Rebuild the test database and run the sqltest**

Run: `bun run test:db && bun vitest run src/db/workflowRegistry.sqltest.ts`
Expected: PASS, 4 tests. `test:db` builds a clean database from scratch, which is the only way to catch a migration that is not re-runnable.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/69_workflow_registry.sql src/db/workflowRegistry.sqltest.ts
git commit -m "feat(workflows): register event-triggered workflows in the cron registry

Adds a kind discriminator to cron_jobs and seeds the four event-driven
senders that until now fired with no row, no switch and no run history.
The seed deliberately does not touch is_active, so replaying the
migration cannot re-enable a workflow an admin paused."
```

---

## Task 2: The shared gate

**Files:**

- Create: `src/fns/workflowRegistry.ts`
- Create: `src/fns/workflowRegistry.test.ts`
- Modify: `src/fns/cronJobs.ts:100-144` (remove `isJobPaused` and `recordRun`, import instead)
- Modify: `src/fns/cronJobs.test.ts` (add one test)

**Interfaces:**

- Consumes: the `kind`-bearing registry from Task 1.
- Produces:
  ```ts
  export type WorkflowRunStatus = "success" | "error" | "skipped";
  export async function isWorkflowPaused(key: string): Promise<boolean>;
  export async function recordWorkflowRun(
    key: string,
    status: WorkflowRunStatus,
    durationMs: number,
    errorMessage: string | null,
  ): Promise<void>;
  export async function runEventWorkflow<T>(options: {
    key: string;
    whenPaused: () => T;
    run: () => Promise<T>;
    outcomeOf?: (result: T) => { status: WorkflowRunStatus; error: string | null };
  }): Promise<T>;
  ```
  Tasks 3, 4 and 5 each call `runEventWorkflow` exactly once.

**Why `outcomeOf` and not a boolean "did it fail":** a sender's result means one
of _three_ things — it broke, it had nothing to do, or it sent. Collapsing that
into two paints normal outcomes the wrong colour in both directions. A declined
KNET transaction makes `notifyPaymentSuccess` return
`{ ok: false, error: "No confirmed payments." }`, which is the **correct**
outcome, not a failure; recording it as `error` would leave a permanent red
**Failed** badge on the very tab built for monitoring, and train admins to
ignore it. In the other direction, `enqueueDepositConfirmation` returns
`{ skipped: true }` for three normal paths — and recording those as `success`
would hide "No admin email recipients configured", which is a real
misconfiguration.

`last_status` already accepts `'success' | 'error' | 'skipped'` (migration 58's
check constraint), `CronJobRow.last_status` already types all three, and the
badge already renders `cron.skipped`. The third state is fully plumbed and
nothing uses it.

- [ ] **Step 1: Write the failing test**

Create `src/fns/workflowRegistry.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

const maybeSingle = vi.fn();
const rpc = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

const { isWorkflowPaused, recordWorkflowRun, runEventWorkflow } =
  await import("./workflowRegistry");

beforeEach(() => {
  vi.clearAllMocks();
  maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
  rpc.mockResolvedValue({ data: null, error: null });
});

describe("isWorkflowPaused", () => {
  test("reports a paused workflow", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { is_active: false }, error: null });
    await expect(isWorkflowPaused("deposit-confirmed")).resolves.toBe(true);
  });

  test("an unreadable registry fails OPEN", async () => {
    // Observability must never become a single point of failure for the thing
    // it observes. notifyPaymentSuccess sits on the MyFatoorah path — a
    // registry outage must not stop a tenant receiving their receipt.
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(isWorkflowPaused("payment-succeeded")).resolves.toBe(false);
  });

  test("an unregistered key is not treated as paused", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(isWorkflowPaused("never-seeded")).resolves.toBe(false);
  });
});

describe("recordWorkflowRun", () => {
  test("records through the shared RPC", async () => {
    await recordWorkflowRun("deposit-confirmed", "success", 42, null);
    expect(rpc).toHaveBeenCalledWith("record_cron_run", {
      _key: "deposit-confirmed",
      _status: "success",
      _duration_ms: 42,
      _error: null,
    });
  });

  test("swallows its own failure", async () => {
    // Recording that a workflow ran must never make the workflow report
    // failure.
    rpc.mockRejectedValueOnce(new Error("registry down"));
    await expect(recordWorkflowRun("x", "success", 1, null)).resolves.toBeUndefined();
  });
});

describe("runEventWorkflow", () => {
  test("a paused workflow does not run its body", async () => {
    // The defect this guards against is a switch that is written and never
    // read: it looks correct in the UI and passes any test that only asserts
    // the mutation succeeded.
    maybeSingle.mockResolvedValueOnce({ data: { is_active: false }, error: null });
    const run = vi.fn().mockResolvedValue({ ran: true });

    const result = await runEventWorkflow({
      key: "deposit-confirmed",
      whenPaused: () => ({ ran: false }),
      run,
    });

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ ran: false });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "deposit-confirmed", _status: "skipped" }),
    );
  });

  test("an active workflow runs its body and records success", async () => {
    // The mirror of the test above: a gate that rejected everything would pass
    // that one and be just as broken.
    const run = vi.fn().mockResolvedValue({ ran: true });

    const result = await runEventWorkflow({
      key: "deposit-confirmed",
      whenPaused: () => ({ ran: false }),
      run,
    });

    expect(run).toHaveBeenCalled();
    expect(result).toEqual({ ran: true });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "deposit-confirmed", _status: "success", _error: null }),
    );
  });

  test("a thrown body records the error and rethrows", async () => {
    const run = vi.fn().mockRejectedValue(new Error("smtp refused"));

    await expect(
      runEventWorkflow({ key: "deposit-confirmed", whenPaused: () => null, run }),
    ).rejects.toThrow(/smtp refused/);

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "error", _error: "smtp refused" }),
    );
  });

  test("outcomeOf can record a nothing-to-do result as skipped, not failed", async () => {
    // The case this exists for: a declined KNET transaction makes
    // notifyPaymentSuccess return { ok: false, error: "No confirmed payments." },
    // which is the correct outcome. Recording it as an error would leave a
    // permanent red Failed badge on the monitoring tab.
    const run = vi.fn().mockResolvedValue({ ok: false, nothingToDo: true, error: "nothing" });

    const result = await runEventWorkflow({
      key: "payment-succeeded",
      whenPaused: () => ({ ok: true, nothingToDo: false, error: "" }),
      run,
      outcomeOf: (value: { nothingToDo: boolean; error: string }) =>
        value.nothingToDo
          ? { status: "skipped" as const, error: value.error }
          : { status: "error" as const, error: value.error },
    });

    expect(result).toMatchObject({ ok: false });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "skipped", _error: "nothing" }),
    );
  });

  test("outcomeOf can still record a genuine failure as an error", async () => {
    // The mirror of the test above: a classifier that called everything skipped
    // would pass that one and hide every real breakage.
    const run = vi.fn().mockResolvedValue({ nothingToDo: false, error: "smtp refused" });

    await runEventWorkflow({
      key: "payment-succeeded",
      whenPaused: () => ({ nothingToDo: false, error: "" }),
      run,
      outcomeOf: (value: { nothingToDo: boolean; error: string }) =>
        value.nothingToDo
          ? { status: "skipped" as const, error: value.error }
          : { status: "error" as const, error: value.error },
    });

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "error", _error: "smtp refused" }),
    );
  });

  test("without outcomeOf a returned result is a success", async () => {
    const run = vi.fn().mockResolvedValue({ ids: ["a"] });

    await runEventWorkflow({
      key: "user-credentials-tenant",
      whenPaused: () => ({ ids: [] }),
      run,
    });

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "success", _error: null }),
    );
  });

  test("an unreadable registry still runs the body", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const run = vi.fn().mockResolvedValue("sent");

    await expect(
      runEventWorkflow({ key: "payment-succeeded", whenPaused: () => "skipped", run }),
    ).resolves.toBe("sent");
    expect(run).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun vitest run src/fns/workflowRegistry.test.ts`
Expected: FAIL — cannot resolve `./workflowRegistry`.

- [ ] **Step 3: Write the shared module**

Create `src/fns/workflowRegistry.ts`:

```ts
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * The `cron_jobs` registry serves two kinds of automation: the jobs the cron
 * endpoint dispatches on a schedule, and the workflows an application event
 * fires. Both need the same two operations, so they share one implementation
 * here rather than two that drift.
 *
 * The table keeps its `cron_jobs` name for the reasons in migration 69.
 */

export type WorkflowRunStatus = "success" | "error" | "skipped";

/**
 * Whether an admin has paused this workflow.
 *
 * Fails OPEN: if the registry cannot be read, the caller proceeds. A registry
 * outage must not silently stop invoices being marked overdue or a tenant
 * receiving their receipt — observability must never become a single point of
 * failure for the thing it observes.
 *
 * An unregistered key is likewise not paused, so a sender whose row was never
 * seeded keeps working.
 */
export async function isWorkflowPaused(key: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("cron_jobs")
      .select("is_active")
      .eq("key", key)
      .maybeSingle();
    if (error || !data) return false;
    return data.is_active === false;
  } catch {
    return false;
  }
}

/**
 * Records the outcome in the registry.
 *
 * Deliberately swallows its own failures: recording that a workflow ran must
 * never be able to make the workflow report failure. Same principle as above,
 * in the other direction.
 */
export async function recordWorkflowRun(
  key: string,
  status: WorkflowRunStatus,
  durationMs: number,
  errorMessage: string | null,
): Promise<void> {
  try {
    await supabaseAdmin.rpc("record_cron_run", {
      _key: key,
      _status: status,
      _duration_ms: durationMs,
      _error: errorMessage,
    });
  } catch {
    // Intentionally ignored.
  }
}

/**
 * Runs an event-triggered workflow under the registry: honours the pause
 * switch, times the run, and records the outcome.
 *
 * This exists so the gate is applied identically by every sender. The
 * alternative — a pause check at each of the five call sites — is exactly where
 * one gets missed, and a missed one is invisible: the switch still looks right
 * in the UI.
 *
 * `whenPaused` returns the caller's own skip shape, so each sender keeps its
 * existing return contract instead of every caller learning a new one.
 *
 * `outcomeOf` exists for senders that return their outcome rather than throwing.
 * A result means one of three things — it broke, it had nothing to do, or it
 * sent — and a sender that returns `{ ok: false }` for a declined card is
 * reporting the second, not the first. Without this hook every such result
 * would be recorded as a success (hiding real misconfiguration) or as an error
 * (painting the monitoring tab permanently red). Senders that simply throw need
 * no classifier.
 *
 * Duration measures building and enqueueing the notification, not delivering
 * it: delivery happens later, in the notification-drain job.
 */
export async function runEventWorkflow<T>(options: {
  key: string;
  whenPaused: () => T;
  run: () => Promise<T>;
  outcomeOf?: (result: T) => { status: WorkflowRunStatus; error: string | null };
}): Promise<T> {
  const { key, whenPaused, run, outcomeOf } = options;

  if (await isWorkflowPaused(key)) {
    await recordWorkflowRun(key, "skipped", 0, null);
    return whenPaused();
  }

  const startedAt = Date.now();
  try {
    const result = await run();
    const outcome = outcomeOf?.(result) ?? { status: "success" as const, error: null };
    await recordWorkflowRun(key, outcome.status, Date.now() - startedAt, outcome.error);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : `${key} failed.`;
    await recordWorkflowRun(key, "error", Date.now() - startedAt, message);
    throw error;
  }
}
```

- [ ] **Step 4: Run the new test**

Run: `bun vitest run src/fns/workflowRegistry.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Point cronJobs.ts at the shared helpers**

In `src/fns/cronJobs.ts`, delete the local `isJobPaused` (lines 100–119) and `recordRun` (lines 121–144) entirely, and delete the now-unused `supabaseAdmin` import on line 9. Add to the imports:

```ts
import { isWorkflowPaused, recordWorkflowRun } from "@/fns/workflowRegistry";
```

Replace the two call sites in `respondToCronRequest`:

```ts
if (await isWorkflowPaused(job)) {
  await recordWorkflowRun(job, "skipped", 0, null);
  return Response.json({ job, durationMs: 0, skipped: true });
}

const startedAt = Date.now();
try {
  const result = await JOBS[job](asOf);
  const durationMs = Date.now() - startedAt;
  await recordWorkflowRun(job, "success", durationMs, null);
  return Response.json({ job, durationMs, result });
} catch (error) {
  const message = error instanceof Error ? error.message : "Job failed.";
  // durationMs was previously only reported on success, which made a slow
  // failure indistinguishable from a fast one in the logs.
  const durationMs = Date.now() - startedAt;
  await recordWorkflowRun(job, "error", durationMs, message);
  return Response.json({ job, durationMs, error: message }, { status: 500 });
}
```

The existing `cronJobs.test.ts` mocks the module specifier
`@/integrations/supabase/client.server`, and `workflowRegistry.ts` imports from
that same specifier, so the mock still intercepts and those tests stay green
without modification.

- [ ] **Step 6: Pin that an event key is not dispatchable**

Append to the `describe("validation still applies")` block in `src/fns/cronJobs.test.ts`:

```ts
test("an event workflow key is not dispatchable as a cron job", async () => {
  // Event rows now share the cron_jobs table. That must not widen what
  // POST /api/public/cron will run: isCronJobName tests membership of the
  // hardcoded JOBS map, and no event key is in it.
  const response = await respondToCronRequest(cronRequest("deposit-confirmed"));
  expect(response.status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
});
```

- [ ] **Step 7: Run the full suite**

Run: `bun vitest run src/fns/cronJobs.test.ts src/fns/workflowRegistry.test.ts && bun run lint && bun run typecheck`
Expected: PASS. `cronJobs.test.ts` should be 8 tests (7 existing + 1 new), all green with no edits to the existing seven.

- [ ] **Step 8: Commit**

```bash
git add src/fns/workflowRegistry.ts src/fns/workflowRegistry.test.ts src/fns/cronJobs.ts src/fns/cronJobs.test.ts
git commit -m "refactor(workflows): share one pause-and-record gate

Moves isJobPaused and recordRun out of cronJobs.ts into a shared
workflowRegistry, and adds runEventWorkflow so every event sender applies
the gate identically. A pause check per call site is where one gets
missed, and a missed one is invisible.

Pins that an event key stays undispatchable by the cron endpoint."
```

---

## Task 3: Gate the deposit confirmation

**Files:**

- Modify: `src/fns/notifyDepositConfirmed.ts:11-83`
- Create: `src/fns/notifyDepositConfirmed.test.ts`

**Interfaces:**

- Consumes: `runEventWorkflow` from Task 2; the `deposit-confirmed` row from Task 1.
- Produces: `notifyDepositConfirmedRecord` keeps its existing return union and gains `{ skipped: true, reason: "Workflow is paused." }` as one more member. Its two callers at `src/hooks/useDeposits.ts:171` and `:233` are **not** modified.

- [ ] **Step 1: Write the failing test**

Create `src/fns/notifyDepositConfirmed.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

const maybeSingle = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

vi.mock("@/fns/enqueueNotification", () => ({
  enqueueNotification: (...args: unknown[]) => enqueue(...args),
  getAdminNotificationEmails: async () => ["admin@example.test"],
}));

const { notifyDepositConfirmedRecord } = await import("./notifyDepositConfirmed");

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
});

describe("the deposit-confirmed workflow switch", () => {
  test("a paused workflow enqueues nothing", async () => {
    // The switch must be READ, not merely written. Asserting on the return flag
    // and on enqueueNotification never being called is the only way to catch a
    // toggle that is stored and then ignored.
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    const result = await notifyDepositConfirmedRecord("11111111-1111-4111-8111-111111111111");

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
  });

  test("pausing consults this workflow's own row", async () => {
    // Four event rows share one table; a sender reading the wrong key would
    // make one switch silently control another.
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    await notifyDepositConfirmedRecord("11111111-1111-4111-8111-111111111111");

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "deposit-confirmed", _status: "skipped" }),
    );
  });
});

describe("classifying what the sender did", () => {
  test("an active workflow that had nothing to do records skipped, not success", async () => {
    // This sender skips for three normal reasons — not confirmed, already
    // notified, no admin recipients. Recording those as successes would hide
    // the third, which is a real misconfiguration. A green row that means
    // "sent nothing" is worse than no row at all.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });

    await runEventWorkflow({
      key: "deposit-confirmed",
      whenPaused: () => ({ skipped: true as const, reason: "paused" }),
      run: async () => ({ skipped: true as const, reason: "Already notified." }),
      outcomeOf: (result: { skipped: boolean; reason?: string }) =>
        result.skipped
          ? { status: "skipped" as const, error: result.reason ?? null }
          : { status: "success" as const, error: null },
    });

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "skipped", _error: "Already notified." }),
    );
  });
});
```

This last test imports the helper directly — add to the top of the file:

```ts
const { runEventWorkflow } = await import("./workflowRegistry");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun vitest run src/fns/notifyDepositConfirmed.test.ts`
Expected: FAIL — the paused path does not exist, so the function falls through to `supabaseAdmin.from("deposits")` and throws on the mock's missing `single`.

- [ ] **Step 3: Wire the gate**

In `src/fns/notifyDepositConfirmed.ts`, add to the imports:

```ts
import { runEventWorkflow } from "@/fns/workflowRegistry";
```

Rename the existing exported function to a module-private one by changing its
declaration on line 11 from

```ts
export async function notifyDepositConfirmedRecord(depositId: string) {
```

to

```ts
async function enqueueDepositConfirmation(depositId: string) {
```

leaving its body completely unchanged. Then add the public wrapper immediately
after that function's closing brace:

```ts
/**
 * The workflow admins see as "Deposit confirmed".
 *
 * The pause check lives here rather than at the two call sites in
 * useDeposits.ts, so neither can forget it.
 */
export async function notifyDepositConfirmedRecord(depositId: string) {
  type Result = Awaited<ReturnType<typeof enqueueDepositConfirmation>>;
  return runEventWorkflow<Result>({
    key: "deposit-confirmed",
    whenPaused: () => ({ skipped: true as const, reason: "Workflow is paused." }),
    run: () => enqueueDepositConfirmation(depositId),
    // Three of this sender's outcomes are skips, not sends: the deposit is not
    // confirmed, it was already notified, or no admin recipients are
    // configured. Recording them as successes would hide the third, which is a
    // real misconfiguration an admin needs to see. The reason is carried into
    // last_error so the row says *why* it skipped.
    outcomeOf: (result) =>
      result.skipped
        ? { status: "skipped" as const, error: result.reason }
        : { status: "success" as const, error: null },
  });
}
```

- [ ] **Step 4: Run the test**

Run: `bun vitest run src/fns/notifyDepositConfirmed.test.ts && bun run typecheck`
Expected: PASS, 2 tests, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/fns/notifyDepositConfirmed.ts src/fns/notifyDepositConfirmed.test.ts
git commit -m "feat(workflows): make the deposit-confirmed switch real

Gates the sender itself rather than its two call sites in useDeposits, so
neither can forget it. The test asserts nothing is enqueued when paused —
a toggle that is written and never read looks correct in the UI."
```

---

## Task 4: Gate the payment success notification

**Files:**

- Modify: `src/fns/notifyPaymentSuccess.ts:18-193`
- Create: `src/fns/notifyPaymentSuccess.test.ts`

**Interfaces:**

- Consumes: `runEventWorkflow` from Task 2; the `payment-succeeded` row from Task 1.
- Produces: `notifyPaymentSuccess` keeps `{ ok, skipped, ids }` / `{ ok: false, error }`. Its callers at `src/fns/myfatoorahWebhook.ts:531` and `src/hooks/usePayments.ts:160` are **not** modified.

This sender never throws — it catches internally and returns
`{ ok: false, error }` — so it is the one that needs `outcomeOf`.

**Read this before writing the test.** Two of its `ok: false` returns are
_correct, expected outcomes_, not failures:

- `"No payment ids."`
- `"No confirmed payments."` — which is exactly what a **declined KNET
  transaction** produces. A failed transaction correctly records nothing.

Classifying those as errors would write `last_status = 'error'` to the
`payment-succeeded` row on every declined card, so the tab the user asked for
_specifically to monitor workflows_ would show a red **Failed** badge as its
steady state — training admins to ignore the screen. They are `skipped`. Only
the `catch` block's return is a genuine `error`.

- [ ] **Step 1: Write the failing test**

Create `src/fns/notifyPaymentSuccess.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

const maybeSingle = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

vi.mock("@/fns/enqueueNotification", () => ({
  enqueueNotification: (...args: unknown[]) => enqueue(...args),
  getAdminNotificationEmails: async () => ["admin@example.test"],
}));

const { notifyPaymentSuccess } = await import("./notifyPaymentSuccess");

const PAYMENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
});

describe("the payment-succeeded workflow switch", () => {
  test("a paused workflow enqueues nothing", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    const result = await notifyPaymentSuccess([PAYMENT_ID]);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
  });

  test("pausing records against this workflow's own key", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    await notifyPaymentSuccess([PAYMENT_ID]);

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "payment-succeeded", _status: "skipped" }),
    );
  });

  test("a paused workflow reports ok, not failure", async () => {
    // This sits on the MyFatoorah path. A deliberate pause must not look like a
    // payment-notification failure to the webhook that logs the result.
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    const result = await notifyPaymentSuccess([PAYMENT_ID]);

    expect(result).toMatchObject({ ok: true });
  });

  test("having nothing to send records skipped, not failed", async () => {
    // "No payment ids." and "No confirmed payments." are correct outcomes — the
    // latter is exactly what a declined KNET transaction produces. Recording
    // them as errors would leave a permanent red Failed badge on the monitoring
    // tab and train admins to ignore it.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });

    const result = await notifyPaymentSuccess([]);

    expect(result).toMatchObject({ ok: false });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "payment-succeeded", _status: "skipped" }),
    );
  });

  test("a nothing-to-do result is never recorded as a success either", async () => {
    // The other half of the same claim: a green row would say a receipt went
    // out when none did.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });

    await notifyPaymentSuccess([]);

    const statuses = rpc.mock.calls
      .filter(([name]) => name === "record_cron_run")
      .map(([, args]) => (args as { _status: string })._status);
    expect(statuses).not.toContain("success");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun vitest run src/fns/notifyPaymentSuccess.test.ts`
Expected: FAIL — no pause path, and the empty-ids early return happens before any registry call.

- [ ] **Step 3: Wire the gate**

In `src/fns/notifyPaymentSuccess.ts`, add to the imports:

```ts
import { runEventWorkflow } from "@/fns/workflowRegistry";
```

Change the declaration on line 18 from

```ts
export async function notifyPaymentSuccess(paymentIds: string[]) {
```

to

```ts
async function enqueuePaymentSuccess(paymentIds: string[]) {
```

and annotate its return type so the three outcomes are representable:

```ts
async function enqueuePaymentSuccess(paymentIds: string[]): Promise<PaymentNotifyResult> {
```

Add this type above it:

```ts
/**
 * Three outcomes, not two. `nothingToDo` marks the returns that are correct
 * rather than broken — most importantly "No confirmed payments.", which is what
 * a declined KNET transaction produces.
 */
type PaymentNotifyResult =
  | { ok: true; skipped: boolean; ids: string[] }
  | { ok: false; error: string; nothingToDo?: true };
```

Leave the body otherwise unchanged, except for tagging the two early returns.
Both must stay **inside** the gated body so the outcome is recorded. Change:

```ts
if (!uniqueIds.length) return { ok: false as const, error: "No payment ids." };
```

to

```ts
if (!uniqueIds.length) {
  return { ok: false as const, nothingToDo: true as const, error: "No payment ids." };
}
```

and

```ts
if (!payments.length) return { ok: false as const, error: "No confirmed payments." };
```

to

```ts
if (!payments.length) {
  // A declined transaction correctly produces no confirmed payment. This is
  // the expected outcome, not a failure.
  return { ok: false as const, nothingToDo: true as const, error: "No confirmed payments." };
}
```

The `catch` block's return stays untagged — that one _is_ a failure.

Add the public wrapper immediately after that function's closing brace:

```ts
/**
 * The workflow admins see as "Payment succeeded".
 *
 * `outcomeOf` is load-bearing here. This sender never throws — it catches and
 * returns `{ ok: false, error }` so a notification failure can never break the
 * payment path — and two of those returns mean "nothing to send", not "broke".
 * Recording a declined card as an error would leave a permanent red Failed
 * badge on the tab built to monitor these.
 */
export async function notifyPaymentSuccess(paymentIds: string[]): Promise<PaymentNotifyResult> {
  return runEventWorkflow<PaymentNotifyResult>({
    key: "payment-succeeded",
    whenPaused: () => ({ ok: true as const, skipped: true, ids: [] }),
    run: () => enqueuePaymentSuccess(paymentIds),
    outcomeOf: (result) => {
      if (result.ok) return { status: "success", error: null };
      if (result.nothingToDo) return { status: "skipped", error: result.error };
      return { status: "error", error: result.error };
    },
  });
}
```

- [ ] **Step 4: Run the test**

Run: `bun vitest run src/fns/notifyPaymentSuccess.test.ts && bun run typecheck`
Expected: PASS, 4 tests, and typecheck clean.

- [ ] **Step 5: Run the callers' existing suites to prove nothing regressed**

Run: `bun vitest run src/fns/myfatoorahWebhook.test.ts src/fns/confirmGatewayPayment.test.ts`
Expected: PASS, unchanged. These exercise the MyFatoorah path that calls this sender.

- [ ] **Step 6: Commit**

```bash
git add src/fns/notifyPaymentSuccess.ts src/fns/notifyPaymentSuccess.test.ts
git commit -m "feat(workflows): make the payment-succeeded switch real

Gates the sender rather than the webhook and usePayments call sites. This
one returns its outcome instead of throwing, and two of its ok:false
returns mean 'nothing to send' rather than 'broke' — a declined KNET
transaction among them. Those record as skipped, so the monitoring tab
does not sit permanently red."
```

---

## Task 5: Gate both credentials workflows

**Files:**

- Modify: `src/fns/notifyUserCredentials.ts:131-281`
- Create: `src/fns/notifyUserCredentials.test.ts`

**Interfaces:**

- Consumes: `runEventWorkflow` from Task 2; the `user-credentials-managerial` and `user-credentials-tenant` rows from Task 1.
- Produces: `notifyUserCredentials` keeps returning `{ ids }` and gains `skipped`/`reason` **additively**, so its caller at `src/fns/createAppUser.ts:133` — which reads `.ids` — keeps working unmodified.

One function serves two workflows. The managerial and tenant paths already branch on `input.kind`, so the key comes from the same branch and the two rows stay independently switchable without splitting the function.

- [ ] **Step 1: Write the failing test**

Create `src/fns/notifyUserCredentials.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

const maybeSingle = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

vi.mock("@/fns/enqueueNotification", () => ({
  enqueueNotification: (...args: unknown[]) => enqueue(...args),
  getAdminNotificationEmails: async () => ["admin@example.test"],
}));

const { notifyUserCredentials } = await import("./notifyUserCredentials");

const BASE = {
  username: "sara",
  password: "s3cret",
  displayName: "Sara",
  email: "sara@example.test",
};

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });
});

describe("the credentials workflow switches", () => {
  test("a paused managerial workflow enqueues nothing", async () => {
    const result = await notifyUserCredentials({ ...BASE, kind: "managerial" });

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true, ids: [] });
  });

  test("a paused tenant workflow enqueues nothing", async () => {
    const result = await notifyUserCredentials({ ...BASE, kind: "tenant" });

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true, ids: [] });
  });

  test("the managerial path consults the managerial row", async () => {
    // The two kinds must be independently switchable. Reading one key for both
    // would make the managerial switch silently control tenant credentials too.
    await notifyUserCredentials({ ...BASE, kind: "managerial" });

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "user-credentials-managerial" }),
    );
  });

  test("the tenant path consults the tenant row", async () => {
    await notifyUserCredentials({ ...BASE, kind: "tenant" });

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "user-credentials-tenant" }),
    );
  });

  test("the paused return still carries ids, so createAppUser keeps working", async () => {
    // createAppUser reads `.ids`. Replacing the shape rather than extending it
    // would turn a paused workflow into a crash at the call site.
    const result = await notifyUserCredentials({ ...BASE, kind: "managerial" });
    expect(Array.isArray(result.ids)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun vitest run src/fns/notifyUserCredentials.test.ts`
Expected: FAIL — no pause path exists.

- [ ] **Step 3: Wire both gates**

In `src/fns/notifyUserCredentials.ts`, add to the imports:

```ts
import { runEventWorkflow } from "@/fns/workflowRegistry";
```

Change the declaration on line 131 from

```ts
export async function notifyUserCredentials(input: NotifyUserCredentialsInput) {
```

to

```ts
async function enqueueUserCredentials(input: NotifyUserCredentialsInput) {
```

leaving its body completely unchanged. Add the public wrapper immediately after
that function's closing brace:

```ts
/**
 * The two workflows admins see as "Managerial account credentials" and "Tenant
 * portal credentials".
 *
 * One function, two registry rows: the kind already decides which message gets
 * built, so it decides which switch applies. That keeps the two independently
 * switchable without splitting the function in half.
 *
 * The paused result keeps `ids` so createAppUser, which reads it, is unaffected.
 */
export async function notifyUserCredentials(
  input: NotifyUserCredentialsInput,
): Promise<{ ids: string[]; skipped?: true; reason?: string }> {
  return runEventWorkflow<{ ids: string[]; skipped?: true; reason?: string }>({
    key: input.kind === "tenant" ? "user-credentials-tenant" : "user-credentials-managerial",
    whenPaused: () => ({ ids: [], skipped: true as const, reason: "Workflow is paused." }),
    run: () => enqueueUserCredentials(input),
  });
}
```

- [ ] **Step 4: Run the test and the caller's suite**

Run: `bun vitest run src/fns/notifyUserCredentials.test.ts src/fns/createAppUser.test.ts && bun run typecheck`
Expected: PASS — 5 new tests, and `createAppUser.test.ts` unchanged and green.

- [ ] **Step 5: Run the whole suite before moving to the UI**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS. This is the last backend task; the UI tasks depend on all of it.

- [ ] **Step 6: Commit**

```bash
git add src/fns/notifyUserCredentials.ts src/fns/notifyUserCredentials.test.ts
git commit -m "feat(workflows): make both credentials switches real

One function serves two workflows, so the kind that already picks the
message now also picks the registry row — the managerial and tenant
switches stay independent. The paused result keeps ids so createAppUser
is unaffected."
```

---

## Task 6: Types, copy, and the shared table renderer

**Files:**

- Modify: `src/integrations/supabase/database.types.ts:308-322`
- Modify: `src/i18n/dictionary.ts` (both locale maps)
- Create: `src/components/admin/WorkflowTable.tsx`

**Interfaces:**

- Consumes: `kind` from Task 1; `CronJob` from `@/hooks/useCronJobs`.
- Produces:

  ```ts
  export function WorkflowTable(props: {
    kind: "scheduled" | "event";
    rows: CronJob[];
    disabled: boolean;
    onToggle: (job: CronJob, isActive: boolean) => void;
  }): JSX.Element;
  ```

  Task 7 renders this twice.

- [ ] **Step 1: Add `kind` to the hand-maintained types**

In `src/integrations/supabase/database.types.ts`, add one line to `CronJobRow`
(keep the alphabetical ordering the type already uses — between `key` and
`last_duration_ms`):

```ts
kind: "scheduled" | "event";
```

Leave line 1288 alone: `TableDefinition<CronJobRow, "key" | "name_ar" | "name_en">`
lists the columns required on insert, and `kind` has a database default so it
stays optional.

**Do not run `bun run gen:types`.** This file is hand-maintained despite looking
generated; the generator does not emit the 73 aliases ~70 files import.

- [ ] **Step 2: Add the copy in both locales**

In `src/i18n/dictionary.ts`, add to the **Arabic** map, immediately after the
`"cron.nothingScheduledHint"` entry (around line 1237):

```ts
    "workflows.title": "سير العمل",
    "workflows.subtitle": "المهام المجدولة والعمليات التي تُشغّلها أحداث النظام",
    "workflows.scheduledTab": "المهام المجدولة",
    "workflows.eventTab": "سير عمل مرتبط بحدث",
    "workflows.scheduledHint": "تعمل هذه المهام وفق جدول زمني على الخادم.",
    "workflows.eventHint": "تعمل هذه العمليات عند وقوع حدث في النظام، لا وفق جدول زمني.",
    "workflows.workflow": "سير العمل",
    "workflows.neverTriggered": "لم يُشغَّل بعد",
    "workflows.queueTime": "مدة الإدراج",
    "workflows.lastTriggered": "آخر تشغيل",
```

and the matching **English** entries after `"cron.nothingScheduledHint"` in the
English map (around line 2594):

```ts
    "workflows.title": "Workflows",
    "workflows.subtitle": "Scheduled jobs and the workflows your system events trigger",
    "workflows.scheduledTab": "Scheduled jobs",
    "workflows.eventTab": "Action trigger workflows",
    "workflows.scheduledHint": "These run on a schedule set on the server.",
    "workflows.eventHint": "These run when something happens in the system, not on a schedule.",
    "workflows.workflow": "Workflow",
    "workflows.neverTriggered": "Not triggered yet",
    "workflows.queueTime": "Queue time",
    "workflows.lastTriggered": "Last triggered",
```

**`typecheck` will NOT catch a missing key.** The dictionary is
`Record<Locale, Record<string, string>>` (`src/i18n/dictionary.ts:14-16`) — there
is no parity constraint between the two maps, so a key added to only one locale
compiles cleanly and ships as a raw `workflows.title` string on screen. Verify
by hand:

Run: `rg -c "workflows\." src/i18n/dictionary.ts`
Expected: `20` — ten keys in each locale. If it prints anything else, one map is
missing entries.

- [ ] **Step 3: Write the shared renderer**

Create `src/components/admin/WorkflowTable.tsx`:

```tsx
import { CardField, MobileCardList } from "@/components/admin/MobileCardList";
import { Badge } from "@/components/ui/badge";
import { LtrText } from "@/components/ui/ltr-text";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CronJob } from "@/hooks/useCronJobs";
import { useIsMobile } from "@/hooks/use-mobile";
import { useI18n } from "@/i18n/provider";

export type WorkflowKind = "scheduled" | "event";

/**
 * One renderer for both Workflows sub-tabs.
 *
 * Shared rather than duplicated so the identical column set is structural: two
 * components rendering "the same" columns is how they come to disagree.
 *
 * The two kinds differ only in wording, and deliberately so. "Never run" reads
 * as a fault for a nightly job and is perfectly normal for an event workflow —
 * no deposit has been confirmed yet is not a misconfiguration. Likewise
 * duration means enqueue time for an event workflow: delivery happens later, in
 * the notification-drain job, so calling it a send time would mislead.
 *
 * `last_error` on a skipped row carries the *reason* the sender had nothing to
 * do ("Already notified.", "No confirmed payments.") rather than a fault, so it
 * is rendered muted. Only a genuine error is rendered destructive.
 */
export function WorkflowTable({
  kind,
  rows,
  disabled,
  onToggle,
}: {
  kind: WorkflowKind;
  rows: CronJob[];
  disabled: boolean;
  onToggle: (job: CronJob, isActive: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const isMobile = useIsMobile();
  const isEvent = kind === "event";

  const dateFormatter = new Intl.DateTimeFormat(locale === "ar" ? "ar-KW" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const emptyRunLabel = isEvent ? t("workflows.neverTriggered") : t("cron.neverRun");
  const lastRunLabel = isEvent ? t("workflows.lastTriggered") : t("cron.lastRun");
  const durationLabel = isEvent ? t("workflows.queueTime") : t("cron.duration");

  const name = (job: CronJob) => (locale === "ar" ? job.name_ar : job.name_en);
  const description = (job: CronJob) =>
    (locale === "ar" ? job.description_ar : job.description_en) ?? "";

  function statusBadge(job: CronJob) {
    if (!job.last_run_at) return <Badge variant="outline">{emptyRunLabel}</Badge>;
    if (job.last_status === "error") return <Badge variant="destructive">{t("cron.error")}</Badge>;
    if (job.last_status === "skipped") return <Badge variant="outline">{t("cron.skipped")}</Badge>;
    return <Badge variant="secondary">{t("cron.success")}</Badge>;
  }

  if (isMobile) {
    return (
      <MobileCardList
        items={rows}
        keyFor={(job) => job.id}
        renderCard={(job) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium">{name(job)}</p>
                <p className="text-xs text-muted-foreground">{description(job)}</p>
              </div>
              {statusBadge(job)}
            </div>
            <CardField label={lastRunLabel}>
              {job.last_run_at ? (
                <LtrText>{dateFormatter.format(new Date(job.last_run_at))}</LtrText>
              ) : (
                emptyRunLabel
              )}
            </CardField>
            <CardField label={durationLabel}>
              {job.last_duration_ms != null ? (
                <LtrText>{`${job.last_duration_ms} ms`}</LtrText>
              ) : (
                "—"
              )}
            </CardField>
            {job.last_error ? (
              <CardField label={t("cron.lastError")}>
                <span
                  className={
                    job.last_status === "skipped" ? "text-muted-foreground" : "text-destructive"
                  }
                >
                  {job.last_error}
                </span>
              </CardField>
            ) : null}
            <div className="flex items-center gap-2">
              <Switch
                checked={job.is_active}
                disabled={disabled}
                onCheckedChange={(checked) => onToggle(job, checked)}
              />
              <span className="text-sm">{t("cron.enabled")}</span>
            </div>
          </div>
        )}
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{isEvent ? t("workflows.workflow") : t("cron.job")}</TableHead>
          <TableHead>{lastRunLabel}</TableHead>
          <TableHead>{t("cron.status")}</TableHead>
          <TableHead>{durationLabel}</TableHead>
          <TableHead>{t("cron.enabled")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((job) => (
          <TableRow key={job.id}>
            <TableCell>
              <p className="font-medium">{name(job)}</p>
              <p className="text-xs text-muted-foreground">{description(job)}</p>
              <p className="font-mono text-xs text-muted-foreground">{job.key}</p>
            </TableCell>
            <TableCell>
              {job.last_run_at ? (
                <LtrText>{dateFormatter.format(new Date(job.last_run_at))}</LtrText>
              ) : (
                <span className="text-muted-foreground">{emptyRunLabel}</span>
              )}
            </TableCell>
            <TableCell>
              {statusBadge(job)}
              {job.last_error ? (
                <p
                  className={`mt-1 max-w-64 truncate text-xs ${
                    job.last_status === "skipped" ? "text-muted-foreground" : "text-destructive"
                  }`}
                  title={job.last_error}
                >
                  {job.last_error}
                </p>
              ) : null}
            </TableCell>
            <TableCell>
              {job.last_duration_ms != null ? (
                <LtrText>{`${job.last_duration_ms} ms`}</LtrText>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell>
              <Switch
                checked={job.is_active}
                disabled={disabled}
                onCheckedChange={(checked) => onToggle(job, checked)}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 4: Verify it compiles**

Run: `bun run lint && bun run typecheck`
Expected: PASS. `WorkflowTable` is not yet rendered anywhere — that is Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/supabase/database.types.ts src/i18n/dictionary.ts src/components/admin/WorkflowTable.tsx
git commit -m "feat(workflows): add the shared workflow table and its copy

One renderer for both sub-tabs, so the identical column set is
structural. The two kinds differ only in wording: never-run is a fault
for a nightly job and normal for an event workflow, and duration means
enqueue time for events because delivery happens in notification-drain."
```

---

## Task 7: The Workflows panel replaces the Scheduled Jobs tab

**Files:**

- Create: `src/components/admin/WorkflowsPanel.tsx`
- Delete: `src/components/admin/CronJobsPanel.tsx`
- Modify: `src/routes/admin.settings.notifications.tsx:6, 294, 810-815`
- Modify: `src/routes/admin.settings.cron.tsx`

**Interfaces:**

- Consumes: `WorkflowTable` from Task 6; `useCronJobs` / `useSetCronJobActive`.
- Produces: `WorkflowsPanel`, replacing `CronJobsPanel` at both of its render sites.

- [ ] **Step 1: Write the panel**

Create `src/components/admin/WorkflowsPanel.tsx`:

```tsx
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";

import { ModuleHeader, TableState } from "@/components/admin/Phase2Ui";
import { WorkflowTable } from "@/components/admin/WorkflowTable";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { useCronJobs, useSetCronJobActive, type CronJob } from "@/hooks/useCronJobs";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";

/**
 * The Workflows screen: what the system does on its own, in two kinds.
 *
 * Scheduled jobs are dispatched by the cron endpoint on a timetable. Action
 * trigger workflows fire when something happens — a deposit is confirmed, an
 * account is created. Both live in the same registry table and are switched the
 * same way, so they share one query and one renderer.
 *
 * A component rather than a route body because it renders in two places: the
 * standalone /admin/settings/cron route and the Workflows tab of the
 * Automations screen. It keeps its own admin check so neither host has to
 * guard it.
 */
export function WorkflowsPanel() {
  const { t } = useI18n();
  const permissions = usePermissions();
  const jobs = useCronJobs(!permissions.isLoading && permissions.isAdmin);
  const setActive = useSetCronJobActive();

  if (permissions.isLoading) return <p>{t("common.loading")}</p>;
  if (!permissions.isAdmin) {
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;
  }

  const rows = jobs.data ?? [];
  // One query serves both tabs. A second query would buy nothing on a registry
  // this small and would let the two tabs disagree about what they just saw.
  const scheduled = rows.filter((job) => job.kind !== "event");
  const events = rows.filter((job) => job.kind === "event");

  // Scoped to the scheduled rows on purpose. "Nothing has ever run" is a real
  // warning for cron and actively wrong for events — a fleet of
  // never-triggered event rows would otherwise either raise a false alarm or,
  // once one fires, suppress a genuine one.
  const nothingHasEverRun = scheduled.length > 0 && scheduled.every((job) => !job.last_run_at);

  function toggle(job: CronJob, isActive: boolean) {
    setActive.mutate(
      { id: job.id, isActive },
      {
        onSuccess: () => toast.success(isActive ? t("cron.resumed") : t("cron.paused")),
        onError: (error) => toast.error(error instanceof Error ? error.message : t("common.error")),
      },
    );
  }

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader title={t("workflows.title")} subtitle={t("workflows.subtitle")} />

      <Tabs defaultValue="scheduled" className="space-y-4">
        {/* Muted and inset, so this reads as a second level rather than a
            fifth sibling of the Automations tabs above it. */}
        <TabsList className="bg-muted/60">
          <TabsTrigger value="scheduled">
            {t("workflows.scheduledTab")}
            <Badge variant="secondary" className="ms-2">
              {scheduled.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="events">
            {t("workflows.eventTab")}
            <Badge variant="secondary" className="ms-2">
              {events.length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scheduled" className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("workflows.scheduledHint")}</p>

          {nothingHasEverRun && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 size-5 shrink-0" />
              <div>
                <p className="font-medium">{t("cron.nothingScheduled")}</p>
                <p className="mt-1">{t("cron.nothingScheduledHint")}</p>
              </div>
            </div>
          )}

          <TableState loading={jobs.isLoading} error={jobs.isError} empty={!scheduled.length}>
            <WorkflowTable
              kind="scheduled"
              rows={scheduled}
              disabled={setActive.isPending}
              onToggle={toggle}
            />
          </TableState>
        </TabsContent>

        <TabsContent value="events" className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("workflows.eventHint")}</p>

          <TableState loading={jobs.isLoading} error={jobs.isError} empty={!events.length}>
            <WorkflowTable
              kind="event"
              rows={events}
              disabled={setActive.isPending}
              onToggle={toggle}
            />
          </TableState>
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 2: Point the Automations screen at it**

In `src/routes/admin.settings.notifications.tsx`:

Replace the import on line 6:

```ts
import { WorkflowsPanel } from "@/components/admin/WorkflowsPanel";
```

Replace the tab trigger on line 294:

```tsx
{
  permissions.isAdmin && <TabsTrigger value="jobs">{t("workflows.title")}</TabsTrigger>;
}
```

Replace the tab body at lines 810–815:

```tsx
{
  /* The Workflows screen, reused rather than reimplemented. It keeps its
            own admin check, so it is safe even though the trigger above is
            already gated. */
}
<TabsContent value="jobs">
  <WorkflowsPanel />
</TabsContent>;
```

Leave the `value="jobs"` string alone — renaming it would silently reset any
user whose browser remembers the old tab value.

- [ ] **Step 3: Point the standalone route at it**

Replace the whole of `src/routes/admin.settings.cron.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";

import { WorkflowsPanel } from "@/components/admin/WorkflowsPanel";

// The screen itself lives in WorkflowsPanel, because it also renders as the
// Workflows tab of the Automations screen. This route stays for existing links;
// it is no longer listed in the settings nav.
export const Route = createFileRoute("/admin/settings/cron")({ component: WorkflowsPanel });
```

- [ ] **Step 4: Delete the superseded panel**

```bash
git rm src/components/admin/CronJobsPanel.tsx
```

Then confirm nothing still imports it:

Run: `rg "CronJobsPanel" src/`
Expected: no matches. If any remain, point them at `WorkflowsPanel`.

- [ ] **Step 5: Run every gate**

Run: `bun run lint && bun run typecheck && bun run test && bun run build`
Expected: PASS. `build` matters here because these are the only tasks with no
unit-test coverage — this repository has no component tests, so compilation plus
the manual check in Step 6 is the verification.

- [ ] **Step 6: Check it in the browser**

Run: `bun run dev`, sign in as an admin, and open
`/admin/settings/notifications`. Confirm:

1. The fourth tab reads **Workflows**, not Scheduled jobs.
2. It has two sub-tabs: **Scheduled jobs** (7 rows) and **Action trigger workflows** (4 rows).
3. Both show Workflow, Last run/Last triggered, Status, Duration/Queue time, Enabled.
4. The event rows read "Not triggered yet", not "Never run".
5. The amber "nothing scheduled" banner appears only on the scheduled sub-tab.
6. Toggling an event workflow off shows the paused toast and survives a reload.
7. Switch the language to Arabic and confirm both sub-tabs render RTL with no
   missing-key placeholders.

There are no `confirm()` dialogs on this screen, so browser automation is safe
here if you prefer it to a manual pass.

- [ ] **Step 7: Commit**

```bash
git add -A src/components/admin src/routes/admin.settings.notifications.tsx src/routes/admin.settings.cron.tsx
git commit -m "feat(workflows): split Scheduled Jobs into Workflows with two tabs

Scheduled-trigger jobs and action-trigger workflows, sharing one query
and one renderer. The amber 'nothing scheduled' banner is scoped to the
scheduled tab, where it is a real warning — on the event tab a
never-triggered row is normal, not a misconfiguration."
```

---

## Task 8: Update the project docs

**Files:**

- Modify: `CLAUDE.md` (the Architecture section's description of `src/fns/`)
- Modify: `deploy/README.md` (the cron runbook, if it describes the registry)

**Interfaces:**

- Consumes: everything above.
- Produces: nothing code-facing.

- [ ] **Step 1: Check what the docs currently claim**

Run: `rg -n "cron_jobs|Scheduled jobs|scheduled jobs" CLAUDE.md deploy/README.md db/README.md`

- [ ] **Step 2: Correct anything now false**

Update every hit that describes `cron_jobs` as a cron-only registry. At minimum,
add to the `src/fns/` bullet in `CLAUDE.md`:

```markdown
`workflowRegistry` holds the shared pause-and-record gate: the `cron_jobs`
table registers both scheduled jobs and event-triggered workflows, told apart
by `kind`. Event senders call `runEventWorkflow` rather than checking the
switch at their call sites.
```

Do not invent claims about behaviour you have not verified — only describe what
the tasks above actually built.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md deploy/README.md
git commit -m "docs: describe the shared workflow registry"
```

---

## Self-Review

**Spec coverage**

| Spec section                                                                        | Task                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| §2 extend `cron_jobs`, keep the name                                                | 1                                                             |
| §2 adding rows cannot make them runnable                                            | 2, step 6                                                     |
| §3 schema, seeds, `do update` excludes `is_active`                                  | 1                                                             |
| §4 shared `workflowRegistry`, gate inside senders, fails open                       | 2, 3, 4, 5                                                    |
| §5 duration = enqueue time; per-kind empty state; banner scoped                     | 6, 7                                                          |
| §6 `WorkflowsPanel` + `WorkflowTable`, one query, inner tabs distinct, legacy route | 6, 7                                                          |
| §7 `database.types.ts`, i18n, notifications route                                   | 6, 7                                                          |
| §8 tests 1–5                                                                        | 3/4/5 (test 1), 2 (tests 2, 3), 2 step 6 (test 4), 1 (test 5) |

**Type consistency** — `runEventWorkflow`'s options object is defined once in
Task 2 and consumed with the same four field names (`key`, `whenPaused`, `run`,
`outcomeOf`) in Tasks 3, 4 and 5. `outcomeOf` returns
`{ status: WorkflowRunStatus; error: string | null }` at every one of its four
uses. `PaymentNotifyResult` is defined in Task 4 and used only there.
`WorkflowTable`'s four props are defined in Task 6 and passed with the same
names in Task 7. `CronJob` is the existing export from `@/hooks/useCronJobs`
throughout.

**Correction made after review** — an earlier draft of this plan used a boolean
`failureOf` hook, which collapsed three outcomes into two and got the answer
wrong in both directions: every declined KNET transaction would have recorded
`last_status = 'error'` on the `payment-succeeded` row (a permanent red badge on
the monitoring tab), while all three of the deposit sender's normal skips would
have recorded `success` (hiding "No admin email recipients configured", a real
misconfiguration). It is now `outcomeOf`, returning one of the three states
`last_status` has always accepted. Tasks 3 and 4 each carry a test that fails if
the collapse returns.

Two claims in that draft were also asserted rather than verified, and one was
false: `typecheck` does **not** enforce AR/EN dictionary key parity
(`type Dict = Record<string, string>`), so Task 6 now checks it with `rg`.

**Known gap, stated rather than hidden** — Tasks 6 and 7 have no automated test.
This repository has no component-test harness (every test is `src/fns/*.test.ts`
or `src/db/*.sqltest.ts`), and adding one is out of scope for this piece. Their
verification is `lint` + `typecheck` + `build` plus the explicit seven-point
browser check in Task 7 Step 6. The logic that could silently break — the gate —
is fully covered in Tasks 2–5.
