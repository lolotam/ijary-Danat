# Notification Provider Setup

Manual configuration guide for the three outbound providers: **Resend** (email),
**Meta WhatsApp Cloud API** (WhatsApp, via Coexistence), and **Twilio WhatsApp**
(alternative WhatsApp provider).

Every environment-variable name and config key below was verified against the
implementation in `src/lib/providers/` and `src/fns/dispatchNotification.ts`.

**Intended production state**

| Provider             | Enabled | Role                                       |
| -------------------- | ------- | ------------------------------------------ |
| `resend`             | ✅      | Email                                      |
| `whatsapp_cloud_api` | ✅      | WhatsApp (Coexistence with the mobile app) |
| `smtp`               | ❌      | Email fallback                             |
| `twilio`             | ❌      | WhatsApp alternative, configured but idle  |

Mutual exclusivity is enforced in the database, not by application code: the
`provider_mutual_exclusivity` trigger on `provider_configs` runs
`public.tg_provider_mutual_exclusivity()` before insert or update of
`is_enabled` (migration 31). Enabling `resend` disables
`smtp` and vice versa; enabling `whatsapp_cloud_api` disables `twilio` and vice
versa. The trigger never touches the other channel family, so `resend` +
`whatsapp_cloud_api` can both be on — which is the intended state.

> **Nothing in this guide is applied automatically.** No provider is enabled by
> code or by a migration. Every step below is a manual action you take.

### Prerequisite: apply migration 38

`db/migrations/38_provider_template_mapping.sql` adds the columns that hold the
approved provider template identifiers. **Apply it before recording any mapping
or enabling a WhatsApp provider.** Without it:

- the `UPDATE notification_templates SET provider_template_name …` statements in
  Sections B and C fail with `column does not exist`;
- WhatsApp dispatch fails when it reads the mapping columns.

Email delivery through Resend or SMTP does not depend on migration 38 — that path
never reads these columns — so Section A can be completed independently.

---

## Rules that apply to all three providers

- `provider_configs.config` stores **environment-variable names only**, never a
  credential. The `provider_configs_secret_references_only` database constraint
  and `validateProviderConfig()` both reject raw secrets.
- Secrets live in Dokploy server variables. None of them may be `VITE_`-prefixed —
  anything `VITE_` is compiled into the browser bundle.
- Never commit `.env` or `.env.production`.
- Provider errors are surfaced with the provider's own message and error code, but
  never with the token, key, or password.

---

## Section A — Resend (email)

### What you must collect

| Value                   | Where it comes from                                |
| ----------------------- | -------------------------------------------------- |
| `RESEND_API_KEY`        | Resend dashboard → API Keys                        |
| `RESEND_FROM`           | An address on a domain you verified in Resend      |
| `RESEND_WEBHOOK_SECRET` | Shown once when you add the webhook (step 12 below) |

### Steps

1. Create or select a Resend account and workspace.
2. Go to **Domains → Add Domain** and enter your sending domain
   (for example `danat-future.com`).
3. Add the DNS records Resend shows you at your DNS provider — the DKIM record,
   the SPF/`MX` records for the return path, and the DMARC record if offered.
4. Wait until the domain shows **Verified**. Do not continue while it is pending:
   sending from an unverified domain is rejected with `validation_error`, which
   dispatch records as a failed notification.
5. Go to **API Keys → Create API Key**. Give it **Sending access** only, scoped to
   the verified domain. Broader permissions are not needed and widen the blast
   radius if the key leaks.
6. Decide the From address. It must be on the verified domain
   (for example `no-reply@danat-future.com`).
7. In Dokploy, add the server variables `RESEND_API_KEY` and `RESEND_FROM`
   (see Section E).
8. In the app: **Admin → Settings → Notifications → Providers → Resend**, set the
   config to:

   ```json
   { "secret_env": "RESEND_API_KEY" }
   ```

9. Set the sender. The code reads `provider_configs.from_email` first and falls
   back to the `RESEND_FROM` environment variable
   (`src/fns/dispatchNotification.ts`). Setting `from_email` in the database is
   clearer, because it is visible in the admin UI.
10. Send one controlled test to an address you own before enabling Resend for real
    traffic (see **Controlled test**, below).
11. After enabling Resend, reload the Providers tab and **confirm SMTP now shows
    as disabled**. The trigger does this; verifying it is how you know the trigger
    is live.
12. Optional but recommended — **delivery reporting**. Go to **Webhooks → Add
    Webhook**, set the endpoint to

    ```
    https://danat-future.com/api/public/resend-webhook
    ```

    and subscribe to at least `email.bounced`, `email.complained`, `email.failed`
    and `email.suppressed`. Resend then shows a signing secret beginning
    `whsec_`; copy it into the Dokploy server variable `RESEND_WEBHOOK_SECRET`
    and restart the container. Order matters: the endpoint must be deployed
    before you add it in Resend, and it answers **503 until the secret is set**.

### What the webhook does, and what it deliberately does not do

`src/fns/resendWebhook.ts` verifies the Svix signature Resend sends
(`svix-id`, `svix-timestamp`, `svix-signature`; the `webhook-*` aliases are
accepted too), archives events to `email_webhook_events`, and — for events that
mean the mail can never arrive — moves the matching `notifications` row to state
**`needs_review`**.

Three cases are deliberately *not* archived, each for a reason given in the
response-code table below: a body over the size cap (refused before it is
parsed), an unsigned delivery carrying no `svix-id` (nothing to deduplicate on),
and a terminal event still inside the race window (a stored row would collide
with the retry that is the whole point).

It is `needs_review` and not `failed` on purpose. `runNotificationDrainJob`
re-sends rows in state `queued` or `failed`, so recording a hard bounce as
`failed` would queue the message straight back at an address that has already
permanently rejected it. `needs_review` stops the retry and puts the row in
front of a human, which is what a bounce calls for.

| Event                                                                | Effect                              |
| -------------------------------------------------------------------- | ----------------------------------- |
| `email.bounced` with `bounce.type` Permanent, Undetermined or absent   | notification → `needs_review`       |
| `email.complained`, `email.failed`, `email.suppressed`                 | notification → `needs_review`       |
| `email.bounced` with `bounce.type` Transient                           | archived only — Resend still retries |
| `email.sent`, `.delivered`, `.opened`, `.clicked`, `.delivery_delayed` | archived only                        |
| `contact.*`, `domain.*`, `suppression.*`                               | archived only                        |

Ignored events are still acknowledged with a 2xx: Resend disables an endpoint
that keeps failing, and a disabled endpoint would take bounce reporting down
with it. Replays are detected by the `svix-id`, which Svix keeps stable across
retries.

### Response codes, and the two cases that are deliberately not 2xx

| Code | When | Why |
| --- | --- | --- |
| `200` | Event handled, ignored, or for mail this app did not send | Normal |
| `401` | Signature missing, forged, or timestamped outside ±5 min | Nothing is trusted before the signature is checked |
| `413` | Body over 256 KB | The endpoint is public, so the body is attacker-controlled until verified. An oversized `Content-Length` is refused before a byte is read; a chunked body is cut off mid-stream |
| `503` | Secret unset, **or** a terminal event whose notification row is not written yet | Asks Svix to retry rather than losing the event |

That second `503` case is the subtle one. `dispatchNotification` stores
`provider_message_id` only *after* the send returns, so a fast bounce can arrive
before the row exists. Acknowledging it would tell Svix never to retry and the
bounce would be lost permanently — exactly the failure this endpoint exists to
prevent. Within two minutes a miss is therefore treated as a race and retried;
after that the mail genuinely was not sent by this app and the event is archived
as `unmatched`.

Those two minutes are measured from the **payload's own `created_at`**, never
from `svix-timestamp`. Svix re-signs every retry with the current clock — it has
to, or a retry would fail the five-minute staleness check — so the header always
says "just now". Ageing from it would make every retry look fresh, answer `503`
forever, and eventually get the endpoint disabled, taking real bounce reporting
down with it.

Unverified deliveries are archived **only when they carry a `svix-id`**. Without
one the unique index cannot deduplicate, so any client could POST in a loop and
grow the table without bound. This costs nothing in practice: the unverified rows
worth keeping are the ones that prove *our* secret is wrong — real Resend
deliveries being rejected — and those always carry the id. If you later fix a
wrong secret, the retry of that same delivery overwrites its own rejected row
rather than colliding with it, so the archive does not keep claiming an event was
unverified after it was in fact applied.

---

## Section B — Meta WhatsApp Cloud API with Coexistence

Coexistence lets the number stay registered in the **WhatsApp Business mobile
app** while the Cloud API also sends from it. You keep using the mobile app by
hand; Danat only sends outbound notifications.

> ### ⚠️ Stop conditions — read before starting
>
> - If Meta at any point asks you to **delete, unregister, or migrate away** the
>   WhatsApp account, **stop immediately**. That is the standard migration flow,
>   not Coexistence, and it will remove the number from your mobile app.
> - Do not uninstall the WhatsApp Business app.
> - The number must remain registered in the mobile app throughout.
> - Open the primary mobile app at least once every **13 days**, or the
>   Coexistence link lapses.
> - **Back up your chats before you begin.**
> - Linked devices (WhatsApp Web, desktop) may need to be reconnected afterwards.
> - Enabling `whatsapp_cloud_api` in Danat **does not** establish Coexistence.
>   Complete and verify Coexistence in Meta first, then enable the provider here.
>
> Whether this account is eligible for Coexistence is determined by Meta during
> onboarding. This guide cannot tell you in advance.

### What you must collect

| Value                      | Where it comes from                         |
| -------------------------- | ------------------------------------------- |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta → WhatsApp → API Setup                 |
| `WHATSAPP_WABA_ID`         | Meta → WhatsApp Business Account settings   |
| `WHATSAPP_ACCESS_TOKEN`    | A **System User** token (see step 10)       |
| Approved template names    | Meta → WhatsApp Manager → Message Templates |

`WHATSAPP_WABA_ID` is **not read when sending**. It is kept because you need it to
manage and query templates, and the setup steps below use it.

`WHATSAPP_TEMPLATE_NAMESPACE` has been **removed**. The namespace was required by
the deprecated On-Premises API; the Cloud API `/messages` endpoint identifies a
template by name and language only. Migration 38 drops the key from the stored
config.

### Steps

1. Confirm the number is currently registered in the WhatsApp Business **mobile
   app** and that you can send and receive with it.
2. **Back up your chats** (WhatsApp Business app → Settings → Chats → Chat backup).
3. In Meta Business Manager, confirm you own the Business Portfolio and that the
   business information (legal name, address, website) is complete. Incomplete
   business details are the most common cause of template rejection.
4. Start the WhatsApp onboarding flow (Embedded Signup) from your Meta app.
5. Choose the path for **“Connect an existing WhatsApp Business App”**. This is
   the Coexistence path. If you are not offered it, stop and re-check the entry
   point — do not proceed down the standard registration path.
6. **If you are asked to unregister or delete the account, stop here.** See the
   stop conditions above.
7. On the mobile app, open **Settings → Linked devices** and scan the Coexistence
   QR / access code shown by the onboarding flow.
8. Complete the connection. Do not uninstall the app. Confirm the mobile app still
   opens and shows your chats.
9. Record the **Phone Number ID** and **WABA ID** from Meta → WhatsApp → API Setup.
10. Create the production access token:
    - Meta Business Settings → **Users → System Users → Add**.
    - Create a System User with the **Admin** or **Employee** role as your policy
      requires.
    - **Assign assets**: add only the WhatsApp Business Account, with full control
      over that asset alone. Do not assign unrelated pages, catalogues, or ad
      accounts.
    - **Generate token** with exactly these permissions:
      - `whatsapp_business_messaging` — required to send.
      - `whatsapp_business_management` — required to read and manage templates.
    - Choose a **System User token**, not the temporary token shown in the Meta
      quickstart. The quickstart token expires after 24 hours and will take
      production down when it does.
    - **Rotation**: System User tokens can be set to never expire, but treat them
      as rotatable. To rotate without downtime: generate the new token, update
      `WHATSAPP_ACCESS_TOKEN` in Dokploy, redeploy, send one controlled test, then
      revoke the old token in Meta. Rotate immediately if the token is ever
      exposed in a log, screenshot, or shared document.
11. Create the message templates in **WhatsApp Manager → Message Templates**, one
    per language, for each row in the mapping table in Section F. Submit them as
    **Utility** (they are transactional, not promotional). Credentials templates
    may fit the **Authentication** category. Meta makes the final category
    decision and may re-categorise your submission.
12. When each template is **Approved**, record its exact name and language code
    into the database:

    ```sql
    update public.notification_templates
    set provider_template_name = '<exact approved name>',
        provider_language_code  = null,          -- or e.g. 'ar_AE' if it differs
        provider_param_keys     = array['tenant_name','amount']  -- see Section F
    where code = 'receipt';
    ```

    Dispatch **refuses to send** while `provider_template_name` is null, so an
    unapproved template can never go out. The name is used verbatim — it is never
    derived from the local template code.

13. In Dokploy, add `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and
    `WHATSAPP_WABA_ID` (Section E).
14. In **Providers → WhatsApp Cloud API**, set the config to:

    ```json
    {
      "secret_env": "WHATSAPP_ACCESS_TOKEN",
      "phone_number_id_env": "WHATSAPP_PHONE_NUMBER_ID",
      "waba_id_env": "WHATSAPP_WABA_ID",
      "graph_api_version": "v23.0"
    }
    ```

    `graph_api_version` is optional and defaults to `v23.0`.

15. Send one controlled notification to a number you own (see **Controlled test**).
16. **Verify the mobile app can still send and receive** a normal message.
17. Only now enable `whatsapp_cloud_api` in the Providers tab.
18. Confirm Twilio shows as disabled.

### Recipient number format

Recipients must be stored in international format. A bare local number such as
`50123456` is rejected with a clear error rather than guessed at, because guessing
a dialling code delivers the message to the wrong country. Store tenant numbers as
`+965…`.

---

## Section C — Twilio WhatsApp (alternative)

> **Do not use your production mobile-app number with Twilio.** Twilio's WhatsApp
> sender registration may require an already-registered WhatsApp Business app
> account to be deleted. Coexistence support is a Meta feature; this guide makes
> **no claim** that Twilio supports it for your account. Use Twilio only with a
> **separately eligible sender**, unless Twilio confirms Coexistence support for
> your account in writing.
>
> If any Twilio registration step asks to delete or unregister a number, stop —
> especially if that number is the one in your WhatsApp Business mobile app.

### What you must collect

| Value                                 | Where it comes from                           |
| ------------------------------------- | --------------------------------------------- |
| `TWILIO_ACCOUNT_SID`                  | Twilio Console dashboard                      |
| `TWILIO_AUTH_TOKEN`                   | Twilio Console dashboard                      |
| `TWILIO_WHATSAPP_FROM`                | Your registered sender, as `whatsapp:+<E164>` |
| Content SID per template and language | Twilio Console → Content Template Builder     |

### Steps

1. Create or select an **upgraded** (non-trial) Twilio account. Trial accounts can
   only message verified numbers.
2. Copy the **Account SID** and **Auth Token** from the Console dashboard.
3. Register a WhatsApp sender: **Messaging → Senders → WhatsApp senders**. Use a
   number that is _not_ your production mobile-app number.
4. If the flow asks you to delete or unregister an existing WhatsApp Business
   account, stop and reconsider the sender you chose.
5. Create the Content Templates in **Content Template Builder**, one per language,
   matching the rows in Section F. Submit them for WhatsApp approval.
6. When approved, record each **Content SID** (begins `HX`).
7. Note the full sender address in `whatsapp:+E164` form, e.g.
   `whatsapp:+14155238886`.
8. Add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_WHATSAPP_FROM` to
   Dokploy (Section E).
9. In **Providers → Twilio**, set the config to:

   ```json
   {
     "account_sid_env": "TWILIO_ACCOUNT_SID",
     "secret_env": "TWILIO_AUTH_TOKEN",
     "from_whatsapp_env": "TWILIO_WHATSAPP_FROM"
   }
   ```

   The sender is read from `provider_configs.from_whatsapp` first, then from the
   variable named by `from_whatsapp_env`.

10. Save the Content SID mappings:

    ```sql
    update public.notification_templates
    set twilio_content_sid   = 'HX…',
        twilio_variable_keys = array['tenant_name','amount']
    where code = 'receipt';
    ```

11. Send one controlled test.
12. Enable Twilio **only** if Meta Cloud API is disabled. Enabling Twilio disables
    `whatsapp_cloud_api` automatically, which stops WhatsApp delivery through Meta.

### Free-form vs template messages

Twilio delivery uses `ContentSid` + `ContentVariables` for business-initiated
messages. A plain `Body` is only sent when the caller explicitly asserts an open
24-hour customer-service window — either `notification_templates.allow_freeform =
true`, or `whatsapp_freeform: true` on the notification payload. This is never
inferred: a message sent as free-form outside the window is rejected by Twilio.
Check Twilio's error-code reference for the exact code your account returns — the
rejection reason is recorded verbatim in the notification's `failure_reason`.

---

## Section D — Safe activation order

1. Configure and verify **Resend**; send a controlled test.
2. Complete **Meta Coexistence onboarding** manually.
3. **Verify the WhatsApp Business mobile app still sends and receives.**
4. Create and get approval for the Meta templates.
5. Configure the Meta environment variables in Dokploy and redeploy.
6. Record the approved template names and parameter keys in the database.
7. Send one controlled Meta test.
8. Enable `resend` and `whatsapp_cloud_api`.
9. Leave `smtp` and `twilio` disabled.
10. Configure Twilio only as an alternative, with its own eligible sender.
11. **Never enable both WhatsApp providers at once.** The trigger prevents it, but
    switching also silently changes which templates are used — Meta names and
    Twilio Content SIDs are separate mappings.

---

## Section E — Dokploy environment variables

Add server variables in Dokploy under project **`Danat-kuwait`** → environment
**`production`** → application **`Danat-kuwait`** → **Environment**.

| Variable                   | Provider |
| -------------------------- | -------- |
| `RESEND_API_KEY`           | Resend   |
| `RESEND_FROM`              | Resend   |
| `RESEND_WEBHOOK_SECRET`    | Resend   |
| `WHATSAPP_ACCESS_TOKEN`    | Meta     |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta     |
| `WHATSAPP_WABA_ID`         | Meta     |
| `TWILIO_ACCOUNT_SID`       | Twilio   |
| `TWILIO_AUTH_TOKEN`        | Twilio   |
| `TWILIO_WHATSAPP_FROM`     | Twilio   |

All of these are **server-only**. None may be given a `VITE_` prefix: `VITE_`
variables are build args baked into the browser bundle and would publish the
credential to every visitor.

After changing server variables:

- Redeploy the application so the running container picks them up. Runtime
  variables are read via `process.env` at send time, but a redeploy is the
  reliable way to guarantee the new value is in the container.
- Verify a variable **exists** without printing it:

  ```bash
  docker exec <container> sh -lc 'test -n "$RESEND_API_KEY" && echo present || echo MISSING'
  ```

  Never `echo` the value itself, and never paste it into a chat, ticket, or doc.

- Never store credentials in `provider_configs` — store the variable _name_.
- Never commit `.env` or `.env.production`.

---

## Section F — Template mapping table

`notification_templates` (migration 38) records the provider-side identifiers.
Fill in the `META_TEMPLATE_NAME_REQUIRED` / `TWILIO_CONTENT_SID_REQUIRED` cells
with the real values once the provider has approved each template.

**These placeholders are rejected by the database** (constraint
`notification_templates_no_placeholder_identifiers`) and treated as "not
configured" by dispatch. They exist only in this table, so a half-finished setup
cannot send an unapproved template name.

| Local code               | Type                   | Meta template name            | Meta category    | Ordered parameters                                | Twilio Content SID            | Free-form allowed |
| ------------------------ | ---------------------- | ----------------------------- | ---------------- | ------------------------------------------------- | ----------------------------- | ----------------- |
| `receipt`                | `receipt`              | `META_TEMPLATE_NAME_REQUIRED` | Utility          | `tenant_name`, `amount`, `periods`, `reference`   | `TWILIO_CONTENT_SID_REQUIRED` | No                |
| `overdue-reminder`       | `overdue_reminder`     | `META_TEMPLATE_NAME_REQUIRED` | Utility          | `tenant_name`, `outstanding`, `days_overdue`      | `TWILIO_CONTENT_SID_REQUIRED` | No                |
| `contract-expiry`        | `contract_expiry`      | `META_TEMPLATE_NAME_REQUIRED` | Utility          | `tenant_name`, `unit`, `months_until`, `end_date` | `TWILIO_CONTENT_SID_REQUIRED` | No                |
| `user-credentials`       | `user_credentials`     | `META_TEMPLATE_NAME_REQUIRED` | Authentication † | `display_name`, `username`, `login_url`           | `TWILIO_CONTENT_SID_REQUIRED` | No                |
| `deposit-confirmation`   | `deposit_confirmation` | — (email only)                | —                | —                                                 | —                             | —                 |
| `payment-admin-alert`    | `payment_admin_alert`  | — (email only)                | —                | —                                                 | —                             | —                 |
| `due-reminder`           | `due_reminder`         | — (not currently sent)        | —                | —                                                 | —                             | —                 |

† Meta makes the final category decision and may re-categorise a submission.
Submit what the message actually is; do not label a transactional message as
marketing to get faster approval.

### Notes on parameters

- Parameter order is significant: the first key becomes `{{1}}`.
- The keys name fields on the **notification payload**, not on the rendered email
  body. A WhatsApp template never sees the rendered body.
- If a payload is missing a mapped key, dispatch refuses to send and records
  exactly which key was missing. It never sends a partially filled template.
- **The password is deliberately not a parameter** on the credentials templates.
  The notification payload is persisted permanently in the Notification Log, and a
  plaintext credential must not outlive its delivery. The password is delivered in
  the message body only.
- `deposit-confirmation` and `payment-admin-alert` are admin email notifications
  and need no WhatsApp template.
- `due-reminder` templates exist in the database but **no code path enqueues
  them today**; no Meta template is needed until one does.

---

## Controlled production test

Do this once per provider, before enabling it for real traffic.

1. Create or pick a **test tenant** whose email and WhatsApp number you control.
2. Confirm the relevant template mapping row is filled in (WhatsApp only).
3. Enable the single provider you are testing, and nothing else.
4. Use **Admin → Settings → Notifications → Send manual message** to that tenant.
5. Check the **Notification Log** row: state should be `sent`, with a provider
   message id. If it is `failed` or `skipped`, the `failure_reason` names the
   exact cause.
6. Confirm the message actually arrived.
7. For WhatsApp: confirm the **mobile Business app still sends and receives**.

Do **not** test the contract-expiry job by passing a future `asOf` to the cron
endpoint. Jobs dispatch inline, so that sends real messages to real tenants.

## Rollback

1. **Disable the provider first**, in the Providers tab. Delivery stops
   immediately and the reason is recorded on each notification. Note the two
   channels record it differently, by design: a WhatsApp send with no enabled
   provider becomes `skipped` ("no active WhatsApp provider in provider_configs"), whereas an
   email send with no enabled provider becomes `failed` ("No email provider is
   enabled") — email has no tenant-level opt-out, so its absence is always a
   fault worth surfacing.
2. Only then remove or rotate the credentials in Dokploy. Removing a variable
   while the provider is still enabled turns every send into a `failed`
   notification.
3. To fall back on email, enable `smtp` — which automatically disables `resend`.
4. To stop only WhatsApp, disable both WhatsApp providers. Email is unaffected;
   the two families are independent.
5. Reverting the template mapping (setting `provider_template_name` back to null)
   stops WhatsApp sends for that template alone, without touching any provider.

### Actions that could disrupt the WhatsApp Business mobile app

These are the only steps in this document that carry that risk. None of them
happen automatically:

- Accepting a Meta prompt to **delete, unregister, or migrate** the number during
  onboarding — this removes it from the mobile app. **Stop if you see it.**
- Registering the **production mobile-app number as a Twilio sender**, if Twilio
  asks to delete the existing WhatsApp Business account.
- Uninstalling the WhatsApp Business app after Coexistence is established.
- Not opening the primary mobile app for more than **13 days**.

Enabling or disabling a provider inside Danat does **not** affect the mobile app.
