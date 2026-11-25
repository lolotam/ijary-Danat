# Notification templates: collapse AR/EN rows, filter manual sends by workflow recipient

**Date:** 2026-08-13
**Branch:** `feat/collapse-template-locales`
**Status:** approved design

## Problem

Four defects in the notification-template surface, discovered while acting on a
request to remove a pager and relabel a dropdown. Two are cosmetic; two are real
data defects verified against the production database
(`danatfuture-supabase-ozoxsa-db-1`).

### 1. Half of every template row is written but never read

`notification_templates` has **34 rows = 17 types × 2 locales**. Every row
carries all four content columns — `subject_ar`, `subject_en`, `body_ar`,
`body_en` — and the AR/EN pairs are byte-identical in all four:

```sql
select a.type,
       (a.body_ar is not distinct from b.body_ar) same_ar,
       (a.body_en is not distinct from b.body_en) same_en
  from notification_templates a
  join notification_templates b
    on a.type = b.type and a.locale = 'ar' and b.locale = 'en';
-- 17 rows, every column `t`
```

But a sender picks the row by locale-suffixed code and then reads only that
locale's column:

```ts
const code = locale === "ar" ? "receipt-ar" : "receipt-en"; // picks the row
await loadTemplateCopy(code, locale, vars);                 // reads row.body_ar when ar
```

So on `receipt-ar`, `body_en` is unreachable by any code path. Yet
`TemplateEditorDialog` renders an "English body" field on that row and saves it
successfully. **An admin can edit English copy on the Arabic row, see a success
toast, and change nothing.** This is the `written-but-never-read-columns` defect
shape the project has hit before.

Two encodings of one concept — row-level `locale` and column suffix `_ar`/`_en`
— compete. `locale` wins at selection time, the suffix wins at read time, and
the loser half of each row dies silently.

### 2. Compensating machinery

`loadTemplateForLocale` in `src/fns/resolveTemplateVariables.ts` carries a
three-tier fallback ladder — lookup by code, then by `type` + `locale`, then
`swapLocaleSuffix(code, locale)` — roughly 50 lines whose only purpose is to
paper over the row split. `sendNotification` and `sendBulkNotification` each
carry a `template.locale !== resolvedLocale` rejection for the same reason.

### 3. The manual-message dropdown offers templates that cannot reach a tenant

`SendManualMessageDialog` and `SendBulkMessageDialog` list every active template
matching the channel and locale. Eleven of the seventeen types are staff-only
notices — `contact_inquiry`, `maintenance_request`, `refund_recorded`,
`contract_created`, `contract_ended`, `contract_closeout`, `contract_restored`,
`invoice_written_off`, `invoice_disputed`, `deposit_confirmation`,
`payment_admin_alert` — and sending one to a tenant is always a mistake.

### 4. Cosmetic

- The templates tab paginates 17 rows at 10 per page.
- The dropdown shows a bare `code`, so an admin must know that
  `invoice-document-ar` is the *document send* template.

## Pre-existing defects found during review — flagged, not fixed here

Adversarial review surfaced four defects in the notification *rendering* layer.
They are real and worth fixing, but they are not part of "collapse the rows and
filter the dropdown", and absorbing them would turn a bounded change into a
rewrite. This change **reduces** exposure to all four, because the dropdown goes
from offering 17 types to 4.

1. **`sendCompanyInfo` cannot succeed in production.** It hardcodes
   `templateCode: "company-info"` (lines 157, 171) and inserts it at line 204,
   but no `company_info` row exists — so the insert violates
   `notifications_template_code_fkey`. The PDF is uploaded first, so every
   attempt also orphans a storage object.
2. **`resolveReceiptVariables` ignores a pinned contract on miss.** When a
   contract is pinned but none of the candidate payments belongs to it, it keeps
   the tenant's latest unrelated payment instead of reporting no match.
3. **`resolveContractExpiryVariables` falls back to an ended contract.** A tenant
   with no active contract can be sent an expiry notice for a terminated one,
   with a negative `days_until`.
4. **`missing` placeholders never block a send.** `buildFinalMessage` records
   them correctly, but both senders reject only on `unavailableReason`, the
   manual send button ignores `missing`, and the bulk path queues every tenant
   regardless. So a template offered by gate 2 can still render blank *for a
   particular tenant* — gate 2 proves the type is resolvable, not that this
   tenant has the data.

Recommended as a follow-up change: a per-tenant availability gate applied after
rendering — reject on the single path, skip-with-reason on the bulk path.

## Non-goals

- WhatsApp provider bindings. All 34 rows are `channel = 'email'` and none are
  mapped; WhatsApp still refuses to send without an approved template mapping.
- `manual_message`, `company_info` and `scheduled_report` have no rows in
  production. `company_info` mode in the manual dialog is therefore currently
  unreachable. Out of scope — not introduced or removed here.
- Any change to which workflows exist or what they send.

## Decisions taken

| # | Decision | Rationale |
|---|---|---|
| 1 | Rename surviving codes to unsuffixed (`receipt-ar` → `receipt`) | The FK `notifications.template_code → notification_templates.code` is `ON UPDATE CASCADE`, so the 30 history rows follow the rename automatically. A `-ar` suffix on a language-neutral row would contradict the new dropdown label. |
| 2 | `user_credentials` **and** `document_send` are excluded as unrenderable | Superseded an earlier decision that was taken on a false premise (see "Corrections"). Neither can be rendered by the generic manual path. |
| 3 | Both `SendManualMessageDialog` and `SendBulkMessageDialog` get the change | Two dialogs offering different template lists for the same job reads as a bug. The logic becomes one shared hook, so the marginal cost is small. |
| 4 | Provider columns stay single-valued | YAGNI. Documented limitation: bilingual WhatsApp binding requires `provider_template_name_ar/_en` and `provider_language_code_ar/_en`, to be added when templates are actually mapped. |
| 5 | Drop the `locale` column outright | Keeping it unread would recreate the exact defect being removed. |
| 6 | Three-stage release: migration-only PR, then app PR, then phase 2 | Migration files only reach the production host via Dokploy's clone of `main`, so "apply before merge" is not executable. |
| 7 | Eligibility is enforced **server-side**, not only in the dropdown | `sendNotification`/`sendBulkNotification` accept any active code today; a filtered dropdown is presentation, not a control. |

## Corrections to an earlier draft

Two claims in the first draft were false and were caught by adversarial review.
Recorded here because the decisions built on them were reversed.

1. **"Old code degrades to the built-in builder rather than failing."** True for
   reading copy, false for writing the audit row. See §C.
2. **"The preview warns about the unresolvable `{{temp_password}}`."** No such
   placeholder exists — `user-credentials-ar` binds only `{{display_name}}`, and
   the credentials block is assembled *in code* by `notifyUserCredentials`, not
   in the template. A generic manual send would deliver a "your login details"
   email containing no login details. Nor would anything stop it: `missing` is
   rendered as a soft warning in `MessagePreviewPanel` only — the manual
   dialog's send button does not consult it and the bulk dialog does not render
   it at all.

## Design

### A. Tenant eligibility

There is **no link in the database** between a template `type` and a workflow
`key`; it exists only implicitly in each sender. Eligibility therefore needs a
declared map. It lives beside `WORKFLOW_CATALOG` in `src/lib/workflowCatalog.ts`,
which already declares itself the single source of truth for built-in workflows.

Eligibility has **three** states, not two. A boolean derived purely from the
workflow's pills would leak `payment_admin_alert` into the tenant dropdown,
because its workflow `payment-succeeded` carries `tenant` in `recipient_targets`
— that pill belongs to the sibling `receipt` template, not to the admin alert.

Eligibility is **two independent gates**. A template is offered only if it passes
both.

#### Gate 1 — audience: may a tenant receive this at all?

```ts
export type TenantEligibility =
  | { mode: "always" }                        // no workflow — it IS a manual send
  | { mode: "never" }                         // staff-only whatever the pills say
  | { mode: "viaWorkflows"; keys: string[] }; // eligible if ANY key includes "tenant"

export const TEMPLATE_TENANT_ELIGIBILITY: Record<NotificationType, TenantEligibility>;
```

Dynamic by design: the `viaWorkflows` decision reads **live**
`cron_jobs.recipient_targets`, so unticking the tenant pill on `contract-expiry`
removes that template from both dropdowns with no deploy.

#### Gate 2 — render: can the generic manual path actually produce this message?

`resolveTypeVariables` (`src/fns/resolveTemplateVariables.ts`) resolves live
variables for **four** types and returns `{}` for every other. Its own comment
says so: *"Only the four types a manual send commonly uses with live data."*

```ts
export const MANUALLY_RENDERABLE_TYPES: ReadonlySet<NotificationType>;
```

`{ overdue_reminder, due_reminder, receipt, contract_expiry }` — exactly the
resolver-backed branches, and nothing else.

`manual_message` and `company_info` are **not** in this set, though an earlier
draft included them:

- **`manual_message`** is not the same thing as free text. Free text is the
  `templateCode === null` branch, which picks resolvers from the placeholders the
  body actually contains. A *stored* row whose type is `manual_message` takes the
  template branch, calls `resolveTypeVariables("manual_message")` and gets `{}` —
  and nothing constrains what placeholders an admin may put in it. Free text
  remains available in both dialogs; it just does not travel through a template.
- **`company_info`** is a dedicated single-recipient action, not a generic
  render. The manual dialog special-cases it; the bulk dialog does not, so
  putting it in a *shared* set would make it bulk-selectable and send stored copy
  with neither the generated body nor the PDF.

This gate is why `document_send` and `user_credentials` are excluded despite
passing gate 1:

- `invoice-document-ar` binds 12 placeholders — `invoice_number`, `subtotal`,
  `total`, `due_date`, `unit_name`, `property_name`, … — and a manual send
  renders **every one of them empty**.
- `user-credentials-ar` binds only `{{display_name}}`; the credentials block is
  assembled in code by `notifyUserCredentials` and the generic path never builds
  it.

Their real flows — "Send invoice to tenant" and automatic credential
provisioning — are untouched and keep working.

**A test must assert gate 2 stays in step with `resolveTypeVariables`.** If a
resolver is added there and not here, the new type stays silently hidden; if
removed there and not here, blank messages reach tenants.

#### The full map — all 20 types

| Type | Gate 1 (audience) | Gate 2 | Offered? |
|---|---|---|---|
| `due_reminder` | `always` (no sender; migration 70) | ✓ | **yes** |
| `overdue_reminder` | `viaWorkflows ["overdue-reminders"]` | ✓ | **yes** |
| `receipt` | `viaWorkflows ["payment-succeeded", "manual-payment-invoice"]` | ✓ | **yes** |
| `contract_expiry` | `viaWorkflows ["contract-expiry"]` | ✓ | **yes** |
| `manual_message` | `always` | ✗ | no — a stored row is not free text |
| `company_info` | `always` | ✗ | no — dedicated action, not a generic render |
| `document_send` | `always` | ✗ | no — unrenderable |
| `user_credentials` | `viaWorkflows ["user-credentials-tenant", "user-credentials-managerial"]` | ✗ | no — unrenderable |
| `payment_admin_alert` | `never` | ✗ | no |
| `scheduled_report` | `never` | ✗ | no |
| `deposit_confirmation` | `viaWorkflows ["deposit-confirmed"]` | ✗ | no |
| `contact_inquiry` | `viaWorkflows ["contact-inquiry-received"]` | ✗ | no |
| `maintenance_request` | `viaWorkflows ["maintenance-request-created"]` | ✗ | no |
| `refund_recorded` | `viaWorkflows ["refund-recorded"]` | ✗ | no |
| `contract_created` | `viaWorkflows ["contract-created"]` | ✗ | no |
| `contract_ended` | `viaWorkflows ["contract-ended"]` | ✗ | no |
| `contract_closeout` | `viaWorkflows ["contract-closeout-completed"]` | ✗ | no |
| `contract_restored` | `viaWorkflows ["contract-restored"]` | ✗ | no |
| `invoice_written_off` | `viaWorkflows ["invoice-written-off"]` | ✗ | no |
| `invoice_disputed` | `viaWorkflows ["invoice-disputed"]` | ✗ | no |

`payment_admin_alert` must be `never` explicitly: its workflow
`payment-succeeded` carries `tenant` for the sibling `receipt` template.
`manual-payment-invoice` has the same split. No other workflow produces two
templates with different audiences.

Both maps are total over `NotificationType` (`Record<NotificationType, …>`), so
adding a type is a compile error until its audience is stated. Tests assert the
exact type→key pairs, not merely that the keys exist — mapping `contact_inquiry`
to `contract-expiry` would otherwise compile and pass.

Unknown workflow keys (an admin-created `cron_jobs` row absent from
`WORKFLOW_CATALOG`) are ignored rather than treated as eligible; a key with no
dispatcher sends nothing anyway.

#### Enforcement

The shared hook

```ts
useTenantEligibleTemplates({ channel: NotificationChannel }): NotificationTemplateRow[]
```

is **presentation only**. `sendNotification` and `sendBulkNotification` today
accept any active template code and validate only its channel, so a stale bundle
or a direct request can still aim `payment-admin-alert` at a tenant. Both server
functions must apply the same two gates before building or inserting anything,
and reject an ineligible code. The gates live in `src/lib/` so client and server
share one implementation.

**The gates apply at those two tenant-manual entry points and nowhere else.**
This is a boundary, not an oversight — a full producer audit confirms that
generalising it would break the system:

| Call site | Gate |
|---|---|
| `sendNotification`, `sendBulkNotification` | **applies** — the admin-chosen surface |
| `sendInvoiceToTenant`, `sendTenantCredentials` | must **bypass** — legitimate `document_send` / `user_credentials` senders |
| `notifyPaymentSuccess`, `contractExpiryJob`, `overdueRemindersJob`, `notifyUserCredentials` | must **bypass** — each sends both tenant and admin notices; `contractExpiryJob` even tags its admin alert with the tenant-capable code |
| the nine staff-only `notify*` senders | must **bypass** — they are staff-audience by design |
| `runReportSchedule`, `resendGeneratedReport` | irrelevant — they insert no template code |
| `enqueueNotification`, `dispatchNotification`, `notificationDrainJob` | must stay **neutral** |

The drain and dispatch neutrality matters for a second reason: they must not
re-evaluate eligibility on a already-queued row. Unticking a workflow's tenant
pill should stop *future* sends, never retroactively cancel a queued one.

Regression tests must prove invoice documents, credentials, staff alerts and
pre-existing queued notifications are all unaffected.

**Expected effect on production data:** 17 types → **4 offered**
(`due_reminder`, `overdue_reminder`, `receipt`, `contract_expiry`).

### B. Dropdown label

`{code} ({localized type})` in both dialogs:

```
deposit-confirmation (تأكيد إيداع)
deposit-confirmation (Deposit confirmation)
```

The type name follows the **dialog's own language selector**
(`effectiveManualLocale`), not the admin's app UI language — the admin is
choosing what the *tenant* receives. `useI18n().t` is bound to the UI locale and
is therefore the wrong tool; `src/i18n/dictionary.ts` already exports
`t(locale, key)` for exactly this, so the label calls that directly with the
message locale. A test must cover the case where UI locale and message locale
differ, since that is the only case where the two spellings diverge.

All 20 `notificationType.*` keys already exist in both locales (40 dictionary
entries), so no new i18n keys are needed and `dictionary.test.ts` parity stays
green.

**Bidi:** a Latin, hyphenated code followed by Arabic text in parentheses
reorders visually inside an RTL dialog. Render the code and the type in separate
`<bdi>` elements with the code forced LTR, and assert the direction attributes
at the DOM level rather than eyeballing it.

### C. Schema collapse — two phases, and why

A single rename-and-drop migration **cannot** be deployed safely. Proven against
production inside a rolled-back transaction:

```
ERROR: insert or update on table "notifications" violates foreign key constraint
       "notifications_template_code_fkey"
DETAIL: Key (template_code)=(deposit-confirmation-NOPE) is not present
```

Every automatic sender does two independent things with its template code:

```ts
const copy = await loadTemplateCopy(code, locale, vars); // maybeSingle → nulls → built-in fallback ✓
await enqueueNotification({ ..., templateCode: code });  // FK insert → THROWS if code is gone ✗
```

The first degrades gracefully, which is what the earlier draft of this spec
reasoned about. The second does not. **Fourteen** sender sites pass a suffixed
code to `enqueueNotification`, including all three sends in
`notifyPaymentSuccess`. So during the window between applying the migration and
Dokploy finishing the container swap, the still-running old bundle would enqueue
`receipt-ar`, violate the FK, and lose the notification.

Severity is high but not catastrophic: `myfatoorahWebhook` calls
`notifyPaymentSuccess` best-effort and only `console.error`s the failure, so the
**payment still settles** — the tenant just silently never gets the receipt.
That is still a customer-facing loss and worth one extra manual step to avoid.

#### Phase 1 — `db/migrations/124_template_unsuffixed_codes.sql`

Additive only. Both old and new codes resolve, so old and new bundles both work.

0. **Precondition.** The migration operates on an **explicit list of the 34
   migration-owned legacy codes**, never on a `-ar`/`-en` regex. The schema has
   never reserved those suffixes, so an admin-created `lease-renewal-ar` is
   legitimate — and a regex-driven phase 2 would rewrite its history to a
   `lease-renewal` that does not exist, then delete it.

   Abort with a diagnostic unless, for every one of the 17 legacy stems:

   - **both** siblings are present (cardinality, not just an inner join — a
     missing sibling must fail loudly, not pass vacuously);
   - the pair agrees under `is not distinct from` on `type`, `channel`,
     `is_active`, `allow_freeform`, **all four content columns**
     (`subject_ar`, `subject_en`, `body_ar`, `body_en` — these are what is
     actually collapsed and the earlier draft omitted them), and every provider
     column;
   - the target unsuffixed code either does not exist, or exists and is
     semantically identical. A pre-existing collision silently accepted by
     `on conflict do nothing` would leave the new app loading an unrelated row.

   Note on provider columns: production has them null, but **migration 58 seeds
   `provider_template_name` and `provider_param_keys` for both contract-expiry
   rows**, so a clean database built by `bun run test:sql` has non-null mappings.
   The guard must therefore compare equal non-null values, not merely assert
   null.

   Wrap the whole migration in an explicit `begin`/`commit`. Neither the runbook
   nor `scripts/test-db.sh` passes `--single-transaction`, so without it a late
   failure leaves the earlier DDL committed.
1. `drop constraint notification_templates_type_channel_locale_key` — required,
   or step 2 collides on `(type, channel, locale)`.
2. `alter column locale set default 'ar'`. The column is `NOT NULL` **with no
   default** (verified in `information_schema`). Without this, the new bundle —
   which no longer sends `locale` — cannot create a template between the deploy
   and phase 2.
3. Insert one unsuffixed row per type, copying the `-ar` row's content. (The
   pair is byte-identical, so which one is copied does not matter.) Guard with
   `on conflict (code) do nothing` for idempotency.

Old code keeps reading `receipt-ar`; new code reads `receipt`. No window.

**PR 1 is a no-op for the deployed *code*, but not for what the old UI shows.**
An earlier draft claimed the running bundle is unaffected. It is not: the old
`useNotificationTemplates` does `select("*")`, so after 124 it returns 51 rows.
The old templates table lists all of them, and because the new unsuffixed rows
default to `locale = 'ar'` and are active, the old Arabic dropdowns show both
`receipt` and `receipt-ar`.

Two consequences, handled differently:

- **New bundle:** its query excludes the 34 legacy codes — by explicit list, not
  by suffix regex, for the `lease-renewal-ar` reason above. The filter lives
  once in `useNotificationTemplates`, not duplicated into both dialogs, and is
  inert after phase 2.
- **Old bundle:** cannot be fixed from this side. So the window is an
  **operational constraint, not a design property**: do not create, edit or
  delete templates between applying 124 and applying 125. An edit to a suffixed
  row in that window is discarded by phase 2, and `on conflict do nothing` will
  not resynchronise the alias on a retry. Keep the window to the length of one
  deploy — the two PRs are merged back to back by the same operator.

#### Phase 2 — `db/migrations/125_drop_template_locale.sql` (after the deploy is verified live)

4. Re-point history **for the 34 legacy codes only**, joined against the explicit
   list rather than rewritten by regex. Legal because the unsuffixed rows already
   exist from phase 1.
5. Delete those 34 rows, now unreferenced. An admin-created `lease-renewal-ar` is
   untouched, because it is not on the list.
6. `alter table notification_templates drop column locale` (which also removes
   the `'ar'` default added in phase 1).

No `unique(type)` constraint is added: an admin may legitimately create several
`manual_message` templates. The existing `unique(code)` remains the identity.

Both migrations are written idempotently (guard each step on the
column/constraint still existing) because they are hand-applied to the live
database, where a retried run must not fail.

**Ordering discipline:** phase 2 must not run until the new container is
confirmed serving. Running it early reintroduces exactly the window phase 1
exists to remove.

### D. Code fallout

| File | Change |
|---|---|
| `src/fns/resolveTemplateVariables.ts` | Delete `loadTemplateForLocale`'s by-type and `swapLocaleSuffix` tiers and `swapLocaleSuffix` itself; a plain by-code lookup replaces them. |
| `src/fns/sendNotification.ts`, `sendBulkNotification.ts` | Delete the `template.locale !== resolvedLocale` rejection. |
| ~17 senders/jobs | `locale === "ar" ? "x-ar" : "x-en"` → the unsuffixed constant. Mechanical. |
| `src/integrations/supabase/database.types.ts` | Hand-remove `locale` from `NotificationTemplateRow` and from the table's required-insert keys. Never overwrite this file. |
| `src/hooks/useNotificationTemplates.ts` | Drop `.order("locale")`; exclude `-ar`/`-en` codes for the transition window. |
| `src/db/templateBodies.sqltest.ts`, `src/db/expiryBuckets.sqltest.ts` | Assert against suffixed codes today; update to the unsuffixed ones. |
| `docs/NOTIFICATION_PROVIDER_SETUP.md` | Documents suffixed template codes; must be corrected. Run `docs-guard`. |

`unavailableReason` stays load-bearing. After the collapse it can no longer be
set by a locale mismatch, but it **must** still be set for a missing or inactive
code — `MessagePreviewPanel` renders the "unavailable" warning from it, and a
plain by-code lookup that returns `template: null` with no reason would show an
empty message instead. Keep the contract and test it for preview, single send
and bulk send. Only the locale-counterpart fallback tests disappear.

### E. Template editor dialog

- The language `Select` becomes the **first control under the dialog title**,
  switching which `subject`/`body` pair is edited. One pane, not two stacked
  panes. It is view state only — it is no longer persisted, because the column
  is gone.
- Its hardcoded `notificationTypes` array lists 11 types while production has
  17: editing a `contract_closeout` row today renders a **blank** type dropdown.
  A TypeScript union is erased at runtime and cannot be iterated, so introduce a
  runtime tuple and derive the union from it:

  ```ts
  export const NOTIFICATION_TYPES = ["due_reminder", …] as const;
  export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
  ```

  That makes the editor list and the union the same object by construction. The
  union currently lives in the hand-maintained `database.types.ts`, so the tuple
  goes there too and the existing exported name keeps its meaning.

### F. Templates table

Remove `templatePage` state, the `Pager`, the `setTemplatePage(1)` call in the
search handler, and the `(templatePage - 1) * 10 + index + 1` row numbering
(→ `index + 1`). Remove the language column — the concept no longer exists.
17 rows; per the project's actual scale, no virtualization.

### G. Stale-selection reset

`manualTemplate` currently survives its own template leaving the eligible set:
the `Select` renders blank and Send proceeds with a stale code. Reset to
`"free"` whenever the selected code is absent from the eligible list. The window
exists today via the locale filter; this change widens it, so the fix is in
scope for both dialogs.

Resetting `manualTemplate` alone is **not** sufficient. If the admin had pulled
the template's copy into the fields with "edit once", `templateEditMode`,
`manualSubject` and `manualBody` stay populated, and that template's text is then
presented and sent as free text under no template at all. The reset must run
through one state transition that also calls the existing `cancelTemplateEdit`.

## Testing

| Test | Asserts |
|---|---|
| `src/lib/workflowCatalog.test.ts` | Both maps are total over `NOTIFICATION_TYPES`; every `viaWorkflows` key exists in `WORKFLOW_CATALOG`; **the exact type→key pairs** match the table in §A, not merely that some key exists. |
| same file | For each of the four gate-2 types, `resolveTypeVariables` returns a non-empty variable set for a seeded tenant, and for a type outside the set it returns `{}`. This is a **behavioural** parity check — an earlier draft proposed grepping `resolveTemplateVariables.ts` for `type === "…"`, which tests formatting and private structure and breaks on a rename or a switch statement without any behaviour changing. |
| `src/hooks/useTenantEligibleTemplates.test.ts` | `payment_admin_alert` is excluded even when `payment-succeeded` carries `tenant`; `document_send` and `user_credentials` are excluded despite passing gate 1; `contract_expiry` appears only while its row carries `tenant`; `always` types appear with no `cron_jobs` row at all. |
| `src/fns/sendNotification.test.ts`, `sendBulkNotification.test.ts` | An ineligible template code is **rejected server-side**, not merely absent from the dropdown. This is the finding that a client-side filter is not a control. |
| `src/fns/resolveTemplateVariables.test.ts` | `unavailableReason` is still set for a missing or inactive code after the fallback ladder is removed. |
| `src/db/templateLocaleCollapse.sqltest.ts` | After both migrations: exactly one row per `(type, channel)` among the seeded types; **none of the 34 legacy codes survives** (asserted against the explicit list, *not* "no code ends in -ar/-en" — that would forbid a legitimate admin code); the `locale` column is gone; every pre-existing `notifications.template_code` still resolves to a live template row; the contract-expiry provider mapping seeded by migration 58 survives onto the merged row. |

**Phase 1 cannot be asserted by the SQL suite.** `scripts/test-db.sh` applies
every migration in numeric order before any test runs, so once 125 exists no
test can observe the intermediate state: `locale` is already gone, the suffixed
rows are already deleted, and an adversarial pair cannot be seeded ahead of 124.
Building a stage-aware harness is disproportionate for a two-migration change.

Instead, phase 1 is verified **where it actually happens** — against production,
between applying 124 and merging PR 2:

```sql
select count(*) from notification_templates;                      -- expect 51
select code from notification_templates where code in ('receipt','receipt-ar');
select column_default from information_schema.columns
 where table_name='notification_templates' and column_name='locale';  -- 'ar'
```

The SQL suite asserts the **final** state only. That is honest about what the
harness can prove, rather than asserting a state it silently never reaches.
| `SendManualMessageDialog.test.tsx` | The label renders `code (type)` in the **message** language while the UI locale is the other one; the code and type sit in separate `<bdi>` elements with the code forced LTR; selecting a template, entering edit-once mode, then making it ineligible resets to `"free"` **and** clears edit mode, subject and body. |
| `src/db/closeoutNotifications.sqltest.ts`, `src/db/newEventWorkflows.sqltest.ts`, `src/db/templateBodies.sqltest.ts`, `src/db/expiryBuckets.sqltest.ts` | All four assert against suffixed codes today and **all four fail after 125**. Each needs its expected row counts halved — two siblings become one — not a mechanical string replace, which would produce duplicate expected values. |

The legacy-code assertion is the guardrail that stops a future seed migration
from resurrecting the pairs. It is deliberately phrased against the explicit list
of 34 rather than as "no code ends in `-ar`/`-en`": the schema has never reserved
those suffixes, so forbidding them outright would break a legitimate
admin-created code.

**Expected coverage loss:** the existing tests for `loadTemplateForLocale`'s
fallback ladder are deleted along with the ladder. That is the point of the
change, not a regression — to be stated explicitly when `test-guard` runs.

Full gates: `bun run lint`, `bun run typecheck`, `bun run test`, and
`bun run test:sql` (which builds a clean database from scratch and is the only
thing that proves the migration set still applies end to end).

## Deploy

Migration files reach the production host only when Dokploy clones `main` at the
start of a build, and the checkout's GitHub token is expired between deploys —
so a migration on an unmerged feature branch **cannot** be applied. "Apply before
merge" is therefore not executable, and the release is three stages:

1. `pg_dump` first — the phase-2 column drop is not reversible.
2. Both PRs are gated on `bun run test:sql` passing locally.
3. **Announce the template-editing freeze — before step 5, not after.** The
   unsafe window opens the moment 124 is applied.
4. **PR 1 — migration `124` only**, no application changes. Merge it. Dokploy
   rebuilds a bundle whose *code* is unchanged.
5. Apply `124` from the new `main` checkout under
   `/etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code/db/migrations`,
   checksum it against the local file, then `notify pgrst, 'reload schema'`.

   The schema change is additive, so the running bundle cannot *fail*. But it is
   **not** invisible to it: the old `useNotificationTemplates` does `select("*")`
   and now returns 51 rows, so the old templates table lists all of them and the
   old Arabic dropdowns show both `receipt` and `receipt-ar`. See §C. Creating,
   editing or deleting a template from here until step 9 is unsafe — an edit to a
   legacy row is discarded by 125.
6. **PR 2 — all application changes plus migration `125`.** Merge; Dokploy
   auto-deploys.
7. **Confirm the new container is serving** — `docker ps`, then send one manual
   message end to end.
8. Only then apply `125` and `notify pgrst, 'reload schema'` again.
9. Verify post-125, then lift the freeze: 17 rows, zero legacy codes,
   `contract-expiry` still carries its provider mapping, no dangling
   `notifications.template_code`.

Steps 5 and 8 must not be collapsed. Between them, both the suffixed and
unsuffixed codes resolve, which is the property that makes the swap safe — see
§C for the FK failure this ordering exists to prevent.

Because phase 1 is additive and phase 2 only removes rows the new code no longer
names, there is no point at which a running bundle can enqueue a template code
that does not exist.

## Known limitation carried forward

One WhatsApp provider binding per `(type, channel)`. If WhatsApp templates are
ever mapped, bilingual binding needs `provider_template_name_ar/_en` and
`provider_language_code_ar/_en` added then.
