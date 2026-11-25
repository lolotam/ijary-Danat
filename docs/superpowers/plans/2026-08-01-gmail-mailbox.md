# Gmail tab → working mailbox — implementation plan

Design: `docs/superpowers/specs/2026-08-01-gmail-mailbox-design.md`

Ordered so each step is independently verifiable and the riskiest part
(threading) lands before the largest part (compose).

## Step 1 — Split the list and detail queries

`useGmailMessages` does `select("*")`, which drags every full MIME payload into
the browser for every row. Already wrong; a detail view makes it much worse.

- List query: enumerate columns, **exclude `raw_payload`**.
- New `useGmailMessage(id)`: fetches `raw_payload` for one message, enabled only
  when a message is open.

## Step 2 — Parsing helpers (`src/lib/gmailMessage.ts`)

Pure functions over a `raw_payload`, so they are unit-testable with no network
and no database:

- `extractHtmlBody(payload)` → HTML string or null
- `extractHeaders(payload)` → `{ messageId, references, inReplyTo, cc, replyTo, date }`
- `listAttachments(payload)` → `{ filename, mimeType, sizeBytes, attachmentId }[]`
- `buildReplyHeaders(headers)` → RFC 5322 `In-Reply-To` / `References`;
  returns `null` when the real `Message-ID` header is absent (the
  `gmail:<id>` fallback is **not** a valid Message-ID and must never be emitted)
- `quoteForReply(...)`, `replySubject(...)`, `forwardSubject(...)`

## Step 3 — Migration 62

- `gmail_messages.category text` (nullable)
- Seed `option_lists` row `gmail_categories` + a starter set of items
- Index on `(company_id, category)` for the filter

Hand-write the `database.types.ts` entries — that file is hand-maintained.

## Step 4 — Shared Gmail client (`src/lib/gmailClient.server.ts`)

`readConfig` and `refreshAccessToken` are private inside `gmailSyncJob.ts` and
are now needed by send and attachment download. Extract **without behaviour
change**; the sync job imports them back.

## Step 5 — Attachment download (`src/fns/gmailAttachment.ts`)

Server fn, staff-gated. `users.messages.attachments.get`, returns base64. Kept
server-side so the access token never reaches the browser.

## Step 6 — Send (`src/fns/gmailSend.ts`)

Server fn, staff-gated. Zod-validated input: `to[]`, `cc[]`, `bcc[]`, `subject`,
`body`, `attachments[]`, optional `replyToMessageId`.

- Build MIME with `MailComposer`, base64url it, POST to `users.messages.send`
- Pass `threadId` for replies so Gmail threads it
- Map a 403 insufficient-scope to a "reconnect Gmail" message
- 25 MB total ceiling

## Step 7 — Scope + reconnect

Add `gmail.send` to `GMAIL_SCOPE`. Surface a banner on the integrations page
when the stored `scope` lacks it, telling the admin to reconnect.

## Step 8 — UI

- **Detail sheet**: sandboxed iframe body, images-off by default, copy button,
  category selector, attachment list, Reply / Reply-all / Forward
- **Compose dialog**: near-full-screen, From read-only, To/Cc/Bcc chips,
  subject, body, attachment picker
- **Gmail tab**: category column + filter

## Step 9 — Tests

Unit (no network): the Step-2 helpers — multipart HTML extraction, attachment
enumeration, `buildReplyHeaders` returning null for a `gmail:` fallback id,
`References` accumulation, subject prefixing (no `Re: Re:`).

Mock: `gmailSend` — recipient validation, size ceiling, scope-error mapping,
`threadId` passed on reply and omitted on compose.

SQL: the category column accepts/filters, and RLS still lets staff update it.

## Gates

`bun run lint && bun run typecheck && bun run test && bun run test:sql`, then
apply migration 62 to production, merge, and verify live in both locales.
