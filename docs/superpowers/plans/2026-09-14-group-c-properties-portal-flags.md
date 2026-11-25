# Group C — property cards, portal flags and popup, landing H1, hide payments tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/admin/properties` cards come in code order with a "monthly to collect" pill that shows what each building can collect this month (real period pricer, term and free-month aware); three admin-toggled portal flags (red reminder popup, message compose, lease concessions) live in the existing card-visibility registry and fail closed; the landing H1 fades in; the portal payments tab is hidden for every tenant by revoking the tenant-role default.

**Architecture:** One SECURITY DEFINER RPC (`get_property_monthly_rent_totals`) wraps `contract_unit_period_amounts` per building behind the same eligibility the invoice generator uses. `useCardVisibility` gains `isReady` so portal gates hide until a successful read. One data migration deletes one `role_permissions` row. The property card and the hero title become their own components.

**Tech Stack:** TanStack Start + React 19, react-query, Radix Dialog (shadcn), Tailwind v4 `@theme` keyframes, plpgsql migrations, Vitest, SQL suite.

**Spec:** `docs/superpowers/specs/2026-09-14-group-c-properties-portal-flags-design.md`

## Global Constraints

- Every new file stays under 500–600 lines. `admin.properties.index.tsx` is 664 lines: the card JSX is extracted to `src/components/admin/properties/PropertyCard.tsx` in Task 2 and the route must end under 600. `src/routes/index.tsx` (2137 lines, pre-existing) receives a three-line edit only.
- Every function gets a doc comment above it that leads with an Arabic description; English may follow for the *why*.
- Migrations are `204_property_monthly_rent_totals_rpc.sql` and `205_revoke_tenant_payments_tab.sql`. Every `create or replace function` is followed by `revoke execute ... from public, anon;` and `grant execute ... to authenticated, service_role;`.
- `database.types.ts` is hand-maintained: add the RPC entry by hand; never run or paste `gen:types` output.
- Never call `contract_unit_period_amounts` from the client; it is `service_role`-only by design. The new RPC wraps it.
- **SQL test isolation:** this worktree uses its own container and port for every SQL command: `TEST_DB_CONTAINER=danat-sqltest-c TEST_DB_PORT=55330 bun run test:db` and `TEST_DB_CONTAINER=danat-sqltest-c TEST_DB_PORT=55330 bun run test:sql`. Never use the default container name (another branch's suite would be destroyed).
- Mocks only at boundaries (Supabase client, `sessionStorage`). Never mock `useCardVisibility`, `useCompany` or any internal hook. Tests assert `disabled=""` on buttons, never a class; no test mocks the module under test; no empty test bodies.
- Implementers do not commit. The orchestrator commits. Do not stage `contract_sample/`.
- Gates before handing back: `bun run lint`, `bun run typecheck`, `bun run test`, and the isolated SQL commands above for any task touching `db/migrations` or `src/db`.
- Fallback direction from the user, verbatim: "If any model goes out of quota (like GLM5.3 ), continue and delegate to Codex Astra 6 medium effort."

---

## File structure

| Path | Responsibility |
|---|---|
| `db/migrations/204_property_monthly_rent_totals_rpc.sql` | `get_property_monthly_rent_totals(date)` |
| `db/migrations/205_revoke_tenant_payments_tab.sql` | delete `('tenant','portal.tab_payments')` |
| `src/db/propertyMonthlyRentTotals.sqltest.ts`, `src/db/revokeTenantPaymentsTab.sqltest.ts` | SQL tests |
| `src/hooks/useProperties.ts` | order by code; `usePropertyMonthlyTotals(periodStart)` |
| `src/hooks/useContracts.ts`, `src/hooks/useContractCloseout.ts` (or wherever the close-out submit mutation lives), `src/components/admin/contracts/ConcessionsDialog.tsx` | invalidate `["property-monthly-totals"]` |
| `src/components/admin/properties/PropertyCard.tsx` | extracted card + pill / error line |
| `src/hooks/useCardVisibility.ts` | `isReady` |
| `src/lib/cardRegistry.ts` | `portal` page, three ids |
| `src/components/portal/ReminderPopupDialog.tsx` | red reminder dialog |
| `src/routes/portal.tsx`, `portal.index.tsx`, `portal.lease.tsx` | gates |
| `src/components/landing/HeroTitle.tsx`, `src/styles.css`, `src/routes/index.tsx` | H1 fade |
| `src/i18n/dictionary.ts` | new keys in both locales |

---

### Task 1: Migration 204 — rent collectible this month per building

**Files:** create `db/migrations/204_property_monthly_rent_totals_rpc.sql`; test `src/db/propertyMonthlyRentTotals.sqltest.ts`.

**Interfaces (produces):** `public.get_property_monthly_rent_totals(p_period_start date default date_trunc('month', current_date)::date) returns table (property_id uuid, monthly_total numeric)`.

- [ ] **Step 1: Write the failing test**

Fixtures via `seedContract` (`src/db/testDb.ts`; `startDate`/`endDate`/`state`/`units` options), all anchored to the database's current month the way `contractScheduleSync.sqltest.ts` does (`FIRST_OF_THIS_MONTH`):
- A: one unit 300, term covering this month.
- B: one unit 200, term covering this month.
- S: units `[300, 200]`, then `update public.units set property_id = <A.propertyId> where id = <S.unitIds[0]>` and `… = <B.propertyId> where id = <S.unitIds[1]>`.
- R: unit 100 in A's property, `start_date` = 24 months ago, `end_date` = 36 months ahead, `increase_after_years = 1, increase_type = 'percent', increase_value = 50` (set via `update public.contracts`).
- F: unit 400 in A's property, `start_date` = 13 months ahead (future).
- E: unit 500 in A's property, state `active` but `end_date` = last month (expired-but-active).
- X: unit 600 in A's property, `archived_at = now()`.
- T: unit 900 in A's property, state `terminated`.
- C: unit 250 in B's property with a `concessions` row of type `free_months`, `free_months = 12`, `start_date = start of this month` (see `period_in_free_months` in migration 139 for the columns it reads).

Assert on `select * from public.get_property_monthly_rent_totals()` (as a user holding `properties.read`, helper copied from `moduleSummaries.sqltest.ts`):
- A: `300 + 300 + 150 = 750`. B: `200 + 200 = 400` (C excluded as a free month).
- `get_property_monthly_rent_totals((current month − 12 months))` → A includes R at base `100` (before its anniversary, after its start).
- `get_property_monthly_rent_totals(null)` equals the no-argument call.
- S's original property absent; `has_function_privilege('anon', …)` false; a user without `properties.read` → `captureRaise` matches /Permission denied/.

- [ ] **Step 2: Run** `TEST_DB_CONTAINER=danat-sqltest-c TEST_DB_PORT=55330 bun run test:sql -- src/db/propertyMonthlyRentTotals.sqltest.ts` — Expected: FAIL.

- [ ] **Step 3: Write the migration**

```sql
-- 204_property_monthly_rent_totals_rpc.sql
--
-- المستحق تحصيله هذا الشهر لكل مبنى: العقود النشطة داخل مدتها، خارج الأشهر
-- المجانية، بسعر الفترة لا بالإيجار الأساسي.
--
-- /admin/properties needs "what this building should collect this month".
-- contract_units.monthly_amount is BASE rent; a contract past its increase
-- anniversary bills more (196), and the only correct pricer,
-- contract_unit_period_amounts, is service_role-only. This definer function
-- applies the generator's own eligibility (active, unarchived, term covers the
-- month, not a free month) then sums that pricer per building. Rent only —
-- recurring extra charges were excluded by decision. A NULL period is the
-- current month: a SQL default covers only an OMITTED argument.

create or replace function public.get_property_monthly_rent_totals(
  p_period_start date default date_trunc('month', current_date)::date
)
returns table (property_id uuid, monthly_total numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_period date := coalesce(p_period_start, date_trunc('month', current_date)::date);
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'properties.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  select u.property_id, round(sum(upa.monthly_amount), 3)
    from public.contracts c
    cross join lateral public.contract_unit_period_amounts(c.id, v_period) upa
    join public.units u on u.id = upa.unit_id
   where c.state = 'active'
     and c.archived_at is null
     and v_period >= date_trunc('month', c.start_date)::date
     and v_period <= date_trunc('month', c.end_date)::date
     and not public.period_in_free_months(c.id, v_period)
   group by u.property_id;
end;
$$;

revoke execute on function public.get_property_monthly_rent_totals(date) from public, anon;
grant execute on function public.get_property_monthly_rent_totals(date) to authenticated, service_role;
```

The wrapper executes as its owner, who owns `contract_unit_period_amounts`, so the `service_role`-only grant on the inner pricer is not a problem; do not widen that grant.

- [ ] **Step 4: Run** `TEST_DB_CONTAINER=danat-sqltest-c TEST_DB_PORT=55330 bun run test:db && TEST_DB_CONTAINER=danat-sqltest-c TEST_DB_PORT=55330 bun run test:sql -- src/db/propertyMonthlyRentTotals.sqltest.ts` — Expected: PASS.

---

### Task 2: Cards in code order, the pill, the card component, invalidation

**Files:** modify `src/hooks/useProperties.ts`, `src/routes/admin.properties.index.tsx`, `src/integrations/supabase/database.types.ts`, `src/i18n/dictionary.ts`, `src/hooks/useContracts.ts` (`useSaveContractWithUnits` `onSuccess`/after-mutation invalidations), the close-out submit mutation (grep `close_out_contract` in `src/hooks`/`src/fns` callers), `src/components/admin/contracts/ConcessionsDialog.tsx` (its save mutation); create `src/components/admin/properties/PropertyCard.tsx`; tests `src/hooks/useProperties.test.ts`, `src/components/admin/properties/PropertyCard.test.tsx`, `src/routes/admin.properties.test.tsx` (static markup with the Supabase client stubbed).

**Interfaces (produces):** `usePropertyMonthlyTotals(periodStart: string, enabled?: boolean): UseQueryResult<Map<string, number>>`; `currentPeriodStart(): string` (`YYYY-MM-01` in Asia/Kuwait) in `src/lib/periodStart.ts`; `PropertyCard` props `{ property; monthlyTotal: number | undefined; totalsError: boolean; locale; t; canUpdate; canDelete; onOpen; onEdit; onDelete }`.

- [ ] **Step 1: Write the failing tests**
  - `useProperties.test.ts`: `propertyMonthlyTotalsQuery("2026-09-01")()` calls `rpc("get_property_monthly_rent_totals", { p_period_start: "2026-09-01" })` and maps `"750.000"` → `750`; `fetchProperties` orders by `("code", { ascending: true })`.
  - `PropertyCard.test.tsx`: `monthlyTotal: 750` → pill with `750`; `monthlyTotal: 0` → pill with `0` (a zero pill is rendered, not hidden); `monthlyTotal: undefined, totalsError: false` → no pill; `totalsError: true` → the `common.error` line, no pill.
  - Route test: with the RPC stub returning rows for one of two buildings, the second building's card gets `monthlyTotal: 0`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — order clause `.order("code", { ascending: true })`; `propertyMonthlyTotalsQuery(periodStart)` + `usePropertyMonthlyTotals(periodStart, enabled)` with key `["property-monthly-totals", periodStart]`; route computes `const periodStart = currentPeriodStart()` once per render via `useMemo`, and passes `monthlyTotal={totals.isSuccess ? (totals.data.get(property.id) ?? 0) : undefined}` and `totalsError={totals.isError}`. `PropertyCard` moves the JSX of `admin.properties.index.tsx:371-433` verbatim and adds under the occupancy toggle:

```tsx
{totalsError ? (
  <p className="text-xs text-destructive">{t("common.error")}</p>
) : monthlyTotal != null ? (
  <div data-testid="monthly-pill" className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white">
    <span>{t("properties.monthlyToCollect")}</span>
    <LtrText>{formatKwd(monthlyTotal, locale)}</LtrText>
  </div>
) : null}
```

  Types entry: `get_property_monthly_rent_totals: { Args: { p_period_start?: string | null }; Returns: Array<{ property_id: string; monthly_total: number }> }`. Invalidation: add `queryClient.invalidateQueries({ queryKey: ["property-monthly-totals"] })` beside the existing invalidations in `useSaveContractWithUnits`, the close-out submit mutation, and the concessions save mutation. i18n: `properties.monthlyToCollect` = "المستحق شهرياً" / "Monthly to collect".
- [ ] **Step 4: Run** `bun run test && bun run typecheck && wc -l src/routes/admin.properties.index.tsx` — Expected: PASS, route < 600 lines.

---

### Task 3: `isReady`, portal flags, gates and the reminder popup

**Files:** modify `src/hooks/useCardVisibility.ts`, `src/lib/cardRegistry.ts`, `src/routes/portal.tsx` (~`:330`), `src/routes/portal.index.tsx:145`, `src/routes/portal.lease.tsx:150-195`, `src/i18n/dictionary.ts`; create `src/components/portal/ReminderPopupDialog.tsx`; tests `src/hooks/useCardVisibility.test.ts`, `src/lib/cardRegistry.test.ts`, `src/components/portal/ReminderPopupDialog.test.tsx`, `src/routes/portal.index.test.tsx`, `src/routes/portal.lease.test.tsx` (create if absent; read how other route tests stub the Supabase client and `useCompany`, e.g. grep `vi.mock("@/integrations/supabase/client"` under `src/routes`).

**Interfaces (produces):** `useCardVisibility()` returns `{ isCardVisible, isLoading, isReady, error }` where `isReady = company.isSuccess && query.isSuccess`.

- [ ] **Step 1: Write the failing tests**
  - `useCardVisibility.test.ts` (renderHook-equivalent via a tiny test component under `QueryClientProvider`, Supabase stubbed): pending → `isReady false`; rejected `card_visibility` read → `isReady false` and `isCardVisible(...)` true (admin default preserved); success → `isReady true`.
  - `cardRegistry.test.ts`: `cardsByPage().at(-1)` is `portal` with ids `["portal.reminderPopup","portal.messageCompose","portal.leaseConcessions"]`.
  - `ReminderPopupDialog.test.tsx` (real hook, Supabase stub, `QueryClientProvider`, jsdom + createRoot): pending → nothing; rejected read → nothing; success + row `is_visible=false` → nothing; success + no row → dialog with the Arabic sentence inside the element referenced by `aria-describedby`; dismissing writes `sessionStorage["portal.reminderPopup.dismissed:tenant-1"]="1"` and a fresh mount reads it and renders nothing; a `sessionStorage` whose `getItem` throws still shows the dialog.
  - `portal.index.test.tsx` / `portal.lease.test.tsx`: flag off → `TenantMessageForm` / the concessions `SectionCard` absent; pending → absent; on → present.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**
  - `useCardVisibility.ts`: add `isReady: company.isSuccess && query.isSuccess` to the returned object (doc comment explains the fail-closed use by the portal).
  - `cardRegistry.ts`: `"portal"` in `CardPage`; three definitions with labelKeys `settings.cards.portal.reminderPopup`, `.messageCompose`, `.leaseConcessions`; `CARD_PAGE_LABEL_KEYS.portal = "settings.cards.portal"`.
  - `ReminderPopupDialog.tsx` (props `{ tenantId: string }`):

```tsx
/**
 * نافذة تذكير حمراء تظهر مرة لكل تبويب متصفح لكل مستأجر، ما لم يُخفِها المسؤول.
 *
 * Fails closed: nothing renders until the flag read succeeded (`isReady`), so
 * a network error can never surface a popup the office switched off.
 * sessionStorage is tab-scoped and survives reloads; the tenant id in the key
 * keeps one login's dismissal from hiding it for the next. A throwing store
 * means "not dismissed".
 */
export function ReminderPopupDialog({ tenantId }: { tenantId: string }) {
  const { t } = useI18n();
  const { isCardVisible, isReady } = useCardVisibility();
  const key = `portal.reminderPopup.dismissed:${tenantId}`;
  const [dismissed, setDismissed] = useState(() => readDismissed(key));
  if (!isReady || dismissed || !isCardVisible("portal.reminderPopup")) return null;
  const dismiss = () => { writeDismissed(key); setDismissed(true); };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) dismiss(); }}>
      <DialogContent className="border-2 border-red-600 bg-red-50 text-red-900 dark:bg-red-950/70 dark:text-red-100 animate-fade-in motion-reduce:animate-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-6 animate-pulse text-red-600 motion-reduce:animate-none" />
            {t("portal.reminder.title")}
          </DialogTitle>
          <DialogDescription className="text-base font-semibold leading-relaxed text-red-900 dark:text-red-100">
            {t("portal.reminder.body")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button className="bg-red-600 hover:bg-red-700" onClick={dismiss}>{t("portal.reminder.understood")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

    with `readDismissed(key)` / `writeDismissed(key)` helpers wrapping `sessionStorage` in try/catch (Arabic doc comments). Mount `<ReminderPopupDialog tenantId={tenant.id} />` in `portal.tsx` right after `<AnnouncementBanner />` (the layout already resolves the tenant; read how it does).
  - Gates: `const flags = useCardVisibility();` then `{flags.isReady && flags.isCardVisible("portal.messageCompose") ? <TenantMessageForm tenantId={tenant.id} /> : null}` in `portal.index.tsx`; same shape around the concessions `SectionCard` in `portal.lease.tsx` with `"portal.leaseConcessions"`.
  - i18n (both locales): `settings.cards.portal` ("بوابة المستأجر" / "Tenant portal"), `settings.cards.portal.reminderPopup` ("نافذة تذكير وزارة الكهرباء" / "Ministry of Electricity reminder popup"), `settings.cards.portal.messageCompose` ("إدارة الرسائل (إرسال رسالة)" / "Message management (compose)"), `settings.cards.portal.leaseConcessions` ("فترات السماح والخصومات" / "Free periods and discounts"), `portal.reminder.title` ("تنبيه" / "Reminder"), `portal.reminder.body` (ar: `يرجى مراجعة مكتب شؤون المستهلكين لوزارة الكهرباء والماء وسداد جميع المبالغ المستحقة.` / en: `Please visit the Consumer Affairs Office of the Ministry of Electricity and Water and settle all outstanding amounts.`), `portal.reminder.understood` ("فهمت" / "Understood").
- [ ] **Step 4: Run** `bun run test && bun run typecheck` — Expected: PASS.

---

### Task 4: Landing hero title fades in

**Files:** create `src/components/landing/HeroTitle.tsx`; modify `src/styles.css` (`@theme`), `src/routes/index.tsx:729-731`; test `src/components/landing/HeroTitle.test.tsx`.

- [ ] Test (`renderToStaticMarkup`): exactly one `<h1`, containing the title text, class list contains `animate-fade-in-slow` and `motion-reduce:animate-none`, and no `animate-pulse` cursor span.
- [ ] Implement: `HeroTitle({ title })` renders the `<h1>` with the classes currently at `index.tsx:729` plus `animate-fade-in-slow motion-reduce:animate-none` (drop `min-h-[1.15em]`); `styles.css` adds `--animate-fade-in-slow: landing-fade-in 1.2s ease-out both;`; `index.tsx` mounts `<HeroTitle title={heroTitle} />` in place of the H1 block; the subtitle `TypedText` stays.
- [ ] Run `bun run test -- src/components/landing/HeroTitle.test.tsx && bun run typecheck && bun run lint`.

---

### Task 5: Migration 205 — revoke the tenant-role payments tab

**Files:** create `db/migrations/205_revoke_tenant_payments_tab.sql`; tests `src/db/revokeTenantPaymentsTab.sqltest.ts`, `src/lib/portalTabs.test.ts` (extend/create).

- [ ] **Step 1: Write the failing tests**

```ts
const MIGRATION = readFileSync("db/migrations/205_revoke_tenant_payments_tab.sql", "utf8");
test("the fresh build already lacks the row, and replaying the file removes a re-inserted one leaving every other tenant grant identical", async () => {
  await withRollback(async (client) => {
    const baseline = await client.query(`select permission_code from public.role_permissions where role = 'tenant' order by 1`);
    expect(baseline.rows.map((r) => r.permission_code)).not.toContain("portal.tab_payments");
    await client.query(`insert into public.role_permissions (role, permission_code) values ('tenant', 'portal.tab_payments')`);
    await client.query(MIGRATION);
    await client.query(MIGRATION);
    const after = await client.query(`select permission_code from public.role_permissions where role = 'tenant' order by 1`);
    expect(after.rows).toEqual(baseline.rows);
    expect((await client.query(`select 1 from public.permissions where code = 'portal.tab_payments'`)).rowCount).toBe(1);
  });
});
```

`portalTabs.test.ts`: with a role set lacking `portal.tab_payments`, `isPortalTabVisible(paymentsTab, { portal_tab_payments: null }, roles)` is false, `true` override → true, `false` → false.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Write the migration**

```sql
-- 205_revoke_tenant_payments_tab.sql
--
-- إخفاء تبويب «مدفوعاتي» افتراضياً عن المستأجرين بسحب صلاحيته من دور المستأجر.
--
-- Every production tenant is on "inherit" (checked 2026-09-14: 57 null, 0
-- true, 0 false), so removing the role default hides the tab for all of them
-- while keeping the tri-state override (an admin can still force-show one
-- tenant) and the permission row (Settings → Roles can grant it back).
-- Data-only, idempotent. Runs after 46 under the harness's numeric order.

delete from public.role_permissions
 where role = 'tenant'::public.app_role
   and permission_code = 'portal.tab_payments';
```

- [ ] **Step 4: Run** `TEST_DB_CONTAINER=danat-sqltest-c TEST_DB_PORT=55330 bun run test:db && TEST_DB_CONTAINER=danat-sqltest-c TEST_DB_PORT=55330 bun run test:sql && bun run test -- src/lib/portalTabs.test.ts` — Expected: PASS, whole SQL suite.

---

### Task 6: Orchestrator gates and guards

- [ ] `bun run lint && bun run typecheck && bun run test` and the isolated `test:db`/`test:sql` on the assembled branch.
- [ ] `clean-code-guard`, `test-guard`, `docs-guard` (migration headers, i18n).

### Task 7: Orchestrator release sequence (definition of done)

- [ ] `pg_dump` baseline on the server.
- [ ] Deliver 204 and 205 from the reviewed branch (chunked base64, md5 checked against the local files), apply with `psql -v ON_ERROR_STOP=1`, `notify pgrst, 'reload schema'`.
- [ ] Verify on production: `has_function_privilege` anon=false/authenticated=true for the RPC; `select * from get_property_monthly_rent_totals()` returns rows; the tenant-role payments row is gone; re-check `select count(*) filter (where portal_tab_payments = true) from tenants` is 0 (a `true` override would keep the tab for that tenant — report it if not 0).
- [ ] Merge; watch the container swap; load `/admin/properties` (pill present, cards in code order) and a portal (popup shows; payments tab absent) — via REST/log checks and one screenshot if a browser is available.

## Debate — round 1 (Codex astra 6 high, read-only relay; tree verified unchanged)

| # | Finding | Sev | Verdict | Reason |
|---|---------|-----|---------|--------|
| 1 | "Monthly to collect" ignored term dates and free months | P1 | accept | Defined as collectible this month; term + `period_in_free_months` filters; fixtures for future/expired-active/archived/terminated/free (Task 1). |
| 2 | NULL period bypasses the anniversary comparison | P2 | accept | `coalesce` to current month; NULL test. |
| 3 | Flag read failures un-hide admin-hidden sections | P2 | accept | `isReady` (success only); portal gates and popup fail closed; tests for rejected reads. |
| 4 | Zero rent and broken loading looked identical | P2 | accept | Missing → 0 after success; error line on failure; route test. |
| 5 | No freshness for totals | P2 | accept | Month in key + RPC arg; invalidation in the three mutations. |
| 6 | sessionStorage lifetime misdescribed | P2 | accept | Per tab per tenant, keyed by tenant id; throwing store shows; remount test. |
| 7 | Instruction not in the accessible description | P2 | accept | `DialogDescription`. |
| 8 | Portal tests mocked the hook | P2 | accept | Real hook under `QueryClientProvider`, Supabase stubbed; route gating tests created. |
| 9 | H1 test could pass with the feature absent | P2 | accept | `HeroTitle` component rendered and asserted; SEO/a11y claim dropped. |
| 10 | Parallel branches share the SQL container | P2 | accept | `TEST_DB_CONTAINER=danat-sqltest-c TEST_DB_PORT=55330` in every SQL command. |
| 11 | Payments test repaired the DB before checking | P2 | accept | Baseline-absent assertion first; complete grant-set equality; `isPortalTabVisible` resolution test; prod `true`-override check in Task 7. |
| 12 | Release sequence missing from the checklist | P1 | accept | Task 7. |

## Self-review

- Spec coverage: T4 (Tasks 1–2), T6 (3), T7 (4), T8 (5), release (7).
- Placeholders: none. Hook names for invalidation are located by grep instruction, not guessed.
- Type consistency: RPC name/columns identical across Task 1 SQL, Task 2 hook and types; flag ids identical in registry, gates and tests; `isReady` used identically in popup and gates.
