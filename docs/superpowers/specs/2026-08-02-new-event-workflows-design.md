# Five new event workflows — the things that happen and notify nobody

**Date:** 2026-08-02
**Piece:** 3 of 3
**Migrations:** `db/migrations/71_new_workflow_notification_types.sql` and
`db/migrations/72_new_event_workflows.sql` — split, see §4
**Branch:** `feat/new-event-workflows` (cut from `feat/authoritative-templates`)
**Depends on:** Piece 1 (merged, PR #61) for `runEventWorkflow`; Piece 2 for
`loadTemplateCopy`, so these five are template-driven from birth rather than
written as hardcoded builders and immediately rewritten.

---

## 1. The problem

Four kinds of thing happen in this system, get written to a table, and notify
nobody:

| Event                                           | Where it lands today   | Who finds out |
| ----------------------------------------------- | ---------------------- | ------------- |
| A visitor submits the landing-page contact form | `contact_inquiries`    | nobody        |
| A maintenance request is logged                 | `maintenance_requests` | nobody        |
| A refund is applied                             | `refunds`              | nobody        |
| A contract is created, or ends                  | `contracts`            | nobody        |

The first is the sharpest: someone types their name and phone number into the
public site asking to rent a property, the row is stored correctly, and no
member of staff is told. It is found only if somebody opens that screen.

The last one — money leaving the system on a refund — is the one with the
highest cost of being missed.

---

## 2. Five rows, not four

The agreed scope said "contract created / ended" as one item. It ships as **two**
registry rows, `contract-created` and `contract-ended`.

They are different triggers on different code paths (`useCreateContract` versus a
state change in `useUpdateContract`), and independent switchability is the entire
point of the registry — an admin who wants to know about terminations but not
every new contract must be able to say so. Collapsing them into one switch would
reproduce, in a new place, the coarse all-or-nothing control this feature exists
to replace.

So: **five** new `kind = 'event'` rows.

| key                           | Trigger                                                                      | Recipients |
| ----------------------------- | ---------------------------------------------------------------------------- | ---------- |
| `contact-inquiry-received`    | `submitContactInquiry.ts:58`, after the insert succeeds                      | admin      |
| `maintenance-request-created` | `useMaintenance.ts:111` `useCreateMaintenanceRequest`                        | admin      |
| `refund-recorded`             | `useRefunds.ts:121` `useApplyRefundAction`                                   | admin      |
| `contract-created`            | `useContracts.ts:172` `useCreateContract`                                    | admin      |
| `contract-ended`              | `useContracts.ts:196` `useUpdateContract`, on transition into an ended state | admin      |

**Recipients are the configured admin addresses** via the existing
`getAdminNotificationEmails()`, matching every workflow shipped in Piece 1. No
new settings surface, no schema change, and each still gets its own switch.

---

## 3. Shape: follow the deposit sender exactly

Every one of the five is the same shape as `notifyDepositConfirmedRecord`, which
Piece 1 already established and tested. There is nothing novel here, and that is
deliberate.

```ts
async function enqueueX(id: string) {
  /* load, guard, compose, enqueue */
}

export async function notifyX(id: string) {
  type Result = Awaited<ReturnType<typeof enqueueX>>;
  return runEventWorkflow<Result>({
    key: "<registry key>",
    whenPaused: () => ({ skipped: true as const, reason: "Workflow is paused." }),
    run: () => enqueueX(id),
    outcomeOf: (result) =>
      result.skipped
        ? { status: "skipped" as const, error: result.reason }
        : { status: "success" as const, error: null },
  });
}
```

Each `enqueueX` returns `{ skipped: true, reason }` for its own nothing-to-do
cases and `{ skipped: false, notification }` on a send, so the three outcomes
stay distinguishable — the classification Piece 1 had to correct.

### The gate goes inside the sender

Not at the trigger site. This is the rule Piece 1 established and the reason all
four of its workflows are switchable without a single call site changing.

### Idempotency

Each checks for an existing non-cancelled notification of its type carrying the
same entity id in `payload`, exactly as `notifyDepositConfirmedRecord` does.
Without it, a retried mutation or a double-click emails the admins twice.

### Client hooks call a guarded server function

Four of the five trigger from client hooks, which cannot use `supabaseAdmin`.
Each gets a `createServerFn` wrapper with a `has_permission` check, called after
the mutation succeeds — the pattern `notifyDepositConfirmed` uses from
`useDeposits.ts`. `contact-inquiry-received` is the exception: `submitContactInquiry`
is already a server function, so it calls its notifier directly.

**A notification failure must never fail the underlying mutation.** The contact
form is public and its insert must succeed even if SMTP is down; a contract must
be created even if the admin mailbox is unreachable. Every call site awaits the
notifier inside a `try`/`catch` that logs and swallows, matching
`useDeposits.ts`.

---

## 4. Templates

Ten new `notification_templates` rows — five workflows × two locales — seeded by
migration 72 with `{{placeholder}}` bodies, authored against Piece 2's contract
so they are template-driven from the first send. Their entries are added to
`TEMPLATE_VARIABLES` so the editor lists their placeholders and the preview can
render them.

### All five get their own notification type

Decided, not deferred. The five new values are:

`contact_inquiry`, `maintenance_request`, `refund_recorded`,
`contract_created`, `contract_ended`

Overloading existing types was considered and rejected. There is **no
admin-facing sibling of `contract_expiry`** — it is a single tenant-facing type,
so filing a contract-created admin email under it would label that row "Contract
expiry" in the notification pool's type filter. That filter is what makes the log
usable; misfiling rows to save a migration is a bad trade. The cost does not
scale with count either: five values is the same edit, in the same three places,
as two.

### The enum forces two migration files

`notification_types` is a real Postgres enum
(`07_phase5_notifications_reports.sql:8`), not a text column with a check
constraint. `ALTER TYPE … ADD VALUE` may run inside a transaction block on modern
Postgres, but **the new value cannot be used in that same transaction**.

Migrations are applied with `--single-transaction`, so a single file that adds
the values and then seeds template rows using them fails with _"unsafe use of new
value of enum type"_. It splits:

- **`71_new_workflow_notification_types.sql`** — `alter type … add value if not
exists` for the five, nothing else.
- **`72_new_event_workflows.sql`** — the five `cron_jobs` rows and the ten
  `notification_templates` rows that reference them.

Applied in filename order, as two separate transactions. Production is
PostgreSQL 17.6; the sqltest image is 15.1.1.78, and the rule holds on both.

Because they are new types, they also need entries in
`notificationTypes` in `admin.settings.notifications.tsx` and
`notificationType.*` keys in **both** locales — and `typecheck` will not catch a
missing Arabic key, so parity is verified by hand.

---

## 5. Tests

Per workflow, mirroring Piece 1's proven set:

1. **Paused ⇒ nothing enqueued**, asserted on the explicit return flag _and_ on
   `enqueueNotification` never being called.
2. **The workflow consults its own registry key** — five rows share one table,
   and a sender reading the wrong key makes one switch silently control another.
3. **Already-notified ⇒ `skipped`, not `success`** — the idempotency path must
   not report a send that did not happen.
4. **A notification failure does not fail the mutation** — the contact-form case
   especially: the insert still returns success when the notifier throws.

Plus one sqltest: the five rows land with `kind = 'event'`, the ten template rows
exist for both locales, the five new enum values exist, and re-running migrations
71 and 72 does not reset `is_active`.

Gates: `lint`, `typecheck`, `test`. Migration applied to the live database over
`ssh-danatfuture-mcp` per the standing preference, after snapshotting
`cron_jobs` and `notification_templates`.

---

## 6. Risks

| Risk                                                                    | Mitigation                                                                                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A notification failure blocks a contract, refund or public contact form | Notifier awaited inside try/catch at every call site; test 4                                                                                   |
| Duplicate emails on retry or double-click                               | Per-entity idempotency check; test 3                                                                                                           |
| One switch silently controls another workflow                           | Each sender pins its own key; test 2                                                                                                           |
| Admins buried in mail once five more workflows fire                     | Every row ships **active**, but each is independently switchable from the Workflows tab — that is the mitigation the feature exists to provide |
| A missing Arabic dictionary key ships silently                          | `Dict` is `Record<string, string>` with no parity constraint; verified with `rg`, not typecheck                                                |
| New enum values break the notification-pool filter                      | Added to `notificationTypes` and both locale maps in the same task                                                                             |
| An enum value used in the transaction that created it                   | Split into migrations 71 and 72; §4. This would fail on the live database under `--single-transaction`                                         |

---

## 7. Out of scope

Tenant-facing copies of these notifications (admins only, as agreed).
Per-workflow configurable recipients. WhatsApp channels for the five — email
only, matching the deposit and payment-alert workflows.
