# Batch B2 — Inbox / Landing Remediation and Gmail OAuth

**Status:** Approved 2026-07-29
**Scope:** Repair the regressions Batch B shipped (three lost capabilities, four
badge/form bugs), harden the Gmail sync worker, and build the in-app "Connect
Gmail" OAuth flow the user chose over an env-var-only token.

Batch B landed without a spec or a plan. This document exists so B2 does not
repeat that. Every defect below was confirmed against the code, not inferred.

---

## B2.1 — L1: Leasing lead status can no longer be changed

### Problem

Every leasing lead is permanently stuck at `status = 'new'`. There is no control
anywhere in the app to move a lead to `contacted` / `accepted` / `rejected`.

### Root cause

Commit `a69a7a5` ("remove Leasing Leads tab (moved to inbox)") deleted the 116
lines that held the only status `<Select>`. The move to the inbox tab
(`admin.inbox.tsx:529-631`) rebuilt the table **without** it. The mutation
`useUpdateLeasingInquiry` (`useLandingSettings.ts:447`) survived; its sole caller
`handleUpdateLeadStatus` (`admin.settings.landing-page.tsx:569`) is unreachable —
nothing renders it.

### Change

Add a Status column to the Leads tab of `admin.inbox.tsx`, using the same
four-option `<Select>` the deleted tab had. The i18n keys it referenced
(`landing.admin.leads.status.new|contacted|accepted|rejected`) still exist in
both locale blocks (`dictionary.ts:1143`, `:2307`), so no new strings are needed.

The allowed values are fixed by the DB:
`check (status in ('new','contacted','accepted','rejected'))`
(`19_landing_page.sql:131`). The `<Select>` must not offer anything else.

Then delete the now-dead code from `admin.settings.landing-page.tsx`: the
`useLeasingInquiries` query (`:139`), the `useUpdateLeasingInquiry` mutation
(`:150`), `handleUpdateLeadStatus` (`:568-576`), the `loadingInquiries` term in
the render gate (`:202`), and the two imports. `inquiries` is already referenced
nowhere — today the settings page blocks its own render on a query whose result
it discards.

---

## B2.2 — L2: Gmail messages can never be marked read

### Problem

`useMarkGmailRead` (`useGmailMessages.ts:40`) has zero consumers. The Gmail tab
renders delete only (`admin.inbox.tsx:705-716`), so `is_read` stays `false`
forever and the bell badge grows monotonically. The only way to clear it is to
delete the mail.

### Change

Wire a mark-read / mark-unread toggle into the Gmail tab's action cell, mirroring
the tenant-message pattern at `:396-406`. Unlike tenant messages (whose control
only appears while `status === 'new'`), Gmail gets a **toggle** — a mail marked
read by accident should be recoverable without deleting it. This needs one new
i18n key, `inbox.markUnread`, in both locale blocks.

### The RLS trap this uncovers

Migration 50 gates UPDATE on `has_role(auth.uid(), 'admin')` (`:56-60`) while the
inbox page gates rendering on `permissions.isStaff`. An accountant or collector
would see the button and get a silent policy failure. The repo's own idiom for
staff-managed inbox rows is `public.is_staff(auth.uid())` — that is what
`tenant_messages_staff_update` uses (`22_batch_features.sql:85-89`), and it is
what mark-read on tenant messages already relies on.

**Migration 50 is edited in place**, not superseded, because it has never been
applied to any host — verified on the current production server 2026-07-29 via
`to_regclass('public.gmail_messages')`. It also gains the `drop policy if exists`
lines every other policy file in this repo carries, for the same reason migration
10 needed them: `create policy` has no `if not exists`, so without the drops a
re-apply of `db/migrations/` aborts here.

SELECT and UPDATE move to `is_staff`. DELETE stays admin-only, matching
`contact_inquiries`.

---

## B2.3 — L3: the Gmail tab is broken in production

Migration 50 was written, committed, and never applied. The Gmail tab queries a
table that does not exist, on both the old host and the current one.

Applying it is an ops step of this batch, not a code change. It ships together
with migration 53 (below) so the tab and its OAuth settings page land at once.

---

## B2.4 — B1: the landing form silently discards what it collects

### Problem

`business_activity`, `preferred_size`, and `preferred_contact_method` render for
**both** request types (`index.tsx:1692`, `:1704`, `:1760`), but the `general`
branch of `onSubmitLeasing` (`:469-484`) sends only name / email / phone /
subject / message. A visitor selects "General request", fills in all three, gets
a success screen, and the data reaches no table.

### Change

`contact_inquiries` has five content columns — `name`, `phone`, `email`,
`subject`, `message` (`10_contact_inquiries.sql:2-10`) — and no schema change is
warranted for a free-text side channel. So:

- Hide the two genuinely leasing-only fields (`business_activity`,
  `preferred_size`) when `request_type === 'general'`. This needs `watch` added
  to the `useForm` destructure at `:265-270`.
- Keep `preferred_contact_method` visible for both — a general enquirer's
  preferred channel is just as useful — and append it to the general path's
  message body alongside the `company_name` line that is already appended.
- Append any non-empty leasing-only values too. react-hook-form retains values
  for unmounted fields by default, so a visitor who fills the leasing fields and
  _then_ switches to "General" still has them in form state. Appending rather
  than dropping them is what makes "nothing is discarded" literally true.

---

## B2.5 — B2: the honeypot is bypassable

`submitLeasingInquiry` enforces `website: z.string().max(0)`
(`submitLeasingInquiry.ts:19`); `submitContactInquiry` has no `website` field at
all (`:7-13`). A bot that posts `request_type=general` skips spam protection
entirely — and that is the branch with no company lookup, so it is the cheaper
one to flood.

### Change

Add the same `website: z.string().max(0).optional()` to `contactSchema`, and pass
`data.website` from the general branch of the form.

### Why the schema gets exported

The existing server-fn tests mock `createServerFn` with a stub `.validator()`, so
zod never executes — that is the documented reason Gate 1 exists. A mock-style
"honeypot rejection" test would assert nothing at all. `contactSchema` is
therefore exported and the test calls `safeParse` on it directly, which is the
only way this assertion means something.

---

## B2.6 — B3/B4: badge counts and the bell dropdown

### B3 — the Tenants tab shows everyone's unread count

`unreadCount` (`admin.inbox.tsx:248-251`) sums tenant + leads + gmail, and is
rendered on the Tenants trigger alone (`:261-265`). The Leads and Gmail triggers
compute their own counts correctly (`:270`, `:278`), so today those numbers are
double-rendered: 3 unread Gmail shows as "3" on Gmail _and_ inflates Tenants.

**Change:** the Tenants badge counts tenant messages only. The consolidated total
stays where it belongs — the header bell.

### B4 — the bell shows a count it cannot show items for

`InboxBell.tsx` branches on `totalCount` (`:65`) but maps `unread` — tenant
messages only (`:70`). Three unread Gmail messages produce badge "3", an empty
dropdown, and not even the "no messages" row, because `totalCount === 0` is false.

**Change:** build one merged, date-sorted list of unread entries across tenant
messages, leads, and Gmail, and render the first 8. Each entry carries the label
of its source so an admin can tell a lead from a mail.

### The deep-link problem this exposes

Rendering leads and Gmail in the dropdown means their links must go somewhere
real. Today `validateSearch` accepts only `?message=<id>` (`admin.inbox.tsx:37`),
the active tab is plain `useState("tenants")` (`:46`), and only tenant rows carry
an `id` anchor and the highlight class (`:340-347`). A lead link would land on the
Tenants tab with nothing highlighted.

So the search schema gains `tab`, the `Tabs` component becomes controlled by it,
and the leads and Gmail rows get the same `id={...-<id>}` anchor and highlight
treatment the tenant rows have. Without this the dropdown fix is cosmetic.

---

## B2.7 — Gmail sync defects

### No pagination

`gmailSyncJob.ts:141-149` sets `maxResults=50` and never reads `nextPageToken`.
Anything beyond the newest 50 in a tick is silently never synced.

**Change:** follow `nextPageToken` — but with a hard cap. Each listed message
costs one serial `format=full` GET (`:168-198`), so an uncapped first run against
a real mailbox would walk every message ever received, one request at a time, and
insert them all as unread. The job takes a page cap and a total-message cap, and
bounds the list query with `q=newer_than:` so a first run cannot swallow a decade
of mail.

### `extractPlainText` reads only the top level

`:102-119` decodes `payload.body.data` and nothing else. Multipart mail — which
is essentially all mail — carries its text in `payload.parts[]`, so `body_text`
is null for nearly every row. The tab papers over this by falling back to
`snippet` (`admin.inbox.tsx:703`).

**Change:** walk the MIME tree recursively. Prefer `text/plain`; fall back to
`text/html` with tags stripped; return null if neither exists (the caller already
falls back to `snippet`).

### `message_id` is nullable under a unique constraint

`unique (company_id, message_id)` with `message_id text` (`50:14,26`) does not
constrain rows where `message_id is null` — in Postgres, null is never equal to
null, so every message lacking an RFC 822 `Message-ID` header re-inserts on every
tick. That directly contradicts the idempotency guarantee in the job's own
docstring.

**Change:** `message_id` becomes `not null`, with the fallback
`gmail:${meta.id}`. Note this is **not** the `gmail:{thread_id}:{internalDate}`
form the roadmap sketched: `thread_id` is itself nullable, whereas `meta.id` is
Gmail's own immutable per-mailbox message id, always present, and currently
thrown away (`GmailMessageFull.id` at `:89` is never written to a column).

### `is_read: false` on every synced row

`:194` hardcodes it. That is safe **only** because the upsert passes
`ignoreDuplicates: true` (`:205`), which makes the write a no-op for rows that
already exist. Since this batch adds mark-read, that dependency stops being
incidental and becomes load-bearing: flipping to a real upsert would un-read the
entire inbox on every tick. It gets a comment saying so.

---

## B2.8 — Gmail OAuth (migration 53)

Today the worker reads `GMAIL_REFRESH_TOKEN` from the environment
(`gmailSyncJob.ts:40`), which means connecting a mailbox requires a redeploy and
a hand-minted token. The user chose the full in-app flow.

### `gmail_connections`

| Column                                              | Notes                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| `id`                                                | uuid pk                                                           |
| `company_id`                                        | fk → companies, **unique** — one connected mailbox per deployment |
| `email_address`                                     | the mailbox that granted consent                                  |
| `refresh_token`                                     | secret; service-role only, never selectable by `authenticated`    |
| `scope`, `token_type`                               | what Google actually granted                                      |
| `connected_by`                                      | fk → auth.users                                                   |
| `connected_at`, `last_synced_at`, `last_sync_error` | operational status                                                |

RLS: admins may read the **status** of the connection, never the token. The
cleanest way to enforce that in Postgres is column-level: the `authenticated`
grant is `select (id, company_id, email_address, scope, connected_by,
connected_at, last_synced_at, last_sync_error)` — `refresh_token` is simply not
in the grant, so a leaked client key still cannot read it. `service_role` keeps
`all`.

### Routes

- `/admin/settings/integrations` — Connect / Disconnect, connection status, last
  sync time and last error.
- `beginGmailOAuth` (**server function**, not a GET route) — admin-gated; mints
  the signed state and returns the Google consent URL, which the page then
  navigates to. It has to be a server function: this app authenticates server
  calls with `Authorization: Bearer <access_token>`
  (`integrations/supabase/auth-middleware.ts`), and a browser navigating to a
  GET route sends no such header — an admin-gated `/api/oauth/google/start`
  would reject the very click that starts the flow. The consent URL carries
  `access_type=offline&prompt=consent`; without both, Google returns no refresh
  token on a repeat consent.
- `/api/oauth/google/callback` — a GET route, because Google redirects the
  browser to it. It carries no session either, and does not need one: the signed
  `state` is what authenticates it, which is precisely what state is for. It
  verifies state, exchanges the code, persists the token server-side, and
  redirects back to the settings page with a status flag.
- `disconnectGmail` (server function) — admin-gated; revokes the grant at Google
  first, then deletes the row, so disconnecting actually ends Google's side of
  the relationship rather than just forgetting it locally.

### The security boundary

The refresh token is the entire risk surface: it is long-lived and grants inbox
read access. It never reaches the browser, never appears in a `VITE_`-prefixed
variable (those are compiled into the bundle), and never lands in an audit
`after` payload. The callback route returns a redirect, not a body. The state
nonce is HMAC-signed with `CRON_SECRET`-style server-only material and carries an
expiry, so a forged or replayed callback is rejected.

`gmailSyncJob` reads the stored connection first and falls back to
`GMAIL_REFRESH_TOKEN` when no row exists, so an environment already wired by hand
keeps working.

---

## B2.9 — Ops

- Apply migrations 50 and 53 to the production host.
- `deploy/README.md`: add the missing `gmail-sync` crontab line — the job is
  registered in `cronJobs.ts:29` but was never scheduled — and correct the
  "five jobs" wording, now six.
- `.env.example`: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI`,
  optional `GMAIL_SYNC_ADDRESS`, and a note that `GMAIL_REFRESH_TOKEN` is now the
  fallback path only.

---

## Tests

| Test                           | Kind                 | Asserts                                                                                                                                                                   |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submitContactInquiry.test.ts` | schema (`safeParse`) | honeypot rejects non-empty `website`; accepts empty/absent; required fields enforced                                                                                      |
| `contactMessageBody.test.ts`   | pure fn              | general-path composer keeps company / activity / size / contact-method; drops nothing non-empty; no dangling separators when all optional                                 |
| `gmailSyncJob.test.ts`         | mock fetch           | not-configured no-op; pagination follows `nextPageToken` and stops at the cap; multipart text extraction (nested, html fallback); `message_id` falls back to `gmail:<id>` |
| `gmailOAuth.test.ts`           | pure fn              | state nonce round-trips; forged signature rejected; expired nonce rejected                                                                                                |
| `gmail.sqltest.ts`             | SQL                  | `message_id` NOT NULL holds; the same message twice is one row; staff can update `is_read`; `refresh_token` is not readable by `authenticated`                            |

The SQL test is what makes the RLS claim real — a mock cannot prove a column
grant. That is precisely what Gate 1 was built for.
