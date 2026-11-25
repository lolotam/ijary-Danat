# Contract: Public Webhook Routes

Routes other systems call. All are public, all verify before trusting, all store the raw event and return quickly; processing happens in a `webhook.process` job ([jobs.md](./jobs.md)). Background: [research.md](../research.md) R14, R15.

## Common behaviour

1. Read the raw body before parsing.
2. Resolve the connection from the path (or, for Meta, from the payload). Unknown connection: respond `404`, store nothing that names a company.
3. Verify the signature or secret in constant time with that connection's secret.
4. Insert `webhook_events` with `company_id`, `connection_id`, `provider`, `signature_valid`, raw body and headers. An invalid event is stored with `signature_valid = false` and is never processed.
5. For a valid event insert a `job_requests` row (`webhook.process`, dedupe key = provider event id) through `companyClient(companyId, { allowSuspended: true })`.
6. Respond `200` in under one second. A duplicate provider event id responds `200` and enqueues nothing.

Suspended companies: events are still stored and payment settlement still runs; nothing else does (FR-045, FR-046).

## Routes

| Route | Caller | Connection lookup | Verification |
|---|---|---|---|
| `POST /api/public/webhooks/myfatoorah/$connectionId` | MyFatoorah | `gateway_connections.id` | Provider signature with the connection's webhook secret |
| `POST /api/public/webhooks/tap/$connectionId` | Tap | `gateway_connections.id` | Provider signature (scheme to confirm, R14) |
| `POST /api/public/webhooks/upayments/$connectionId` | UPayments | `gateway_connections.id` | Provider signature or token (scheme to confirm, R14) |
| `POST /api/public/webhooks/evolution/$connectionId` | Platform Evolution server | `whatsapp_connections.id` | Header secret equals the connection's current or previous secret, and `body.instance` equals `instance_name` |
| `GET /api/public/webhooks/meta` | Meta (subscription check) | — | `hub.verify_token` equals the platform verify token; echo `hub.challenge` |
| `POST /api/public/webhooks/meta` | Meta | `whatsapp_connections.phone_number_id` from each entry | `X-Hub-Signature-256` with the platform app secret |
| `POST /api/public/webhooks/resend/$companyId` | Resend (company's own account) | `provider_configs` of the company | Svix signature with the company's webhook secret |
| `POST /api/public/webhooks/resend-platform` | Resend (platform default sender) | Company taken from the stored message record | Svix signature with the platform secret |

Removed: `POST /api/public/cron` (replaced by worker schedules), and the three single-company routes `myfatoorah-webhook`, `evolution-webhook`, `resend-webhook`.

## Payment return page

`GET /portal/payments/callback/$preq` stays session-free. It loads the payment request by its unguessable id through `platformClient` limited to that one lookup, obtains the company from the row, and from then on uses `companyClient(companyId, { allowSuspended: true })`. It triggers `payment.settle` and shows the result; it never trusts query-string status values.

## Settlement guarantee

A payment is recorded once, whichever arrives first: webhook, return page, or the 10-minute `payment.reconcile` job. All three call the same settlement function, keyed on the payment request, using the gateway connection and credentials version stored on that request.

## Rules carried over

- A permanently bounced email moves its notification to `needs_review`, never to `failed`, because `failed` rows are retried.
- Secret comparison is constant-time.
- No secret value appears in `webhook_events`, logs or audit entries; headers that carry secrets are redacted before storage.
