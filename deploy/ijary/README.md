# IJARY deployment and operations

**Danat production is out of bounds.** No command, migration, script or deployment from this repository targets Danat's live server, containers or data. IJARY is a separate deployment. Do not deploy or touch any server without the owner's explicit go-ahead at that moment.

## Stack

IJARY runs on the owner's Contabo server under Dokploy and Traefik, behind Cloudflare:

- **Web** — the TanStack Start / Nitro application built from the repository `Dockerfile`; the final `runtime` stage is the image Dokploy builds.
- **Supabase** — self-hosted PostgreSQL, GoTrue, PostgREST, Storage, Realtime and Kong, deployed separately from the web app. `supabase.env.example` here is its placeholder environment template.
- **Redis and worker** — the two services in [`docker-compose.yml`](docker-compose.yml). Redis holds BullMQ queue state; the worker runs the outbox relay, job handlers and schedules. The `job_requests` table in Postgres is the source of truth.
- **Evolution** — one platform WhatsApp QR server, configured through the platform environment. Companies reach it through per-company connections.

The compose file publishes no ports and adds no Traefik labels: the web app and Supabase are routed separately.

## Environment

### Server runtime

The web server (`src/server.ts`) and the worker (`src/worker/main.ts`) validate the server schema in `src/lib/env.server.ts` at startup. These names are required:

| Variable                    | Purpose                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| `SUPABASE_URL`              | URL of the self-hosted Supabase API.                                           |
| `SUPABASE_PUBLISHABLE_KEY`  | Publishable/anon key used by browser and auth calls.                           |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key for the lint-allowlisted platform files; bypasses RLS.         |
| `SUPABASE_JWT_SECRET`       | Server-only secret used to sign and verify company and support-session tokens. |
| `INTEGRATIONS_MASTER_KEY`   | Server-only AES-256-GCM key that encrypts `company_secrets`.                   |
| `REDIS_URL`                 | Redis connection for the worker. Compose sets it to the private service URL.   |
| `PLATFORM_ROOT_HOST`        | Root platform host used by host resolution.                                    |
| `PLATFORM_ADMIN_HOST`       | Super admin host used by host resolution.                                      |
| `CRON_SECRET`               | Required by the server schema; signs the Gmail OAuth `state` parameter.        |

`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` and `INTEGRATIONS_MASTER_KEY` **must never be given a `VITE_` prefix**: anything prefixed `VITE_` is compiled into the browser bundle. `GMAIL_CLIENT_SECRET` is server-only for the same reason. `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are also injected into the browser at runtime from `src/fns/publicRuntimeConfig.ts`.

Lovable preview uses `SELF_SUPABASE_*` aliases (`SELF_SUPABASE_URL`, `SELF_SUPABASE_PUBLISHABLE_KEY`, `SELF_SUPABASE_SERVICE_ROLE_KEY`, `SELF_SUPABASE_JWT_SECRET`); `parseServerEnv` normalises them to the names above. `SUPABASE_ANON_KEY` and `SELF_SUPABASE_ANON_KEY` are fallback names read by the server-side sign-in and password-reset calls. A normal IJARY deployment sets the names in the table, not the aliases.

### Optional server integrations

| Variable(s)                                                                                                               | Purpose                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `TRUST_FORWARDED_HOST`                                                                                                    | Whether host resolution trusts the forwarded host header.                                          |
| `APP_BASE_URL`                                                                                                            | Public origin for gateway redirects and the Evolution webhook URL.                                 |
| `PUBLIC_APP_URL`                                                                                                          | Public origin used in portal emails and generated documents.                                       |
| `MYFATOORAH_API_KEY`, `MYFATOORAH_WEBHOOK_SECRET`, `MYFATOORAH_BASE_URL`                                                  | Platform MyFatoorah credentials, webhook verification and API environment.                         |
| `PLATFORM_EMAIL_PROVIDER`, `PLATFORM_EMAIL_FROM`, `PLATFORM_RESEND_WEBHOOK_SECRET`                                        | Platform default sender and its webhook.                                                           |
| `RESEND_API_KEY`, `RESEND_FROM`                                                                                           | Resend credentials and sender address.                                                             |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`                                                           | SMTP credentials and sender address.                                                               |
| `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`, `META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_API_VERSION` | Meta Cloud API app, Embedded Signup, webhook verification and Graph version.                       |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`                                                                                  | Platform Evolution server for WhatsApp QR connections.                                             |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`                                                                              | Cloudflare zone and token for the custom-hostname flow. Both are required together.                |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI`                                                            | Google OAuth app for the Gmail inbox connection.                                                   |
| `GMAIL_REFRESH_TOKEN`, `GMAIL_SYNC_ADDRESS`, `GMAIL_SYNC_WINDOW`                                                          | Fallback mailbox, sync identity and sync look-back window.                                         |
| `SENTRY_DSN`                                                                                                              | Server-side Sentry fallback when the build-time value is absent.                                   |
| `CHROMIUM_PATH`                                                                                                           | Chromium binary used to render PDFs. The `Dockerfile` sets it in the shared `chromium-base` stage. |

Several names are paired by `superRefine` in `src/lib/env.server.ts`: a sender provider needs its `FROM` address, Resend needs its API key, SMTP needs its host, a Meta app id or signup config needs the app secret, Evolution URL needs its key, and each Cloudflare name needs the other. Set the pairs together or leave both unset.

### Build-time and test-only names

| Variable(s)                                                                        | Purpose                                                                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`                               | Build arguments in the `Dockerfile`; browser fallback config.                  |
| `VITE_SENTRY_DSN`, `VITE_PUBLIC_POSTHOG_PROJECT_TOKEN`, `VITE_PUBLIC_POSTHOG_HOST` | Optional build arguments; empty values leave those integrations disabled.      |
| `SENTRY_AUTH_TOKEN`                                                                | Optional BuildKit secret for source-map upload; never an env var or build arg. |
| `SKIP_ENV_VALIDATION`, `VITEST`                                                    | Test-only validation bypasses; do not set them in a deployment.                |

### Worker and Supabase environment

The worker reads `deploy/ijary/.env.worker`, an untracked file you create; `.gitignore` already ignores `.env.*`. `REDIS_URL` is set by the compose file, not by that file. The full optional-name list is also in the comment above the `worker` service in `docker-compose.yml`.

The Supabase stack is configured by its own deployment, not by this compose file. `supabase.env.example` is its placeholder template: GoTrue's `GOTRUE_SITE_URL` / `SITE_URL` and redirect allow-list (`GOTRUE_URI_ALLOW_LIST` / `ADDITIONAL_REDIRECT_URLS`) cover the root host, the admin host and `https://*.ijary.app/**`, and `API_CORS_ORIGINS` covers the same hosts for Kong. Set the name family the deployed compose actually reads. Verified custom domains are added per company; the wildcard is not widened for them.

### Kong: refuse direct GoTrue user writes

GoTrue accepts any JWT signed with `SUPABASE_JWT_SECRET` on `PUT /auth/v1/user`, including a support-session token. Left open, a super admin in a support session could change the impersonated user's password or email and keep access after the session ends. The app no longer writes there: password changes go through `changeOwnPassword` (`src/fns/changeOwnPassword.ts`), which refuses support sessions. The production Kong must refuse the direct write, as `dev-local/volumes/api/kong.yml` does: a service `auth-v1-user-write-blocked` whose route matches `paths: [/auth/v1/user]` with `methods: [PUT, PATCH]` and runs the `request-termination` plugin with `status_code: 403`, and `request-termination` added to `KONG_PLUGINS`. `GET /auth/v1/user` must stay open; the server's auth middleware and `supabase.auth.setSession` call it. Check after deploying: an anonymous `PUT /auth/v1/user` answers 403 and an anonymous `GET` answers 401.

## Applying migrations

Dokploy deploys code, never schema. Nothing applies `db/migrations/` for you, and there is no staging environment. Apply reviewed migrations **before** the new web or worker bundle goes live, or the bundle runs against the old schema.

1. Verify the migration set from a clean database with `bun run test:db` and `bun run test:sql`. See [`db/README.md`](../../db/README.md) for the numeric run order: `db/migrations/` by leading migration number (`sort -V`), then `supabase/migrations/`.
2. Take a `pg_dump` of the IJARY database. Schema changes are not reversible.
3. Read each migration's header before applying it. Apply the exact reviewed files with `psql -v ON_ERROR_STOP=1`. Checksum the file deployed on the server against the local file before applying it.
4. Run `notify pgrst, 'reload schema';`. Without it, new RPCs answer 404 from PostgREST's stale schema cache.
5. After a schema change, run `bun run gen:types` and hand-copy the new table, column or RPC entry into `src/integrations/supabase/database.types.ts`. The generated file is a reference only.

## Backups

- Dump the database with `pg_dump` before schema changes and on the owner's backup schedule.
- Supabase Storage keeps each object's content type in POSIX extended attributes. Copy Storage directories only with `rsync -aX` or `tar --xattrs`; a plain copy leaves files present but served with the wrong content type. This applies to the buckets that carry stored files, including documents, WhatsApp media, Gmail attachments and backups.
- The app's own Backup → Restore path sets `session_replication_role = replica` (`db/migrations/146_backups.sql`), so money-moving deposit triggers do not fire during that restore. An out-of-band `psql` data restore does not get that protection and needs the trigger workaround in [`db/README.md`](../../db/README.md).

## Worker

[`docker-compose.yml`](docker-compose.yml) defines `redis` (`redis:7.4-alpine`, append-only) on a named volume and `worker`, built from the repository `Dockerfile` with `target: worker`. The worker waits for Redis to become healthy, then runs `bun run src/worker/main.ts` on Bun with the TypeScript sources and `tsconfig.json` path alias. Chromium and Arabic/Latin fonts are installed in the shared base image because document jobs render PDFs.

The worker validates the whole server schema before it starts; a missing required name stops the process instead of degrading it. Deploy the web app and the migrations first, then start the worker. Schedules are owned by the worker; there is no external crontab and no `/api/public/cron` route.

## Wildcard address and certificate

The three host kinds are `ijary.app`, `admin.ijary.app` and `<slug>.ijary.app`. The intended setup is a Cloudflare-proxied wildcard DNS record for `*.ijary.app`, one Traefik router with a host-regexp rule, and a wildcard certificate obtained by DNS-01 with an API token scoped to the `ijary.app` zone.

**Pending:** the owner's Cloudflare API token for the zone has not been supplied. Do not configure DNS-01 or claim the wildcard certificate is active until it is. Until then, the fallback in the conversion research is a Cloudflare Origin CA wildcard certificate mounted into Traefik. The same token and `CLOUDFLARE_ZONE_ID` are used by the custom-hostname flow below.

An unknown host must still answer 404; the router must pass the request to the app rather than serve a catch-all site.

## Custom domains (Cloudflare for SaaS)

A company can be reached on a domain of its own beside its automatic `<slug>.ijary.app` address. The super admin attaches it from `/platform/companies/:id`; the company is not asked to change platform code.

1. The platform creates a custom hostname in its Cloudflare zone and stores the answer in `company_domains` (`kind = 'custom'`, `verification_status = 'pending'`, `provider_ref` = the Cloudflare id).
2. The panel shows the ownership TXT record and CNAME target. The company publishes them in its own DNS.
3. A status check reads the hostname back from Cloudflare and marks the row `verified` only when Cloudflare reports it active. A pending or blocked hostname resolves to nothing.

Operational notes:

- Traefik routes on the `Host` header; the router rule must accept a custom host as well. The wildcard certificate does not cover it.
- Cloudflare serves the certificate for a custom hostname proxied through it. A domain pointed straight at the origin needs its own origin certificate.
- Add each custom domain to the Supabase redirect allow-lists (`GOTRUE_URI_ALLOW_LIST` / `ADDITIONAL_REDIRECT_URLS`) and to `API_CORS_ORIGINS`; the wildcard does not include it.
