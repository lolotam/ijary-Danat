# Authoritative templates — an HTML editor, a live preview, and templates that actually control the email

**Date:** 2026-08-02
**Piece:** 2 of 3
**Migration:** `db/migrations/70_seed_template_bodies.sql`
**Branch:** `feat/authoritative-templates`
**Depends on:** Piece 1 (merged, PR #61). Independent of it in code, but sequenced
after so the two land separately.

---

## 1. The problem

There are 16 rows in `notification_templates` in production — 8 types × 2 locales
— every one active, every one with `body_ar` and `body_en` populated:

```
due-reminder, overdue-reminder, receipt, contract-expiry,
invoice-document, deposit-confirmation, user-credentials, payment-admin-alert
```

**Fourteen of them are decorative.** Only `user-credentials-*` (migration 68) and
the manual-send path in `sendNotification.ts` read a body. Every other
automatic send composes its HTML from a hardcoded builder in
`src/lib/emailTemplates.ts` and merely _tags_ the notification row with a
`template_code`.

So an admin edits a template, saves it, sees it listed as active — and the next
receipt goes out with the old wording. This is the same written-but-never-read
defect Piece 1 fixed for the pause switch, in a different place. Adding a
preview without fixing it would make it worse: the preview would faithfully show
an email the system never sends.

### Where the body is decided

`enqueueNotification` writes `subject` and `body` onto the `notifications` row.
`dispatchNotification` reads `notification.body` and sends it verbatim. **The
body is baked at enqueue time, not at send time.**

That means "make templates authoritative" is not a change to the dispatcher. It
is a change to what each _sender_ composes — which is exactly what migration 68
already did for credentials via `loadCredentialCopy`. This piece generalises that
proven pattern to the **six** remaining types that actually have a sender —
`due_reminder` has none, which §7 covers.

---

## 2. What the template body controls

**Hybrid, with full-document opt-in.**

By default the stored body is the _inner content_: it is placed inside
`wrapLayout`'s branded shell (green header, brand name, grey footer note), so
every email stays on-brand and a template only carries the part that differs.

If the trimmed body begins with `<!doctype` or `<html` (case-insensitive), it is
used **verbatim** and the shell is skipped. That is the escape hatch for an
admin who wants total control of a particular email.

```ts
/** Exported from emailTemplates.ts; the single place this decision is made. */
export function renderEmailDocument(locale: EmailLocale, title: string, bodyHtml: string): string {
  const trimmed = bodyHtml.trimStart();
  if (/^<!doctype|^<html/i.test(trimmed)) return bodyHtml;
  return wrapLayout(locale, title, bodyHtml);
}
```

The alternative — always a full document — was rejected because a brand change
would then mean hand-editing 16 rows instead of one function, and every template
would have to re-implement Outlook-safe inline styles.

**`wrapLayout` is also what sets `dir`.** Skipping it for a full document means
the admin must set `dir="rtl"` and `lang="ar"` themselves on an Arabic template,
or it renders left-to-right and looks broken. That is inherent to the opt-in
rather than a defect, but it is not discoverable — so the editor's placeholder
help states it wherever the full-document escape hatch is mentioned.

---

## 3. The change that makes this safe: seed the bodies from the builders

Making templates authoritative means the DB body replaces the builder's inner
content entirely. If the seeded bodies did not already reproduce today's emails,
switching this on would silently degrade every notification — a receipt losing
its amounts table, an expiry warning losing its date.

So **migration 70 rewrites all 14 non-credentials bodies with HTML that
reproduces the current builder output**, with every dynamic value expressed as a
`{{placeholder}}`.

The consequence is the property that makes this reviewable: **on the day it
ships, every email is byte-comparable to what it was before.** Nothing changes
until an admin edits a template. The switch from hardcoded to template-driven is
observable only as new capability, never as new wording.

The builders stay in `emailTemplates.ts` as the **fallback** when a row is
missing or inactive — the same degradation migration 68 chose. They are not a
second source of truth for the happy path; they are the safety net for a deleted
row.

---

## 4. The shared loader

`loadCredentialCopy` becomes a general, exported function in a new
`src/fns/loadTemplateCopy.ts`:

```ts
export async function loadTemplateCopy(
  code: string,
  locale: EmailLocale,
  variables: Record<string, string>,
): Promise<{ subject: string | null; body: string | null }>;
```

Behaviour, unchanged from the credentials implementation:

- Selects on `code` and `is_active = true`.
- Reads the column matching the locale (`subject_ar`/`subject_en`,
  `body_ar`/`body_en`), so what an admin edits under "Arabic" is exactly what an
  Arabic recipient receives.
- Returns `{ subject: null, body: null }` when the row is missing or inactive, so
  callers fall back to the built-in copy rather than sending nothing.
- Values are escaped with `escapeVariables` before substitution; the
  admin-authored markup around them is deliberately left as markup. A tenant
  named `<script>` must not be able to inject through a placeholder.

`notifyUserCredentials.ts` drops its private copy and imports this one.

### Plain-text bodies

Emails carry a `text` alternative and WhatsApp is plain text, but the table has
no `body_text` column and this piece does not add one. `stripMarkup` — today a
private function in `notifyUserCredentials.ts` — moves to
`src/lib/templateRender.ts` and derives the text part from the rendered HTML.
One authored body, both representations.

---

## 5. Variables and preview samples

A single registry, `src/lib/templateVariables.ts`, pure and importable from both
the browser and the server:

```ts
export interface TemplateVariableSpec {
  key: string;
  labelAr: string;
  labelEn: string;
  sample: string;
}
export const TEMPLATE_VARIABLES: Record<NotificationType, TemplateVariableSpec[]>;
```

It drives two things that must not disagree: the placeholder list shown in the
editor, and the values the preview substitutes. Defining them apart is how a
preview comes to show a placeholder the sender never supplies.

**Preview data is built-in samples, not real records** — `أحمد المطيري`,
`INV-2026-0042`, `250.000 KWD`. Deterministic, works on an empty system, and puts
no real tenant's name, phone or balance on an admin screen. Unknown placeholders
render verbatim (`{{recipent_name}}`), which is `renderTemplate`'s existing
behaviour and makes a typo visible rather than silently blank.

---

## 6. The editor

In the Templates tab's existing dialog:

- **Body fields become monospace HTML source textareas.** No CodeMirror or
  Monaco — neither is installed and neither is needed to paste and edit HTML.
- **Each body gets an Edit / Preview toggle.** Preview renders through
  `renderEmailDocument` — the _same_ function the senders use — so the preview
  is honest by construction rather than by a second implementation kept in step.
- **Both locales preview independently**, each in its own direction (`rtl` for
  Arabic), because the shell sets `dir` from the locale.
- **A placeholder reference** for the selected type, click-to-insert at the
  cursor.

### Preview isolation

The preview renders in `<iframe sandbox srcdoc={html} />` with an **empty**
`sandbox` attribute — no `allow-scripts`, no `allow-same-origin`. Admin-authored
HTML therefore cannot run script, reach the session, or escape into the admin
layout, and a malformed template breaks only its own preview pane.

This is why no HTML sanitiser is added. Sanitising would be the wrong tool
anyway: the body is _meant_ to contain arbitrary markup, authored by an admin who
already has permission to change what the system emails. The isolation protects
the admin app from broken HTML, not the system from the admin.

---

## 7. Which senders change

| Template code            | Sender                                 |
| ------------------------ | -------------------------------------- |
| `overdue-reminder-*`     | `overdueRemindersJob`                  |
| `receipt-*`              | `notifyPaymentSuccess`                 |
| `contract-expiry-*`      | `contractExpiryJob`                    |
| `invoice-document-*`     | `sendInvoiceToTenant`                  |
| `deposit-confirmation-*` | `notifyDepositConfirmedRecord`         |
| `payment-admin-alert-*`  | `notifyPaymentSuccess`                 |
| `user-credentials-*`     | already template-driven (migration 68) |
| `due-reminder-*`         | **none — see below**                   |

Six senders change. Each gains the same three lines: load the copy, fall back to
the builder when it is null, compose through `renderEmailDocument`.

### `due-reminder-*` has no sender at all

`grep -rn 'type: "due_reminder"' src/` returns **nothing**. The enum member
exists (`07_phase5_notifications_reports.sql:8`), `dispatchNotification` lists it
among the types it can route, and two template rows sit in production — but
nothing anywhere enqueues a notification of that type. Only `overdue_reminder`
has a sender.

So these two rows are decorative for a _different_ reason than the other twelve:
not "written and never read", but "read by nobody because nothing writes". This
piece cannot make them authoritative, because there is no send path to point at
a template.

They are therefore **seed-only**: migration 70 gives them sensible placeholder
bodies so they are ready if a due-reminder sender is ever built, and no code
changes. Anything more would be inventing a feature nobody asked for. Worth
raising separately as a product question — should tenants get a reminder _before_
an invoice falls overdue? — but not answering it here.

---

## 8. Tests

1. **A template body reaches the sent notification.** Seed a row with a
   recognisable marker, run the sender, assert the marker appears in the enqueued
   `body`. This is the assertion that would have failed for all seven types
   before this piece — the one that proves the row is read.
2. **A missing or inactive row falls back to the built-in copy** and still sends.
3. **Placeholders are substituted; unknown ones survive verbatim.**
4. **Values are escaped, markup is not** — a tenant named `<script>alert(1)</script>`
   appears escaped in the body while the template's own `<p>` survives.
5. **The full-document opt-in is honoured** — a body starting with `<!doctype`
   is not wrapped; anything else is.
6. **Locale selects the matching column** — the Arabic row's `body_ar` is used
   for an Arabic recipient, never `body_en`.
7. **sqltest:** all 16 rows still active with both bodies non-null after
   migration 70, and re-running it is idempotent.
8. **The seeded bodies reproduce the builders' output.** This is the test §3's
   whole safety claim rests on, and nothing else checks it: if migration 70's
   hand-written HTML drops the receipt's amounts table, tests 1–7 all still pass
   and the regression ships silently.

   For each of the six live types, render the built-in builder and the seeded
   template with the same variables and assert they carry the same significant
   content. Exact byte equality would fail on whitespace trivia, so normalise
   whitespace and assert that **every dynamic value the builder emits also
   appears in the rendered template**. That is weaker than equality but catches
   the failure that matters — a dropped table, a missing amount, a lost date.

Gates: `bun run lint`, `typecheck`, `test`. Migration verified by applying it to
the live database over `ssh-danatfuture-mcp` (not local Docker) per the standing
preference, after snapshotting the current bodies.

---

## 9. Risks

| Risk                                                | Mitigation                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Switching to DB bodies silently changes every email | Migration 70 seeds bodies reproducing current output; day-one behaviour identical |
| A deleted or inactive row stops a send              | Falls back to the built-in builder, per migration 68's proven pattern             |
| Tenant data injects through a placeholder           | `escapeVariables` before substitution; test 4                                     |
| Admin HTML breaks the admin UI                      | Preview in an empty-sandbox iframe                                                |
| Preview disagrees with what is sent                 | Preview calls `renderEmailDocument`, the same function the senders use            |
| Editing migration 70 later won't reach prod         | New migration each time; standing repo rule                                       |
| Losing the plain-text alternative                   | `stripMarkup` derives it from the rendered HTML                                   |

---

## 10. Out of scope

Piece 3's four new workflows. A `body_text` column. WYSIWYG editing. Per-tenant
template overrides. Template versioning or history.
