# IJARY — background stack

`docker-compose.yml` here runs the two containers that have no web front:

| Service  | What it is                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `redis`  | `redis:7.4-alpine`, `appendonly yes` on a named volume, no published port.                                                         |
| `worker` | Built from the repository `Dockerfile` with `target: worker`; runs `bun run src/worker/main.ts` and waits for Redis to be healthy. |

It does **not** run the web application or the Supabase stack — both are
deployed separately in Dokploy on the same host, and the worker reaches them
through `SUPABASE_URL`.

## Environment

The worker reads `deploy/ijary/.env.worker`, a file you create and never commit
(`.gitignore` already ignores `.env.*`). It holds values only; the names come
from `src/lib/env.server.ts`:

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_PUBLISHABLE_KEY
SUPABASE_JWT_SECRET
INTEGRATIONS_MASTER_KEY
PLATFORM_ROOT_HOST
PLATFORM_ADMIN_HOST
CRON_SECRET
```

`REDIS_URL` is not one of them: the compose file sets it to `redis://redis:6379`.
The optional names (email, WhatsApp, MyFatoorah) are listed in the comment
above the `worker` service in the compose file.

## Supabase stack environment

The Supabase stack is configured by its own deployment, not this compose file.
`supabase.env.example` is its placeholder template: GoTrue's
`GOTRUE_SITE_URL` / `SITE_URL` and redirect allow-list
(`GOTRUE_URI_ALLOW_LIST` / `ADDITIONAL_REDIRECT_URLS`) covering
`https://ijary.app/**`, `https://admin.ijary.app/**` and `https://*.ijary.app/**`,
`API_CORS_ORIGINS` for the Kong `cors` plugin, and placeholder values for the
three server-only secrets (`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`,
`INTEGRATIONS_MASTER_KEY` — never `VITE_`-prefixed). Verified custom domains
are added to both lists per company later, never by widening the wildcard.

## Deploying

Nothing here is deployed without the owner's explicit go-ahead at that moment.
The worker image comes from the repository `Dockerfile`, so deploy the web app
first and the worker once the queue and the migrations are in place.

## Custom domains (Cloudflare for SaaS)

A company can be reached on a domain of its own (`www.acme.com`) beside its
automatic address (`acme.ijary.app`). The super admin attaches the domain from
the platform panel (`/platform/companies/:id` → the domains panel); the platform
never asks the company to configure anything itself.

### The flow

1. The super admin adds the domain. The platform asks Cloudflare to create a
   custom hostname inside the platform's own zone and stores the answer in
   `company_domains` (`kind = 'custom'`, `verification_status = 'pending'`,
   `provider_ref` = the Cloudflare id).
2. The panel shows the ownership record Cloudflare returned (the `_cf-custom-hostname…`
   TXT record and its value). The company publishes that TXT record in its own
   DNS, and points a CNAME at the target the panel shows.
3. The super admin presses "check the status". The platform re-reads the
   hostname from Cloudflare and marks the row `verified` once Cloudflare
   reports it active — only then does the host resolve to that company. A
   hostname that is still `pending` or that Cloudflare blocked resolves to
   nothing at all, so the request answers 404 without naming any company.

### What the deployment needs

- `CLOUDFLARE_API_TOKEN` — a token with the "SSL and Certificates Write"
  permission on the platform's zone.
- `CLOUDFLARE_ZONE_ID` — the zone that holds the platform's addresses
  (`ijary.app`). Both are optional: without them the custom-domain flow stays
  off and every company keeps its automatic address.

### Traefik and the host allow-list

- The proxy keeps routing on the `Host` header. The router rule must accept the
  custom host as well: either the existing host-regexp rule is widened to the
  custom domain, or one router is added per custom domain. The wildcard
  certificate for `*.ijary.app` does **not** cover a custom domain, and the
  rule must not fall back to serving any unknown host — an unknown host has to
  answer 404 (the code decides that from `company_domains`, but the proxy must
  still pass the request through instead of rejecting it earlier).
- Cloudflare issues and serves the certificate for the custom hostname, so the
  origin keeps its own certificate for the platform's addresses. If a custom
  domain is pointed straight at the origin instead of through Cloudflare, the
  origin needs a certificate for it — that is the owner's decision per domain.
- The Supabase stack's allow-lists are per domain and are **not** widened by the
  wildcard: add the custom domain to `GOTHRU_URI_ALLOW_LIST` /
  `ADDITIONAL_REDIRECT_URLS` and to `API_CORS_ORIGINS` in the Supabase
  deployment, so sign-in redirects and API calls from the company's own domain
  are accepted.
- The DNS of the company's domain needs the TXT record and the CNAME target
  the panel shows. Both live in Cloudflare's zone; the platform only records
  them.
