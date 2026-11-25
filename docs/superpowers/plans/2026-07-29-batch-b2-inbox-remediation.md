# Batch B2 — Inbox Remediation and Gmail OAuth: Implementation Plan

> Design: `docs/superpowers/specs/2026-07-29-batch-b2-inbox-remediation-design.md`

**Goal:** Restore the three capabilities Batch B lost, fix the four form/badge
defects it shipped, harden the Gmail sync worker, and add the in-app Gmail OAuth
connect flow.

**Status:** Implemented 2026-07-29 — commits `c34b0f9`, `8d20565`, `4cf9604`.
Step 3.6 (applying migrations 50 and 53 to production) is the one remaining
item and is an ops action, not code.

**Shape:** three commits, each independently green under
`bun run lint && bun run typecheck && bun run test` (plus `bun run test:sql` from
commit 2 onward).

**Tech:** React 19 + TanStack Router/Start, TanStack Query, react-hook-form + zod,
Radix/shadcn, Supabase, Vitest.

---

## Commit 1 — UI and landing remediation (L1, L2, B1–B4)

| File                                         | Change                                                                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/admin.inbox.tsx`                 | Leads Status `<Select>` (L1); Gmail mark-read/unread toggle (L2); Tenants badge counts tenant messages only (B3); `tab` search param + controlled `Tabs`; row anchors + highlight on leads and Gmail rows |
| `src/components/admin/InboxBell.tsx`         | Merge tenant + lead + Gmail unread into one date-sorted list; label each source; deep-link with `{ tab, message }` (B4)                                                                                   |
| `src/routes/admin.settings.landing-page.tsx` | Delete the dead `useLeasingInquiries` query, `useUpdateLeasingInquiry`, `handleUpdateLeadStatus`, the `loadingInquiries` render gate, and both imports                                                    |
| `src/lib/contactMessageBody.ts`              | NEW — pure composer for the general-request message body                                                                                                                                                  |
| `src/routes/index.tsx`                       | `watch("request_type")`; hide leasing-only fields on general; pass `website`; compose the body via the new helper (B1)                                                                                    |
| `src/fns/submitContactInquiry.ts`            | Export `contactSchema`; add `website: z.string().max(0).optional()` (B2)                                                                                                                                  |
| `src/i18n/dictionary.ts`                     | `inbox.markUnread`, `inbox.source.*` in **both** `ar` and `en`                                                                                                                                            |
| `src/lib/contactMessageBody.test.ts`         | NEW                                                                                                                                                                                                       |
| `src/fns/submitContactInquiry.test.ts`       | NEW — `safeParse` against the real schema                                                                                                                                                                 |

Steps:

- [x] 1.1 Export `contactSchema` + honeypot field; write the schema test first and watch it fail on the missing field.
- [x] 1.2 `contactMessageBody.ts` + its test.
- [x] 1.3 Landing form: `watch`, conditional fields, `website`, composed body.
- [x] 1.4 Inbox: `tab` search param, controlled tabs, row anchors/highlight for leads + Gmail.
- [x] 1.5 Inbox: Leads status Select; Gmail read toggle; Tenants badge scoped.
- [x] 1.6 Bell: merged unread list.
- [x] 1.7 Strip the dead lead code from landing-page settings.
- [x] 1.8 i18n keys in both locales.
- [x] 1.9 `format` → `lint` → `typecheck` → `test`; commit.

**Watch for:** the four lead statuses are DB-constrained
(`19_landing_page.sql:131`) — offering a fifth value yields a check violation at
runtime, not a type error.

---

## Commit 2 — Gmail sync hardening + migration 50 corrections

| File                                          | Change                                                                                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/migrations/50_gmail_messages.sql`         | `message_id` NOT NULL; `drop policy if exists` before each create; SELECT/UPDATE → `public.is_staff(auth.uid())`, DELETE stays admin                                                                     |
| `src/integrations/supabase/database.types.ts` | Hand-edit `gmail_messages.message_id` to non-null (the file is hand-maintained — never regenerate over it)                                                                                               |
| `src/fns/gmailSyncJob.ts`                     | `nextPageToken` pagination with page + total caps and a `newer_than` bound; recursive `extractPlainText`; `message_id` fallback `gmail:<meta.id>`; comment the `ignoreDuplicates` ↔ `is_read` dependency |
| `src/fns/gmailSyncJob.test.ts`                | NEW                                                                                                                                                                                                      |
| `src/db/gmail.sqltest.ts`                     | NEW                                                                                                                                                                                                      |

Steps:

- [x] 2.1 Edit migration 50 (safe: never applied to any host — verified 2026-07-29).
- [x] 2.2 `bun run test:db --fresh` — the migration set must build a clean DB.
- [x] 2.3 Extract `extractPlainText` / pagination into testable units; write tests.
- [x] 2.4 Implement; hand-patch `database.types.ts`.
- [x] 2.5 `test:sql` + the three gates; commit.

**Watch for:** `bun run gen:types` writes `database.types.generated.ts`, a
reference file. Copying an entry across is a hand edit. Overwriting the real file
destroys 73 aliases that ~70 files import.

---

## Commit 3 — Gmail OAuth (migration 53)

| File                                          | Change                                                             |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `db/migrations/53_gmail_connections.sql`      | NEW — table, RLS, column-level grant that excludes `refresh_token` |
| `src/integrations/supabase/database.types.ts` | Hand-written `gmail_connections` entry                             |
| `src/lib/oauthState.ts`                       | NEW — HMAC sign/verify + expiry for the state nonce                |
| `src/routes/api/oauth/google/start.ts`        | NEW — admin-gated consent redirect                                 |
| `src/routes/api/oauth/google/callback.ts`     | NEW — state verify, code exchange, persist, redirect               |
| `src/hooks/useGmailConnection.ts`             | NEW — status query + disconnect mutation                           |
| `src/routes/admin.settings.integrations.tsx`  | NEW — Connect / Disconnect + status                                |
| `src/fns/gmailSyncJob.ts`                     | Read the stored connection first; env token as fallback            |
| `src/i18n/dictionary.ts`                      | Integration page strings, both locales                             |
| `deploy/README.md`, `.env.example`            | `gmail-sync` crontab line; six jobs not five; `GMAIL_*` vars       |
| `src/lib/oauthState.test.ts`                  | NEW                                                                |

Steps:

- [x] 3.1 Migration 53 + `test:db --fresh`.
- [x] 3.2 `oauthState.ts` + test (forged signature, expiry).
- [x] 3.3 Routes; then the settings page and hook.
- [x] 3.4 Sync job reads the stored token.
- [x] 3.5 Docs/env; gates; commit.
- [ ] 3.6 Apply migrations 50 + 53 to production, then re-probe with
      `to_regclass` — Batch B's migration 50 was committed and never applied and
      nobody noticed.

**Watch for:** the refresh token never reaches the browser, never enters a
`VITE_` variable, never enters an audit payload. The callback returns a redirect,
never a body containing the token.

---

## Verification

1. `bun run lint && bun run typecheck && bun run test` before every commit.
2. `bun run test:sql` from commit 2.
3. `bun run test:db --fresh` after any migration edit — it builds a clean
   database from `db/migrations/` and is the only thing that catches a parse
   error or a non-re-runnable file.
4. Every new i18n key present in **both** the `ar` and `en` blocks.
5. Migrations verified _on the host_ after applying, not assumed.
6. Never force-push, rebase, amend, or squash anything already on `main`.
