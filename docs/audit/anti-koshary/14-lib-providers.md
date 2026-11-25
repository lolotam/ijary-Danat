# S14 — `src/lib`: providers, evolution, gmail, backup archive

**Lines read:** ~2,980 · **Files:** 19 · **Date:** 2026-09-22

`providers/` (11 files, 1349) · `evolution/` (2 files, 451) · `backupArchive.ts` (460) ·
`gmailMessage.ts` (348) · `gmailClient.server.ts` (128) · `gmailDeliveryFailure.ts` (118) ·
`gmailOAuthConfig.ts` (80) · `gmailDirection.ts` (41).

**Overall:** the provider abstraction itself is good — one `EmailProviderMessage` /
`WhatsAppProviderMessage` / `ProviderResult` contract in `providers/types.ts`, one
`sendWithX(message)` per provider, config validation split out. What is missing is the
thing every one of those six functions needed and none of them has.

---

## Findings

### 1 · High — every notification-sending HTTP call can hang forever, and the repo already wrote down why that matters

**Where:** `providers/resend.ts:72` · `providers/postora.ts:158` · `providers/twilio.ts:63` ·
`providers/whatsapp.ts:67` · `gmailClient.server.ts:87` — **five bare `fetch` calls with no
`signal`** — plus `providers/smtp.ts:17-22`, whose nodemailer transport sets no
`connectionTimeout`, `greetingTimeout` or `socketTimeout`.

The timeout landscape across the whole codebase:

| Caller | Timeout |
| --- | --- |
| `fns/myfatoorahGateway.ts:25` | 20 s |
| `lib/evolution/client.ts:55` | 10 s |
| `fns/resolveMapEmbed.ts:107` | 8 s |
| `fns/evolutionAvatars.ts:41` | 4 s |
| **`providers/resend.ts`** (every email) | **none** |
| **`providers/postora.ts`** (WhatsApp) | **none** |
| **`providers/twilio.ts`** (WhatsApp) | **none** |
| **`providers/whatsapp.ts`** (Cloud API) | **none** |
| **`gmailClient.server.ts`** (token refresh) | **none** |
| **`providers/smtp.ts`** | nodemailer defaults — **up to 10 min** on a hung socket |

`fns/myfatoorahGateway.ts:18-24` states the reasoning that was never carried across:

> *"A bare `fetch` has no timeout. If MyFatoorah accepts the connection and then never
> replies, the request hangs for as long as the socket stays open — the server function never
> returns, and the caller's UI waits forever with nothing to report."*

**Which means:** the lesson was learned for the one path that moves money and not applied to
the five that send every notification the product produces. Two concrete consequences:

- **The drain job stalls.** `runNotificationDrainJob` sends rows in a loop. A provider that
  accepts the TCP connection and stops responding — the exact shape of the 2026-09-02
  Evolution `device_removed` incident, where a closed WhatsApp session answered sends with
  HTTP 500 rather than failing fast — blocks the whole batch indefinitely. Every later row
  in that tick goes unsent, and the row in flight is neither `sent` nor `failed`.
- **An admin's manual send never returns.** `sendNotification`, `gmailSend` and
  `resendMailboxSend` are all user-triggered server functions over these providers. The
  spinner runs until the browser gives up, with nothing recorded.

**Fix:** `signal: AbortSignal.timeout(MS)` on all five fetches and
`connectionTimeout`/`greetingTimeout`/`socketTimeout` on the nodemailer transport. Copy
`myfatoorahGateway.ts:37-48`'s error handling while you are there — it distinguishes a
timeout from a DNS failure in the message, which is the difference between "the provider is
down" and "the URL is wrong". One shared `PROVIDER_TIMEOUT_MS` in `providers/types.ts`; 15 s
is a reasonable default for all six (mail and WhatsApp APIs answer in well under a second).

---

### 2 · Medium — four HTML-to-plain-text converters, and the crudest one is on the SMTP path

**Where:** `lib/templateRender.ts:96` (`stripMarkup`, **exported**) ·
`lib/gmailMessage.ts:59-62` · `fns/gmailSend.ts:105-106` ·
**`lib/providers/smtp.ts:29`** — `message.body.replace(/<[^>]+>/g, " ")`

`stripMarkup`'s docblock records what the crude version cost:

> *"Source formatting is dropped the way a browser drops it… **Both reached tenants verbatim
> over WhatsApp**, which shows whitespace the HTML rendering never did."*
> and: *"Table cells become WhatsApp-readable lines… Before this the flattened body read
> `رقم الفاتورةINV-0003154` with no separator at all."*

`stripMarkup` handles `<br>`, `<td>/<th>`, `<tr>`, block tags, collapsed inter-tag
whitespace, and entity decoding. `smtp.ts:29` replaces every tag with a single space and
decodes nothing.

**Which means:** the plain-text alternative on every SMTP email is built by the version whose
failures are documented two files away. `<p>A</p><p>B</p>` becomes `"A B"` instead of two
lines, `&amp;` stays literal, and any `<style>` block's CSS is inlined into the text part as
prose. Recipients on a text-only client — and spam filters, which read the text part — see
that. The fix already exists, is exported, and is one import away.

**Fix:** `import { stripMarkup } from "@/lib/templateRender"` in `providers/smtp.ts` and use
it. Consider the same for `gmailMessage.ts` and `fns/gmailSend.ts`, but check first — those
two parse *inbound* mail rather than generating an alternative, and may have different
requirements. `smtp.ts` is the unambiguous one.

---

## Not reported, and why

- **`providers/types.ts` as the shared contract** — `EmailProviderMessage`,
  `WhatsAppProviderMessage`, `ProviderResult`, `configValue`, `requiredEnv`. Six providers,
  one interface each way, config validation in its own file. This is correct, and it is why
  finding 1 is a one-line change per provider rather than a redesign.
- **`providers/evolution.ts` and `providers/postora.ts` both ~290 lines** — the two
  WhatsApp providers with the most protocol surface. They share the message type and diverge
  only where the APIs do. Correct.
- **`sendWithPostora(send.value, notification.id)` taking an extra argument** — the one leak
  in the provider abstraction, deliberate (the row id is the idempotency key Postora needs).
  Counted in **S02 #5**, not re-reported.
- **`lib/evolution/client.ts` (391)** — the only outbound client in the repo that gets
  timeouts right (`DEFAULT_TIMEOUT_MS = 10_000`, overridable per call with a documented
  reason). The model for finding 1's fix.
- **`backupArchive.ts` (460)** — over the ceiling; one job (build/parse the archive),
  server-only, admin-gated. Length without the symptoms.
- **`gmailOAuthConfig.ts:6`** — carries an explicit note that `VITE_`-prefixed vars are
  compiled into the client bundle, and keeps the OAuth secret out of them. Correct.

## Test coverage of this scope

`providers/` has test files for the config validation, template binding and several senders;
`gmailMessage`, `gmailDeliveryFailure` and `backupArchive` are tested.

**Neither finding is covered.** A timeout test needs a fake slow server, and nothing asserts
the SMTP text alternative's shape. Finding 1 in particular is the kind of thing that only
shows up in production, which is how it survived.

**Consequence for Pass 2:** finding 1 is additive and low-risk — a timeout that never fires
changes nothing — but pick the value deliberately and make sure the resulting error is
recorded as `failed` (so the drain job retries) rather than thrown past the state write.
Finding 2 changes the text part of outgoing SMTP email; send one to yourself and read the
source.

## Ledger entries added

See `LEDGER.md` — the outbound-timeout table, the four HTML-to-text converters,
`providers/types.ts` and `evolution/client.ts` recorded as correct.
