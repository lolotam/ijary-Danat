# Five New Event Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify the admin recipients when a contact inquiry arrives, a maintenance request is logged, a refund is applied, or a contract is created or ended — five independently switchable workflows, template-driven from birth.

**Architecture:** Each is the exact shape `notifyDepositConfirmedRecord` established in Piece 1: a private `enqueueX` wrapped in `runEventWorkflow`, gated inside the sender rather than at the trigger site, with per-entity idempotency and three-state outcome classification. Bodies come from `loadTemplateCopy` (Piece 2), so no new hardcoded builders are written.

**Tech Stack:** TanStack Start (React 19), Bun, Vitest, self-hosted Supabase (Postgres 17.6), manual SQL migrations.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-02-new-event-workflows-design.md`. Read it before Task 1.
- **Branch:** `feat/new-event-workflows`, cut from `feat/authoritative-templates`. **Piece 2 must be merged or present** — Task 3 onward imports `loadTemplateCopy`.
- **Two migration files, and the order matters.** `notification_types` is a real Postgres enum (`07_phase5_notifications_reports.sql:8`). `ALTER TYPE … ADD VALUE` cannot have its new value **used** in the same transaction, and migrations are applied with `--single-transaction`. Migration 71 adds the values; migration 72 uses them. **Never merge them into one file** — it fails on the live database.
- **Migrations go to the LIVE database over `ssh-danatfuture-mcp`, not local Docker.** Container `danatfuture-supabase-ozoxsa-db-1`, `psql -U supabase_admin -d postgres`, `-v ON_ERROR_STOP=1 --single-transaction`, one file at a time. Apply only the new migrations. SSH exec caps commands at **1000 characters**: `base64 -w0`, `split -b 800`, chunked `printf … >>`, `base64 -d`, then **verify `md5sum`** before running.
- **Snapshot `cron_jobs` and `notification_templates` before writing.**
- **`database.types.ts` is hand-maintained.** Add the five enum members by hand. Never `bun run gen:types`.
- **Both locales for every string.** `type Dict = Record<string, string>` — `typecheck` will **not** catch a missing key. Verify with `rg -c`.
- **A notification failure must never fail the underlying mutation.** Every call site awaits the notifier inside `try`/`catch` that logs and swallows, matching `useDeposits.ts`.
- **Gates before presenting any task:** `bun run lint`, `bun run typecheck`, `bun run test`.
- Commit after every task. Never force-push, rebase, amend or squash.

---

## File Structure

| File                                                   | Responsibility                                  | Task |
| ------------------------------------------------------ | ----------------------------------------------- | ---- |
| `db/migrations/71_new_workflow_notification_types.sql` | The five enum values, nothing else              | 1    |
| `db/migrations/72_new_event_workflows.sql`             | 5 registry rows + 10 template rows              | 2    |
| `src/db/newEventWorkflows.sqltest.ts`                  | Enum values, rows, idempotency                  | 2    |
| `src/integrations/supabase/database.types.ts`          | Five `NotificationType` members                 | 2    |
| `src/i18n/dictionary.ts`                               | `notificationType.*` for the five, both locales | 2    |
| `src/routes/admin.settings.notifications.tsx`          | Add the five to `notificationTypes`             | 2    |
| `src/lib/templateVariables.ts`                         | Placeholders + samples for the five             | 2    |
| `src/fns/notifyContactInquiry.ts` (+ test)             | Workflow 1                                      | 3    |
| `src/fns/submitContactInquiry.ts`                      | Trigger 1                                       | 3    |
| `src/fns/notifyMaintenanceRequest.ts` (+ test)         | Workflow 2                                      | 4    |
| `src/hooks/useMaintenance.ts`                          | Trigger 2                                       | 4    |
| `src/fns/notifyRefundRecorded.ts` (+ test)             | Workflow 3                                      | 5    |
| `src/hooks/useRefunds.ts`                              | Trigger 3                                       | 5    |
| `src/fns/notifyContractLifecycle.ts` (+ test)          | Workflows 4 and 5                               | 6    |
| `src/hooks/useContracts.ts`                            | Triggers 4 and 5                                | 6    |

---

## Task 1: The enum values, alone

**Files:**

- Create: `db/migrations/71_new_workflow_notification_types.sql`

**Interfaces:**

- Consumes: nothing.
- Produces: `notification_types` gains `contact_inquiry`, `maintenance_request`, `refund_recorded`, `contract_created`, `contract_ended`. Migration 72 and every later task depend on these existing.

This file exists **only** because of the transaction rule. Adding one statement
to migration 72 instead would fail on the live database.

- [ ] **Step 1: Write the migration**

Create `db/migrations/71_new_workflow_notification_types.sql`:

```sql
-- ---------------------------------------------------------------------------
-- 71 — notification types for the five new event workflows
-- ---------------------------------------------------------------------------
--
-- SEPARATE FILE ON PURPOSE. `notification_types` is a real Postgres enum
-- (07_phase5_notifications_reports.sql:8). `alter type … add value` may run
-- inside a transaction block, but the new value CANNOT BE USED in that same
-- transaction. Migrations are applied with --single-transaction, so seeding a
-- notification_templates row that references one of these in the same file
-- fails with "unsafe use of new value of enum type". Migration 72 uses them.
--
-- Each gets its own type rather than overloading an existing one: the
-- notification pool's type filter is what makes the log usable, and filing a
-- contract-created admin email under "Contract expiry" — a tenant-facing type —
-- would quietly break it.

alter type public.notification_types add value if not exists 'contact_inquiry';
alter type public.notification_types add value if not exists 'maintenance_request';
alter type public.notification_types add value if not exists 'refund_recorded';
alter type public.notification_types add value if not exists 'contract_created';
alter type public.notification_types add value if not exists 'contract_ended';
```

`if not exists` makes it re-runnable, which the repo's migrations generally are.

- [ ] **Step 2: Apply it to the live database**

Snapshot first:

```bash
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -tAc \
  "select unnest(enum_range(null::public.notification_types));"
```

Then transfer per the Global Constraints (base64 chunks, md5 verified) and apply.
Verify:

```bash
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -tAc \
  "select unnest(enum_range(null::public.notification_types));"
```

Expected: the original 11 plus the five new ones.

- [ ] **Step 3: Commit**

```bash
git add db/migrations/71_new_workflow_notification_types.sql
git commit -m "feat(workflows): add notification types for the five new workflows

Separate file because ALTER TYPE ADD VALUE cannot have its value used in the
same transaction, and migrations run with --single-transaction. Migration 72
uses them."
```

---

## Task 2: The registry rows, templates, types and copy

**Files:**

- Create: `db/migrations/72_new_event_workflows.sql`, `src/db/newEventWorkflows.sqltest.ts`
- Modify: `src/integrations/supabase/database.types.ts`, `src/i18n/dictionary.ts`, `src/routes/admin.settings.notifications.tsx`, `src/lib/templateVariables.ts`

**Interfaces:**

- Consumes: the enum values from Task 1.
- Produces: five `cron_jobs` rows with `kind = 'event'` and keys
  `contact-inquiry-received`, `maintenance-request-created`, `refund-recorded`,
  `contract-created`, `contract-ended`; ten `notification_templates` rows.
  Tasks 3–6 reference these keys and codes verbatim.

- [ ] **Step 1: Write the failing sqltest**

Create `src/db/newEventWorkflows.sqltest.ts`:

```ts
import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

const KEYS = [
  "contact-inquiry-received",
  "contract-created",
  "contract-ended",
  "maintenance-request-created",
  "refund-recorded",
];

const CODES = [
  "contact-inquiry-ar",
  "contact-inquiry-en",
  "contract-created-ar",
  "contract-created-en",
  "contract-ended-ar",
  "contract-ended-en",
  "maintenance-request-ar",
  "maintenance-request-en",
  "refund-recorded-ar",
  "refund-recorded-en",
];

describe("migration 71 — the enum", () => {
  test("the five new notification types exist", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ v: string }>(
        `select unnest(enum_range(null::public.notification_types))::text as v`,
      );
      const values = rows.map((r) => r.v);
      for (const t of [
        "contact_inquiry",
        "maintenance_request",
        "refund_recorded",
        "contract_created",
        "contract_ended",
      ]) {
        expect(values).toContain(t);
      }
    });
  });
});

describe("migration 72 — rows", () => {
  test("the five workflows are registered as events", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ key: string }>(
        `select key from public.cron_jobs
          where kind = 'event' and key = any($1::text[]) order by key`,
        [KEYS],
      );
      expect(rows.map((r) => r.key)).toEqual(KEYS);
    });
  });

  test("the registry now holds sixteen rows in total", async () => {
    // 7 scheduled + 4 from Piece 1 + 5 here. A count that drifts means a seed
    // landed twice or not at all.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n from public.cron_jobs`,
      );
      expect(rows[0].n).toBe("16");
    });
  });

  test("ten templates exist, both locales, active, with bodies", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ code: string }>(
        `select code from public.notification_templates
          where code = any($1::text[])
            and is_active and body_ar is not null and body_en is not null
          order by code`,
        [CODES],
      );
      expect(rows.map((r) => r.code)).toEqual(CODES);
    });
  });

  test("re-running the seed does not re-enable a paused workflow", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.cron_jobs set is_active = false where key = 'refund-recorded'`,
      );
      await client.query(
        `insert into public.cron_jobs (key, kind, name_ar, name_en)
           values ('refund-recorded', 'event', 'ر', 'Refund recorded')
         on conflict (key) do update
           set kind = excluded.kind, name_ar = excluded.name_ar, name_en = excluded.name_en`,
      );
      const { rows } = await client.query<{ is_active: boolean }>(
        `select is_active from public.cron_jobs where key = 'refund-recorded'`,
      );
      expect(rows[0].is_active).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun vitest run --config vitest.sql.config.ts src/db/newEventWorkflows.sqltest.ts`
Expected: FAIL — the enum values and rows do not exist.

- [ ] **Step 3: Write migration 72**

Create `db/migrations/72_new_event_workflows.sql`. Header:

```sql
-- ---------------------------------------------------------------------------
-- 72 — five event workflows: contact inquiry, maintenance, refund, contract
-- ---------------------------------------------------------------------------
--
-- Depends on migration 71 having COMMITTED: it uses the enum values 71 adds, and
-- a new enum value cannot be used in the transaction that created it.
--
-- Contract created and ended are two rows, not one. They are different triggers
-- on different code paths, and independent switchability is the point of the
-- registry — an admin who wants terminations but not every new contract must be
-- able to say so.
--
-- `do update` deliberately does NOT touch is_active on either table: replaying
-- must never silently re-enable a workflow an admin switched off.
```

Then the five `cron_jobs` rows with `kind = 'event'` and bilingual
names/descriptions stating the **trigger** (e.g. "Emails the admin recipients
when a visitor submits the contact form"), and the ten
`notification_templates` rows — `channel = 'email'`, one per locale, with
`{{placeholder}}` bodies as inner content per Piece 2's contract.

Both inserts use `on conflict … do update` on the name/description/body columns
only.

- [ ] **Step 4: Add the enum members to the hand-maintained types**

In `src/integrations/supabase/database.types.ts`, find the `NotificationType`
union and add the five members. **Do not run `gen:types`.**

- [ ] **Step 5: Add the type labels in both locales**

In `src/i18n/dictionary.ts`, **Arabic** map:

```ts
    "notificationType.contact_inquiry": "طلب تواصل",
    "notificationType.maintenance_request": "طلب صيانة",
    "notificationType.refund_recorded": "استرداد مبلغ",
    "notificationType.contract_created": "عقد جديد",
    "notificationType.contract_ended": "انتهاء عقد",
```

**English** map:

```ts
    "notificationType.contact_inquiry": "Contact inquiry",
    "notificationType.maintenance_request": "Maintenance request",
    "notificationType.refund_recorded": "Refund recorded",
    "notificationType.contract_created": "Contract created",
    "notificationType.contract_ended": "Contract ended",
```

Verify parity — `typecheck` will not:

Run: `rg -c '"notificationType\.(contact_inquiry|maintenance_request|refund_recorded|contract_created|contract_ended)"' src/i18n/dictionary.ts`
Expected: `10`.

- [ ] **Step 6: Add them to the pool's type filter**

In `src/routes/admin.settings.notifications.tsx`, extend the
`notificationTypes` array (line ~76) with the five new values. Without this the
new rows appear in the log but cannot be filtered for — the exact reason they got
their own types.

- [ ] **Step 7: Declare their placeholders**

In `src/lib/templateVariables.ts`, add an entry per type, matching the variables
the senders will supply in Tasks 3–6:

```ts
  contact_inquiry: [
    v("name", "الاسم", "Name", "سارة العتيبي"),
    v("email", "البريد", "Email", "sara@example.com"),
    v("phone", "الهاتف", "Phone", "+965 5000 0000"),
    v("message", "الرسالة", "Message", "أرغب في الاستفسار عن شقة"),
  ],
  maintenance_request: [
    v("code", "رقم الطلب", "Request code", "MNT-2026-0031"),
    v("title", "العنوان", "Title", "تسريب مياه"),
    v("unit_name", "الوحدة", "Unit", "شقة 12"),
    v("priority", "الأولوية", "Priority", "عالية"),
  ],
  refund_recorded: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("amount", "المبلغ", "Amount", "150.000 KWD"),
    v("reason", "السبب", "Reason", "إلغاء عقد"),
    v("code", "الرقم", "Code", "REF-2026-0009"),
  ],
  contract_created: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("contract_code", "رقم العقد", "Contract code", "CTR-2026-0044"),
    v("unit_name", "الوحدة", "Unit", "شقة 12"),
    v("start_date", "تاريخ البداية", "Start date", "2026-09-01"),
    v("end_date", "تاريخ الانتهاء", "End date", "2027-08-31"),
  ],
  contract_ended: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("contract_code", "رقم العقد", "Contract code", "CTR-2025-0130"),
    v("unit_name", "الوحدة", "Unit", "شقة 12"),
    v("end_date", "تاريخ الانتهاء", "End date", "2026-08-31"),
  ],
```

- [ ] **Step 8: Apply both migrations to the live database, in order**

Apply 71 first (if Task 1 has not already), then 72 — **two separate psql
invocations**, never one. Verify with the queries in Task 1 Step 2 plus:

```bash
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U supabase_admin -d postgres -tAc \
  "select kind, count(*) from public.cron_jobs group by kind order by kind;"
```

Expected: `event|9`, `scheduled|7`.

- [ ] **Step 9: Run the gates**

Run: `bun vitest run --config vitest.sql.config.ts src/db/newEventWorkflows.sqltest.ts && bun run lint && bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add db/migrations/72_new_event_workflows.sql src/db/newEventWorkflows.sqltest.ts src/integrations/supabase/database.types.ts src/i18n/dictionary.ts src/routes/admin.settings.notifications.tsx src/lib/templateVariables.ts
git commit -m "feat(workflows): register five event workflows and their templates

Contract created and ended are two independently switchable rows, not one.
Each workflow gets its own notification type so the pool's type filter stays
honest rather than filing admin mail under a tenant-facing type."
```

---

## Task 3: Contact inquiry — the sharpest gap

**Files:**

- Create: `src/fns/notifyContactInquiry.ts`, `src/fns/notifyContactInquiry.test.ts`
- Modify: `src/fns/submitContactInquiry.ts:58`

**Interfaces:**

- Consumes: `runEventWorkflow` (Piece 1), `loadTemplateCopy` + `renderEmailDocument` (Piece 2), `enqueueNotification`, `getAdminNotificationEmails`.
- Produces:
  ```ts
  export async function notifyContactInquiryRecord(
    inquiryId: string,
  ): Promise<
    { skipped: true; reason: string } | { skipped: false; notification: Tables<"notifications"> }
  >;
  ```
  Tasks 4–6 copy this shape exactly.

This is the only one of the five whose trigger is already a server function, so
no `createServerFn` wrapper is needed.

- [ ] **Step 1: Write the failing test**

Create `src/fns/notifyContactInquiry.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

const maybeSingle = vi.fn();
const single = vi.fn();
const limit = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle, single, eq: () => ({ maybeSingle }), neq: () => ({ limit }) }),
      }),
    }),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

vi.mock("@/fns/enqueueNotification", () => ({
  enqueueNotification: (...args: unknown[]) => enqueue(...args),
  getAdminNotificationEmails: async () => ["admin@example.test"],
}));

const { notifyContactInquiryRecord } = await import("./notifyContactInquiry");

const ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  limit.mockResolvedValue({ data: [], error: null });
  enqueue.mockResolvedValue({ id: "n1" });
});

describe("the contact-inquiry-received switch", () => {
  test("a paused workflow enqueues nothing", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    const result = await notifyContactInquiryRecord(ID);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
  });

  test("pausing records against this workflow's own key", async () => {
    // Nine event rows now share one table; a sender reading the wrong key makes
    // one switch silently control another.
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    await notifyContactInquiryRecord(ID);

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "contact-inquiry-received", _status: "skipped" }),
    );
  });

  test("an already-notified inquiry records skipped, not success", async () => {
    // Idempotency: a retried mutation must not email the admins twice, and the
    // registry must not claim a send that did not happen.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    single.mockResolvedValue({ data: { id: ID, name: "Sara" }, error: null });
    limit.mockResolvedValue({ data: [{ id: "existing" }], error: null });

    const result = await notifyContactInquiryRecord(ID);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "skipped" }),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun vitest run src/fns/notifyContactInquiry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/fns/notifyContactInquiry.ts`:

```ts
import { enqueueNotification, getAdminNotificationEmails } from "@/fns/enqueueNotification";
import { loadTemplateCopy } from "@/fns/loadTemplateCopy";
import { runEventWorkflow } from "@/fns/workflowRegistry";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { renderEmailDocument, type EmailLocale } from "@/lib/emailTemplates";

const WORKFLOW_KEY = "contact-inquiry-received";

async function enqueueContactInquiry(inquiryId: string) {
  const found = await supabaseAdmin
    .from("contact_inquiries")
    .select("*")
    .eq("id", inquiryId)
    .single();
  if (found.error) throw new Error(found.error.message);
  const inquiry = found.data;

  // Idempotency: a retried mutation must not email the admins twice.
  const existing = await supabaseAdmin
    .from("notifications")
    .select("id")
    .eq("type", "contact_inquiry")
    .contains("payload", { inquiry_id: inquiryId })
    .neq("state", "cancelled")
    .limit(1);
  if (!existing.error && existing.data?.length) {
    return { skipped: true as const, reason: "Already notified." };
  }

  const adminEmails = await getAdminNotificationEmails();
  if (!adminEmails.length) {
    return { skipped: true as const, reason: "No admin email recipients configured." };
  }

  const company = await supabaseAdmin
    .from("companies")
    .select("default_locale")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const locale = (company.data?.default_locale ?? "ar") as EmailLocale;

  const variables = {
    name: inquiry.name ?? "",
    email: inquiry.email ?? "",
    phone: inquiry.phone ?? "",
    message: inquiry.message ?? "",
  };
  const code = locale === "ar" ? "contact-inquiry-ar" : "contact-inquiry-en";
  const copy = await loadTemplateCopy(code, locale, variables);
  const subject = copy.subject ?? (locale === "ar" ? `طلب تواصل جديد` : `New contact inquiry`);
  const body = renderEmailDocument(
    locale,
    subject,
    copy.body ?? `<p>${variables.name} — ${variables.email}</p><p>${variables.message}</p>`,
  );

  const notification = await enqueueNotification({
    type: "contact_inquiry",
    channel: "email",
    audience: "admin",
    locale,
    subject,
    body,
    recipientAddress: adminEmails[0],
    templateCode: code,
    payload: { inquiry_id: inquiryId, recipients: adminEmails },
  });

  return { skipped: false as const, notification };
}

/**
 * The workflow admins see as "Contact inquiry received".
 *
 * The gate lives here rather than at the trigger site, so submitContactInquiry
 * cannot forget it.
 */
export async function notifyContactInquiryRecord(inquiryId: string) {
  type Result = Awaited<ReturnType<typeof enqueueContactInquiry>>;
  return runEventWorkflow<Result>({
    key: WORKFLOW_KEY,
    whenPaused: () => ({ skipped: true as const, reason: "Workflow is paused." }),
    run: () => enqueueContactInquiry(inquiryId),
    // "Already notified" and "no recipients configured" are skips, not sends.
    // Recording them as successes would hide the second, a real misconfiguration.
    outcomeOf: (result) =>
      result.skipped
        ? { status: "skipped" as const, error: result.reason }
        : { status: "success" as const, error: null },
  });
}
```

- [ ] **Step 4: Wire the trigger, without letting it break the public form**

In `src/fns/submitContactInquiry.ts`, after the insert succeeds, capture the new
row's id (add `.select("id").single()` to the insert) and then:

```ts
// The public contact form must succeed even if notification fails — a
// visitor's inquiry is stored either way. Never let this throw outward.
try {
  await notifyContactInquiryRecord(inserted.id);
} catch (error) {
  console.error("notifyContactInquiry failed:", error);
}
```

- [ ] **Step 5: Add the does-not-break-the-form test**

Append to `src/fns/submitContactInquiry.test.ts`:

```ts
test("a notification failure does not fail the inquiry submission", async () => {
  // The form is public. A visitor's inquiry must be stored even when SMTP, the
  // registry, or the notifier itself is down.
  notify.mockRejectedValueOnce(new Error("smtp down"));

  const result = await submitContactInquiry({ data: VALID_INQUIRY });

  expect(result).toMatchObject({ success: true });
});
```

mocking `@/fns/notifyContactInquiry` alongside the existing mocks.

- [ ] **Step 6: Run the gates**

Run: `bun vitest run src/fns/notifyContactInquiry.test.ts src/fns/submitContactInquiry.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/fns/notifyContactInquiry.ts src/fns/notifyContactInquiry.test.ts src/fns/submitContactInquiry.ts src/fns/submitContactInquiry.test.ts
git commit -m "feat(workflows): tell someone when a contact inquiry arrives

Until now a visitor could type their name and phone into the public site
asking to rent a property, the row stored correctly, and nobody told. The
notifier is wrapped in try/catch at the trigger: the inquiry must be stored
even when mail is down."
```

---

## Task 4: Maintenance request

**Files:**

- Create: `src/fns/notifyMaintenanceRequest.ts`, `src/fns/notifyMaintenanceRequest.test.ts`
- Modify: `src/hooks/useMaintenance.ts:111`

**Interfaces:**

- Consumes: the same set as Task 3.
- Produces: `notifyMaintenanceRequestRecord(requestId)` plus a guarded
  `createServerFn` wrapper `notifyMaintenanceRequest`, because the trigger is a
  client hook and cannot use `supabaseAdmin`.

- [ ] **Step 1: Write the failing test**

Copy `src/fns/notifyContactInquiry.test.ts` verbatim, changing: the import to
`./notifyMaintenanceRequest`, the exported name to
`notifyMaintenanceRequestRecord`, and the expected key to
`"maintenance-request-created"`. Keep all three tests (paused enqueues nothing;
records its own key; already-notified is skipped) — they are the set that caught
real defects in Piece 1.

- [ ] **Step 2: Run to verify it fails**

Run: `bun vitest run src/fns/notifyMaintenanceRequest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/fns/notifyMaintenanceRequest.ts` following Task 3's file exactly,
with:

- `const WORKFLOW_KEY = "maintenance-request-created";`
- table `maintenance_requests`, type `maintenance_request`
- template codes `maintenance-request-ar` / `maintenance-request-en`
- variables `{ code, title, unit_name, priority }`
- payload `{ request_id: requestId, recipients: adminEmails }`

Add the guarded server function, mirroring `notifyDepositConfirmed`:

```ts
const schema = z.object({ requestId: z.string().uuid() });

export const notifyMaintenanceRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data, context }) => {
    const permission = await context.supabase.rpc("has_permission", {
      _code: "maintenance.create",
      _user_id: context.userId,
    });
    if (permission.error || !permission.data) {
      throw new Error("Forbidden");
    }
    return notifyMaintenanceRequestRecord(data.requestId);
  });
```

Throw an `Error`, **not** `new Response(403)` — a thrown `Response` resolves as
_success_ on the client in this codebase.

- [ ] **Step 4: Wire the trigger**

In `src/hooks/useMaintenance.ts`, in `useCreateMaintenanceRequest`'s `onSuccess`
(or after the insert resolves), matching `useDeposits.ts:171`:

```ts
try {
  await notifyMaintenanceRequestFn({ data: { requestId: data.id } });
} catch (error) {
  console.error("notifyMaintenanceRequest failed:", error);
}
```

- [ ] **Step 5: Run the gates and commit**

Run: `bun vitest run src/fns/notifyMaintenanceRequest.test.ts && bun run lint && bun run typecheck`

```bash
git add src/fns/notifyMaintenanceRequest.ts src/fns/notifyMaintenanceRequest.test.ts src/hooks/useMaintenance.ts
git commit -m "feat(workflows): notify admins when a maintenance request is logged"
```

---

## Task 5: Refund recorded

**Files:**

- Create: `src/fns/notifyRefundRecorded.ts`, `src/fns/notifyRefundRecorded.test.ts`
- Modify: `src/hooks/useRefunds.ts:121` (`useApplyRefundAction`)

**Interfaces:**

- Consumes: the same set as Task 3.
- Produces: `notifyRefundRecordedRecord(refundId)` plus a guarded
  `notifyRefundRecorded` server function.

Money leaving the system is the event with the highest cost of being missed.

- [ ] **Step 1: Write the failing test**

Copy Task 3's test file, changing the import to `./notifyRefundRecorded`, the
export to `notifyRefundRecordedRecord`, and the key to `"refund-recorded"`.

- [ ] **Step 2: Run to verify it fails**

Run: `bun vitest run src/fns/notifyRefundRecorded.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Follow Task 3's file, with:

- `const WORKFLOW_KEY = "refund-recorded";`
- table `refunds`, type `refund_recorded`
- codes `refund-recorded-ar` / `refund-recorded-en`
- variables `{ tenant_name, amount, reason, code }`
- payload `{ refund_id: refundId, recipients: adminEmails }`
- permission code `refunds.update` in the server-function guard, falling back to
  `refunds.create` the way `notifyDepositConfirmed` does

- [ ] **Step 4: Wire the trigger**

In `useApplyRefundAction`'s success path, inside `try`/`catch` as above.

- [ ] **Step 5: Run the gates and commit**

Run: `bun vitest run src/fns/notifyRefundRecorded.test.ts && bun run lint && bun run typecheck && bun run test`

```bash
git add src/fns/notifyRefundRecorded.ts src/fns/notifyRefundRecorded.test.ts src/hooks/useRefunds.ts
git commit -m "feat(workflows): alert admins when a refund is applied

Money leaving the system previously notified nobody."
```

---

## Task 6: Contract created and contract ended

**Files:**

- Create: `src/fns/notifyContractLifecycle.ts`, `src/fns/notifyContractLifecycle.test.ts`
- Modify: `src/hooks/useContracts.ts:172` and `:196`

**Interfaces:**

- Consumes: the same set as Task 3.
- Produces:
  ```ts
  export async function notifyContractCreatedRecord(contractId: string);
  export async function notifyContractEndedRecord(contractId: string);
  export const notifyContractLifecycle; // guarded server fn taking { contractId, event }
  ```

One file, two workflows — the same arrangement `notifyUserCredentials` uses for
its two credential workflows. **Each consults its own registry key**, so the two
stay independently switchable.

- [ ] **Step 1: Write the failing test**

Create `src/fns/notifyContractLifecycle.test.ts` using Task 3's mock setup, with
these tests:

```ts
describe("the two contract workflows are independently switchable", () => {
  test("created consults contract-created", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });
    await notifyContractCreatedRecord(ID);
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "contract-created", _status: "skipped" }),
    );
  });

  test("ended consults contract-ended", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });
    await notifyContractEndedRecord(ID);
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "contract-ended", _status: "skipped" }),
    );
  });

  test("pausing one does not silence the other", async () => {
    // The whole reason these are two rows rather than one: an admin who wants
    // terminations but not every new contract must be able to say so.
    maybeSingle.mockResolvedValueOnce({ data: { is_active: false }, error: null });
    await notifyContractCreatedRecord(ID);
    expect(enqueue).not.toHaveBeenCalled();

    vi.clearAllMocks();
    rpc.mockResolvedValue({ data: null, error: null });
    limit.mockResolvedValue({ data: [], error: null });
    enqueue.mockResolvedValue({ id: "n1" });
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    single.mockResolvedValue({ data: { id: ID, code: "CTR-1" }, error: null });

    await notifyContractEndedRecord(ID);
    expect(enqueue).toHaveBeenCalled();
  });
});
```

Plus the paused-enqueues-nothing and already-notified-is-skipped tests for both.

- [ ] **Step 2: Run to verify it fails**

Run: `bun vitest run src/fns/notifyContractLifecycle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

One private `enqueueContractEvent(contractId, event: "created" | "ended")` that
selects the type, code and payload from `event`, and two thin exports:

```ts
export async function notifyContractCreatedRecord(contractId: string) {
  type Result = Awaited<ReturnType<typeof enqueueContractEvent>>;
  return runEventWorkflow<Result>({
    key: "contract-created",
    whenPaused: () => ({ skipped: true as const, reason: "Workflow is paused." }),
    run: () => enqueueContractEvent(contractId, "created"),
    outcomeOf: (result) =>
      result.skipped
        ? { status: "skipped" as const, error: result.reason }
        : { status: "success" as const, error: null },
  });
}
```

and the same for `ended` with `key: "contract-ended"`.

Idempotency keys on `{ contract_id, event }` in the payload, so a contract that
is created _and later_ ended produces two notifications rather than the second
being suppressed as a duplicate of the first.

- [ ] **Step 4: Wire both triggers**

`useCreateContract` calls the created variant. `useUpdateContract` calls the
ended variant **only on a transition into an ended state** — compare the previous
state to the next and fire only when it changes, or every subsequent edit to an
already-ended contract re-notifies. Both inside `try`/`catch`.

- [ ] **Step 5: Run every gate**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 6: Browser check**

Run `bun run dev`, open `/admin/settings/notifications` → Workflows → Action
trigger workflows. Confirm **nine** event rows, each with its own switch, and
that the five new ones read "Not triggered yet". Submit the public contact form
and confirm that row's status becomes a success with a recent timestamp, and a
notification appears in the pool typed "Contact inquiry".

- [ ] **Step 7: Commit**

```bash
git add src/fns/notifyContractLifecycle.ts src/fns/notifyContractLifecycle.test.ts src/hooks/useContracts.ts
git commit -m "feat(workflows): notify on contract created and contract ended

Two registry rows, not one: different triggers on different code paths, and
an admin who wants terminations but not every new contract must be able to
say so. Ended fires only on a transition into an ended state, so editing an
already-ended contract does not re-notify."
```

---

## Self-Review

**Spec coverage**

| Spec section                                                              | Task                          |
| ------------------------------------------------------------------------- | ----------------------------- |
| §2 five rows not four; triggers; admin recipients                         | 2, 3, 4, 5, 6                 |
| §3 deposit-sender shape, gate inside, idempotency, try/catch at call site | 3–6                           |
| §4 own enum type each; two migration files                                | 1, 2                          |
| §4 `notificationTypes` array + both locale maps                           | 2                             |
| §5 tests 1–4 + sqltest                                                    | 3–6 (1–3), 3 (4), 2 (sqltest) |

**Type consistency** — every `notifyXRecord` returns the same
`{ skipped: true; reason } | { skipped: false; notification }` union and is passed
to `runEventWorkflow` with the same four option names (`key`, `whenPaused`,
`run`, `outcomeOf`) defined in Piece 1. Registry keys used in Tasks 3–6 match the
seeds in Task 2 exactly: `contact-inquiry-received`,
`maintenance-request-created`, `refund-recorded`, `contract-created`,
`contract-ended`.

**Known gaps, stated rather than hidden**

1. **Tasks 4 and 5 reuse Task 3's test file structure by instruction rather than
   repeating it in full.** Task 3's file is complete and adjacent; the three
   changes needed are named explicitly. This is the one place the plan says
   "copy that" — everywhere else the code is written out.
2. **No component test covers the Workflows tab showing nine rows.** No harness
   exists; Task 6 Step 6's browser check covers it, including an end-to-end
   contact-form submission.
3. **`contract-ended` depends on how `useUpdateContract` represents an ended
   state.** Task 6 Step 4 requires comparing previous to next state; confirm the
   exact column and values (`state`, or `ended_at`) when implementing, since
   `59_draft_contracts_are_not_ended.sql` shows this has subtleties.
