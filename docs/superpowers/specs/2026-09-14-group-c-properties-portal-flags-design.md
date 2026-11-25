# Group C — property cards, portal feature flags and popup, landing H1, hide portal payments

Date: 2026-09-14. Branch: `feat/properties-portal-flags` (cut from `main` after PR #200).
Lands as a pull request; migrations applied to the live database before the merge.

Covers user tasks T4, T6, T7, T8. Group D (contract builder) runs in parallel on
its own branch and touches none of these files.

## Evidence that shaped the design

- `/admin/properties` cards render inline in `src/routes/admin.properties.index.tsx:363-437`
  (file is 664 lines, over the ceiling). The list is ordered `created_at desc`
  server-side and paginated at 10 (`useProperties.ts:124-128`); sorting the
  page client-side would reorder only 10 rows. Codes are `PROP-001…` (migration
  189), so `order by code` is numeric order.
- No per-property money aggregate exists. `contract_units.monthly_amount` is
  base rent; a contract past its increase anniversary bills more, and the only
  correct pricer, `contract_unit_period_amounts` (migration 196), is
  `service_role`-only. Decision: a new SECURITY DEFINER RPC sums the pricer
  per building (rent only, no extra charges).
- The repo's feature-flag store is `card_visibility` (migration 126, policy
  rebuilt in 132: `select … using (true)` for any authenticated session, write
  gated on `company.update`), driven by `CARD_REGISTRY` in
  `src/lib/cardRegistry.ts` and the Settings → Cards screen. Absent row =
  visible; while loading `isCardVisible` returns true. Tenant sessions can read
  it. Decision: the three portal flags live there.
- Portal layout `src/routes/portal.tsx` mounts `AnnouncementBanner` (company
  columns) at `:330`; there is no on-load dialog today. The compose form is
  `TenantMessageForm` mounted once at `portal.index.tsx:145`; the lease
  concessions block is the `SectionCard` at `portal.lease.tsx:150-195`.
- The landing H1 uses `TypedText` (`src/components/landing/TypedText.tsx`) at
  `src/routes/index.tsx:730`. Tailwind v4 `@theme` already defines
  `--animate-fade-in: landing-fade-in 0.25s ease-out both` (`src/styles.css:14`).
  No framer-motion.
- Portal tab visibility (`src/lib/portalTabs.ts:136-150`): per-tenant tri-state
  override, else `role_permissions` for role `tenant`. The
  `('tenant','portal.tab_payments')` row exists in production; all 57 tenants
  are on "inherit" (`portal_tab_payments is null`). Decision: revoke the role
  row, keep the tri-state.

## T4 — property cards

### Order

`useProperties.ts:127`: `.order("code", { ascending: true })` replaces the
`created_at` order. Table view sort keys are unchanged.

### Monthly rent per building

Migration `204_property_monthly_rent_totals_rpc.sql`:

```sql
create or replace function public.get_property_monthly_rent_totals(
  p_period_start date default date_trunc('month', current_date)::date
) returns table (property_id uuid, monthly_total numeric)
```

`security definer`, `set search_path = public, pg_temp`, guarded by
`has_permission(auth.uid(), 'properties.read')` for `authenticated`; grants
`revoke … from public, anon; grant … to authenticated, service_role`.

**Definition: rent collectible for the given month**, not the contractual
rate. A NULL `p_period_start` is normalised to the current month
(`coalesce(...)`, because a SQL default covers only an omitted argument). A
contract counts when it is `active`, not archived, its term covers the month
(`date_trunc('month', start_date) <= p_period_start <= date_trunc('month', end_date)`),
and the month is not a free month (`not period_in_free_months(id, p_period_start)`,
the same eligibility the invoice generator applies). For each such contract
the RPC calls `contract_unit_period_amounts(id, p_period_start)` and groups
the unit amounts by `units.property_id`. Rent only: extra charges are not
included (decision). Buildings with no eligible contract are absent.

Client: `usePropertyMonthlyTotals(periodStart)` in `src/hooks/useProperties.ts`
calls the RPC with the explicit month (`YYYY-MM-01`) so the query key
`["property-monthly-totals", periodStart]` rolls over at a month boundary,
and returns `{ totals: Map<propertyId, number> }`. After a **successful** read
a building absent from the result is `0`; while loading the pill is not
shown; on error the card shows a small muted `t("common.error")` line where
the pill would be (never a silent absence). The mutations that change what a
building collects invalidate the key: `useSaveContractWithUnits`, the
close-out submit, and the concessions dialog save (each already invalidates
other keys; the new key is added beside them). The pill is
`bg-emerald-600 text-white` with the label `properties.monthlyToCollect`
("المستحق شهرياً" / "Monthly to collect").

### File split

The card JSX moves to `src/components/admin/properties/PropertyCard.tsx`
(new directory), taking `property`, `monthlyTotal`, `onOpen`, `onEdit`,
`onDelete`, `canUpdate`, `canDelete`. The route shrinks under 600 lines.

## T6 — portal feature flags and the reminder popup

### Registry

`CardPage` gains `"portal"`; `CARD_PAGE_LABEL_KEYS.portal = "settings.cards.portal"`
("بوابة المستأجر" / "Tenant portal"). Three definitions:

| id | labelKey | gates |
|---|---|---|
| `portal.reminderPopup` | `settings.cards.portal.reminderPopup` | the red reminder dialog |
| `portal.messageCompose` | `settings.cards.portal.messageCompose` | `TenantMessageForm` on the dashboard |
| `portal.leaseConcessions` | `settings.cards.portal.leaseConcessions` | the concessions `SectionCard` on the lease page |

The Settings → Cards screen picks them up with no change (it renders the
registry). Absent row = visible, so the popup shows and both sections show
until an admin unticks them.

### Gating semantics in the portal

`isCardVisible` answers true while loading **and after a failed read**
(`query.data ?? []`), which is the right default for admin KPI cards but would
un-hide an administratively hidden portal section whenever the read errors or
the company row is missing. `useCardVisibility` therefore gains
`isReady: boolean` — true only after both the company and the flag reads
**succeeded** (`status === "success"`). Portal gates render nothing until
`isReady`, then `isCardVisible(id) ? <block/> : null`; on error they stay
hidden (the admin cards keep the visible default). The popup opens only when
`isReady && isCardVisible("portal.reminderPopup")`.

### Reminder popup

`src/components/portal/ReminderPopupDialog.tsx` (new): a Radix `Dialog`
mounted in the portal layout next to `AnnouncementBanner`. **Lifetime: once
per browser tab per signed-in tenant.** Dismissal is stored in
`sessionStorage` under `portal.reminderPopup.dismissed:<tenantId>` (tab-scoped,
survives reloads, not shared across tabs; the tenant id in the key means a
different login in the same tab sees it again). Storage reads/writes are
wrapped in try/catch and a throwing store means "not dismissed" (show). The
instruction is rendered through `DialogDescription` so assistive technology
announces it as the dialog's description. Red visual:
`border-red-600 bg-red-50 dark:bg-red-950/60`, a pulsing red bell/alert icon,
the dialog panel enters with the existing `animate-fade-in` plus a gentle
`animate-pulse` ring. Text fixed in i18n:

- ar: `يرجى مراجعة مكتب شؤون المستهلكين لوزارة الكهرباء والماء وسداد جميع المبالغ المستحقة.`
- en: `Please visit the Consumer Affairs Office of the Ministry of Electricity and Water and settle all outstanding amounts.`

One button `t("common.close")` (and `t("portal.reminder.understood")`
"فهمت" / "Understood" as the primary). `motion-reduce:animate-none`.

## T7 — landing H1

`src/styles.css` gains `--animate-fade-in-slow: landing-fade-in 1.2s ease-out both`
in the same `@theme` block. The hero title becomes its own small component
`src/components/landing/HeroTitle.tsx` (`<h1 className="… animate-fade-in-slow motion-reduce:animate-none">{title}</h1>`),
mounted at `src/routes/index.tsx:729-731` in place of the `TypedText` H1; the
test renders that component, not a class constant. No SEO/a11y improvement is
claimed: `TypedText` already exposed the full title to assistive technology;
the change is visual only. The subtitle keeps its typewriter (out of scope),
so `TypedText` is not deleted.

## T8 — hide the portal payments tab for everyone

Migration `205_revoke_tenant_payments_tab.sql`:

```sql
delete from public.role_permissions
 where role = 'tenant'::public.app_role and permission_code = 'portal.tab_payments';
```

Idempotent. The permission row itself stays (an admin can re-grant it from
Settings → Roles). Per-tenant "show" overrides still work; the form default
stays "inherit". No change to `portalTabs.ts`.

## Migrations

| File | Content |
|---|---|
| `204_property_monthly_rent_totals_rpc.sql` | `get_property_monthly_rent_totals(date)` |
| `205_revoke_tenant_payments_tab.sql` | delete the tenant-role payments row |

## Release sequence (part of the definition of done)

Group C and group D run in parallel; each worktree uses its **own SQL test
container and port** (`TEST_DB_CONTAINER=danat-sqltest-c TEST_DB_PORT=55330`
for C; D has no SQL) because `scripts/test-db.sh` destroys and rebuilds the
named container whenever migration fingerprints differ.

Before the merge: back up (`pg_dump`), deliver 204 and 205 to the server from
the reviewed branch (checksummed, not from the Dokploy checkout, which only
holds `main`), apply with `ON_ERROR_STOP`, `notify pgrst, 'reload schema'`,
verify `get_property_monthly_rent_totals()` returns rows and refuses anon,
verify the tenant-role payments row is gone and re-check that no tenant
carries a `true` override that would keep the tab. Then merge, watch the
container swap, load `/admin/properties` and the portal, and confirm the pill
and the popup.

## Tests

SQL: `propertyMonthlyRentTotals.sqltest.ts` (two buildings; one shared
2-unit contract split by unit; an active contract past its increase
anniversary counts the increased rent and, for a period before the
anniversary but after its start, the base rent; a contract starting next year
excluded; an `active` contract whose `end_date` is before the period excluded;
an archived contract excluded; a terminated contract excluded; a free month
(concession) excluded; NULL period behaves as the current month; anon refused;
no-permission refused). `revokeTenantPaymentsTab.sqltest.ts`: on the fresh
build the row is already absent (baseline proves the chain, since 46 seeds
and 205 runs later under `sort -V`); re-inserting the row and replaying the
file removes it and leaves the **complete** set of other tenant-role
permissions byte-identical; `isPortalTabVisible` (Vitest) resolves inherit →
hidden, `true` → shown, `false` → hidden for the payments tab with the
role set lacking the permission.

Vitest: `cardRegistry.test.ts` (portal page present with the three ids;
`cardsByPage` order ends with portal); `useCardVisibility.test.ts` (`isReady`
false while pending, false after a rejected read, true after success);
`ReminderPopupDialog.test.tsx` and the portal index/lease gating tests use the
**real** `useCardVisibility` under a `QueryClientProvider` with the Supabase
client stubbed at the boundary (`companies` and `card_visibility` reads):
pending → hidden, rejected → hidden, success+off → hidden, success+on →
shown; the popup's dismissal survives unmount/remount, is keyed by tenant id,
and a throwing `sessionStorage` shows the popup; the accessible description
carries the instruction. `PropertyCard.test.tsx` (pill renders the amount;
`0` renders a zero pill; error state renders the error line). Route-level
`admin.properties` test: totals success maps a missing building to 0.
`useProperties.test.ts` (`usePropertyMonthlyTotals` maps rows; order by code).
`HeroTitle.test.tsx` renders one `<h1>` containing the title, the fade class,
and no cursor span.

## Out of scope

Creating flags from the company form; a per-tenant popup; restyling the
landing subtitle; hiding the tenant-detail payments column.
