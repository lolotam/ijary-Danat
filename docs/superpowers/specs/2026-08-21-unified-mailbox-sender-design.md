# Unified mailbox: sender selection and provider badges

**Date:** 2026-08-21
**Status:** proposed

## What the user asked for

1. Compose gets a sender option — pick which address to send from, Gmail or Resend.
2. The inbox receives **all** incoming mail from both Gmail and Resend.
3. Filters and badges showing which provider a message came through.

## What is buildable, and what is not

Points 1 and 3 are buildable in full. **Point 2 is not**, and no amount of code
changes that. Two independent blockers:

**No MX records.** `danat-future.com` has none — verified 2026-08-21 against
`1.1.1.1` and `8.8.8.8` — and root-domain inbound was deliberately switched off
in Resend. Mail cannot physically reach Resend without an MX record pointing at
it. Resend's own guidance is to put inbound on a subdomain so it does not
conflict with existing mail; that is a DNS decision, not a code one.

**The API key cannot read.** Even with MX in place, the `email.received` webhook
carries *only metadata* — Resend documents that "webhooks do not include the
email body, headers, or attachments". The body must be fetched with
`GET /emails/received/:id`. The production key is send-only: it answers
`401 {"name":"restricted_api_key"}` on every read endpoint. Inbound would store
subject lines with permanently empty bodies.

So inbound is **out of scope**, and deliberately not stubbed. A dead code path
that silently receives nothing is this codebase's documented recurring defect
(see `written-but-never-read-columns`). The schema this design adds is what
inbound would need, so enabling it later is additive, not a rewrite.

**Prerequisites to revisit inbound:** (a) an MX record on a subdomain such as
`mail.danat-future.com`, and (b) a Resend API key with read access — a second
key, keeping the send-only key for sending.

## Core design decision: the sender *is* the provider

Not two controls. One dropdown of concrete addresses, each carrying its
provider. Choosing `ahmed@danat-future.com` selects Resend because that is the
only provider that can send it; choosing the connected Gmail account selects
Gmail. A separate provider toggle would let a user pick an illegal pair —
Gmail plus an arbitrary From — and Gmail would reject it.

This resolves the constraint already documented at `GmailComposeDialog.tsx:32`:

> From is display-only. Gmail sends as the authenticated account and refuses an
> arbitrary sender, so an editable From would be a control that silently does
> nothing — worse than an honest read-only field.

That reasoning still holds *for Gmail*. Resend is different: it verifies the
**domain**, so any address on `danat-future.com` is legal. The field stops being
a lie because the options are now restricted to addresses that actually work.

## Data model — migration 158

`gmail_messages` gains one column:

```sql
alter table public.gmail_messages
  add column if not exists provider text not null default 'gmail'
    check (provider in ('gmail', 'resend'));
create index if not exists gmail_messages_provider_idx
  on public.gmail_messages (company_id, provider, received_at desc);
```

`default 'gmail'` backfills every existing row correctly — everything in there
today did come through Gmail.

**The table keeps its name.** It now holds Resend rows too, so the name becomes
historical. Renaming touches 16 files and the hand-maintained `database.types.ts`
for no behavioural gain, and this design should not carry that risk. The column
comment records why.

**Resend sender addresses** live in the existing settings option list mechanism
as `resend_senders`, matching how `gmail_categories` already works. Admins edit
them in Settings → Lists rather than needing a deploy. Resend rejects an address
outside the verified domain, and that error surfaces to the sender.

**`message_id` for Resend rows** is `resend:<email_id>`, mirroring the existing
`gmail:<id>` convention for messages with no RFC 822 header. This keeps the
`(company_id, message_id)` unique key meaningful and makes the row joinable to
`email_webhook_events.provider_message_id`.

## Send path

A new server function `sendMailboxMessage` owns provider routing:

- `provider: 'gmail'` → the existing Gmail path, unchanged.
- `provider: 'resend'` → `sendWithResend` from `src/lib/providers/resend.ts`,
  which already handles attachments and returns a message id.

Both branches then write the same `gmail_messages` row with
`direction = 'sent'` and the matching `provider`, so the Sent folder is unified
by construction rather than by a merge at read time.

`gmailSend` is not deleted or rewritten — the Gmail branch delegates to its
existing internals. Its 
tests keep passing unchanged, which is the evidence
that the refactor preserved behaviour.

**Validation:** the server function re-checks that the chosen sender is legal
for the chosen provider. A client can post any JSON; a Resend address paired
with `provider: 'gmail'` must be rejected server-side, not merely absent from
the dropdown.

## Inbox UI

- **Badge** per row and in the message sheet: Gmail or Resend, driven by
  `provider`. Bilingual, following existing badge patterns.
- **Filter**: All / Gmail / Resend, alongside the existing category filter, in
  both Received and Sent sub-tabs. Added to `useGmailMessages` params and to the
  query key, so the two providers never share a cache page — the same reason
  `direction` is already in that key.
- Received rows are all Gmail until inbound exists. The filter is still correct,
  not speculative: it is needed the moment the first Resend row is *sent*.

## Testing

- `sendMailboxMessage`: routes to the right provider; rejects a provider/sender
  mismatch; writes a row with the correct `provider` and `message_id` prefix.
  The Resend branch asserts against a fake at the HTTP boundary, not a mock of
  our own helper.
- `useGmailMessages`: the provider filter reaches the query and is part of the
  cache key.
- Badge rendering for both providers.
- Migration 158 verified against the real Postgres before it is applied.

Assertions must be non-vacuous: shadcn bakes `disabled:` classes into every
button, so a disabled assertion checks `disabled=""`, not a class match.

## Out of scope

- Resend inbound (blocked as above).
- Renaming `gmail_messages`.
- Threading Resend replies — no inbound means no reply to thread.

---

## Revisions after the Codex debate round (2026-08-22)

### Accepted

**Option identity is `(provider, address)`, not address alone.** The original
claim — that an address implies its provider — is wrong whenever the connected
Gmail account sits on `danat-future.com`, since Resend verifies the *domain* and
could send the same address. The dropdown therefore labels each option with both
(`ahmed@danat-future.com — Resend`). Where only one provider can send an
address, only one option appears, so the simple case stays simple.

**`sendWithResend` is missing most of what compose submits.** It sends only
`from`, `to`, `subject`, `html` and attachments (`resend.ts:31`), silently
dropping `cc`, `bcc` and the plain-text alternative — and it rejects a
BCC-only message outright (`resend.ts:24`), which is exactly the shape
"send to all tenants" produces. Both are fixed as part of this work: the payload
gains `cc`, `bcc`, `text` and `reply_to`, and the recipient check becomes
"at least one of to/cc/bcc", matching the rule compose already enforces.

**Reply and forward lock the sender to the originating provider.** Gmail
threading consumes `thread_id` and stored headers (`gmailSend.ts:335`); a reply
re-routed through Resend would break the thread silently. Locking is honest and
costs nothing — new messages still offer the full choice. Cross-provider
threaded replies are deliberately deferred, not half-built.

**`direction` must always be written explicitly.** It is nullable and null is
rendered as *Received* (`useGmailMessages.ts:161`), so any Resend insert that
omits it would fabricate inbound Resend mail — the precise illusion this design
refuses to create. A test asserts the written row's `direction`.

**`provider` must be immutable.** Staff hold unrestricted row `UPDATE` on the
table (`50_gmail_messages.sql:78`), so provenance would be editable through
PostgREST. Migration 158 adds a trigger rejecting any change to `provider`,
following the guard-trigger pattern of migration 39.

**Both column lists and the compatibility fallback need `provider`.**
`useGmailMessages` keeps two explicit column strings plus a fallback query that
currently only knows about a missing `failed_recipients` (`useGmailMessages.ts:27`,
`:172`). Missing one would make the badge silently absent.

**Delete/trash must route by provider.** `gmailTrashMessages` resolves a Gmail
API id for every selected row (`gmailTrashMessages.ts:72`); a Resend row has
none. Resend rows are deleted locally only, and the UI says so.

### Rejected, with reasons

**Splitting `message_id` into `provider_message_id` + `rfc_message_id` and
re-keying on `(company_id, provider, provider_message_id)`.** The stated risk is
a collision between a Gmail row and a Resend row sharing an RFC Message-ID. The
`resend:<email_id>` prefix already namespaces Resend rows, so that collision
cannot occur, and no dual-provider delivery path exists to create one. Re-keying
a live table to prevent an impossible collision is unjustified risk. The
pre-existing conflation of RFC and Gmail API ids inside `message_id`
(`gmailSend.ts:268`) is a real wart, but it predates this work and fixing it is
a separate change — bug fixes and refactors do not travel together.

**A `provider_senders` table instead of an option list.** Correct in the
abstract, over-built for four stable addresses. The option list is the
established pattern here (`gmail_categories`), keeps the addresses admin-editable
without a deploy, and the provider is bound by the list's identity rather than
by a column. Address format is validated server-side, and Resend itself rejects
anything outside the verified domain with an error that surfaces to the sender.
Revisit if senders ever need per-address verification state.
