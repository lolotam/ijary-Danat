# Routes

TanStack Start uses **file-based routing**. Every non-test `.tsx` file in this directory is part of the route tree (a page or a layout); colocated `*.test.tsx` files are not routes. Do **not** create `src/pages/`, `src/routes/_app/index.tsx`, or `app/layout.tsx` — those are Next.js / Remix conventions. The only root layout is `src/routes/__root.tsx`.

`routeTree.gen.ts` is auto-generated. Don't edit it by hand.

## Conventions

| File                     | URL                                                     |
| ------------------------ | ------------------------------------------------------- |
| `index.tsx`              | `/`                                                     |
| `about.tsx`              | `/about`                                                |
| `users/index.tsx`        | `/users`                                                |
| `users/$id.tsx`          | `/users/:id` (dynamic — bare `$`, no curly braces)      |
| `posts/{-$category}.tsx` | `/posts/:category?` (optional segment)                  |
| `files/$.tsx`            | `/files/*` (splat — read via `_splat` param, never `*`) |
| `_layout.tsx`            | layout route (renders children via `<Outlet />`)        |
| `__root.tsx`             | app shell — wraps every page; preserve `<Outlet />`     |

A file name ending in `_` opts out of the layout with the same base name. For example `portal_.auth.tsx` defines `/portal/auth` without the `portal.tsx` layout; `admin.contracts_.builder.tsx` defines `/admin/contracts/builder`.

## Search params

List-scope filters that should survive refresh, shareable links, and post-action redirects (e.g. after close-out) use **URL search params**, declared on the route with `validateSearch` + Zod.

| Param    | Meaning                              | Convention                                                                      |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| `?view=` | List scope: current / archived / all | Lowercase enum values, always defaulted via `.catch("current")`, never required |

Leave `search` / `page` / local filters (`stateFilter`, etc.) as component
`useState` unless migrating them deliberately — do not mix both in one change.

Read with `Route.useSearch()`, change with `navigate({ search })`. This is the
first search-param convention for list scope in this repo.

## Hosts and route groups

Host resolution happens once in `server/middleware/company.ts`, then
`src/company/routeGating.ts` closes paths to the wrong host. The host names come
from `PLATFORM_ROOT_HOST` and `PLATFORM_ADMIN_HOST`; they are not hard-coded in
the gate.

| Host                      | Route groups served                                              |
| ------------------------- | ---------------------------------------------------------------- |
| `ijary.app`               | `/` temporary platform page and shared pages                     |
| `admin.ijary.app`         | `/platform/*` and shared pages                                   |
| `<slug>.ijary.app`        | `/`, `/admin/*`, `/portal/*`, `/support-session`, shared pages   |
| Any other host            | 404; no company is named, except for public callbacks            |
| Any host, `/api/public/*` | Public provider callbacks; each handler resolves its own company |

`/platform/*` returns 404 on company hosts. `/admin/*` and `/portal/*` return 404 on the platform and super admin hosts. A suspended company gets its suspended page for application pages and `COMPANY_SUSPENDED` for API and server-function calls; `/suspended`, `/api/public/*` and built assets stay reachable.

### `/platform/*` — super admin (admin host)

`platform.tsx` is the layout. Existing pages: `platform.index.tsx` (`/platform/`), `platform.login.tsx`, `platform.mfa.tsx`, `platform.audit.tsx`, `platform.gateways.tsx`, `platform.companies.index.tsx`, `platform.companies.$id.tsx`.

### `/admin/*` — company staff (company host)

`admin.tsx` is the layout. Existing pages include:

- `admin.index.tsx` — dashboard.
- Properties: `admin.properties.index.tsx`, `admin.properties.$id.tsx`; units: `admin.units.index.tsx`, `admin.units.$id.tsx`.
- Renters and contracts: `admin.tenants.index.tsx`, `admin.tenants.$id.tsx`, `admin.tenants.$id.index.tsx`, `admin.tenants.$id.documents.tsx`, `admin.contracts.tsx`, `admin.contracts_.builder.tsx`, `admin.contracts_.$id.closeout.tsx`.
- Billing: `admin.invoices.tsx`, `admin.payments.tsx`, `admin.deposits.tsx`, `admin.expenses.tsx`, `admin.electricity.tsx`.
- Operations: `admin.employees.tsx`, `admin.maintenance.index.tsx`, `admin.inbox.tsx`, `admin.reports.tsx`, `admin.audit.tsx`.
- Settings: `admin.settings.tsx` plus `admin.settings.index.tsx`, `admin.settings.users.tsx`, `admin.settings.roles.tsx`, `admin.settings.lists.tsx`, `admin.settings.notifications.tsx`, `admin.settings.cards.tsx`, `admin.settings.integrations.tsx`, `admin.settings.landing-page.tsx`, `admin.settings.cron.tsx`, `admin.settings.backup.tsx`.

### `/portal/*` — renter portal (company host)

`portal.tsx` is the layout for `portal.index.tsx`, `portal.invoices.tsx`, `portal.payments.tsx`, `portal.lease.tsx`, `portal.profile.tsx` and `portal.shop.tsx`.

`portal_.auth.tsx` (`/portal/auth`), `portal_.payments.callback.tsx` (`/portal/payments/callback`) and `portal_.payments.callback_.$preq.tsx` (`/portal/payments/callback/$preq`) are deliberately outside that layout: the callback pages must work without a signed-in portal session.

### `/support-session` — company host

`support-session.tsx` consumes a support-session token from the URL fragment. It is gated to company hosts alongside `/admin/*` and `/portal/*`.

### `/api/public/*` — provider callbacks (any host)

| File                                             | URL                                            | Purpose                                        |
| ------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------- |
| `api/public/webhooks/$provider.$connectionId.ts` | `/api/public/webhooks/:provider/:connectionId` | Provider callbacks resolved by connection id.  |
| `api/public/webhooks/evolution.$connectionId.ts` | `/api/public/webhooks/evolution/:connectionId` | Evolution/WhatsApp callback by connection id.  |
| `api/public/webhooks/meta.ts`                    | `/api/public/webhooks/meta`                    | Meta Cloud API verification and events.        |
| `api/public/webhooks/resend.$companyId.ts`       | `/api/public/webhooks/resend/:companyId`       | Email delivery events for a company sender.    |
| `api/public/webhooks/resend-platform.ts`         | `/api/public/webhooks/resend-platform`         | Email delivery events for the platform sender. |

Other API routes: `api/oauth/google/callback.ts` (`/api/oauth/google/callback`) is the Gmail OAuth redirect; it resolves the company from the signed `state` or the company host. There is no `/api/public/cron` route; schedules run in the worker.

### Shared pages

`index.tsx`, `auth.tsx`, `reset-password.tsx`, `suspended.tsx`, `not-found.tsx`, `terms.tsx` and `privacy.tsx` are top-level pages. Host gating still applies: an unknown host gets 404.
