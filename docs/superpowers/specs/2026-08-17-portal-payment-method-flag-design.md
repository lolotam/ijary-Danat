# Admin-controlled portal payment methods — design

**Date:** 2026-08-17
**Status:** implemented
**Scope:** one migration (`companies` gains two boolean columns), one server-function
guard, two pure library functions, the portal Pay-Now UI, one admin settings card.
No env var, no MyFatoorah API change, no new table.

## Problem

`/portal/invoices` always offered the same three hosted payment methods, from a
hardcoded constant in `PayNowMenu.tsx`. The only filter applied to it was device
capability (`isPaymentMethodOffered`, `src/lib/paymentHandoff.ts`). There was no
way for an administrator to say "this portal takes KNET only".

Two concrete consequences:

1. **Methods not live on the MyFatoorah account were still offered.**
   `createPayment.ts` already records the failure mode in a comment — a
   pinned-but-disabled method fails *at the gateway*, after the tenant has
   pressed the button and a `payment_requests` row already exists. The tenant
   sees a broken gateway page; the admin gets an orphan row.
2. **A single-method operator still got a dropdown.** Pressing "ادفع الآن"
   opened a menu with one item in it — a wasted tap on every payment.

## Design

### KNET is the base, not a switch

The setting is **not** a list of enabled methods. KNET is unconditional, and the
two switches decide only whether Apple Pay and Google Pay are offered *on top of
it*.

That asymmetry is the design's load-bearing decision, and it is what makes the
rest small. A list of enabled methods makes "no method at all" representable, so
every consumer downstream has to defend against an empty payment menu: an empty
state in the UI, an at-least-one rule in the admin form, a CHECK constraint in
the database, and a warning for the one configuration that can reach it. With
KNET structurally always present, that state cannot be written down, so none of
that code exists.

The invariant holds because `paymentHandoffFor` only ever returns `"unavailable"`
for `APPLE_PAY`. KNET therefore survives every device filter, on every device.
`paymentHandoff.test.ts` pins this directly: `offeredPaymentMethods` is asserted
to contain KNET across the full cross-product of device profiles and settings.

### Where the setting lives: two booleans on `companies`

`portal_apple_pay_enabled` and `portal_google_pay_enabled`, both
`boolean not null default true`.

The `companies` row is already this project's home for portal-shaping settings —
`max_visible_unpaid_invoices`, `portal_bg_url` and `announcement_enabled` all
live there and are all read by portal code. It is already readable by a tenant
(`companies_select_tenant`, `db/migrations/17_tenant_portal_units_rls.sql`) and
writable only by an admin (`companies_update_permitted`,
`db/migrations/03_phase1_permissions_audit.sql`). The grant in
`01_schema_core.sql:49` is table-level, so new columns are covered without a
further grant.

`useCompany` / `useUpdateCompany` already fetch and write that row, and
`useUpdateCompany` already writes the `company.update` audit entry — so the admin
side needed no new hook and gets audit for free.

**Both default to `true`.** Production showed all three methods before this
change and a push to `main` auto-deploys, so the existing row had to land with
today's exact behaviour and change nothing for tenants until an admin turns a
switch off.

**Rejected alternatives.** A `text[]` of enabled methods reintroduces the empty
state described above. A `settings_json` blob loses type safety and turns a typo
into a silent misconfiguration. A separate table buys per-company rows the schema
already has via `companies.id` and costs a new RLS policy pair. An `option_lists`
row is the wrong shape — that mechanism drives free-form dropdown *values*, and
these are a closed enum pinned by MyFatoorah's API contract.

### The effective list is an intersection, computed in one place

Two pure functions in `src/lib/paymentHandoff.ts`:

- `enabledPaymentMethods({ applePay, googlePay })` — KNET always, then the
  enabled extras, in the fixed display order. Order lives in code, so toggling a
  switch cannot reorder the tenant's menu.
- `offeredPaymentMethods({ device, enabled })` — filters that through the
  existing `isPaymentMethodOffered`.

**Everything keys off the effective list, never the configured one.** This is the
easiest thing to get wrong. With Apple Pay enabled and the tenant on an Android
phone, two methods are configured and only KNET is reachable — branching on the
configured count renders correctly on a desktop and wrongly on exactly the
devices tenants pay from. Both `PayNowMenu` and `paySelected` consume
`offeredPaymentMethods`, and a test asserts this specific case.

### Three render states in `PayNowMenu`

| State | Render |
| --- | --- |
| Settings still loading | Disabled button, **normal** "ادفع الآن" label, no provider named. |
| Exactly one method offered | A plain `Button` calling `onSelect(method)` directly. No `DropdownMenu` in the tree at all. Label composes "ادفع الآن" with the provider name in JSX — `t()` takes no interpolation parameters (`src/i18n/provider.tsx:23`), so a templated key is not an option. |
| Two or more offered | Today's dropdown, over the offered list. |

The loading branch is checked first and deliberately does not name a provider:
until the company row resolves there is nothing to name, and guessing would flip
the label under the tenant when the real answer arrived.

There is no empty state, per the invariant above.

### Server enforcement, scoped to tenants

The UI filter is not a control — `createPayment` is a server function reachable
with any method in the enum. Three constraints shaped the guard:

- **It cannot live in `inputSchema`.** The enabled set is a database read, and
  the `createServerFn` mock used across `src/fns/*.test.ts` never runs
  `.validator()`. A rule placed there is asserted by nothing.
- **It throws `Error`, never `Response`.** A thrown `Response` is delivered to
  the client as a *resolved* value via `x-tss-raw`, so the portal would read a
  refusal as a successful payment. A test asserts the thrown value is an `Error`
  and not a `Response`.
- **It applies to tenant-initiated payments only.** Every caller passes
  `paymentMethod` explicitly, including admin's "KNET link" button
  (`admin.invoices.tsx`). A blanket rule would break that button the moment an
  admin switched a rail off for the portal — which is not what the setting means.

`tenantPaymentContext` already computed `actingAsStaff`; `TenantPaymentContext`
now carries it, and the guard runs only when it is `false`. This mirrors the
`tenant_portal_enabled` exemption immediately above it in the same file.

The check runs **before** `reservePaymentRequest`, so a refusal cannot leave an
orphan `payment_requests` row behind. A test asserts no reservation read happens
on the refused path.

`enabledMethodsForTenant` reads the company row through the **caller's** client
rather than `supabaseAdmin`: only the paying tenant ever reaches it, and
`companies_select_tenant` already grants them that row. Reaching for the
service-role key in a money path would buy nothing and give up the user-scoped
posture the rest of the admin-triggered paths keep. It fails closed throughout —
no company link, no row, or a denied read all refuse.

### Admin UI

`src/components/admin/PortalPaymentMethodsCard.tsx`, a form-context consumer
following the `AnnouncementSettingsCard` precedent: it shares the settings page's
single save button and existing mutation. This also keeps
`admin.settings.index.tsx` — already **660 lines**, past the project's 500–600
ceiling — from growing by more than an import, two schema fields, two defaults,
two loads and one placement (660 → 670).

Two switches, plus a line stating KNET is always available. That line is not
decoration: without it, an admin who turns both switches off has no confirmation
that tenants can still pay. A test asserts there is no third switch, since adding
one would quietly reintroduce the empty-menu state this design removed.

## Assumptions and known gaps

1. **Admin-generated payment links are out of scope.** An admin pressing "KNET
   link" on an invoice keeps working regardless of the portal setting. *Known
   gap:* an operator who reads the setting as "this system only accepts KNET"
   will find admin tooling unaffected by it.
2. **The three methods stay the closed set.** MyFatoorah's `CARD` remains
   excluded, as `createPayment.ts` documents.
3. **One company row.** `useCompany` reads the first row by `created_at` and the
   deployment has exactly one. The columns are per-company, so this is
   forward-compatible — but note that multi-company is not enforced in RLS
   anywhere today, and this change does not address that.
4. **The setting does not retroactively kill live payment links.** A tenant
   holding an already-issued Google Pay URL can still pay it after Google Pay is
   switched off. The guard sits on the request path; nothing here touches an
   already-issued URL. Killing live links is a separate, riskier decision.

## Acceptance criteria

- [x] With both switches on, the portal behaves exactly as before.
- [x] With both off, "ادفع الآن" opens the KNET hosted page in one press, with no
      dropdown rendered.
- [x] With Google Pay on and Apple Pay off, the dropdown shows those two only.
- [x] Apple Pay on + Android phone renders the *direct* KNET button, not a
      one-item dropdown.
- [x] `createPayment` called by a tenant with a disabled method rejects, and the
      test asserts on the thrown `Error`.
- [x] `createPayment` called by a tenant with KNET always succeeds.
- [x] `createPayment` called by staff with a switched-off method succeeds.
- [x] The refused path performs no `payment_requests` read or write.
- [x] `bun run lint` and `bun run typecheck` pass.
- [x] `bun run test` — 221 files, 1870 tests, all passing.
