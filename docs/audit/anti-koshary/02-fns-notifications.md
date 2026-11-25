# S02 — `src/fns`: notifications & templates

**Lines read:** ~5,800 · **Files:** 25 · **Date:** 2026-09-22

Files: `resolveTemplateVariables.ts` (588), `resendWebhook.ts` (583), `dispatchNotification.ts` (517),
`notifyPaymentSuccess.ts` (482), `notifyUserCredentials.ts` (377), `sendBulkNotification.ts` (250),
`sendInvoiceToTenant.ts` (247), `sendCompanyInfo.ts` (247), `notificationDrainJob.ts` (229),
`evolutionDelivery.ts` (226), `overdueRemindersJob.ts` (215), `notifyContractLifecycle.ts` (201),
`enqueueNotification.ts` (185), `sendNotification.ts` (164), `notifyContractRestored.ts` (162),
`notifyInvoiceWrittenOff.ts` (161), `notifyContractCloseout.ts` (160), `notifyInvoiceDisputed.ts` (155),
`notifyDepositConfirmed.ts` (147), `notifyRefundRecorded.ts` (142), `notifyMaintenanceRequest.ts` (142),
`notifyContactInquiry.ts` (111), `loadTemplateCopy.ts` (56), `templateChannelPolicy.ts` (47),
`contractExpiryDelivery.ts` (24).

**Overall:** the *policy* layer here is excellent — `templateChannelPolicy.ts` and
`loadTemplateCopy.ts` are small, single-purpose and carefully argued. The koshary is in
the **sender family**: nine files that are the same 150-line file with the event name
changed, and one 225-line dispatcher that decides a database state by pattern-matching
English prose.

---

## Findings

### 1 · High — the notification's final state is decided by substring-matching a human-readable message

**Where:** `src/fns/dispatchNotification.ts:474-479`

```ts
return updateNotification(notification.id, {
  state: issues.some((issue) => issue.includes("skipped")) ? "skipped" : "failed",
  ...
});
```

`issues` is a list of prose. Of the seven messages that can land in it, **three do not
contain the word "skipped"**:

| Message pushed into `issues` | Source | Contains "skipped"? |
| --- | --- | --- |
| `EMAIL_SKIP.remindersDisabled` | `lib/whatsappSkipReasons.ts:23` | yes |
| `WHATSAPP_SKIP.remindersDisabled` / `.noNumber` / `.noProvider` | `lib/whatsappSkipReasons.ts:11-13` | yes |
| `"No email recipient is available."` | `dispatchNotification.ts:342` | **no** |
| `"No email provider is enabled."` | `dispatchNotification.ts:343` | **no** |
| `` `WhatsApp not sent: ${send.reason}` `` | `dispatchNotification.ts:453` | **no** |

**Which means:** a notification that cannot be sent because *nothing is configured* — no
recipient address, no enabled email provider — is written to the database as **`failed`**,
not `skipped`. `runNotificationDrainJob` re-queues `failed` rows
(`notificationDrainJob.ts:111,170`), so it retries three times, fails identically three
times, then parks the row in `needs_review` reading *"Gave up after 3 attempts. Last error:
No email provider is enabled."* An operator triaging `needs_review` sees a delivery failure
where the truth is a missing setting, and the Notification Log's `skipped` filter — the
surface built to show exactly this — stays empty.

The coupling is **already broken in the shared constants module**:
`EMAIL_SKIP.alreadyDelivered` and `WHATSAPP_SKIP.alreadyDelivered`
(`lib/whatsappSkipReasons.ts:15,22`) also lack the word. They are not reachable from this
function today (only `contractExpiryJob` uses them), so nothing is wrong right now — but
they are in the same `as const` object, one import away, and the next person who reuses one
here changes a database state by editing a sentence.

**Fix:** make `issues` a list of `{ kind: "skip" | "failure"; message: string }` — the push
sites already know which they are — and test `issues.some(i => i.kind === "failure")`. The
wording then becomes free to change, which is the property that is missing.

---

### 2 · Medium — nine senders each re-derive "which company are we", and all nine ignore `company_id`

**Where:** identical five-line query in `notifyContactInquiry.ts:39-43`,
`notifyContractCloseout.ts:45-49`, `notifyContractLifecycle.ts:49-53`,
`notifyContractRestored.ts:45-49`, `notifyDepositConfirmed.ts:53-57`,
`notifyInvoiceDisputed.ts:41-45`, `notifyInvoiceWrittenOff.ts:45-49`,
`notifyMaintenanceRequest.ts:45-49`, `notifyRefundRecorded.ts:41-45`; plus
`enqueueNotification.ts:113-119` (`companyEmail`) — **ten sites**.

```ts
.from("companies").select("default_locale").order("created_at").limit(1).maybeSingle()
```

Byte-identical in all ten (two also select `currency`). No drift yet — this is the bug that
has not happened.

**Which means:** "the company" is defined as *the oldest row in `companies`*, ten times
over, in code that already holds a record carrying the right answer. `invoices`,
`tenants` and `contracts` all have `company_id`, and `createPayment.ts:355` reads it
properly — these senders do not. The moment a second company exists, every notification it
generates is written in company #1's locale, with company #1's currency label, and
addressed to company #1's inbox. Changing that rule is a ten-file edit.

**Fix:** one `notificationCompanyContext(companyId: string | null)` in `src/lib`, taking the
id the caller already has and falling back to the oldest row only when it is null. This is
not a speculative multi-tenant feature — it is the existing rule, written once, in a place
where it can be corrected.

---

### 3 · Medium — nine copies of the "already notified?" guard, all fail-open on a database error

**Where:** `notifyContactInquiry.ts:27-34` · `notifyContractCloseout.ts:32-38` ·
`notifyContractLifecycle.ts:32-38` · `notifyContractRestored.ts:32-38` ·
`notifyDepositConfirmed.ts:31-37` · `notifyInvoiceDisputed.ts:27-35` ·
`notifyInvoiceWrittenOff.ts:32-38` · `notifyMaintenanceRequest.ts:32-38` ·
`notifyRefundRecorded.ts:28-34`

Each differs only in the `type` string and one payload key, and each ends:

```ts
return !existing.error && Boolean(existing.data?.length);
```

**Which means:** the idempotency guard for every admin notification treats *"the query
failed"* as *"not yet notified"* and sends again. A transient PostgREST error during a
close-out produces a second copy of the same admin email — and because the guard is written
out nine times, fixing the fail-open posture is a nine-file edit, in nine files that are
otherwise identical.

**Fix:** one `alreadyNotified(type, payloadMatch)` helper that throws on a query error, so
the caller's existing `catch` turns it into a reported skip rather than a silent duplicate.

---

### 4 · Medium — the nine-sender family is the same file nine times

**Where:** `src/fns/notify*.ts`

Normalising the event name away, `notifyInvoiceWrittenOff.ts` (161 lines) and
`notifyInvoiceDisputed.ts` (155 lines) differ in **~20 substantive lines**. Every one of the
nine repeats the same skeleton in the same order:

```
loadX()  →  wasAlreadyNotified()  →  resolveNotificationRecipients()
→ loadMessageContext()  →  buildXCopy()  →  enqueueNotification()
→ null-check for the template-channel gate  →  try/catch → { skipped, reason }
→ runEventWorkflow wrapper  →  createServerFn with a has_permission preamble
```

Findings 2 and 3 are two slices of this; the rest is the enqueue block, the
`if (!notification) return { skipped: true, reason: \`Template ${code} excludes...\` }`
check, the catch-and-report, and the `runEventWorkflow` wrapper — each written out nine
times.

**Which means:** every cross-cutting change to how an event notification behaves costs nine
edits. That is not hypothetical: findings 1, 2, 3 and S01's finding 7 are each a rule that
now needs a nine-file sweep, and `notifyDepositConfirmed` has already drifted (it uses
`skipped: true as const` where the others use `skipped: true`, a small sign the copies are
being edited independently).

**Fix:** `runEventWorkflow` already owns the outer frame. Extend it — or add one
`notifyEvent({ key, type, dedupeKey, buildCopy, targets })` beside it — so each sender is
reduced to its `buildCopy` and its dedupe key, which is the only part that genuinely
differs. **Do not** merge the `build*Copy` functions: the variables, fallback wording and
subject line are per-event and have every reason to diverge. Extract the frame, keep the
copy.

---

### 5 · Medium — `dispatchNotificationRecord` is 225 lines with five levels of nesting

**Where:** `src/fns/dispatchNotification.ts:282-507`

One function holding: the notification read, the tenant read, provider selection,
attachment loading, the email branch (recipient expansion, branding substitution, two
provider sends, a mailbox mirror), the WhatsApp branch (number resolution, template
mapping, four provider sends), and the terminal-state decision — all inside one `try`.

The reminders-disabled guard is written **twice inside this one function**, verbatim
(`:316-321` and `:430-436`):

```ts
notification.audience === "tenant" &&
  PROACTIVE_REMINDER_TYPES.has(notification.type) &&
  tenant && !tenant.reminders_enabled
```

**Which means:** the rule "a tenant's opt-out silences proactive reminders, but never the
office's own alert row" — which the comments show was got wrong once already — has to be
changed in two places in a function that no longer fits on a screen. The email branch
reaches five levels of nesting (`try` → `if channel` → `else` → `else` → `if provider`), and
the branding/mailbox-mirror block sits at the deepest point, which is exactly where a missed
branch lives.

**Fix:** extract `sendEmailChannel(notification, tenant, configs, attachments)` and
`sendWhatsAppChannel(...)`, each returning `{ messageIds, issues, provider, senderAddress }`,
and hoist the opt-out guard above both. That is three functions of ~70 lines from one of
225, with no behaviour change and no new abstraction — the two branches already have
disjoint bodies.

---

### 6 · Medium — a manual send of any event-type template mails blank placeholders, and nothing stops it

**Where:** `src/fns/resolveTemplateVariables.ts:380-404` → `src/components/admin/MessagePreviewPanel.tsx:102-113`

`resolveTypeVariables` resolves live data for exactly four types — `overdue_reminder`,
`due_reminder`, `receipt`, `contract_expiry` — and returns `{}` for everything else. The
comment says so plainly. The unresolved keys are reported in `missing[]`, which
`MessagePreviewPanel` renders as an amber advisory list.

**Which means:** an admin manually sending `invoice_disputed`, `contract_closeout`,
`refund_recorded`, `deposit_confirmation`, `maintenance_request` or any of the other
non-covered types gets a message where `{{amount}}`, `{{reason}}` and `{{invoice_code}}`
render **empty**, and the only thing standing between that and the tenant's inbox is an
amber panel with no effect on the send button. The tenant receives
*"نزاع على فاتورة - "* with a blank amount.

**Fix:** two options, and they are a product decision, not a code one — (a) disable the send
button while `missing` is non-empty for a tenant-audience send, or (b) extend
`resolveTypeVariables` to the remaining types. (a) is one line and stops the bleeding; (b) is
the real fix. Flagging rather than choosing.

---

### 7 · Low — `getAdminNotificationEmails` is dead production code held up by its own mocks

**Where:** `src/fns/enqueueNotification.ts:176-179`

Declared "preserved for call sites and mocks". There are no call sites: every hit outside
its own module is a test — one test of it (`enqueueNotification.test.ts:127`) and **twelve
test files that mock it** while the code under test calls `resolveNotificationRecipients`.

**Which means:** twelve mock blocks carry a line that stubs a function production never
invokes. Harmless today, but it is the kind of entry that makes the next reader believe the
admin-recipient path has two entry points when it has one.

*Verified not dynamically reached:* no string-keyed dispatch, no re-export, not part of a
published surface.

**Fix:** delete the export and the twelve mock lines together, in one commit, or the tests
keep it alive forever.

---

## Not reported, and why

- **`resendWebhook.ts` at 583 lines** — the same transport+verify+persist shape as
  `myfatoorahWebhook.ts`, but it has exactly one consumer (`api/public/resend-webhook.ts`)
  and no cron job or callback needs to import its internals. Over the ceiling, no consequence
  to name.
- **`isRecord` / `stringAt` repeated from `myfatoorahWebhook.ts`** — coincidental; already
  judged in S01.
- **Two `whatsappProvider` / `emailProvider` selectors and four provider send branches** —
  looks like a switch waiting to be a map, but each branch takes different arguments
  (`sendWithPostora` needs the row id as an idempotency key, `evolutionMessage` needs the
  attachments). Unifying them needs a flag per caller, which the reference calls the wrong
  abstraction. Left alone.
- **`templateChannelPolicy.ts` reading the template row twice** (once for channel, once for
  copy) — deliberate and argued in the docblock: the two degrade in opposite directions on
  `is_active`. Merging them would reintroduce a fixed bug.

## Test coverage of this scope

Every sender has a test file, and the mocks are honest: `notifyInvoiceDisputed.test.ts:72-76`
mocks `resolveNotificationRecipients` — the function actually called — not just the dead
`getAdminNotificationEmails`, so the recipient path is really exercised.

**What is not covered:**

- Finding 1's state decision. No test asserts that a `"No email provider is enabled."` issue
  produces `failed` rather than `skipped` — the behaviour is emergent from a string match,
  and a test would have to assert on the string.
- The nine dedupe guards' error path (`!existing.error`). Tests set `error: null`
  throughout, so the fail-open branch in finding 3 has never executed under test.
- `resolveTypeVariables`' twelve unhandled types (finding 6) — tested for the four that are
  handled.

**Consequence for Pass 2:** findings 2, 3, 4 and 5 are behaviour-preserving refactors whose
sender-level tests would catch a regression. Finding 1 changes which state is written and
finding 6 changes whether a send is possible — both need a test written *before* the change,
not a green suite after it.

## Ledger entries added

See `LEDGER.md` — the company lookup, the dedupe guard, the sender skeleton, the
skip-message constants, `getAdminNotificationEmails`.
