# Contract: Company Context

The rules every request, server function, job and SQL object follows to know which company it acts for. Background: [research.md](../research.md) R1, R2, R4, R17, R18.

## 1. Hosts

| Host | Serves | Company context |
|---|---|---|
| `ijary.app` | Temporary platform page with a sign-in entry | None |
| `admin.ijary.app` | Super admin panel (`/platform/*` routes only) | None |
| `<slug>.ijary.app` | Company sign-in, admin panel (`/admin/*`), renter portal (`/portal/*`) | The company owning the host |
| Any other host | 404 page | None |
| Any host — `/api/public/*` paths only | Payment and messaging provider callbacks (webhooks) | None at the gate; each handler resolves its own company and refuses with `COMPANY_REQUIRED` |

`/platform/*` returns 404 on a company host. `/admin/*` and `/portal/*` return 404 on the platform and super admin hosts. The `/api/public/*` exemption is deliberate: those callbacks arrive on whatever host the provider was configured with, and gating them would silently drop payment and messaging callbacks during host misconfiguration — the handler, not the gate, decides which company a callback belongs to.

## 2. Request context (server)

Set once by the host middleware and read through `getRequestCompany()`:

```ts
type RequestCompany = {
  id: string;            // companies.id
  slug: string;
  status: "active" | "suspended";
  host: string;
};
```

Rules:

- A server function that needs a company calls `requireRequestCompany()`, which throws `COMPANY_REQUIRED` when the host has none.
- After authentication, `profile.company_id !== requestCompany.id` is handled as "not signed in". The response does not say that the account exists elsewhere.
- `status === "suspended"`: every route except the suspended page and the public webhook routes responds with the suspended page.

## 3. Database clients

| Client | Postgres role | Who may import it | Company |
|---|---|---|---|
| Browser `supabase` | `authenticated` / `anon` | Client code | From `profiles` via `current_company_id()` |
| `companyClient(companyId, opts?)` | `company_service` | Any server function or job handler | From the signed claim |
| `platformClient` (today's `supabaseAdmin`) | `service_role` | Only `src/platform/**`, `src/company/hostCompany.server.ts`, `src/worker/relay.ts`, `src/worker/runJobPorts.ts`, `src/worker/scheduler.ts` | None; bypasses RLS |

`companyClient` contract:

```ts
function companyClient(
  companyId: string,
  opts?: { allowSuspended?: boolean },
): SupabaseClient<Database>;
```

- Throws `COMPANY_REQUIRED` if `companyId` is empty or not a UUID.
- Signs a JWT valid for 5 minutes: `{ role: "company_service", company_id, allow_suspended?: true }`.
- `allowSuspended` may be passed only by the payment settlement path.
- Lint rule: importing `client.server.ts` outside the allow-list fails the build.

## 4. JWT claims the database reads

| Claim | Set by | Read by |
|---|---|---|
| `role` | GoTrue or `companyClient` | PostgREST role switch |
| `sub` | GoTrue or support-session mint | `auth.uid()` |
| `aal` | GoTrue | `is_platform_admin()` |
| `company_id` | `companyClient` | `current_company_id()` for `company_service` |
| `allow_suspended` | `companyClient` | `current_company_id()` |
| `impersonator`, `impersonation_session` | Support-session mint | `current_company_id()`, `write_audit` |

A `company_id` claim on an `authenticated` token is ignored.

## 5. SQL contract

```sql
public.current_company_id() returns uuid   -- null = no access
public.is_platform_admin()  returns boolean
public.module_enabled(_key text) returns boolean
```

Policy shape for every company-scoped table (names vary):

```sql
create policy t_select on public.t for select to authenticated, company_service
  using (company_id = (select public.current_company_id())
         and <existing role or permission condition, hoisted>);

create policy t_insert on public.t for insert to authenticated, company_service
  with check (company_id = (select public.current_company_id())
              and <existing condition>);
```

Rules checked by structure tests:

1. Every table in `public` except the allow-list (`permissions`, `reserved_slugs`, platform tables) has a `company_id` column, RLS enabled and forced, and at least one policy; every policy text contains `current_company_id`.
2. No policy calls an auth helper outside a scalar sub-select (existing `rlsHoistedAuth.sqltest.ts`, extended).
3. Every `security definer` function in `public` references `current_company_id` in its body, or is on the platform allow-list.
4. No function or source file selects from `companies` with `limit 1`.
5. No grant of `delete` on `companies`.

## 6. Errors

| Code | Meaning | User-facing |
|---|---|---|
| `COMPANY_REQUIRED` | Operation ran without a company | Generic error; logged as a defect |
| `COMPANY_SUSPENDED` | Company is suspended | Suspended page |
| `MODULE_DISABLED` | Section is off for the company | "This section is not available for your company" |
| `LIMIT_UNITS`, `LIMIT_STAFF`, `LIMIT_STORAGE`, `LIMIT_WHATSAPP` | A limit was reached | Message naming the limit and current value |
| `SUPPORT_SESSION_FORBIDDEN` | Action not allowed in a support session | "Not available during a support session" |
