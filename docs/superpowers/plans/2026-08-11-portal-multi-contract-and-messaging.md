# Portal Multi-Contract & Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tenant portal work correctly for tenants holding several contracts, add an admin-controlled announcement banner, make manual tenant messages resolve live data with a preview, add bulk messaging, and fix the contract/tenant CSV exports so multi-contract data is not collapsed or dropped.

**Architecture:** Contract selection lives in the URL (`?contract=<uuid>`) alongside the existing `?tenant=`, so one mechanism serves all four portal pages and makes cross-page navigation ("Pay Now" → invoices with the contract preselected) a `search` prop rather than shared state. Invoice filtering happens in SQL, inside `evaluate_portal_payable_invoices`, because the pay-oldest-first lock is computed there and filtering the returned array client-side would silently let a tenant skip another contract's arrears. Manual messaging gains one server-side variable resolver that both the preview and the send call, so a correct preview cannot coexist with an empty send. CSV row-building moves out of the route components into pure modules so it can be unit tested.

**Tech Stack:** TanStack Start (React 19) + Nitro, TanStack Query, self-hosted Supabase (Postgres 17 + PostgREST), Tailwind CSS 4 + shadcn/ui (Radix), react-hook-form + Zod, Vitest, Bun.

---

## Global Constraints

Every task's requirements implicitly include this section. Violating any of these fails
review regardless of whether the feature works.

- **File ceiling: 500–600 lines.** Split by responsibility when a file you are editing
  passes it. `src/routes/admin.contracts.tsx` is ~1470 lines and is named in `CLAUDE.md`
  as a known offender to split when next touched — Lane D touches it.
- **Every function gets a doc comment *above* it, leading with an Arabic description.**
  English may follow for the *why*. Arabic is the product's primary language.
  Example shape:
  ```ts
  /**
   * يُرجع عقود المستأجر غير المؤرشفة، الأحدث أولاً.
   *
   * Archived contracts are excluded everywhere else in this codebase
   * (migration 82); the portal must not be the one place they reappear.
   */
  ```
- **i18n parity is test-enforced.** `src/i18n/dictionary.test.ts` fails `bun run test` if
  a key exists in only one locale, and asserts every `t("literal")` in the codebase
  resolves. **Every new string needs both `ar` and `en` entries in
  `src/i18n/dictionary.ts`.**
- **`src/integrations/supabase/database.types.ts` is hand-maintained** despite looking
  generated. Edit it by hand. Never overwrite it with `bun run gen:types` output.
- **`src/routeTree.gen.ts` is generated.** Never edit it.
- **Archived contracts (`archived_at is not null`) are excluded** from every query added
  by this plan.
- **Migrations are manual SQL** in `db/migrations/`, numbered. A `security definer`
  function's identity is `(name, arg types)` — changing the argument list requires
  `drop function if exists` **first**, or you create an overload and leave the old body
  live. Revokes must name **both** `public` and `anon`.
- **Money paths (`src/fns/`) are tested next to the code.** `createServerFn`'s test mock
  skips `.validator()`, so a Zod schema asserted only through a server-fn test never runs
  — export the schema and assert against it directly.
- **Never commit `.env`; never put a secret in a `VITE_`-prefixed variable** (those are
  compiled into the browser bundle).
- **Gates before presenting any task:** `bun run lint`, `bun run typecheck`,
  `bun run test`. SQL tasks additionally run `bun run test:db`.
- **Only one lane may run `bun run test:db` at a time** — the `danat-sqltest` Docker
  container is shared and is not isolated by git worktrees.
- **Never force-push, rebase, amend, or squash** commits already pushed. The repo is
  Lovable-connected.

### Facts you must not re-derive incorrectly

- `invoices.contract_id` is `not null`. Invoice → contract is exact.
- `payments` has **no** `contract_id`. A payment reaches a contract only through
  `payment_allocations → invoices → contract_id`, and one payment may span two contracts.
- `renderTemplate` leaves unknown `{{keys}}` verbatim by design. Do not change that.
- `exportRecordsToCsv(rows, filename, locale = "en")` — the third argument is optional and
  both existing call sites omit it. That is why Arabic CSV headers have never applied.

---

## Lane Map (for parallel execution)

Four lanes, partitioned by **file ownership** so parallel agents cannot collide. Lanes are
independent; tasks *within* a lane are sequential.

| Lane | Scope | Owns |
| ---- | ----- | ---- |
| **A** | Portal multi-contract + Pay Now dropdown + portal responsiveness | `src/routes/portal*.tsx`, `src/hooks/usePortalData.ts`, `src/hooks/usePortalInvoices.ts`, `src/components/portal/**`, `db/migrations/121_*`, `src/db/portalPayable*` |
| **B** | Announcement banner | `db/migrations/122_*`, `src/routes/admin.settings.index.tsx`, `src/components/portal/AnnouncementBanner.tsx`, the header slot in `src/routes/portal.tsx` |
| **C** | Live-variable messaging + preview + bulk send | `src/fns/resolveTemplateVariables.ts`, `src/fns/sendNotification.ts`, `src/fns/sendBulkNotification.ts`, `src/components/admin/SendManualMessageDialog.tsx`, `MessagePreviewPanel.tsx`, `SendBulkMessageDialog.tsx`, `src/routes/admin.settings.notifications.tsx` |
| **D** | CSV exports | `src/lib/contractCsv.ts`, `src/lib/tenantCsv.ts`, `src/lib/csvHeaders.ts`, export blocks in `src/routes/admin.contracts.tsx` and `src/routes/admin.tenants.index.tsx` |

**Shared file — `src/i18n/dictionary.ts`.** Every lane adds keys to it. Each lane appends
its keys under a clearly commented block for its own feature; conflicts are append-only
and resolve trivially. **Responsiveness is not a lane** — it is an acceptance criterion
inside Lanes A and B, on files they already own.

---

# LANE A — Portal multi-contract

### Task A1: SQL — contract-scoped payable invoices

**Files:**
- Create: `db/migrations/121_portal_payable_by_contract.sql`
- Create: `src/db/portalPayableByContract.sqltest.ts`
- Modify: `src/db/portalPayableSignature.structure.test.ts`
- Modify: `src/integrations/supabase/database.types.ts` (RPC entry, by hand)

**Interfaces:**
- Consumes: nothing.
- Produces: `evaluate_portal_payable_invoices(p_tenant_id uuid, p_contract_id uuid default null)`
  returning the **unchanged** row type
  `(invoice_id uuid, period_year int, period_month int, total numeric, paid numeric, balance numeric, state text, is_overdue boolean, sequence_order int, is_selectable boolean, lock_reason text)`.

- [ ] **Step 1: Read the current live definition**

The live body is in `db/migrations/97_portal_payable_and_reapply_align.sql`, section 1
(functions supersede by *highest migration number*, not by filename order). Read the whole
function. Migration 121 copies that body and changes only what this task names.

- [ ] **Step 2: Write the failing SQL test**

Create `src/db/portalPayableByContract.sqltest.ts`, following the structure of the
existing `src/db/invoiceRegeneration.sqltest.ts` (same harness, same connection helper).
Seed one tenant with **two** contracts, each with unpaid invoices, then assert:

```ts
// 1. Null contract → today's behaviour: every unpaid invoice of the tenant.
const all = await rpc("evaluate_portal_payable_invoices", { p_tenant_id: tenantId });
expect(all.rows).toHaveLength(4);

// 2. Filtered → only that contract's invoices.
const filtered = await rpc("evaluate_portal_payable_invoices", {
  p_tenant_id: tenantId,
  p_contract_id: contractB,
});
expect(filtered.rows.map((r) => r.invoice_id).sort()).toEqual(contractBInvoiceIds.sort());

// 3. sequence_order renumbers WITHIN the filtered set, starting at 1.
expect(filtered.rows.map((r) => r.sequence_order)).toEqual([1, 2]);

// 4. The oldest row of the filtered set is selectable even though an OLDER
//    invoice of the other contract is still unpaid. This is the whole point.
expect(filtered.rows[0].is_selectable).toBe(true);

// 5. A contract belonging to a different tenant is rejected, not silently ignored.
await expect(
  rpc("evaluate_portal_payable_invoices", {
    p_tenant_id: tenantId,
    p_contract_id: otherTenantsContract,
  }),
).rejects.toThrow(/does not belong/i);
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
bun run test:db          # provisions/refreshes the Postgres container
bun run test:sql
```
Expected: FAIL — the 2-argument function does not exist yet (PostgREST/psql reports no
function matching the argument types).

- [ ] **Step 4: Write the migration**

Create `db/migrations/121_portal_payable_by_contract.sql`. Open it with a comment block
explaining *why* the drop is mandatory — this repo's migrations carry that reasoning:

```sql
-- 121_portal_payable_by_contract.sql
--
-- evaluate_portal_payable_invoices gains an optional p_contract_id so the
-- tenant portal can show, and gate payment on, one contract at a time.
--
-- *** SIGNATURE CHANGE — THE OLD FORM MUST DROP FIRST. ***
-- A function's identity is (name, argument types). `create or replace` with a
-- new argument list creates an OVERLOAD and leaves migration 97's 1-arg body
-- live, still serving every existing call. Same case as migration 97 itself.
--
-- Why the filter is in SQL and not in the client: sequence_order and
-- is_selectable implement pay-oldest-first, and portal.invoices.tsx enforces a
-- prefix rule over the returned rows. Filtering the array client-side would
-- keep tenant-wide ordering while applying the prefix rule to a subset, which
-- lets a tenant pay contract B's May while contract A's January is unpaid.
-- That is a silent change to a money path.
--
-- Body copied from db/migrations/97_portal_payable_and_reapply_align.sql
-- section 1 (the highest-numbered, therefore live, definition).

drop function if exists public.evaluate_portal_payable_invoices(uuid);

create or replace function public.evaluate_portal_payable_invoices(
  p_tenant_id uuid,
  p_contract_id uuid default null
)
returns table (
  invoice_id uuid,
  period_year integer,
  period_month integer,
  total numeric,
  paid numeric,
  balance numeric,
  state text,
  is_overdue boolean,
  sequence_order integer,
  is_selectable boolean,
  lock_reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_tenant_id is null then
    raise exception 'Tenant is required';
  end if;

  -- Auth guard: re-stated verbatim from migration 97. Adding a parameter must
  -- not widen who may call this.
  if auth.role() = 'authenticated' and not (
    public.is_staff(auth.uid()) or (
      public.has_role(auth.uid(), 'tenant') and exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.tenant_id = p_tenant_id
      )
    )
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'Tenant not found';
  end if;

  -- A contract id from another tenant raises rather than quietly returning
  -- nothing: silence would read to the caller as "this contract has no
  -- invoices", which is a different and misleading answer.
  if p_contract_id is not null and not exists (
    select 1 from public.contracts c
    where c.id = p_contract_id and c.tenant_id = p_tenant_id
  ) then
    raise exception 'Contract does not belong to this tenant'
      using errcode = '42501';
  end if;

  -- ... migration 97's body, with TWO changes:
  --   (a) the invoice scan gains:
  --         and (p_contract_id is null or i.contract_id = p_contract_id)
  --   (b) sequence_order is row_number() over the FILTERED, ordered set, so it
  --       restarts at 1 within a contract.
end;
$$;

-- Migration 96's lesson: `from public` alone misses an explicit anon grant and
-- `from anon` alone misses a PUBLIC grant. Name both.
revoke all on function public.evaluate_portal_payable_invoices(uuid, uuid) from public, anon;
grant execute on function public.evaluate_portal_payable_invoices(uuid, uuid)
  to authenticated, service_role;
```

Fill `-- ...` with migration 97's actual body text. Do not paraphrase it — copy it and
apply exactly changes (a) and (b).

- [ ] **Step 5: Verify from a clean database**

```bash
bun run test:db
bun run test:sql
```
Expected: PASS. `test:db` builds from scratch — that is the only run that proves the whole
set applies. Never verify by replaying all migrations against an already-migrated database;
that fails on `identify_contract_expiry_reminders` (its OUT row type changes across
07/31/33 and `create or replace` cannot do that).

- [ ] **Step 6: Assert the overload is gone**

Extend `src/db/portalPayableSignature.structure.test.ts` with a case asserting exactly one
`evaluate_portal_payable_invoices` exists and its argument list is `(uuid, uuid)`:

```ts
it("has no leftover 1-argument overload", async () => {
  const rows = await query(`
    select pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'evaluate_portal_payable_invoices'
  `);
  expect(rows.map((r) => r.args)).toEqual(["uuid, uuid"]);
});
```

- [ ] **Step 7: Hand-edit `database.types.ts`**

Find the `evaluate_portal_payable_invoices` entry (around line 1736) and change `Args`:

```ts
Args: { p_tenant_id: string; p_contract_id?: string | null };
```

Leave `Returns` untouched — the row type did not change.

- [ ] **Step 8: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add db/migrations/121_portal_payable_by_contract.sql \
        src/db/portalPayableByContract.sqltest.ts \
        src/db/portalPayableSignature.structure.test.ts \
        src/integrations/supabase/database.types.ts
git commit -m "feat(portal): scope payable-invoice evaluation to one contract"
```

---

### Task A2: Contract list and selection hooks

**Files:**
- Modify: `src/hooks/usePortalData.ts`
- Create: `src/hooks/usePortalContractSelection.ts`
- Create: `src/hooks/usePortalContractSelection.test.ts`
- Create: `src/lib/portalContractLabel.ts`
- Create: `src/lib/portalContractLabel.test.ts`

**Interfaces:**
- Consumes: nothing from A1 (independent).
- Produces:
  ```ts
  export interface PortalContractOption {
    id: string;
    code: string;
    type: ContractType;
    state: ContractState;
    start_date: string;
    end_date: string;
    monthly_amount: number;
    unitCodes: string[];
  }
  export function usePortalContracts(tenantId: string | null): UseQueryResult<PortalContractOption[]>;
  export function usePortalContractSelection(): { contractId: string | null; setContractId(next: string | null): void };
  export function portalContractLabel(contract: PortalContractOption, locale: "ar" | "en"): string;
  ```

- [ ] **Step 1: Write the failing label test**

`src/lib/portalContractLabel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { portalContractLabel } from "@/lib/portalContractLabel";

const base = {
  id: "c1", code: "CTR-001", type: "residential", state: "active",
  start_date: "2026-01-01", end_date: "2026-12-31", monthly_amount: 300,
} as const;

describe("portalContractLabel", () => {
  it("shows the units then the code in brackets", () => {
    expect(portalContractLabel({ ...base, unitCodes: ["U-1", "U-2"] }, "en"))
      .toBe("U-1, U-2 (CTR-001)");
  });

  it("falls back to the code alone when a contract has no units", () => {
    expect(portalContractLabel({ ...base, unitCodes: [] }, "en")).toBe("CTR-001");
  });

  it("joins with the Arabic comma in Arabic", () => {
    expect(portalContractLabel({ ...base, unitCodes: ["U-1", "U-2"] }, "ar"))
      .toBe("U-1، U-2 (CTR-001)");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
bun run test src/lib/portalContractLabel.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the label**

`src/lib/portalContractLabel.ts`:

```ts
import type { PortalContractOption } from "@/hooks/usePortalData";

/**
 * يبني عنوان العقد المعروض في قائمة البوابة: أسماء الوحدات ثم رمز العقد بين قوسين.
 *
 * The tenant recognises their contract by the unit they live in, not by a code
 * they have never seen — so units lead and the code disambiguates. A contract
 * with no units is a data state that exists (units removed mid-term), and it
 * must still be selectable rather than rendering an empty row.
 */
export function portalContractLabel(
  contract: PortalContractOption,
  locale: "ar" | "en",
): string {
  if (!contract.unitCodes.length) return contract.code;
  const separator = locale === "ar" ? "، " : ", ";
  return `${contract.unitCodes.join(separator)} (${contract.code})`;
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
bun run test src/lib/portalContractLabel.test.ts
```
Expected: PASS.

- [ ] **Step 5: Add `usePortalContracts` to `src/hooks/usePortalData.ts`**

Append (do not restructure the existing hooks):

```ts
/** خيار عقد واحد في قائمة اختيار العقود بالبوابة. */
export interface PortalContractOption {
  id: string;
  code: string;
  type: Tables<"contracts">["type"];
  state: Tables<"contracts">["state"];
  start_date: string;
  end_date: string;
  monthly_amount: number;
  unitCodes: string[];
}

/**
 * عقود المستأجر غير المؤرشفة، الأحدث أولاً.
 *
 * Every state, not active-only: an ended contract still owns invoices and
 * payments, and hiding it would hide the tenant's own history from them.
 * Archived contracts are excluded, matching every other path since migration 82.
 */
export function usePortalContracts(tenantId: string | null) {
  return useQuery({
    queryKey: ["portal-contracts", tenantId],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<PortalContractOption[]> => {
      const { data: contracts, error } = await supabase
        .from("contracts")
        .select("id, code, type, state, start_date, end_date, monthly_amount")
        .eq("tenant_id", tenantId!)
        .is("archived_at", null)
        .order("start_date", { ascending: false });
      if (error) throw error;
      if (!contracts.length) return [];

      const { data: links, error: linkError } = await supabase
        .from("contract_units")
        .select("contract_id, unit_id")
        .in("contract_id", contracts.map((contract) => contract.id))
        .order("line_order");
      if (linkError) throw linkError;

      const unitIds = [...new Set(links.map((link) => link.unit_id))];
      const unitCodeById = new Map<string, string>();
      if (unitIds.length) {
        const { data: units, error: unitError } = await supabase
          .from("units").select("id, code").in("id", unitIds);
        if (unitError) throw unitError;
        for (const unit of units) unitCodeById.set(unit.id, unit.code);
      }

      const codesByContract = new Map<string, string[]>();
      for (const link of links) {
        const code = unitCodeById.get(link.unit_id);
        if (!code) continue;
        codesByContract.set(link.contract_id, [
          ...(codesByContract.get(link.contract_id) ?? []),
          code,
        ]);
      }
      return contracts.map((contract) => ({
        ...contract,
        unitCodes: codesByContract.get(contract.id) ?? [],
      }));
    },
  });
}
```

- [ ] **Step 6: Generalize `usePortalLease` to take a contract**

Change its signature to `usePortalLease(tenantId: string | null, contractId?: string | null)`.
Add `contractId ?? null` to the query key. When `contractId` is set, replace the
`.eq("state","active").order(...).limit(1)` selection with `.eq("id", contractId)`; when it
is null keep today's newest-active fallback exactly as it is. Document the fallback in the
Arabic doc comment — it is why the dashboard renders before any selection is made.

Update the two existing call sites (`portal.index.tsx`, `portal.lease.tsx`) in Task A4.

- [ ] **Step 7: Write the failing selection-hook test**

`src/hooks/usePortalContractSelection.test.ts` — mock `@tanstack/react-router`'s
`useSearch` and `useNavigate` the way the repo's other hook tests do:

```ts
it("returns null when no contract is in the URL", () => { /* → contractId === null */ });
it("returns the contract id from ?contract=", () => { /* → contractId === "c1" */ });
it("preserves ?tenant= when changing contract", () => {
  // setContractId("c2") must navigate with search { tenant: "t1", contract: "c2" }
  // Dropping ?tenant makes the portal layout treat a previewing admin as plain
  // staff and bounce them to /admin — the bug portal.index.tsx already guards.
});
it("clears ?contract= when set to null (All contracts)", () => { /* search has no contract key */ });
```

- [ ] **Step 8: Run it and confirm it fails, then implement**

```bash
bun run test src/hooks/usePortalContractSelection.test.ts   # FAIL: module not found
```

`src/hooks/usePortalContractSelection.ts`:

```ts
/**
 * العقد المختار حاليًا في البوابة، مقروءًا من عنوان الصفحة `?contract=`.
 *
 * The URL, not component state: it is what lets "Pay Now" on the dashboard open
 * My Invoices already filtered, and what makes a refresh or a shared link keep
 * the tenant where they were. `null` means "all contracts".
 */
export function usePortalContractSelection() { /* ... */ }
```

The setter must spread the existing search object and delete the `contract` key when
`next` is null, then `navigate({ search: ..., replace: true })`.

- [ ] **Step 9: Run tests and commit**

```bash
bun run test src/hooks src/lib/portalContractLabel.test.ts
bun run lint && bun run typecheck
git add src/hooks/usePortalData.ts src/hooks/usePortalContractSelection.ts \
        src/hooks/usePortalContractSelection.test.ts \
        src/lib/portalContractLabel.ts src/lib/portalContractLabel.test.ts
git commit -m "feat(portal): contract list and URL-backed contract selection"
```

---

### Task A3: ContractSwitcher component + i18n keys

**Files:**
- Create: `src/components/portal/ContractSwitcher.tsx`
- Create: `src/components/portal/ContractSwitcher.test.tsx`
- Modify: `src/i18n/dictionary.ts`

**Interfaces:**
- Consumes: `usePortalContracts`, `usePortalContractSelection`, `portalContractLabel` (A2).
- Produces: `<ContractSwitcher tenantId={string | null} className?={string} />`.

- [ ] **Step 1: Add the i18n keys — both locales**

In `src/i18n/dictionary.ts`, under a `// Portal — multi-contract` comment, add to **both**
the `ar` and `en` objects:

| Key | ar | en |
| --- | -- | -- |
| `portal.contract.label` | `العقد` | `Contract` |
| `portal.contract.all` | `كل العقود` | `All contracts` |
| `portal.contract.none` | `لا توجد عقود` | `No contracts` |
| `portal.contract.select` | `اختر العقد` | `Select a contract` |
| `portal.invoices.contractCode` | `رمز العقد` | `Contract code` |

Missing either side fails `bun run test` via `dictionary.test.ts`.

- [ ] **Step 2: Write the failing component test**

`src/components/portal/ContractSwitcher.test.tsx` — render with a mocked
`usePortalContracts` returning two contracts and assert:
- both labels render as options,
- an "All contracts" option is present,
- choosing one calls `setContractId` with that id,
- when the tenant has **zero** contracts nothing renders (`container` is empty),
- when the tenant has exactly **one** contract the switcher still renders (the tenant
  should see which contract they are looking at, not a mystery page).

- [ ] **Step 3: Run it and confirm it fails**

```bash
bun run test src/components/portal/ContractSwitcher.test.tsx
```

- [ ] **Step 4: Implement**

Use the shadcn `Select` already imported in `portal.tsx`. Requirements:

- Trigger shows `t("portal.contract.label")` and the selected label; renders as a
  prominent **button** (the user asked for a button that opens a dropdown list).
- `min-w-0` on the trigger and `truncate` on its text — a long Arabic contract name must
  not blow out a 360 px viewport.
- `aria-label={t("portal.contract.select")}`.
- Returns `null` when the query is loading or returns no contracts.

- [ ] **Step 5: Run tests and commit**

```bash
bun run test src/components/portal src/i18n
git add src/components/portal/ContractSwitcher.tsx \
        src/components/portal/ContractSwitcher.test.tsx src/i18n/dictionary.ts
git commit -m "feat(portal): contract switcher component"
```

---

### Task A4: Wire the four portal pages

**Files:**
- Modify: `src/routes/portal.index.tsx`
- Modify: `src/routes/portal.lease.tsx`
- Modify: `src/routes/portal.invoices.tsx`
- Modify: `src/routes/portal.payments.tsx`
- Modify: `src/hooks/usePortalInvoices.ts`
- Create: `src/lib/portalPaymentContracts.ts`
- Create: `src/lib/portalPaymentContracts.test.ts`
- Modify: `src/hooks/usePortalData.ts` (payments query returns contract ids)

**Interfaces:**
- Consumes: A1's RPC, A2's hooks, A3's component.
- Produces: `usePortalInvoices(tenantId, contractId)`;
  `PortalPayment` gains `contractIds: string[]`;
  `filterPaymentsByContract(payments, contractId): PortalPayment[]`.

- [ ] **Step 1: Register `?contract=` on the portal layout route**

`src/routes/portal.tsx` — extend `validateSearch` so the param survives navigation:

```ts
validateSearch: (search: Record<string, unknown>): { tenant?: string; contract?: string } => ({
  ...(typeof search.tenant === "string" ? { tenant: search.tenant } : {}),
  ...(typeof search.contract === "string" ? { contract: search.contract } : {}),
}),
```

And extend `linkSearch` so the nav tabs carry the selection between pages:

```ts
const linkSearch = {
  ...(viewTenantId ? { tenant: viewTenantId } : {}),
  ...(contractId ? { contract: contractId } : {}),
};
```

> Lane B also edits `portal.tsx` (header slot). Coordinate: Lane A owns
> `validateSearch`/`linkSearch`, Lane B owns the header `<div>`. They do not overlap.

- [ ] **Step 2: Thread the contract into `usePortalInvoices`**

```ts
/**
 * فواتير البوابة القابلة للدفع، مع إمكانية قصرها على عقد واحد.
 *
 * The contract filter is applied by the RPC, not here: sequence_order and
 * is_selectable implement pay-oldest-first and must be renumbered inside the
 * filtered set, which only the database can do correctly.
 */
export function usePortalInvoices(tenantId: string | null, contractId: string | null = null) {
  return useQuery({
    queryKey: ["portal-invoices", tenantId, contractId],
    enabled: Boolean(tenantId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("evaluate_portal_payable_invoices", {
        p_tenant_id: tenantId!,
        ...(contractId ? { p_contract_id: contractId } : {}),
      });
      if (error) throw error;
      return data;
    },
  });
}
```

- [ ] **Step 3: Write the failing payment→contract test**

`src/lib/portalPaymentContracts.test.ts`:

```ts
const spanning = { id: "p1", contractIds: ["A", "B"] } as PortalPayment;
const single   = { id: "p2", contractIds: ["A"] } as PortalPayment;
const orphan   = { id: "p3", contractIds: [] } as PortalPayment;

it("shows a payment under every contract it settled", () => {
  expect(filterPaymentsByContract([spanning, single], "B").map((p) => p.id)).toEqual(["p1"]);
});

it("hides an unallocated payment from any single-contract view", () => {
  expect(filterPaymentsByContract([orphan], "A")).toEqual([]);
});

it("shows everything, including unallocated payments, when no contract is selected", () => {
  expect(filterPaymentsByContract([spanning, single, orphan], null)).toHaveLength(3);
});
```

- [ ] **Step 4: Run it, confirm it fails, then implement**

`src/lib/portalPaymentContracts.ts`:

```ts
/**
 * يُرشِّح المدفوعات حسب العقد المختار.
 *
 * `payments` carries no contract_id — a payment reaches a contract only through
 * its allocated invoices, and the portal lets one payment settle invoices from
 * two contracts at once. So a spanning payment appears under BOTH contracts:
 * hiding it from one would hide money the tenant actually paid on it. A payment
 * with no allocations belongs to no contract and shows only in the "all" view.
 */
export function filterPaymentsByContract(
  payments: PortalPayment[],
  contractId: string | null,
): PortalPayment[] {
  if (!contractId) return payments;
  return payments.filter((payment) => payment.contractIds.includes(contractId));
}
```

- [ ] **Step 5: Populate `contractIds` in `usePortalPayments`**

The hook already fetches `payment_allocations` and then the allocated invoices. Add
`contract_id` to that invoice `select` (it is currently `"id, period_month, period_year"`)
and build a per-payment `Set<string>` of contract ids in the same loop that builds
`periodsByPayment`. Add `contractIds: string[]` to the `PortalPayment` type.

- [ ] **Step 6: Dashboard — `portal.index.tsx`**

- Render `<ContractSwitcher>` where the unit/period/amount strip is today, styled as the
  prominent button the user asked for.
- Move the unit / contract-period / monthly-amount block **beneath** it.
- `usePortalLease(tenant.id, contractId)`.
- Pay Now:
  ```tsx
  <Link
    to="/portal/invoices"
    search={(prev: Record<string, unknown>) => ({
      ...prev,
      ...(contractId ? { contract: contractId } : {}),
    })}
  >
  ```
  Keep the existing comment about carrying `?tenant=` — it documents a real bug.

- [ ] **Step 7: My Lease — `portal.lease.tsx`**

Put `<ContractSwitcher>` on the same flex line as the `<h1>`
(`flex flex-wrap items-center justify-between gap-3`). Pass `contractId` to
`usePortalLease`. The detail cards already read from `lease.data`, so they follow.

- [ ] **Step 8: My Invoices — `portal.invoices.tsx`**

- `<ContractSwitcher>` on the title line.
- `usePortalInvoices(tenant.id, contractId)`.
- **New contract-code column** on each invoice row. The RPC row type is deliberately
  unchanged, so fetch the mapping separately: query
  `invoices.select("id, contracts(code)").in("id", rowIds)` (or a `contract_id → code`
  lookup built from `usePortalContracts`) and render the code next to the period. On
  mobile it becomes a second line, not a horizontal scroll.
- Clear `selectedIds` whenever `contractId` changes — a selection made under one contract
  must not survive into another, or the tenant pays invoices they can no longer see.

- [ ] **Step 9: My Payments — `portal.payments.tsx`**

Place `<ContractSwitcher>` **between** the `<h1>` block and the Export CSV button, in the
existing `flex flex-wrap items-start justify-between gap-3` header. Filter with
`filterPaymentsByContract`. The CSV export exports the **filtered** rows — what the tenant
sees is what they get — and gains a `contract` column.

- [ ] **Step 10: Responsiveness pass on all four pages**

Baseline **360 × 640**; also check 414 and 768, in **both** `ar` (RTL) and `en` (LTR).

- No horizontal page scroll at 360 px. Wide content scrolls inside its own
  `overflow-x-auto` container.
- Tap targets ≥ 44 px.
- Use logical properties (`ms-`, `me-`, `start-`, `end-`) — a physical `ml-`/`pl-` slip is
  invisible in LTR and wrong in RTL.
- Long Arabic names and unit lists truncate or wrap; they never widen the layout.
- Keep the sticky pay bar's `env(safe-area-inset-bottom)`.

- [ ] **Step 11: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/routes/portal.index.tsx src/routes/portal.lease.tsx \
        src/routes/portal.invoices.tsx src/routes/portal.payments.tsx \
        src/routes/portal.tsx src/hooks/usePortalInvoices.ts src/hooks/usePortalData.ts \
        src/lib/portalPaymentContracts.ts src/lib/portalPaymentContracts.test.ts
git commit -m "feat(portal): contract selection across dashboard, lease, invoices and payments"
```

---

### Task A4b: Forward the contract through `createPayment` — REQUIRED, not optional

**Files:**
- Modify: `src/fns/createPayment.ts`
- Modify: `src/fns/createPayment.test.ts`
- Modify: `src/hooks/useCreatePayment.ts`
- Modify: `src/routes/portal.invoices.tsx` (pass `contractId` into the mutation)

**Why this task exists.** `createPayment.ts:186` re-runs
`evaluate_portal_payable_invoices` server-side with **`p_tenant_id` only**, then at
line 197 does:

```ts
const selectedInvoices = payableQuery.data.slice(0, input.invoiceIds.length);
if (payableQuery.data[0]?.is_selectable !== true ||
    !selectedInvoices.every((invoice) => requestedIds.has(invoice.invoice_id))) {
  throw new Error("Invoices must be paid in chronological order.");
}
```

It validates the selection as a **prefix of the tenant-wide payable list**. So the moment
the portal filters by contract, a tenant selecting contract B's invoices while contract A
has an older unpaid one hits that `every(...)` check and the payment is **rejected**. Every
screen would look correct and the gateway step would fail. Without this task the whole
Lane A feature is dead on arrival.

- [ ] **Step 1: Write the failing test**

In `src/fns/createPayment.test.ts`:

```ts
it("accepts a contract-scoped selection while another contract has older arrears", async () => {
  // tenant with contract A (unpaid Jan) and contract B (unpaid Apr, May)
  // request { invoiceIds: [aprB, mayB], contractId: B } → resolves, does not throw
});

it("still rejects an out-of-order selection within the chosen contract", async () => {
  // request { invoiceIds: [mayB], contractId: B } while aprB is unpaid
  // → throws "Invoices must be paid in chronological order."
});

it("keeps today's tenant-wide ordering when no contract is given", async () => {
  // request { invoiceIds: [aprB] } with no contractId, janA unpaid → throws
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
bun run test src/fns/createPayment.test.ts
```
Expected: FAIL — the first case throws "Invoices must be paid in chronological order."
That failure **is** the bug this task fixes; confirm you see exactly that message before
changing anything.

- [ ] **Step 3: Thread `contractId` through**

- Add `contractId: z.string().uuid().nullable().optional()` to the input schema
  (line ~31, beside `invoiceIds`).
- Pass it into `invoiceSelection({ ... })` and on to the RPC:
  ```ts
  const payableQuery = await input.supabase.rpc("evaluate_portal_payable_invoices", {
    p_tenant_id: input.tenantId,
    ...(input.contractId ? { p_contract_id: input.contractId } : {}),
  });
  ```
- **Leave the prefix check itself untouched.** It is now correct by construction: the RPC
  returns the contract's rows renumbered from 1, so "prefix of the payable list" means
  "prefix of *this contract's* payable list" — which is decision D1, enforced server-side
  rather than trusted from the client.
- The `idempotencyKey` is derived from `tenantId + invoiceIds` and needs no change: the
  invoice ids already differ per contract.

- [ ] **Step 4: Pass it from the portal**

`useCreatePayment` forwards `contractId`; `portal.invoices.tsx` supplies the currently
selected one. Under "All contracts" it is omitted and behaviour is bit-for-bit today's.

- [ ] **Step 5: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/fns/createPayment.ts src/fns/createPayment.test.ts \
        src/hooks/useCreatePayment.ts src/routes/portal.invoices.tsx
git commit -m "fix(payments): validate a contract-scoped invoice selection against that contract"
```

---

### Task A5: Pay Now → payment-method dropdown

**Files:**
- Modify: `src/routes/portal.invoices.tsx`
- Create: `src/components/portal/PayNowMenu.tsx`
- Create: `src/components/portal/PayNowMenu.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `<PayNowMenu disabled pendingMethod onSelect={(method: HostedPaymentMethod) => void} />`.

- [ ] **Step 1: Add i18n keys — both locales**

| Key | ar | en |
| --- | -- | -- |
| `portal.invoices.payNowAction` | `ادفع الآن` | `Pay Now` |
| `portal.invoices.choosePaymentMethod` | `اختر وسيلة الدفع` | `Choose a payment method` |

- [ ] **Step 2: Write the failing test**

`src/components/portal/PayNowMenu.test.tsx`:
- Initially the three method buttons are **not** in the document; one "Pay Now" button is.
- Pressing Pay Now reveals KNET, Google Pay and Apple Pay.
- Choosing one calls `onSelect` with `"KNET"` / `"GOOGLE_PAY"` / `"APPLE_PAY"` — the exact
  strings MyFatoorah v3 expects (the underscore matters).
- `disabled` keeps the menu closed.

- [ ] **Step 3: Run it, confirm it fails, then implement**

Use the shadcn `DropdownMenu`. Move the existing `paymentMethodButtons` array into this
component **unchanged**, including its Arabic doc comment about pinning MyFatoorah's hosted
page to a single provider and about Apple Pay staying listed on every device.

- [ ] **Step 4: Replace the button grid in `portal.invoices.tsx`**

Swap the `grid gap-2 sm:grid-cols-3` block for `<PayNowMenu>`. **`paySelected(method)` is
not modified** — `paymentHandoffFor`, the popup-blocked toast, and `ApplePayQrDialog` all
keep working exactly as they do now. This is a presentation change over working machinery.

- [ ] **Step 5: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/components/portal/PayNowMenu.tsx src/components/portal/PayNowMenu.test.tsx \
        src/routes/portal.invoices.tsx src/i18n/dictionary.ts
git commit -m "feat(portal): pay now opens a payment-method dropdown"
```

---

### Task A6: Username on the profile page

**Files:**
- Modify: `src/routes/portal.profile.tsx`
- Modify: `src/i18n/dictionary.ts`

- [ ] **Step 1: Read the username off the profile**

**Verified:** `profiles.username` exists (`src/integrations/supabase/database.types.ts:1222`,
`string | null`) and is written by `src/fns/createAppUser.ts:72`. `usePortalIdentity`
already loads the whole profile row, so the value is in `identity.data.profile.username`
with no new query.

Render `"—"` when it is null: a tenant created before usernames existed signs in by email,
and a blank card is better than a fabricated value.

- [ ] **Step 2: Add the i18n key — both locales**

`portal.profile.username` → `اسم المستخدم` / `Username`.

- [ ] **Step 3: Add the fifth card**

Append to the `fields` array, before the `changePassword` section. Wrap the value in
`<LtrText>` (`ltr: true`) — a username is Latin text under an Arabic label, and without the
isolate its punctuation reorders. Use a distinct icon (`AtSign`) and tile gradient.

The grid is `sm:grid-cols-2`; five cards leave one hanging. Change to
`sm:grid-cols-2 lg:grid-cols-3` so the row is balanced on a laptop and still stacks on a
phone.

- [ ] **Step 4: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/routes/portal.profile.tsx src/i18n/dictionary.ts
git commit -m "feat(portal): show the sign-in username on the profile page"
```

---

# LANE B — Announcement banner

### Task B1: Migration + admin control

**Files:**
- Create: `db/migrations/122_portal_announcement.sql`
- Modify: `src/integrations/supabase/database.types.ts` (companies columns, by hand)
- Modify: `src/routes/admin.settings.index.tsx`
- Modify: `src/i18n/dictionary.ts`

- [ ] **Step 1: Write the migration**

```sql
-- 122_portal_announcement.sql
--
-- A single scrolling announcement line in the tenant portal header, controlled
-- from admin settings. It lives on `companies` rather than in a new table
-- because there is exactly one active announcement at a time and the portal
-- already loads the company row on every page (useCompany) — a new table would
-- add a query and an RLS policy to carry one string.
--
-- Idempotent: add column if not exists, no drops.

alter table public.companies
  add column if not exists announcement_ar text,
  add column if not exists announcement_en text,
  add column if not exists announcement_enabled boolean not null default false;

comment on column public.companies.announcement_enabled is
  'Master switch for the portal header banner. Off by default so the columns can
   be populated before the banner goes live.';
```

**No RLS work is needed, and none should be added.** Verified: `companies_select_tenant`
(`db/migrations/17_tenant_portal_units_rls.sql:21-28`) already lets a portal tenant read
the company row, and `01_schema_core.sql:49` grants `select` to `authenticated`. Adding a
policy here would widen a boundary this feature does not need widened.

`not null default false` is safe against existing rows and existing inserts: Postgres
backfills the default, and no code path inserts a `companies` row without defaults.

- [ ] **Step 2: Verify from a clean database**

```bash
bun run test:db
```
Expected: PASS. **Coordinate with Lane A** — only one lane runs `test:db` at a time
(shared container).

- [ ] **Step 3: Hand-edit `database.types.ts`**

Add to the `companies` `Row`, `Insert` and `Update` blocks (around lines 1120–1200):

```ts
announcement_ar: string | null;        // Row
announcement_en: string | null;
announcement_enabled: boolean;
announcement_ar?: string | null;       // Insert / Update
announcement_en?: string | null;
announcement_enabled?: boolean;
```

- [ ] **Step 4: Add the i18n keys — both locales**

| Key | ar | en |
| --- | -- | -- |
| `settings.announcement.title` | `شريط الإعلانات` | `Announcement banner` |
| `settings.announcement.description` | `يظهر في أعلى بوابة المستأجر` | `Shown at the top of the tenant portal` |
| `settings.announcement.enabled` | `تفعيل الشريط` | `Enable the banner` |
| `settings.announcement.textAr` | `النص بالعربية` | `Arabic text` |
| `settings.announcement.textEn` | `النص بالإنجليزية` | `English text` |

- [ ] **Step 5: Add the settings card**

In `src/routes/admin.settings.index.tsx`, follow the existing company-settings card
pattern exactly (same form, same mutation, same save button). Three controls: a `Switch`
for `announcement_enabled`, and two `Textarea`s for `announcement_ar` / `announcement_en`.

If the file passes the 500–600 line ceiling with this addition, extract the new card into
`src/components/admin/AnnouncementSettingsCard.tsx` rather than growing the route.

- [ ] **Step 6: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add db/migrations/122_portal_announcement.sql \
        src/integrations/supabase/database.types.ts \
        src/routes/admin.settings.index.tsx src/i18n/dictionary.ts
git commit -m "feat(settings): admin-controlled portal announcement banner"
```

---

### Task B2: The banner itself

**Files:**
- Create: `src/components/portal/AnnouncementBanner.tsx`
- Create: `src/components/portal/AnnouncementBanner.test.tsx`
- Modify: `src/routes/portal.tsx` (header slot only)
- Modify: `src/index.css` (or wherever Tailwind CSS 4 `@theme` / keyframes live — check first)

- [ ] **Step 1: Write the failing test**

`src/components/portal/AnnouncementBanner.test.tsx`, with `useCompany` mocked:

```ts
it("renders nothing when the banner is disabled", () => {
  // announcement_enabled: false, text present → container.firstChild is null
});
it("renders nothing when the active locale's text is blank", () => {
  // enabled, announcement_en: "" , locale "en" → nothing
});
it("renders the Arabic text in Arabic", () => { /* … */ });
it("duplicates the text so the loop is seamless", () => {
  // two nodes with the same text; the second is aria-hidden so a screen reader
  // does not announce the announcement twice
});
it("marks the marquee so reduced-motion stops it", () => {
  expect(track).toHaveClass("motion-reduce:animate-none");
});
```

- [ ] **Step 2: Run it, confirm it fails, then implement**

```tsx
/**
 * شريط إعلانات متحرك في ترويسة البوابة، يتحكم به المسؤول من الإعدادات.
 *
 * The text node is duplicated and the track translated by -50%: that is what
 * makes an infinite marquee seamless without JavaScript measuring anything.
 * The duplicate is aria-hidden so assistive tech announces the message once.
 *
 * Direction follows the UI locale — Arabic scrolls right-to-left, English
 * left-to-right — because a marquee running against the reading direction is
 * read as broken rather than as decoration.
 */
export function AnnouncementBanner() { /* ... */ }
```

Requirements:
- Reads `announcement_enabled` and the locale's text from `useCompany()`. Returns `null`
  when disabled, still loading, or the text is blank/whitespace.
- Two CSS animations, `portal-marquee-rtl` and `portal-marquee-ltr`, chosen by `dir` from
  `useI18n()` — never a hardcoded single direction.
- `motion-reduce:animate-none` on the track, following the idiom already in
  `portal.index.tsx`. With motion reduced, the text sits still and wraps. A marquee that
  ignores `prefers-reduced-motion` is an accessibility defect and, for some vestibular
  conditions, a genuine hazard.
- Bold, high-contrast, accent-coloured — the user asked for it to read as important.
- `role="status"` so a screen reader reports it without stealing focus.
- Pauses on hover/focus (`hover:[animation-play-state:paused]`) so a tenant can actually
  read a long message.

Keyframes (add next to the project's existing Tailwind CSS 4 theme block):

```css
@keyframes portal-marquee-ltr { from { transform: translateX(-50%); } to { transform: translateX(0); } }
@keyframes portal-marquee-rtl { from { transform: translateX(0); } to { transform: translateX(-50%); } }
```

- [ ] **Step 3: Mount it in the portal header**

In `src/routes/portal.tsx`, inside the existing
`<div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">`,
between the logo `<Link>` and the actions `<div>`:

```tsx
<AnnouncementBanner />
```

The banner's own root **must** carry `min-w-0 flex-1 overflow-hidden`. Without `min-w-0` a
flex child refuses to shrink below its content width, and a long announcement pushes the
sign-out button off the right edge of a phone. Verify at 360 px in both directions.

- [ ] **Step 4: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/components/portal/AnnouncementBanner.tsx \
        src/components/portal/AnnouncementBanner.test.tsx \
        src/routes/portal.tsx src/index.css
git commit -m "feat(portal): scrolling announcement banner in the header"
```

---

# LANE C — Messaging

### Task C1: Live variable resolver

**Files:**
- Create: `src/fns/resolveTemplateVariables.ts`
- Create: `src/fns/resolveTemplateVariables.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const resolveVariablesSchema = z.object({
    tenantId: z.string().uuid(),
    templateCode: z.string().trim().max(120).nullable().optional(),
    locale: z.enum(["ar", "en"]).nullable().optional(),
    contractId: z.string().uuid().nullable().optional(),
  });
  export interface ResolvedTemplateCopy {
    variables: Record<string, string>;
    subject: string;
    bodyHtml: string;
    bodyText: string;
    /** Placeholders present in the template that no value was found for. */
    missing: string[];
  }
  export const resolveTemplateVariables: ServerFn<..., ResolvedTemplateCopy>;
  export function collectPlaceholders(source: string): string[];
  export function findMissingPlaceholders(source: string, variables: Record<string, string>): string[];
  ```

- [ ] **Step 1: Write the failing pure-function tests**

`collectPlaceholders` and `findMissingPlaceholders` are pure and carry most of the risk —
test them directly rather than through the server fn:

```ts
it("collects every distinct placeholder", () => {
  expect(collectPlaceholders("Dear {{tenant_name}}, {{amount}} for {{ period }}"))
    .toEqual(["tenant_name", "amount", "period"]);
});

it("tolerates the spaced form the renderer accepts", () => {
  expect(collectPlaceholders("{{ amount }}")).toEqual(["amount"]);
});

it("reports a placeholder with no resolved value", () => {
  expect(findMissingPlaceholders("{{a}} {{b}}", { a: "1" })).toEqual(["b"]);
});

it("counts an empty string as missing — a blank amount is not a resolved amount", () => {
  expect(findMissingPlaceholders("{{a}}", { a: "" })).toEqual(["a"]);
});
```

The placeholder regex must match `renderTemplate`'s exactly: `/{{\s*([a-zA-Z0-9_]+)\s*}}/g`.
A resolver that finds placeholders the renderer does not substitute reports lies.

- [ ] **Step 2: Assert the Zod schema directly**

```ts
it("rejects a non-uuid tenant", () => {
  expect(resolveVariablesSchema.safeParse({ tenantId: "nope" }).success).toBe(false);
});
```

This exists because `createServerFn`'s test mock skips `.validator()`. A schema tested only
through the server fn is never actually executed.

- [ ] **Step 3: Run and confirm failure**

```bash
bun run test src/fns/resolveTemplateVariables.test.ts
```

- [ ] **Step 4: Implement the resolver**

```ts
/**
 * يجمع القيم الحية لمتغيّرات القالب لمستأجر معيّن قبل الإرسال أو المعاينة.
 *
 * One resolver, two callers: the preview panel and sendNotification both go
 * through here. Computing them separately is how you ship a preview that looks
 * right while the delivered message still says {{amount}} — which is exactly
 * the bug this replaces.
 */
export const resolveTemplateVariables = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(resolveVariablesSchema)
  .handler(async ({ data, context }) => { /* ... */ });
```

Guard with `has_permission("notifications.send")`, mirroring `sendNotification.ts:34-38`.
Resolve by the template's **type**, reading through `supabaseAdmin`:

| Type | Query | Variables |
| ---- | ----- | --------- |
| `overdue_reminder` | invoices where `state = 'overdue'`, `balance > 0`, `is_visible_to_tenant`, optionally `contract_id = contractId` | `amount` = Σ balance, `period` = earliest overdue period, `unit` = joined unit codes, `due_date` = earliest due date, `days_overdue` |
| `due_reminder` | earliest unpaid invoice (`due`/`partially_paid`) | `amount`, `period`, `unit`, `due_date` |
| `receipt` | latest `confirmed` payment | `amount`, `period` (from allocations), `unit` |
| `contract_expiry` | the selected or newest active contract | `unit`, `months_until_expiry`, `end_date` |
| every type | — | `tenant_name`, `company_name` (locale-correct) |

Format money to 3 decimals (KWD) and dates as ISO — match what the cron jobs already send,
so a manual overdue reminder reads identically to an automatic one.

Then build the three outputs:

```ts
const escaped = escapeVariables(variables);              // HTML path — same call the senders use
const bodyHtml = renderTemplate(templateBodyForLocale, escaped) ?? "";
const bodyText = stripMarkup(bodyHtml);                  // plain-text / WhatsApp path
const subject = renderTemplate(templateSubjectForLocale, escaped) ?? "";
const missing = findMissingPlaceholders(
  `${templateSubjectForLocale} ${templateBodyForLocale}`, variables);
```

Escaping must live here, not at the call sites — if the preview skips `escapeVariables` and
the sender applies it, the two disagree on any name containing `&` or `<`.

- [ ] **Step 5: Run tests and commit**

```bash
bun run test src/fns/resolveTemplateVariables.test.ts
bun run lint && bun run typecheck
git add src/fns/resolveTemplateVariables.ts src/fns/resolveTemplateVariables.test.ts
git commit -m "feat(notifications): resolve live template variables for a tenant"
```

---

### Task C2: Make `sendNotification` use the resolver

**Files:**
- Modify: `src/fns/sendNotification.ts`
- Create: `src/fns/sendNotification.test.ts` (none exists today)

- [ ] **Step 1: Write the failing test**

```ts
it("resolves live variables for a template send", async () => {
  // tenant with one overdue invoice of 250.000, template body "{{amount}}"
  // → the inserted notification body contains "250.000", not "{{amount}}"
});

it("still honours an explicit variables override", async () => {
  // data.variables wins over a resolved value — the caller was more specific
});

it("passes contractId through so a multi-contract tenant gets the right amount", async () => {
  // two contracts overdue; contractId pins the amount to that contract's total
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
bun run test src/fns/sendNotification.test.ts
```

- [ ] **Step 3: Replace the two-variable literal**

Lines 82–89 currently read:

```ts
const variables = {
  tenant_name: tenant.name,
  company_name: /* ... */,
  ...data.variables,
};
```

Replace with a call to the resolver's internal helper (extract the resolution logic from
C1 into a plain exported async function `resolveVariablesForTenant(...)` that both the
server fn and this module call — a server fn must not invoke another server fn over HTTP
from inside a handler):

```ts
const resolved = await resolveVariablesForTenant({
  tenantId: tenant.id, templateCode: data.templateCode ?? null,
  locale: resolvedLocale, contractId: data.contractId ?? null,
});
const variables = { ...resolved.variables, ...data.variables };
```

Add `contractId: z.string().uuid().nullable().optional()` to the schema.

**Do not change** `renderTemplate`'s leave-unknown-keys-verbatim behaviour, the recipient
resolution, the audit write, or the dispatch call.

- [ ] **Step 4: Run tests and commit**

```bash
bun run test src/fns
bun run lint && bun run typecheck
git add src/fns/sendNotification.ts src/fns/sendNotification.test.ts \
        src/fns/resolveTemplateVariables.ts
git commit -m "fix(notifications): manual template sends resolve live tenant data"
```

---

### Task C3: Preview panel in the send dialog

**Files:**
- Create: `src/components/admin/MessagePreviewPanel.tsx`
- Create: `src/components/admin/MessagePreviewPanel.test.tsx`
- Modify: `src/components/admin/SendManualMessageDialog.tsx`
- Modify: `src/i18n/dictionary.ts`

- [ ] **Step 1: Add the i18n keys — both locales**

| Key | ar | en |
| --- | -- | -- |
| `notifications.preview` | `معاينة` | `Preview` |
| `notifications.previewHtml` | `HTML` | `HTML` |
| `notifications.previewText` | `نص عادي` | `Plain text` |
| `notifications.previewSource` | `المصدر` | `Source` |
| `notifications.previewVariables` | `المتغيّرات` | `Variables` |
| `notifications.previewMissing` | `متغيّرات بلا قيمة` | `Unresolved variables` |
| `notifications.previewContract` | `العقد` | `Contract` |
| `notifications.previewEmpty` | `اختر قالبًا للمعاينة` | `Choose a template to preview` |

- [ ] **Step 2: Write the failing test**

```ts
it("renders the resolved subject and body", () => { /* … */ });
it("lists unresolved placeholders so the admin sees them before sending", () => { /* … */ });
it("shows both Arabic and English previews", () => { /* AR ⇄ EN toggle */ });
it("renders HTML inside a sandboxed iframe, not into the admin's own DOM", () => {
  const frame = container.querySelector("iframe");
  expect(frame?.getAttribute("sandbox")).toBe("");
});
```

- [ ] **Step 3: Run it, confirm it fails, then implement**

```tsx
/**
 * لوحة معاينة الرسالة قبل الإرسال، بصيغة HTML أو نص عادي، بالعربية والإنجليزية.
 *
 * The HTML tab renders into <iframe sandbox srcdoc> rather than
 * dangerouslySetInnerHTML: a notification template is admin-authored markup,
 * and injecting it into the admin console's own document would let a template
 * body run script in a privileged session.
 */
export function MessagePreviewPanel(props: {
  tenantId: string;
  templateCode: string | null;
  contractId: string | null;
  channel: NotificationChannel;
}) { /* ... */ }
```

- Calls `resolveTemplateVariables` once per locale (AR and EN) through `useServerFn`.
- Tabs: HTML / Plain text / Source, plus an AR ⇄ EN switch. Plain text shows the
  `bodyText` the resolver returned — **not** a client-side re-strip, or the preview and the
  WhatsApp message can differ.
- `missing[]` rendered as a visible warning list, not a console log.
- `<iframe sandbox="" srcDoc={bodyHtml} />` — empty `sandbox` denies everything.

- [ ] **Step 4: Wire it into the dialog**

In `SendManualMessageDialog.tsx`:
- Add a contract `Select` shown only when the tenant has more than one contract; its value
  feeds both the preview and the send.
- Render `<MessagePreviewPanel>` below the template selector, hidden in free-text and
  company-info modes.
- Pass `contractId` in the `sendManual.mutateAsync` payload.

The dialog is 285 lines and will pass the 500–600 ceiling if the preview lives inside it —
that is why the panel is its own file. If the dialog still crosses the ceiling, extract the
form fields into `SendManualMessageFields.tsx`.

- [ ] **Step 5: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/components/admin/MessagePreviewPanel.tsx \
        src/components/admin/MessagePreviewPanel.test.tsx \
        src/components/admin/SendManualMessageDialog.tsx src/i18n/dictionary.ts
git commit -m "feat(notifications): preview a manual message with live data before sending"
```

---

### Task C4: Bulk send to all tenants

**Files:**
- Create: `src/fns/sendBulkNotification.ts`
- Create: `src/fns/sendBulkNotification.test.ts`
- Create: `src/components/admin/SendBulkMessageDialog.tsx`
- Create: `src/hooks/useSendBulkNotification.ts`
- Modify: `src/routes/admin.settings.notifications.tsx`
- Modify: `src/i18n/dictionary.ts`

**Interfaces:**
- Consumes: `resolveVariablesForTenant` (C1/C2).
- Produces:
  ```ts
  export const sendBulkSchema = z.object({
    audience: z.enum(["all", "with_active_contract", "selected"]),
    tenantIds: z.array(z.string().uuid()).optional(),
    channel: z.enum(["email", "whatsapp", "both"]),
    locale: z.enum(["ar", "en"]).nullable().optional(),
    templateCode: z.string().trim().max(120).nullable().optional(),
    subject: z.string().trim().max(300).nullable().optional(),
    body: z.string().trim().max(10000).nullable().optional(),
    respectRemindersEnabled: z.boolean().default(true),
  }).refine((v) => v.templateCode || v.body, {
    message: "Select a template or enter message text.",
  });
  // → { queued: number; skipped: Array<{ tenantId: string; reason: string }> }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("queues one notification per eligible tenant", async () => { /* 3 tenants → queued: 3 */ });

it("skips tenants with reminders disabled by default", async () => {
  // → queued: 2, skipped: [{ tenantId: t3, reason: "reminders_disabled" }]
});

it("sends to reminders-off tenants when the admin explicitly opts in", async () => {
  // respectRemindersEnabled: false → queued: 3
});

it("skips, and reports, a tenant with no address for the channel", async () => {
  // channel "email", tenant without an email → skipped reason "no_email"
});

it("resolves variables per tenant, not once for the batch", async () => {
  // two tenants with different overdue amounts → two different bodies.
  // Resolving once would tell 200 tenants somebody else's balance.
});

it("writes one audit row for the batch", async () => { /* notification.bulk_create */ });

it("rejects a payload with neither template nor body", () => {
  expect(sendBulkSchema.safeParse({ audience: "all", channel: "email" }).success).toBe(false);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun run test src/fns/sendBulkNotification.test.ts
```

- [ ] **Step 3: Implement**

```ts
/**
 * يرسل رسالة يدوية أو قالبًا إلى مجموعة من المستأجرين دفعة واحدة.
 *
 * Rows are INSERTED as `queued` and delivered by notificationDrainJob rather
 * than sent inline: a synchronous loop over two hundred tenants would outlive
 * the request and leave delivery half-finished with no record of where it
 * stopped. Queuing makes the batch resumable and auditable.
 */
export const sendBulkNotification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(sendBulkSchema)
  .handler(async ({ data, context }) => { /* ... */ });
```

- Guard with `has_permission("notifications.send")`.
- Resolve the audience: `all` = every tenant; `with_active_contract` = tenants with a
  non-archived `active` contract; `selected` = `tenantIds`.
- Per tenant: resolve variables (C1), render subject/body, determine the recipient address
  exactly as `sendNotification` does, and skip with a reason where there is none.
- Insert through the existing `enqueueNotification(row, { dispatch: false })`
  (`src/fns/enqueueNotification.ts`) rather than hand-rolling an insert. Verified: it
  already writes `state: "queued"`, honours `dispatch: false`, and handles the `23505`
  delivery-key collision by returning the existing `queued`/`sent` row — which is exactly
  the idempotency a bulk send needs when an admin double-clicks. Reuse it; do not
  reimplement it.
- Verified that the drain job will pick these up: `notificationDrainJob.ts:43` selects
  `.in("state", ["queued", "failed"])`. A `queued` row with a resolved
  `recipient_address` is drainable.
- One `write_audit` row: action `notification.bulk_create`, `p_after` carrying audience,
  channel, template code, queued count and skipped count.

- [ ] **Step 4: Build the dialog**

`SendBulkMessageDialog.tsx`:
- Audience selector with a **live recipient count**.
- Channel, locale, template — same controls as the single-tenant dialog.
- `MessagePreviewPanel` (C3) against the first matching tenant, labelled clearly as a
  sample so nobody reads it as "what all 200 will say".
- A `respectRemindersEnabled` switch, defaulting **on**.
- **Typed confirmation of the recipient count** before the send button enables. Bulk
  messaging is irreversible and outward-facing; a mis-click must not reach 200 people.
- On success, a toast reporting queued and skipped counts, with the skip reasons listed.

- [ ] **Step 5: Add the entry point**

In `admin.settings.notifications.tsx`, a **Send to all tenants** button beside the existing
`notifications.sendManual` action, gated on `PERMISSIONS` the same way.

- [ ] **Step 6: i18n keys — both locales**

`notifications.sendBulk`, `notifications.bulkAudience`, `notifications.bulkAudienceAll`,
`notifications.bulkAudienceActive`, `notifications.bulkAudienceSelected`,
`notifications.bulkRecipientCount`, `notifications.bulkConfirm`,
`notifications.bulkRespectReminders`, `notifications.bulkQueued`,
`notifications.bulkSkipped`, `notifications.bulkSampleNotice`.

- [ ] **Step 7: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/fns/sendBulkNotification.ts src/fns/sendBulkNotification.test.ts \
        src/components/admin/SendBulkMessageDialog.tsx \
        src/hooks/useSendBulkNotification.ts \
        src/routes/admin.settings.notifications.tsx src/i18n/dictionary.ts
git commit -m "feat(notifications): send a message to all tenants at once"
```

---

# LANE D — CSV exports

### Task D1: Extract and fix the contracts export

**Files:**
- Create: `src/lib/contractCsv.ts`
- Create: `src/lib/contractCsv.test.ts`
- Modify: `src/routes/admin.contracts.tsx` (remove `exportContracts`' row-building)
- Modify: `src/lib/csvHeaders.ts`

**Interfaces:**
- Produces: `export function contractCsvRows(contracts: ContractExportItem[]): CsvRow[];`

- [ ] **Step 1: Write the failing test**

```ts
it("emits one row per unit on a multi-unit contract", () => {
  const rows = contractCsvRows([contractWithThreeUnits]);
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.unit_code)).toEqual(["U-1", "U-2", "U-3"]);
});

it("repeats the contract's own columns on every unit row", () => {
  const rows = contractCsvRows([contractWithThreeUnits]);
  expect(new Set(rows.map((r) => r.code)).size).toBe(1);
});

it("numbers the unit lines from 1", () => {
  expect(contractCsvRows([contractWithThreeUnits]).map((r) => r.unit_line_order))
    .toEqual(["1", "2", "3"]);
});

it("still emits one row for a contract with no units", () => {
  // A contract must never vanish from its own export because a unit link is missing.
  const rows = contractCsvRows([contractWithNoUnits]);
  expect(rows).toHaveLength(1);
  expect(rows[0].unit_code).toBe("");
});

it("carries each unit's own monthly amount, not the contract total", () => {
  expect(contractCsvRows([contractWithThreeUnits]).map((r) => r.unit_monthly_amount))
    .toEqual(["100", "150", "200"]);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun run test src/lib/contractCsv.test.ts
```

- [ ] **Step 3: Implement**

```ts
/**
 * يحوّل العقود إلى صفوف CSV، صفٌّ لكل وحدة داخل العقد.
 *
 * The old export took `primaryUnit(contract)` and dropped every other unit, so
 * a three-shop contract exported one shop. One row per unit keeps the re-import
 * contract intact — the importer reads unit_code + tenant_code from a single
 * row — while stopping the silent data loss.
 */
export function contractCsvRows(contracts: ContractExportItem[]): CsvRow[] { /* ... */ }
```

Columns: every existing column from `admin.contracts.tsx:558-582`, plus `unit_line_order`
and `unit_monthly_amount`. `unit_code` / `unit_name` / `property_*` now come from the row's
own unit rather than from `primaryUnit`.

- [ ] **Step 4: Add the new header keys to `csvHeaders.ts` — both locales**

`unit_line_order` → `ترتيب الوحدة` / `Unit line`;
`unit_monthly_amount` → `إيجار الوحدة الشهري` / `Unit monthly amount`.
Verify every other column this export emits already has an Arabic entry; add any that
do not.

- [ ] **Step 5: Rewrite the call site with the locale argument**

```ts
function exportContracts() {
  exportRecordsToCsv(contractCsvRows(contractExport.data?.items ?? []), "contracts.csv", locale);
}
```

The third argument is the Arabic-export fix: it defaults to `"en"`, and this call site has
always omitted it, so Arabic headers have never been applied.

- [ ] **Step 6: Note the file-size result**

`admin.contracts.tsx` is ~1470 lines and `CLAUDE.md` names it a known offender to split
when next touched. Removing the row builder is a real reduction; record the before/after
line count in the commit message. If further obvious extraction presents itself in the code
you are already editing, take it — but do not go refactoring parts of the file this task
does not touch.

- [ ] **Step 7: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/lib/contractCsv.ts src/lib/contractCsv.test.ts \
        src/routes/admin.contracts.tsx src/lib/csvHeaders.ts
git commit -m "fix(contracts): export every unit of a multi-unit contract, with Arabic headers"
```

---

### Task D2: Extract and fix the tenants export

**Files:**
- Create: `src/lib/tenantCsv.ts`
- Create: `src/lib/tenantCsv.test.ts`
- Modify: `src/routes/admin.tenants.index.tsx`
- Modify: `src/lib/csvHeaders.ts`

**Interfaces:**
- Produces: `export function tenantCsvRows(tenants: TenantExportItem[]): CsvRow[];`

- [ ] **Step 1: Write the failing test**

```ts
it("emits one row per contract for a multi-contract tenant", () => {
  const rows = tenantCsvRows([tenantWithTwoContracts]);
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.contract_code)).toEqual(["CTR-1", "CTR-2"]);
});

it("numbers the contracts from 1 so the reader can order them", () => {
  expect(tenantCsvRows([tenantWithTwoContracts]).map((r) => r.contract_index))
    .toEqual(["1", "2"]);
});

it("repeats the tenant's own columns on every contract row", () => {
  const rows = tenantCsvRows([tenantWithTwoContracts]);
  expect(new Set(rows.map((r) => r.code)).size).toBe(1);
});

it("scopes properties and units to the contract on that row", () => {
  const rows = tenantCsvRows([tenantWithTwoContracts]);
  expect(rows[0].connected_unit_code).toBe("U-1; U-2");   // contract 1 only
  expect(rows[1].connected_unit_code).toBe("U-9");        // contract 2 only
});

it("still emits one row for a tenant with no contracts", () => {
  // A tenant must never disappear from the tenant export.
  const rows = tenantCsvRows([tenantWithNoContracts]);
  expect(rows).toHaveLength(1);
  expect(rows[0].contract_code).toBe("");
});
```

- [ ] **Step 2: Run and confirm failure, then implement**

```ts
/**
 * يحوّل المستأجرين إلى صفوف CSV، صفٌّ لكل عقد.
 *
 * The old export semicolon-joined every contract into one cell, so a tenant
 * with three contracts had three start dates in one column and no way to tell
 * which unit belonged to which contract. One row per contract makes the file
 * readable and keeps each contract's properties and units together.
 */
export function tenantCsvRows(tenants: TenantExportItem[]): CsvRow[] { /* ... */ }
```

New columns: `contract_index`, `contract_code`, `contract_state`, `contract_start_date`,
`contract_end_date`, `contract_monthly_amount`. The existing `connected_*` columns keep
their names but are now scoped to that row's contract. Drop
`connected_contract_codes` / `active_contract_start_date` / `active_contract_end_date` /
`connected_contract_states` — `contract_code`, `contract_start_date`, `contract_end_date`
and `contract_state` replace them exactly.

- [ ] **Step 3: Dedupe by tenant code in the importer**

**This is required, not optional — and it is a hard error, not a wasted write.**

Verified path: `src/fns/bulkImport.ts:246` calls the SQL function
`bulk_import_phase6(p_entity, p_rows)`. Its `tenants` branch
(`db/migrations/113_electricity_and_bulk_import.sql:231-246`) is a **plain
`insert ... select` with no `on conflict` clause**, and `tenants.code` is unique. Feeding
it three rows carrying the same tenant code raises `23505` and **fails the entire import**.
So one-row-per-contract without this step turns a working import into a guaranteed error.

Dedupe in TypeScript, in `bulkImport.ts`, immediately before the
`supabaseAdmin.rpc("bulk_import_phase6", …)` call — keyed by entity so no other importer
changes behaviour:

```ts
/**
 * يزيل تكرار المستأجرين حسب الرمز قبل الاستيراد الجماعي.
 *
 * The tenants export emits one row per contract, so the same tenant legitimately
 * appears several times in one file. bulk_import_phase6 inserts without an
 * `on conflict` clause against a unique `code`, so the duplicates would abort the
 * whole batch with 23505. First occurrence wins — the same tenant the old
 * semicolon-joined export used to round-trip.
 */
function dedupeTenantRowsByCode(rows: Array<Record<string, unknown>>) { /* ... */ }
```

Test it:

```ts
it("imports a tenant once when the CSV repeats it per contract", () => {
  const rows = [{ code: "T-1", name: "A" }, { code: "T-1", name: "A" }, { code: "T-2", name: "B" }];
  expect(dedupeTenantRowsByCode(rows)).toHaveLength(2);
});

it("keeps the first occurrence, matching the old primary-contract round trip", () => {
  const rows = [{ code: "T-1", name: "first" }, { code: "T-1", name: "second" }];
  expect(dedupeTenantRowsByCode(rows)[0].name).toBe("first");
});

it("leaves rows with a blank code alone — the importer generates one per row", () => {
  // `coalesce(nullif(row_data.code,''), public.next_tenant_code())` in the SQL
  // means a blank code is a NEW tenant each time, not a duplicate.
  expect(dedupeTenantRowsByCode([{ code: "" }, { code: "" }])).toHaveLength(2);
});
```

That third case matters: collapsing blank-coded rows would silently drop new tenants.

- [ ] **Step 4: Add the new header keys — both locales**

`contract_index` → `رقم العقد التسلسلي` / `Contract #`;
`contract_code` → `رمز العقد` / `Contract code`;
`contract_state` → `حالة العقد` / `Contract state`;
`contract_start_date` → `بداية العقد` / `Contract start date`;
`contract_end_date` → `نهاية العقد` / `Contract end date`;
`contract_monthly_amount` → `الإيجار الشهري` / `Monthly amount`.

- [ ] **Step 5: Rewrite the call site with the locale argument**

```ts
function exportTenants() {
  exportRecordsToCsv(tenantCsvRows(tenantExport.data?.items ?? []), "tenants.csv", locale);
}
```

- [ ] **Step 6: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test
git add src/lib/tenantCsv.ts src/lib/tenantCsv.test.ts \
        src/routes/admin.tenants.index.tsx src/lib/csvHeaders.ts src/fns/bulkImport.ts
git commit -m "fix(tenants): one CSV row per contract, with Arabic headers"
```

---

# Integration

### Task E1: Guards, full gates, and documentation

- [ ] **Step 1: Run the full gate set on the merged branch**

```bash
bun run lint && bun run typecheck && bun run test && bun run test:db && bun run test:sql
```

- [ ] **Step 2: Run the guard skills**

- `clean-code-guard` over every production file changed.
- `test-guard` over every test file added — it exists to catch the tests that assert
  nothing, mock an internal helper, or swallow an error in a `catch`. A passing suite says
  nothing about those.
- `docs-guard` over the spec, this plan, and any doc comment claiming behaviour.

- [ ] **Step 3: Verify the responsiveness criterion**

At 360 / 414 / 768 px, in **both** locales: dashboard, lease, invoices, payments, profile,
and the header banner. No horizontal page scroll; nothing clipped; tap targets ≥ 44 px.

- [ ] **Step 4: Apply migrations to production BEFORE merging**

A push to `main` auto-deploys. Migrations do not. Apply `121` and `122` to
`danatfuture-supabase-ozoxsa-db-1` over `ssh-danatfuture-mcp` first:

```bash
pg_dump                                   # schema changes are not reversible
cd /etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code/db/migrations
cat 121_*.sql 122_*.sql > /root/apply.sql
md5sum /root/apply.sql                    # MUST match the local concatenation
docker exec -i danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - < /root/apply.sql
docker exec danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres -Atc "notify pgrst, 'reload schema'"
```

`notify pgrst` is required — without it PostgREST keeps a stale signature cache and the
new 2-argument RPC 404s even though it exists.

- [ ] **Step 5: Update `TODO.md` and open the PR**

Re-check the current branch before committing — the user works concurrently in this repo
and the branch can change mid-run.

---

## Self-Review

**Spec coverage**

| Spec item | Task |
| --------- | ---- |
| 1a–1c dashboard contract button, unit info beneath | A4 step 6 |
| 1d Pay Now → invoices with contract preselected | A4 step 6 |
| 2 My Lease dropdown on the title line | A4 step 7 |
| 3a My Invoices dropdown + contract-code column | A4 step 8 |
| 3b invoices filtered by contract | A1 + A4 step 2 |
| 4 My Payments dropdown between title and Export CSV | A4 step 9 |
| 5 Username card on Profile | A6 |
| 6 Pay Now button → method dropdown → gateway | A5 |
| Full mobile responsiveness | A4 step 10, B2 step 3, E1 step 3 |
| Announcement banner: admin control, infinite loop, direction, styling | B1, B2 |
| Manual message live variables | C1, C2 |
| Manual message preview, HTML/text, AR+EN | C3 |
| Bulk send to all tenants | C4 |
| contracts.csv multi-unit | D1 |
| tenants.csv one row per contract | D2 |
| Arabic **and** English CSV exports | D1 step 5, D2 step 5 |

**Type consistency** — `PortalContractOption` (A2) is consumed by name in A3 and A4;
`filterPaymentsByContract` (A4) matches its test; `resolveVariablesForTenant` (C1) is the
plain function C2 and C4 both call, distinct from the `resolveTemplateVariables` server fn;
`contractCsvRows` / `tenantCsvRows` (D1/D2) match their call sites.

**Known open risk, surfaced rather than hidden:** bulk **WhatsApp** will not deliver in
production today — all 14 templates are unmapped and only `smtp` is enabled. The code path
is built and correct; delivery starts working when the template mapping lands. Bulk email
works now.

---

## Corrections applied during implementation

This plan was reviewed adversarially (Codex, read-only) and executed. Several instructions
above turned out to be **wrong about this codebase**. They are left in place so the diff of
reasoning is readable, but everything below overrides them. Do not follow the original text
where it conflicts.

| # | The plan said | The code actually says | Where |
| - | ------------- | ---------------------- | ----- |
| 1 | Overdue templates use `amount`, `period`, `unit`, `due_date`, `days_overdue`; receipt uses `amount`, `period`, `unit`; expiry uses `months_until_expiry` | The authoritative catalogue is **`src/lib/templateVariables.ts`**: overdue = `outstanding`, `days_overdue`; receipt = `amount`, `payment_date`, `reference`; expiry = `contract_code`, `end_date`, `unit`, `days_until`, `company_name`. Confirmed by the seeded bodies in `db/migrations/70_seed_template_bodies.sql` | Task C1 |
| 2 | Escape variables into **both** subject and body | **Subjects render from RAW values; only bodies are escaped.** `src/fns/loadTemplateCopy.ts:17-24` records the incident: escaping the subject put `&amp;` in recipients' inboxes and `&amp;amp;` in the branded header | Task C1 |
| 3 | "A server fn must not invoke another server fn over HTTP from inside a handler" | **False** — TanStack Start supports it. Extracting `buildFinalMessage` is still right, but for parity, not because calling a server fn is forbidden | Task C2 |
| 4 | Sample contract fixture `type: "residential"` | `ContractType` is `"investment" \| "lease"` (`database.types.ts:81`). `"residential"` fails typecheck | Task A2 |
| 5 | Dedupe tenants only | **Contracts too.** `contracts.csv` at one row per unit repeats the contract code, and `bulk_import_phase6` inserts with no `on conflict` against a unique `code` — re-import raises `23505` and fails the whole batch. `dedupeRowsByCode` covers both | Task D2 |
| 6 | `contract_monthly_amount` Arabic label `الإيجار الشهري` | Collides with `monthly_amount`'s existing label. `csvHeaders` keeps a reverse Arabic→key map, so a duplicate label makes one column unreachable on an Arabic re-import. Used `إيجار العقد الشهري` | Task D2 |
| 7 | `useTenants` already carries per-contract rent | It selected `id, code, tenant_id, state, start_date, end_date` only. `monthly_amount` was added to the select, the type, and the construction site | Task D2 |
| 8 | Migration 121 as drop + create | Must be wrapped in `BEGIN`/`COMMIT`. Under `psql -v ON_ERROR_STOP=1`, a failure in the create or either grant would commit the drop and leave production with **no** payable-invoice function | Task A1 |
| 9 | Apply migrations from the Dokploy checkout **before** merging | Circular — `CLAUDE.md:193-212` says the merge is what *delivers* the files to that checkout. See the corrected sequence below | Task E1 |
| 10 | Task list omitted `createPayment` | `createPayment.ts:186-206` re-runs the RPC tenant-wide and validates the selection as a prefix of that list, so a contract filter without a `contractId` passthrough rejects every scoped payment. Added as **Task A4b** | Lane A |
| 11 | Selection hook trusted `?contract=` | A malformed, foreign, or archived value reached a `uuid` RPC argument. `resolvePortalContractId` clears it to "all contracts" | Task A2 |
| 12 | Bulk send: `enqueueNotification(row, { dispatch: false })`, and capacity unaddressed | The function takes **one** object with `dispatch` inside it. Idempotency needs an explicit `deliveryKey`. And `DRAIN_BATCH_LIMIT = 100` per run with `STALE_AFTER_HOURS = 72` on a daily cron means a large batch has recipients **cancelled rather than sent** — the dialog now warns above that capacity | Task C4 |

### Corrected production sequence (supersedes Task E1 step 4)

Migration 121 is **backward compatible**: PostgREST resolves an existing one-argument
`{p_tenant_id}` call against the two-argument form with a defaulted `p_contract_id`, so the
currently-deployed bundle keeps working after the migration lands. Migration 122 is purely
additive. That is what makes the documented Dokploy window safe:

1. `pg_dump` first — schema changes are not reversible.
2. Merge to `main`. Dokploy clones the branch into
   `/etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code` at the **start** of the
   build, which is what puts the new migrations on the server.
3. During the build, concatenate `121_*.sql 122_*.sql` from that checkout, `md5sum` against
   the local file, and apply with `psql -v ON_ERROR_STOP=1`.
4. `notify pgrst, 'reload schema'` — without it PostgREST keeps a stale signature cache and
   the two-argument RPC 404s even though it exists.
5. The container swaps to the new bundle.

The old bundle running against the new schema during steps 2–5 is the window this ordering
accepts, and both migrations are compatible with it by construction. Verified end to end by
`bun run test:db` (119 migrations applied to an empty database) and `bun run test:sql`
(347 tests).
