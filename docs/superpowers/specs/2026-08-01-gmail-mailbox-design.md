# Gmail tab → working mailbox — design

**Date:** 2026-08-01
**Status:** approved, in implementation
**Owner decisions captured:** app-only categories · From fixed to the connected
account · attachments both directions

## The ask

> "This section is already working well, showing all the messages... However, I
> cannot view the message content, reply, create a new message, or send anything
> yet."

Five capabilities: read the full body, reply, forward, copy, categorise; plus a
Compose button opening a large Gmail-like window with full control of the
fields.

## What already exists (and what that buys us)

`gmail_messages.raw_payload` stores the **entire `format=full` Gmail message**,
not a summary. That single fact removes most of the read-side work:

| Needed for              | Already in `raw_payload`                          |
| ----------------------- | ------------------------------------------------- |
| Full HTML body          | `payload.parts[]` → `text/html` part, base64url   |
| Correct reply threading | `Message-ID`, `References`, `In-Reply-To` headers |
| Cc / Reply-To / Date    | same headers array                                |
| Attachment list         | parts with `filename` + `body.attachmentId`       |

So no `body_html` column and no re-sync. Attachment _bytes_ are the exception —
Gmail omits them from `format=full` and they need a separate API call.

`nodemailer` is already a dependency. `MailComposer` builds RFC 5322 MIME
(multipart, attachments, threading headers) **without opening an SMTP
connection**, so outgoing mail does not need hand-rolled MIME. Verified offline
before this document was written.

## Decisions

### 1. Sending goes through the Gmail API, not SMTP

SMTP/Resend is already wired for notifications, so it is the tempting shortcut.
It is the wrong tool here: it sends from a different identity, does not thread,
and never appears in the mailbox's Sent folder. "Reply" would not be a reply.
Gmail's `users.messages.send` with a `threadId` is the only path that makes the
feature mean what it says.

### 2. This requires a scope change, and therefore a reconnect

Current grant: `gmail.readonly` + `userinfo.email`. Sending needs
`gmail.send`. **A stored refresh token does not gain scopes retroactively** —
the admin must Disconnect and Connect again once deployed.

Checked before designing: `GMAIL_REFRESH_TOKEN` is **not** set in the production
container, so `readConfig`'s env fallback cannot silently keep serving the old
read-only token. The reconnect will take effect. This is why that variable must
stay unset.

### 3. Rendering mail HTML is the security surface

Remote HTML written by strangers renders inside an authenticated admin session.
Controls, in order of importance:

- **`<iframe sandbox srcdoc=…>` with no `allow-scripts`.** Scripts cannot
  execute at all and the frame gets an opaque origin, so it cannot reach the
  parent DOM, session, or cookies. This is the primary control and it does not
  depend on a sanitiser being correct.
- **Remote images blocked by default**, behind an explicit "show images" toggle,
  enforced by a CSP `<meta>` injected into the srcdoc. Remote images in mail are
  tracking pixels: loading them leaks read-status, time, and the office IP to
  whoever sent it.
- No new dependency. A sanitiser (DOMPurify) would be defence in depth, but the
  sandbox already denies execution, which is the property that matters.

### 4. Categories are app-local

Owner's choice. A `category` column on `gmail_messages`, with the vocabulary
living in the existing `option_lists` machinery under code `gmail_categories`.
That reuses the settings screen the owner already knows — and, after migration
61, the seeded categories there are editable and deletable like any other.

Rejected: real Gmail labels, which would need `gmail.modify` (restricted scope,
larger consent screen) for write access.

### 5. From is fixed to the connected account

Owner's choice, and the only honest option. Gmail refuses to send as an
arbitrary address — that is spoofing, and the API rejects it. Every other field
(To, Cc, Bcc, Subject, body, attachments) is fully editable.

## Deliberate non-goals

- Rich-text/WYSIWYG composing. Plain text body; the reply quotes the original.
- Gmail label read/write.
- Draft saving. Compose is open-and-send.

## Risks

| Risk                                                                    | Handling                                                                                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Admin forgets to reconnect; send fails                                  | Send path detects a missing `gmail.send` scope and returns a specific "reconnect required" message, not a raw 403                   |
| `select("*")` pulls every full MIME payload to the browser              | Split list/detail queries — a pre-existing bug this work would otherwise make much worse                                            |
| `resolveMessageKey` fallback `gmail:<id>` is not a valid RFC Message-ID | Thread off the **real header** read from `raw_payload`; absent header ⇒ send without threading rather than emitting a malformed one |
| Large attachments                                                       | 25 MB ceiling (Gmail's own limit), enforced before upload with a clear message                                                      |
