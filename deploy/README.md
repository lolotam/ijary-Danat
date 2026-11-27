# Deployment — Danat Al Mustaqbal ERMP

The app is a single Node service (TanStack Start / Nitro) that talks to your
existing self-hosted Supabase. Supabase is **not** redefined here — the app joins
the network your Supabase stack already runs on.

## Dokploy

1. Create an Application from this repo. Build is the provided `Dockerfile`
   (multi-stage, non-root, healthchecked).
2. Set every variable from `.env.example` as a Dokploy secret. The ones with no
   safe default and no fallback:
   - `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SENTRY_DSN`
     (baked into the browser bundle at build time — set them _before_ the first
     build; an empty `VITE_SENTRY_DSN` disables Sentry). `SENTRY_DSN` is an
     optional runtime var for the server side and falls back to the VITE one.
   - `SENTRY_AUTH_TOKEN` (optional, turns on source-map upload) goes under
     **Build Secrets** only, with exactly that name. Not under Environment and
     not under Build Args: an environment variable reaches the running
     container, and a build arg is recorded in the build image's history.
   - `MYFATOORAH_API_KEY`, `MYFATOORAH_WEBHOOK_SECRET`
   - `MYFATOORAH_BASE_URL` — **must match the environment the API key belongs to**:
     `https://apitest.myfatoorah.com` for a sandbox/demo key,
     `https://api.myfatoorah.com` for a live key. It defaults to the **live**
     URL when unset, so a sandbox key with no explicit value authenticates
     against production and every lookup fails with a 401.
   - `CRON_SECRET`
3. Join the app to the Docker network your Supabase compose stack uses, so
   `SUPABASE_URL` can resolve internally.
4. Point the MyFatoorah merchant webhook at
   `https://danat-future.com/api/public/myfatoorah-webhook`
   (sandbox account API: `https://apitest.myfatoorah.com`, live: `https://api.myfatoorah.com`).
   Set `APP_BASE_URL=https://danat-future.com` so the hosted-page redirect returns to
   `/portal/payments/callback` on this host.

### Switching from sandbox to live

`MYFATOORAH_API_KEY`, `MYFATOORAH_WEBHOOK_SECRET` and the webhook registration in
the merchant portal are **all per-environment**. Change all three together:

| Variable                    | Sandbox                          | Live                         |
| --------------------------- | -------------------------------- | ---------------------------- |
| `MYFATOORAH_BASE_URL`       | `https://apitest.myfatoorah.com` | `https://api.myfatoorah.com` |
| `MYFATOORAH_API_KEY`        | sandbox token                    | live token                   |
| `MYFATOORAH_WEBHOOK_SECRET` | sandbox HMAC secret              | live HMAC secret             |

Swapping the key but not the secret is the failure that hides itself: signature
verification rejects every callback, and settlement silently degrades to the
ten-minute `payment-reconcile` tick while the app still looks healthy. Confirm a
row lands in `webhook_events` within seconds of the first live payment — not
minutes later.

None of these are `VITE_`-prefixed, so they are not baked into the browser
bundle: a restart applies them, no rebuild needed.

### The tenant portal offers exactly three methods

`createPayment` pins MyFatoorah's hosted page to one of `KNET`, `GOOGLE_PAY` or
`APPLE_PAY` (`hostedPaymentMethods` in `src/fns/createPayment.ts`), so the tenant
lands on that provider rather than on MyFatoorah's own method chooser. All three
must be **enabled on the account the API key belongs to** — a pinned method the
account does not have fails at the gateway, not at our boundary.

Apple Pay only runs in Safari on Apple hardware. Elsewhere the portal shows the
tenant a QR code of the same payment URL to scan with an iPhone, and the
signed-in desktop tab polls `confirmGatewayPayment` with the payment-request code
to settle on the phone's behalf — the phone itself lands on
`/portal/payments/callback` without a session and cannot settle there.

`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. It is server-only — never expose it as a
`VITE_` variable, since anything prefixed `VITE_` is compiled into the browser bundle.

### Diagnosing a failed payment callback

The portal deliberately shows the tenant one message for every unsuccessful
charge ("لم تكتمل عملية الدفع أو تم إلغاؤها" / "The payment did not complete or
was cancelled") — gateway codes must not reach the UI. Tell the cases apart from
the app logs instead; `confirmGatewayPayment` logs the gateway's own reason
whenever it resolves a non-paid outcome:

```
[confirmGatewayPayment] gateway did not report a paid invoice
{"outcome":"failed","invoiceId":"7039145","paymentId":"0707…","gatewayError":"MF020: IPAY0100044-Problem occured while loading payment page."}
```

Read `gatewayError` first — it distinguishes a tenant who cancelled
(`Transaction not Captured!`, `Transaction canceled!`) from a gateway that never
served a payment page (`IPAY0100044`), which is a MyFatoorah/KNET-side fault and
cannot be fixed from this repo. A different UI message
("تعذّر التحقق من حالة الدفع" / "We couldn't verify the payment status") means the
inquiry itself threw — check `MYFATOORAH_BASE_URL` and the API key first.

To query the gateway directly for one transaction:

```sh
docker exec <app-container> node -e 'fetch("https://apitest.myfatoorah.com/v2/GetPaymentStatus",\
{method:"POST",headers:{Authorization:"Bearer "+process.env.MYFATOORAH_API_KEY,\
"Content-Type":"application/json"},body:JSON.stringify({Key:"<InvoiceId>",KeyType:"InvoiceId"})})\
.then(r=>r.json()).then(j=>console.log(JSON.stringify(j.Data,null,2)))'
```

## Scheduled jobs

Ten jobs must run unattended. They are not an HTTP endpoint any more: the
background worker owns the schedule, and every tick fans the work out to the
companies that have not switched it off (`src/worker/scheduler.ts`).

| `job`                | Cadence                       | What it does                                                                                                |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `overdue`            | daily, 01:10                  | Flips due invoices to `overdue`.                                                                            |
| `overdue-reminders`  | daily, 01:15                  | Emails/WhatsApp overdue tenants once per calendar month.                                                    |
| `contract-expiry`    | daily, 01:20                  | Queues 4/3/2/1-month and 7-day contract expiry reminders.                                                   |
| `scheduled-reports`  | daily, 01:30                  | Runs any `report_schedules` row that is due.                                                                |
| `notification-drain` | daily, 01:40                  | Sends due-but-queued notifications, retries single-channel failures, cancels stale ones.                    |
| `gmail-sync`         | every 10 minutes              | Pulls the connected mailbox into the inbox's Gmail tab. No-ops until Gmail is connected.                    |
| `salaries`           | monthly, 1st of the month     | One salary row per active employee. Idempotent on `(employee_id, year, month)`.                             |
| `payment-reconcile`  | every 10 minutes, offset by 5 | Settles gateway payments the webhook never delivered. The only server-side settlement path.                 |
| `backup`             | not scheduled                 | Snapshots every table to a ZIP in the `backups` bucket — but only if the daily or weekly switch is on.      |
| `log-retention`      | daily, 02:00                  | Deletes audit/notification log rows older than the window an admin chose (off until chosen; migration 242). |

The cadences are the ones in `contracts/jobs.md` section 7, and the worker
writes them down in `src/worker/scheduler.ts`. `backup` is the one job without a
schedule: the catalogue replaced it with `company.export`, whose request is
filed by an admin action and not by a timetable.

`payment-reconcile` runs at :05, :15, :25 … deliberately offset from
`gmail-sync`'s :00, :10, :20 so the two never fire together. It is the only
server-side path that settles a gateway payment: everything else needs an
authenticated browser on `/portal/payments/callback`, so a tenant who pays a
link without signing in depends entirely on this tick. Ten minutes is the
longest a paid invoice should look unpaid; do not move it to the nightly batch.

`gmail-sync` runs every 10 minutes rather than hourly — it feeds an inbox
someone is watching, so a long gap is not useful. It is safe at that rate: it
no-ops entirely until a mailbox is connected at
`/admin/settings/integrations`, and each tick is bounded by `GMAIL_SYNC_WINDOW`
plus internal page and message caps.

The optional `asOf` of the panel's "run now" backdates a run (useful to replay
a missed day). Only `overdue`, `overdue-reminders`, `contract-expiry`,
`scheduled-reports` and `salaries` honour it. The other five accept and ignore
it, so a "backdated" call to any of them is an ordinary run against the present:

- `notification-drain` — draining is always relative to now.
- `backup` — a snapshot is always of the present; backdating one would file
  today's data under an earlier period key and consume a period the real day
  still needs.
- `log-retention` — purges relative to now (`src/fns/logRetentionJob.ts`).
- `gmail-sync` — syncs the live mailbox (`src/fns/gmailSyncJob.ts`).
- `payment-reconcile` — asks the gateway for live transaction status
  (`src/fns/paymentReconcileJob.ts`).

> That screen is now the **Workflows** panel, with two tabs: these ten
> scheduled jobs, and the event-triggered workflows that fire on an application
> event rather than a timetable (migration 69). Both live in `cron_jobs`, told
> apart by `kind`. Only the scheduled keys are dispatchable here — naming an
> event key does nothing.

### notification-drain safety rules

This job is the only one that sends messages nobody triggered on that tick, so
it is deliberately narrow (`src/fns/notificationDrainJob.ts`):

- Rows more than **72h past due** are `cancelled`, never sent. A backlog after an
  outage must not become a burst of stale messages to tenants.
- Failed rows retry at most **3 times**, then wait for a human.
- **`channel: "both"` failures are never auto-retried.** Its email leg can succeed
  before the WhatsApp leg throws, and `dispatchNotificationRecord` discards the
  message ids in that path — so the row reads `failed` with no
  `provider_message_id` even though the email was delivered. Retrying would send
  it twice. Use the manual retry button for those.
- At most **100 rows** per run.

Before the first run of a fresh deployment, check what it would touch:

```sql
select id, type, channel, state, retry_count, coalesce(scheduled_at, created_at) as due_at
from public.notifications
where state in ('queued', 'failed')
order by due_at;
```

**All ten jobs are idempotent**, so a duplicate tick is harmless and a missed
day can be re-run:

- `overdue` is a state transition — a second run finds nothing left to flip.
- `overdue-reminders` skips a tenant that already has a non-cancelled
  `overdue_reminder` for the same `month_key` (`src/fns/overdueRemindersJob.ts`).
  That is a check before the insert, not a unique index, so a repeated tick is
  safe but two ticks racing each other could both queue.
- `contract-expiry` skips a milestone only after its notification has been sent
  or is still queued, so failed and skipped deliveries retry on the next run.
- `scheduled-reports` advances `next_run_at` after each run. A run that fails
  does _not_ advance it, so it retries on the next tick.
- `notification-drain` dispatches through `dispatchNotificationRecord`, which
  returns early for rows already `sent` or `cancelled` — a repeated tick cannot
  re-send. Note it ignores `asOf`: draining is always relative to now.
- `salaries` inserts with `on conflict do nothing` against
  `unique (employee_id, year, month)`, so a retried tick cannot pay anyone twice.
- `gmail-sync` upserts on `(company_id, message_id)` with `ignoreDuplicates`, so
  a message already synced is left untouched — including its read flag, which
  staff may have cleared in the inbox.
- `payment-reconcile` returns early for a payment request already marked
  completed, so a repeated tick cannot double-settle.
- `backup` writes at most one archive per Kuwait calendar day (or ISO week), and
  a partial unique index on `(kind, period_key)` is the invariant behind that —
  two ticks racing each other both pass the due check and exactly one survives
  the insert. The loser reports itself as skipped.
- `log-retention` deletes rows older than a cutoff computed from `now()`
  (`242_log_retention.sql`), so a repeated tick finds nothing new to delete.

The scheduled path runs as `service_role` and reaches the companies through the
outbox; the manual "run now" path stays user-scoped and enforces
`has_permission`. `backup` additionally requires the `admin` role for its
run-now path: no permission code in this project means "administrator", and
this job can write a full copy of the database.

## Reverse proxy

`nginx.example.conf` is a reference vhost (TLS, security headers, proxy pass). If
Dokploy's built-in Traefik already terminates TLS, you do not need it — use it
when fronting the app with your own Nginx.

## Auth 401s after redeploy — anon key rotation runbook

The browser's Supabase anon key is injected at **runtime**: the SSR'd HTML
carries `window.__SUPABASE_CONFIG` built from the app container's
`SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` env vars (see
`src/fns/publicRuntimeConfig.ts` and `src/routes/__root.tsx`), with the
build-time `VITE_*` values as fallback only.

If login returns **401 with body `{"message":"Unauthorized"}`**, Kong is
rejecting the anon key before GoTrue ever sees the request — the key the
browser sent does not match the Supabase stack's current `ANON_KEY`.
This happens when the `supabase-danat` compose service is **deleted and
recreated** in Dokploy (recreation generates fresh `JWT_SECRET` / `ANON_KEY` /
`SERVICE_ROLE_KEY` and an empty database under a new
`/etc/dokploy/compose/<slug>/files/volumes/db/data` bind mount). A plain
redeploy of the compose keeps the same secrets and data.

To recover after a key rotation:

1. Read the new keys: `/etc/dokploy/compose/<supabase-slug>/code/.env`
   (`ANON_KEY`, `SERVICE_ROLE_KEY`, `JWT_SECRET`).
2. In Dokploy → Danat-kuwait app → Environment, update
   `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (and the `VITE_*`
   build args to keep the fallback honest).
3. Redeploy the app (an env-only change needs just a restart for the runtime
   injection; the rebuild only refreshes the fallback values).
4. Users refresh the page — no cache clearing needed, the HTML is
   SSR'd per request.

If the stack was recreated the database is empty too: re-run
`db/migrations/` + `supabase/migrations/`, then re-seed the admin user.

## Cloudflare-only origin (firewall)

Both domains sit behind Cloudflare, but the origin's ports 80/443 answer
anyone who connects to the server IP directly. That bypasses Cloudflare's
protection, and it lets a caller forge the client-IP headers that rate limits
and audit rows trust. `deploy/cloudflare-origin-firewall.sh` drops new
connections to Traefik's published ports (80/tcp, 443/tcp, 443/udp) on the
public interface unless they come from Cloudflare's published ranges. It
covers those ports only; the pre-flight below checks that nothing else is
published.

**UFW does not work here.** Traefik's ports are published by Docker, and
Docker routes them through PREROUTING/FORWARD, never through the INPUT chain
UFW manages. The script hooks the `DOCKER-USER` chain instead, which Docker
leaves alone. A firewall in front of the host (at the provider or hypervisor)
would do the same job without touching iptables. This server is a VM (its NIC
has a Proxmox MAC prefix), not a Hetzner Cloud server, so Hetzner Cloud
Firewall is not available to it.

What stays reachable: SSH (22) is not touched. Container-to-container traffic,
loopback, and the app's own calls out to `supabase.danat-future.com` are not
filtered. Let's Encrypt HTTP-01 renewals still work, because Cloudflare proxies
`/.well-known/acme-challenge/` to the origin.

### Pre-flight (re-check before applying)

- Every hostname Traefik serves resolves to Cloudflare, not `49.12.59.137`:
  `danat-future.com`, `www.`, `dokploy.`, `wa.`, `supabase.`. A grey-cloud
  (DNS-only) record would go dark.
- `/usr/local/bin/danat-cron` calls `https://danat-future.com/...`, not the IP.
- Traefik's ACME resolver uses `httpChallenge`, not `tlsChallenge`.
- `ss -ltnp` shows nothing public beyond 22 and Traefik's 80/443 (and the
  swarm ports 2377/7946, a separate issue). A port published later is not
  covered by this filter.
- `ip -6 addr show dev eth0` has no global address (checked 2026-09-23). If
  one is added and Docker's ip6tables is off, IPv6 reaches docker-proxy
  through INPUT and is not filtered; re-check with an external `curl -6`.

### Apply

```bash
install -m 0755 deploy/cloudflare-origin-firewall.sh /usr/local/sbin/
install -m 0644 deploy/systemd/cloudflare-origin-firewall.* /etc/systemd/system/
# Escape hatch: if anything breaks, the filter removes itself in 10 minutes.
nohup sh -c 'sleep 600; /usr/local/sbin/cloudflare-origin-firewall.sh remove' >/dev/null 2>&1 &
echo $! > /root/cf-escape.pid
/usr/local/sbin/cloudflare-origin-firewall.sh apply
```

Then verify from **outside** the server (a check from the host itself goes
through loopback and proves nothing):

- `https://danat-future.com` loads, and a login and a portal page work.
- `curl -m 5 -k https://49.12.59.137 -H 'Host: danat-future.com'` from a
  laptop times out.

If both hold, cancel the escape hatch and make the rules persistent. Kill the
parent shell, not the `sleep`: killing the `sleep` ends it early and the shell
then runs `remove` straight away.

```bash
kill "$(cat /root/cf-escape.pid)"
```

```bash
systemctl daemon-reload
systemctl enable --now cloudflare-origin-firewall.service cloudflare-origin-firewall.timer
```

The timer refreshes the ranges daily. A refresh whose download fails or looks
short keeps the rules that are already loaded. The last good lists are cached
in `/var/lib/cloudflare-origin-firewall`, so a boot without network still loads
the filter; with no cache either, the service retries every minute. To undo everything:
`cloudflare-origin-firewall.sh remove`, then `systemctl disable --now` both
units.
