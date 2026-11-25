# Group B — close-out follow-ups, due day 1, rent increase — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Written-off invoices can no longer be marked paid; the tenants Life Cycle filter works on every tab; the close-out wizard writes off post-move-out months by default; every open contract is normalised to bill on the 1st with reminders honouring the tenant toggle on every channel; a contract can carry one rent increase (percent or fixed) that prices every invoice from its anniversary onward.

**Architecture:** SQL owns money: one new unit pricer `contract_unit_period_amounts(contract, period)` feeds `contract_period_amounts`, and all four invoice-writing functions plus their three line loops route through it. The save RPC accepts the three increase columns and enforces a row-locked paid-invoice lock. The client adds a form section, a Zod trio, and three small gates (row action, filter composition, close-out seed). Each SQL re-issue is its own migration copying the highest-numbered body verbatim and applying only the named hunks.

**Tech Stack:** Postgres 17 plpgsql migrations in `db/migrations/`, Vitest SQL suite in `src/db/*.sqltest.ts` (`TEST_DB_PORT=55329 bun run test:sql`, container `danat-sqltest`), TanStack Start + React 19, react-hook-form + Zod, Tailwind/shadcn, `src/i18n/dictionary.ts` (ar + en parity is test-enforced).

**Spec:** `docs/superpowers/specs/2026-09-14-group-b-closeout-dueday-rent-increase-design.md`

## Global Constraints

- Every new file stays under 500–600 lines. `ContractFormDialog.tsx` is 621 lines: the increase section is its own component, never inlined.
- Every function gets a doc comment above it that leads with an Arabic description; English may follow for the *why*.
- Migrations are numbered `194`–`200` exactly as listed below. A re-issued function copies the **highest-numbered** existing body verbatim (170 for the four pricers, 159 for `set_invoice_paid`, 173 for `save_contract_with_units`) and changes only the hunks this plan names. After every `create or replace function`, restate `revoke execute ... from public, anon;` and `grant execute ... to authenticated, service_role;` (migration 96 rule).
- `database.types.ts` is hand-maintained: add the three contract columns by hand to `ContractRow`; never run or paste `gen:types` output.
- Never write `contracts.monthly_amount` from application code or SQL; it is trigger-maintained.
- Skip rules on reprice are unchanged: `paid`, `partially_paid`, `waived`, `cancelled`, concession-linked invoices are never repriced.
- Tests assert `disabled=""` on buttons, never a class; no test may mock the module under test; no empty test bodies.
- Implementers do not commit. The orchestrator commits. Do not stage `contract_sample/`.
- Gates before handing back: `bun run lint`, `bun run typecheck`, `bun run test`, and `TEST_DB_PORT=55329 bun run test:sql` for any task touching `db/migrations` or `src/db`.
- Fallback direction from the user, verbatim: "If any model goes out of quota (like GLM5.3 ), continue and delegate to Codex Astra 6 medium effort."

---

## File structure

| Path | Responsibility |
|---|---|
| `db/migrations/194_set_invoice_paid_refuses_waived.sql` | state guard on mark/unmark paid |
| `db/migrations/195_due_day_first.sql` | bulk due-day normalisation |
| `db/migrations/196_contract_rent_increase_schema.sql` | columns, checks, effective-period fn, unit pricer, `contract_period_amounts` re-issue |
| `db/migrations/197_generate_invoices_uses_period_pricer.sql` | `generate_invoices_for_year` re-issue |
| `db/migrations/198_regenerate_uses_period_pricer.sql` | `regenerate_contract_invoices` re-issue |
| `db/migrations/199_sync_schedule_uses_period_pricer.sql` | `sync_contract_invoice_schedule` re-issue |
| `db/migrations/200_save_contract_accepts_increase.sql` | `save_contract_with_units` re-issue with lock |
| `src/db/setInvoicePaidRefusesWaived.sqltest.ts` | Task 1 tests |
| `src/db/dueDayFirst.sqltest.ts` | Task 5 tests |
| `src/db/rentIncreasePricing.sqltest.ts` | Tasks 7–11 tests |
| `src/lib/tenantListView.ts` | add `effectiveTenantLifecycle` |
| `src/lib/closeoutInvoiceActions.ts` | new: `defaultInvoiceAction`, `reseedUntouched` |
| `src/lib/contractIncrease.ts` | new: pure helpers (effective period, label) shared by form and table |
| `src/components/admin/contracts/ContractIncreaseSection.tsx` | new form section |
| `src/lib/whatsappSkipReasons.ts` | add `EMAIL_SKIP.remindersDisabled` |

---

### Task 1: `set_invoice_paid` refuses waived and cancelled invoices

**Files:**
- Create: `db/migrations/194_set_invoice_paid_refuses_waived.sql`
- Test: `src/db/setInvoicePaidRefusesWaived.sqltest.ts`

**Interfaces:**
- Consumes: `public.set_invoice_paid(p_invoice_id uuid, p_paid boolean, p_method text, p_manual_payment_reason text)` body from `db/migrations/159_manual_payment_method.sql:78-215`.
- Produces: same signature; raises `22023` on `waived`/`cancelled`.

- [ ] **Step 1: Write the failing SQL test**

Migration 159 enforces pay-oldest-first, so every fixture acts on **period 1**, the earliest invoice.

```ts
import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 194 — a written-off or cancelled invoice cannot be marked paid or
 * unpaid. INV-0007120 was laundered waived → paid → due through this RPC on
 * 2026-09-13; the unpay branch recomputes state from money and can never
 * return to `waived`.
 */
async function firstInvoiceIn(client: PoolClient, state: string) {
  const fx = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31" });
  await client.query(`select public.generate_invoices_for_year($1, 2026, true)`, [fx.contractId]);
  const { rows } = await client.query<{ id: string }>(
    `update public.invoices set state = $2::public.invoice_states where contract_id = $1 and period_month = 1 returning id`,
    [fx.contractId, state],
  );
  return rows[0].id;
}

describe("set_invoice_paid on a waived or cancelled invoice", () => {
  test("refuses to mark a waived invoice paid and leaves it waived", async () => {
    await withRollback(async (client) => {
      const id = await firstInvoiceIn(client, "waived");
      const message = await captureRaise(client, `select * from public.set_invoice_paid($1, true, 'cash', null)`, [id]);
      expect(message).toMatch(/cannot be marked paid or unpaid/);
      const after = await client.query(`select state from public.invoices where id = $1`, [id]);
      expect(after.rows[0].state).toBe("waived");
    });
  });

  test("refuses to unmark a cancelled invoice", async () => {
    await withRollback(async (client) => {
      const id = await firstInvoiceIn(client, "cancelled");
      const message = await captureRaise(client, `select * from public.set_invoice_paid($1, false, null, null)`, [id]);
      expect(message).toMatch(/cannot be marked paid or unpaid/);
    });
  });

  test("a due invoice still marks paid", async () => {
    await withRollback(async (client) => {
      const id = await firstInvoiceIn(client, "due");
      await client.query(`select * from public.set_invoice_paid($1, true, 'cash', null)`, [id]);
      const after = await client.query(`select state from public.invoices where id = $1`, [id]);
      expect(after.rows[0].state).toBe("paid");
    });
  });
});
```

Read `captureRaise` at `src/db/testDb.ts:107` and match its real signature (it may take a callback rather than `(client, sql, params)`).

- [ ] **Step 2: Run** `TEST_DB_PORT=55329 bun run test:sql -- src/db/setInvoicePaidRefusesWaived.sqltest.ts` — Expected: the two "refuses" tests FAIL.

- [ ] **Step 3: Write the migration**

Copy `db/migrations/159_manual_payment_method.sql` lines 78–215 (the `drop function if exists ...` and `create or replace function public.set_invoice_paid(...)` through its grants) verbatim under this header, then insert the guard right after `if not found then raise exception 'Invoice not found'; end if;`:

```sql
-- 194_set_invoice_paid_refuses_waived.sql
--
-- على الفاتورة المشطوبة أو الملغاة ألا تُسدَّد ولا يُلغى سدادها يدوياً.
--
-- Incident 2026-09-13: INV-0007120 was written off by a close-out, then the
-- tenant-detail action column marked it paid (a real payment + allocation
-- inserted directly, bypassing apply_payment_allocation's waived check) and
-- unmarked it, which recomputes state from money and can only yield
-- due/overdue. The write-off was gone. The guard lives here, the only layer
-- every UI path shares.
```

```sql
  if v_invoice.state in ('cancelled', 'waived') then
    raise exception 'Invoice % cannot be marked paid or unpaid in its current state',
      v_invoice.code using errcode = '22023';
  end if;
```

Keep 159's trailing `revoke execute ... from public, anon;` and `grant execute ... to authenticated, service_role;` exactly.

- [ ] **Step 4: Run** `TEST_DB_PORT=55329 bun run test:db && TEST_DB_PORT=55329 bun run test:sql -- src/db/setInvoicePaidRefusesWaived.sqltest.ts` — Expected: PASS (3 tests).

- [ ] **Step 5: Hand back** — report gate output; do not commit.

---

### Task 2: Tenant-detail action column gates the paid toggle by state

**Files:**
- Modify: `src/components/admin/InvoiceRowActions.tsx:158-166`
- Test: `src/components/admin/InvoiceRowActions.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { InvoiceRowActions } from "@/components/admin/InvoiceRowActions";

vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (k: string) => k, locale: "en" }) }));

const handlers = {
  canSend: true,
  canGenerateLink: true,
  canTogglePaid: true,
  onSend: vi.fn(),
  onGenerateLink: vi.fn(),
  onTogglePaid: vi.fn(),
};

function invoiceIn(state: string) {
  return {
    id: "inv-1", code: "INV-1", state, balance: 100, total: 100, paid: 0,
    period_year: 2026, period_month: 9, tenant: null, unit: null, contract: null,
  } as never;
}

describe("InvoiceRowActions paid toggle", () => {
  test.each(["waived", "cancelled"])("is disabled on a %s invoice", (state) => {
    render(<InvoiceRowActions invoice={invoiceIn(state)} company={null} handlers={handlers} />);
    expect(screen.getByLabelText("invoices.markPaid")).toHaveAttribute("disabled", "");
  });

  test.each(["due", "overdue", "partially_paid", "paid"])("is enabled on a %s invoice", (state) => {
    render(<InvoiceRowActions invoice={invoiceIn(state)} company={null} handlers={handlers} />);
    const label = state === "paid" ? "invoices.markUnpaid" : "invoices.markPaid";
    expect(screen.getByLabelText(label)).not.toHaveAttribute("disabled");
  });
});
```

Match the `useI18n` import path the component actually uses and add invoice fields until typecheck passes, keeping the cast.

- [ ] **Step 2: Run** `bun run test -- src/components/admin/InvoiceRowActions.test.tsx` — Expected: the waived/cancelled cases FAIL.

- [ ] **Step 3: Implement**

```tsx
        // Mark is offered only where money is still owed; unmark only on a paid
        // row. A waived or cancelled invoice gets neither: set_invoice_paid
        // (migration 194) refuses them, and offering the button would invite
        // the click that laundered INV-0007120 out of its write-off.
        disabled={!canTogglePaid || paidPending || busy || (!paid && !payable)}
```

`paid` is the existing `invoice.state === "paid"` boolean; `payable` is `isPayable(invoice.state)` (add `const payable = isPayable(invoice.state);` next to `paid` if it is not already in scope).

- [ ] **Step 4: Run** the test file and `bun run typecheck` — Expected: PASS.

---

### Task 3: Life Cycle select overrides the tab's lifecycle pin

**Files:**
- Modify: `src/lib/tenantListView.ts`, `src/routes/admin.tenants.index.tsx:106-124`
- Test: `src/lib/tenantListView.test.ts` (create or extend)

**Interfaces:**
- Produces: `effectiveTenantLifecycle(view: TenantListView, selected: string): TenantLifecycle | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";

import { effectiveTenantLifecycle } from "@/lib/tenantListView";

describe("effectiveTenantLifecycle", () => {
  test("the select wins over the tab when set", () => {
    expect(effectiveTenantLifecycle("active", "contract_ended")).toBe("contract_ended");
  });
  test("the tab applies when the select is empty", () => {
    expect(effectiveTenantLifecycle("active", "")).toBe("active");
    expect(effectiveTenantLifecycle("ended", "")).toBe("contract_ended");
  });
  test("all/archived tabs with an empty select send no lifecycle", () => {
    expect(effectiveTenantLifecycle("all", "")).toBeUndefined();
    expect(effectiveTenantLifecycle("archived", "")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL, export missing.

- [ ] **Step 3: Implement**

```ts
/**
 * يحدّد دورة الحياة الفعلية للاستعلام: اختيار المرشّح يغلب تثبيت التبويب.
 *
 * The `?view=active` tab pins `lifecycle=active` on the server and the Life
 * Cycle select filters client-side on the same column; ANDed, "Contract
 * Ended" on the Active tab could never return a row. The select is the more
 * specific intent, so it replaces the pin rather than narrowing it.
 */
export function effectiveTenantLifecycle(
  view: TenantListView,
  selected: string,
): TenantLifecycle | undefined {
  if (selected) return selected as TenantLifecycle;
  return resolveTenantListView(view).lifecycle;
}
```

In `admin.tenants.index.tsx`, pass `lifecycle: effectiveTenantLifecycle(view, filters.lifecycle)` to `useTenants` (move the call below the `filters` state if needed). `archiveMode` and `useTenantsSummary` unchanged.

- [ ] **Step 4: Run** `bun run test -- src/lib/tenantListView.test.ts && bun run typecheck` — Expected: PASS.

---

### Task 4: Close-out wizard seeds post-move-out months to write off, and re-seeds untouched rows when the date changes

**Files:**
- Create: `src/lib/closeoutInvoiceActions.ts`
- Modify: `src/routes/admin.contracts_.$id.closeout.tsx:221-235` and the invoice radio group (~629-671)
- Test: `src/lib/closeoutInvoiceActions.test.ts`

**Interfaces:**
- Produces: `defaultInvoiceAction(invoice: { period_year: number; period_month: number }, moveOutDate: string): "leave" | "write_off"`; `reseedUntouched(rows: InvoiceActionInput[], invoices: Array<{ id: string; period_year: number; period_month: number }>, moveOutDate: string, touched: ReadonlySet<string>): InvoiceActionInput[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";

import { defaultInvoiceAction, reseedUntouched } from "@/lib/closeoutInvoiceActions";

describe("defaultInvoiceAction", () => {
  test("a month after the move-out month is written off", () => {
    expect(defaultInvoiceAction({ period_year: 2026, period_month: 10 }, "2026-09-13")).toBe("write_off");
    expect(defaultInvoiceAction({ period_year: 2027, period_month: 1 }, "2026-09-13")).toBe("write_off");
  });
  test("the move-out month itself and earlier months are left", () => {
    expect(defaultInvoiceAction({ period_year: 2026, period_month: 9 }, "2026-09-13")).toBe("leave");
    expect(defaultInvoiceAction({ period_year: 2026, period_month: 8 }, "2026-09-13")).toBe("leave");
  });
  test("an unparseable move-out date leaves everything", () => {
    expect(defaultInvoiceAction({ period_year: 2027, period_month: 1 }, "")).toBe("leave");
  });
});

describe("reseedUntouched", () => {
  const invoices = [
    { id: "a", period_year: 2026, period_month: 9 },
    { id: "b", period_year: 2026, period_month: 10 },
  ];
  test("recomputes rows the operator never touched and keeps the ones they did", () => {
    const rows = [
      { invoice_id: "a", action: "leave" as const, amount: 0 },
      { invoice_id: "b", action: "cancel" as const, amount: 0 },
    ];
    const next = reseedUntouched(rows, invoices, "2026-08-01", new Set(["b"]));
    expect(next).toEqual([
      { invoice_id: "a", action: "write_off", amount: 0 },
      { invoice_id: "b", action: "cancel", amount: 0 },
    ]);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { InvoiceActionInput } from "@/lib/closeoutSchema"; // use the real module that declares InvoiceActionInput in the closeout route

/**
 * الإجراء الافتراضي لفاتورة في معالج إنهاء العقد: شطب ما بعد شهر الإخلاء.
 *
 * The operator closing CON-00026 expected every future month gone and had to
 * flip 40 radios by hand; the one they missed stayed `due`. The wizard still
 * lets every row be changed — this only chooses the starting point.
 */
export function defaultInvoiceAction(
  invoice: { period_year: number; period_month: number },
  moveOutDate: string,
): "leave" | "write_off" {
  const match = /^(\d{4})-(\d{2})/.exec(moveOutDate);
  if (!match) return "leave";
  const moveOutKey = Number(match[1]) * 12 + Number(match[2]);
  const periodKey = invoice.period_year * 12 + invoice.period_month;
  return periodKey > moveOutKey ? "write_off" : "leave";
}

/**
 * يعيد بذر الصفوف التي لم يلمسها المشغّل عند تغيير تاريخ الإخلاء.
 *
 * The seed runs when invoices load, against the default (today's) date. A
 * backdated move-out entered afterwards must move the write-off boundary for
 * every row the operator has not decided by hand, and only those.
 */
export function reseedUntouched(
  rows: InvoiceActionInput[],
  invoices: Array<{ id: string; period_year: number; period_month: number }>,
  moveOutDate: string,
  touched: ReadonlySet<string>,
): InvoiceActionInput[] {
  const byId = new Map(invoices.map((invoice) => [invoice.id, invoice] as const));
  return rows.map((row) => {
    if (touched.has(row.invoice_id)) return row;
    const invoice = byId.get(row.invoice_id);
    if (!invoice) return row;
    return { ...row, action: defaultInvoiceAction(invoice, moveOutDate), amount: 0 };
  });
}
```

Find where `InvoiceActionInput` is actually declared (grep the closeout route's imports) and import from there.

Route wiring: (a) in the seed effect use `action: defaultInvoiceAction(invoice, form.getValues("moveOutDate"))`; (b) add `const [touchedActions, setTouchedActions] = useState<Set<string>>(new Set())` and in the per-invoice radio `onChange` add the invoice id to it; (c) add an effect on `form.watch("moveOutDate")` that, when `unpaidInvoices.length` and existing actions exist, calls `form.setValue("invoiceActions", reseedUntouched(existing, unpaidInvoices, moveOutDate, touchedActions))`.

- [ ] **Step 4: Run** the test and `bun run typecheck` — Expected: PASS.

---

### Task 5: Migration 195 — due day 1 for every open contract

**Files:**
- Create: `db/migrations/195_due_day_first.sql`
- Test: `src/db/dueDayFirst.sqltest.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

const MIGRATION = readFileSync("db/migrations/195_due_day_first.sql", "utf8");

/**
 * Migration 195 — rent is due on the 1st of its month. 67 of 70 production
 * contracts carried 15 as typed data; the bulk update moves them and every
 * unpaid invoice they own, and leaves settled money and closed contracts alone.
 */
async function dueDates(client: import("pg").PoolClient, contractId: string) {
  const { rows } = await client.query<{ period_month: number; due_date: string }>(
    `select period_month, to_char(due_date, 'YYYY-MM-DD') as due_date from public.invoices where contract_id = $1 order by period_month`,
    [contractId],
  );
  return new Map(rows.map((r) => [r.period_month, r.due_date] as const));
}

describe("migration 195 due day", () => {
  test("moves open contracts and their unpaid invoices to the 1st, idempotently", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31", dueDay: 15 });
      await client.query(`select public.generate_invoices_for_year($1, 2026, true)`, [fx.contractId]);
      await client.query(`update public.invoices set state = 'paid', paid = total where contract_id = $1 and period_month = 1`, [fx.contractId]);
      await client.query(`update public.invoices set state = 'waived' where contract_id = $1 and period_month = 2`, [fx.contractId]);

      await client.query(MIGRATION);
      await client.query(MIGRATION);

      const contract = await client.query(`select due_day from public.contracts where id = $1`, [fx.contractId]);
      expect(contract.rows[0].due_day).toBe(1);
      const dates = await dueDates(client, fx.contractId);
      expect(dates.get(1)).toBe("2026-01-15");
      expect(dates.get(2)).toBe("2026-02-15");
      expect(dates.get(3)).toBe("2026-03-01");
    });
  });

  test("a terminated contract keeps its due day", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2025-01-01", endDate: "2025-12-31", dueDay: 15, state: "terminated" });
      await client.query(MIGRATION);
      const contract = await client.query(`select due_day from public.contracts where id = $1`, [fx.contractId]);
      expect(contract.rows[0].due_day).toBe(15);
    });
  });

  test("a terminated contract already on day 1 keeps its historical invoice dates", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2025-01-01", endDate: "2025-12-31", dueDay: 1, state: "terminated" });
      await client.query(`select public.generate_invoices_for_year($1, 2025, true)`, [fx.contractId]);
      await client.query(`update public.invoices set due_date = make_date(2025, period_month, 15) where contract_id = $1`, [fx.contractId]);
      await client.query(MIGRATION);
      const dates = await dueDates(client, fx.contractId);
      expect(dates.get(1)).toBe("2025-01-15");
    });
  });
});
```

Note: `generate_invoices_for_year(..., true)` bills only up to the current month for a 2026 contract; assert on months that exist (1–3 are always present when the suite runs in or after March). If the terminated 2025 fixture generates nothing because the contract is not active, seed it `active`, generate, then `update public.contracts set state = 'terminated'`.

- [ ] **Step 2: Run** — Expected: FAIL (file missing).

- [ ] **Step 3: Write the migration**

```sql
-- 195_due_day_first.sql
--
-- الإيجار يستحق في الأول من شهره. Operator decision 2026-09-14: every open
-- contract bills on the 1st, and every unpaid invoice moves with it. The
-- one-time consequence — September invoices become overdue on the next
-- nightly run and reminders go out in one burst — was accepted explicitly.
-- Paid, waived and cancelled invoices are settled history and stay put, and
-- so does every invoice of a terminated, expired or archived contract.
--
-- One-time normalisation, not a rule: the form, the save RPC and bulk import
-- keep accepting 1–28 (their defaults were already 1). Due dates only move
-- earlier here, so no overdue → due reversal is needed.

update public.contracts
   set due_day = 1
 where due_day <> 1
   and archived_at is null
   and state not in ('terminated', 'expired');

update public.invoices i
   set due_date = make_date(i.period_year, i.period_month, 1)
  from public.contracts c
 where c.id = i.contract_id
   and c.due_day = 1
   and c.archived_at is null
   and c.state not in ('terminated', 'expired')
   and i.state in ('due', 'overdue', 'partially_paid')
   and i.due_date <> make_date(i.period_year, i.period_month, 1);
```

- [ ] **Step 4: Run** `TEST_DB_PORT=55329 bun run test:db && TEST_DB_PORT=55329 bun run test:sql -- src/db/dueDayFirst.sqltest.ts` — Expected: PASS.

---

### Task 6: Reminders-off silences the tenant email legs too, never the admin alert

**Files:**
- Modify: `src/lib/whatsappSkipReasons.ts:19-23`, `src/fns/contractExpiryJob.ts:208-220`, `src/fns/dispatchNotification.ts` (proactive check)
- Test: `src/fns/contractExpiryJob.test.ts`, `src/fns/dispatchNotification.test.ts`

- [ ] **Step 1: Write the failing tests**

In `contractExpiryJob.test.ts`, next to the `test.each` at ~line 119:

```ts
  test("reminders off drops both tenant legs and keeps the admin alert", async () => {
    tenantRow.mockResolvedValue({
      data: {
        id: "tenant-1", name: "Ahmed", email: "tenant@example.test", mobile: null,
        preferred_language: "en", whatsapp: "+96550000000", reminders_enabled: false,
      },
      error: null,
    });
    const result = await runContractExpiryJob("2026-12-22");
    const legs = enqueue.mock.calls.map(([a]) => a);
    expect(legs.some((a) => a.audience === "tenant")).toBe(false);
    expect(legs.some((a) => a.audience === "admin" && a.channel === "email")).toBe(true);
    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ leg: "email", reason: expect.stringMatching(/reminders are disabled/i) })]),
    );
  });
```

Read how the neighbouring tests obtain the skip list and the admin recipients mock; mirror them exactly.

In `dispatchNotification.test.ts`, using the testkit tenant fixture (`dispatchNotification.testkit.ts:218`), add two cases: (a) an `overdue_reminder` **email** row with `audience: "tenant"` for a tenant with `reminders_enabled: false` ends with the reminders-disabled reason and the email provider mock is not called; (b) a `contract_expiry` email row with `audience: "admin"` and the same tenant **is** sent. Mirror the shape of the existing WhatsApp reminders-disabled test.

- [ ] **Step 2: Run** both files — Expected: the new cases FAIL.

- [ ] **Step 3: Implement**

`whatsappSkipReasons.ts`: add `remindersDisabled: "Email skipped: reminders are disabled for this tenant.",` to `EMAIL_SKIP`.

`contractExpiryJob.ts`, tenant email branch, before the address check:

```ts
      // The tenant's reminders switch is channel-agnostic. Until now only the
      // WhatsApp leg read it, so a tenant who opted out still got the email.
      if (!tenant.reminders_enabled) skip("email", EMAIL_SKIP.remindersDisabled);
      else if (!tenantEmailDelivery) skip("email", EMAIL_SKIP.noAddress);
```

(keep the rest of the chain). The admin-alert block further down is untouched.

`dispatchNotification.ts`: hoist the set to module level as `PROACTIVE_REMINDER_TYPES`. In the email branch add, as the first check:

```ts
      // Tenant audience only: admin alert rows carry the same tenant_id and
      // type, and an opted-out tenant must not silence the office.
      if (
        notification.audience === "tenant" &&
        PROACTIVE_REMINDER_TYPES.has(notification.type) &&
        tenant && !tenant.reminders_enabled
      ) {
        issues.push(EMAIL_SKIP.remindersDisabled);
      } else { /* existing email send path */ }
```

Apply the same `notification.audience === "tenant"` condition to the existing WhatsApp check.

- [ ] **Step 4: Run** `bun run test -- src/fns/contractExpiryJob.test.ts src/fns/dispatchNotification.test.ts && bun run typecheck` — Expected: PASS.

---

### Task 7: Migration 196 — increase columns, effective period, unit pricer, `contract_period_amounts`

**Files:**
- Create: `db/migrations/196_contract_rent_increase_schema.sql`
- Test: `src/db/rentIncreasePricing.sqltest.ts` (pricer section)

**Interfaces:**
- Produces:
  - columns `contracts.increase_after_years integer`, `contracts.increase_type text`, `contracts.increase_value numeric(14,3)`; constraint `contracts_increase_all_or_none`
  - `public.contract_increase_effective_period(p_contract public.contracts) returns date`
  - `public.contract_unit_period_amounts(p_contract_id uuid, p_period_start date) returns table (unit_id uuid, unit_code text, line_order integer, monthly_amount numeric)`
  - `public.contract_period_amounts(uuid, date)` now period-aware.

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 196 — one rent increase per contract, effective from the
 * anniversary. Percent scales each unit; fixed is split by largest remainder
 * in fils so every share is non-negative and lines sum to the header.
 */
export async function setIncrease(client: PoolClient, contractId: string, years: number, type: string, value: number) {
  await client.query(
    `update public.contracts set increase_after_years = $2, increase_type = $3, increase_value = $4 where id = $1`,
    [contractId, years, type, value],
  );
}

export async function unitAmounts(client: PoolClient, contractId: string, period: string) {
  const { rows } = await client.query<{ monthly_amount: string }>(
    `select monthly_amount from public.contract_unit_period_amounts($1, $2::date) order by line_order`,
    [contractId, period],
  );
  return rows.map((r) => Number(r.monthly_amount));
}

describe("contract_unit_period_amounts", () => {
  test("no increase: base rent every period", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2025-02-01", endDate: "2030-01-31", units: [{ monthlyAmount: 300 }, { monthlyAmount: 200 }] });
      expect(await unitAmounts(client, fx.contractId, "2028-06-01")).toEqual([300, 200]);
    });
  });

  test("percent applies from the anniversary month, not before", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2025-02-01", endDate: "2030-01-31", units: [{ monthlyAmount: 300 }, { monthlyAmount: 200 }] });
      await setIncrease(client, fx.contractId, 2, "percent", 10);
      expect(await unitAmounts(client, fx.contractId, "2027-01-01")).toEqual([300, 200]);
      expect(await unitAmounts(client, fx.contractId, "2027-02-01")).toEqual([330, 220]);
    });
  });

  test("fixed is split by largest remainder and the lines sum exactly", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2025-02-01", endDate: "2030-01-31", units: [{ monthlyAmount: 100 }, { monthlyAmount: 100 }, { monthlyAmount: 100 }] });
      await setIncrease(client, fx.contractId, 1, "fixed", 100);
      const amounts = await unitAmounts(client, fx.contractId, "2026-02-01");
      expect(amounts.reduce((a, b) => a + b, 0)).toBeCloseTo(400, 3);
      expect(amounts).toEqual([133.334, 133.333, 133.333]);
    });
  });

  test("a tiny fixed increase over many units never goes negative", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2025-02-01", endDate: "2030-01-31", units: Array.from({ length: 6 }, () => ({ monthlyAmount: 0.001 })) });
      await setIncrease(client, fx.contractId, 1, "fixed", 0.003);
      const amounts = await unitAmounts(client, fx.contractId, "2026-02-01");
      for (const amount of amounts) expect(amount).toBeGreaterThanOrEqual(0.001);
      expect(amounts.reduce((a, b) => a + b, 0)).toBeCloseTo(0.009, 3);
    });
  });

  test("contract_period_amounts carries the increase into the subtotal", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2025-02-01", endDate: "2030-01-31", monthlyAmount: 500 });
      await setIncrease(client, fx.contractId, 1, "percent", 20);
      const { rows } = await client.query<{ subtotal: string }>(`select subtotal from public.contract_period_amounts($1, '2026-02-01'::date)`, [fx.contractId]);
      expect(Number(rows[0].subtotal)).toBe(600);
    });
  });

  test.each([
    "increase_after_years = 1",
    "increase_type = 'percent'",
    "increase_value = 10",
    "increase_after_years = 1, increase_type = 'percent'",
    "increase_after_years = 1, increase_value = 10",
    "increase_type = 'percent', increase_value = 10",
  ])("the check constraint rejects a partial increase (%s)", async (assignment) => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2025-02-01", endDate: "2030-01-31" });
      await expect(client.query(`update public.contracts set ${assignment} where id = $1`, [fx.contractId])).rejects.toThrow(/contracts_increase_all_or_none/);
    });
  });
});
```

`seedContract`'s `positiveRentField` equivalent in SQL is `monthly_amount > 0`; 0.001 is valid.

- [ ] **Step 2: Run** — Expected: FAIL (function missing).

- [ ] **Step 3: Write the migration**

```sql
-- 196_contract_rent_increase_schema.sql
--
-- زيادة إيجار واحدة لكل عقد، تسري من ذكرى بدايته السنوية.
--
-- Contracts already encode this in free text ("Rent increases by 15% after
-- year 2" in CON-00026's notes) and nobody reprices. The three columns make it
-- data; contract_unit_period_amounts makes it money. Once-per-contract is the
-- shape, not a rule to enforce elsewhere.

alter table public.contracts
  add column if not exists increase_after_years integer,
  add column if not exists increase_type text,
  add column if not exists increase_value numeric(14,3);

-- Every populated-branch predicate names a NOT NULL column explicitly: a CHECK
-- that evaluates to NULL passes, so `increase_after_years >= 1` alone would
-- admit a row with only that column set.
alter table public.contracts drop constraint if exists contracts_increase_all_or_none;
alter table public.contracts add constraint contracts_increase_all_or_none check (
  (increase_after_years is null and increase_type is null and increase_value is null)
  or (increase_after_years is not null and increase_after_years >= 1
      and increase_type is not null and increase_type in ('percent', 'fixed')
      and increase_value is not null and increase_value > 0
      and (increase_type <> 'percent' or increase_value <= 100))
);

/**
 * أول شهر تسري فيه الزيادة: بداية العقد + عدد السنوات، مقصوصاً إلى أول الشهر.
 */
create or replace function public.contract_increase_effective_period(p_contract public.contracts)
returns date
language sql
immutable
as $$
  select case
    when p_contract.increase_after_years is null then null
    else date_trunc('month',
           p_contract.start_date + make_interval(years => p_contract.increase_after_years))::date
  end
$$;

/**
 * إيجار كل وحدة في فترة معيّنة، بعد تطبيق الزيادة إن كانت سارية.
 *
 * Percent scales each unit. Fixed is split by largest remainder in whole fils:
 * every unit gets the floor of its exact share, and the leftover fils go one
 * each to the largest fractional parts (ties by line order). Every share is
 * non-negative and the lines sum to base + increase exactly — invoice_items
 * must equal the header.
 */
create or replace function public.contract_unit_period_amounts(
  p_contract_id uuid,
  p_period_start date
)
returns table (unit_id uuid, unit_code text, line_order integer, monthly_amount numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_contract public.contracts%rowtype;
  v_effective date;
  v_base_total numeric(14,3);
  v_total_fils bigint;
  v_leftover bigint;
begin
  select c.* into v_contract from public.contracts c where c.id = p_contract_id;
  if not found then
    raise exception 'Contract not found';
  end if;

  v_effective := public.contract_increase_effective_period(v_contract);

  if v_effective is null or p_period_start < v_effective then
    return query
      select cu.unit_id, u.code, cu.line_order, cu.monthly_amount
        from public.contract_units cu
        join public.units u on u.id = cu.unit_id
       where cu.contract_id = p_contract_id
       order by cu.line_order, cu.unit_id;
    return;
  end if;

  if v_contract.increase_type = 'percent' then
    return query
      select cu.unit_id, u.code, cu.line_order,
             round(cu.monthly_amount * (1 + v_contract.increase_value / 100), 3)
        from public.contract_units cu
        join public.units u on u.id = cu.unit_id
       where cu.contract_id = p_contract_id
       order by cu.line_order, cu.unit_id;
    return;
  end if;

  select coalesce(sum(cu.monthly_amount), 0) into v_base_total
    from public.contract_units cu where cu.contract_id = p_contract_id;
  v_total_fils := round(v_contract.increase_value * 1000)::bigint;

  return query
    with exact as (
      select cu.unit_id, u.code, cu.line_order, cu.monthly_amount,
             (v_total_fils * cu.monthly_amount / nullif(v_base_total, 0)) as share
        from public.contract_units cu
        join public.units u on u.id = cu.unit_id
       where cu.contract_id = p_contract_id
    ),
    floored as (
      select e.*, floor(e.share)::bigint as fils, (e.share - floor(e.share)) as frac
        from exact e
    ),
    ranked as (
      select f.*, row_number() over (order by f.frac desc, f.line_order, f.unit_id) as rn,
             (v_total_fils - sum(f.fils) over ()) as leftover
        from floored f
    )
    select r.unit_id, r.code, r.line_order,
           r.monthly_amount + (r.fils + case when r.rn <= r.leftover then 1 else 0 end) / 1000.0
      from ranked r
     order by r.line_order, r.unit_id;
end;
$$;

revoke execute on function public.contract_unit_period_amounts(uuid, date) from public, anon;
grant execute on function public.contract_unit_period_amounts(uuid, date) to authenticated, service_role;
```

Then re-issue `contract_period_amounts` copying `db/migrations/170_free_month_generates_nothing.sql:57-95` verbatim and replacing

```sql
  select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
    from public.contract_units cu where cu.contract_id = v_contract.id;
```

with

```sql
  -- Period-aware since 196: the unit pricer applies the contract's rent
  -- increase once p_period_start reaches the anniversary.
  select coalesce(sum(upa.monthly_amount), 0) into v_subtotal
    from public.contract_unit_period_amounts(v_contract.id, p_period_start) upa;
```

Keep the `revoke`/`grant` pair from 170:94-95.

- [ ] **Step 4: Run** `TEST_DB_PORT=55329 bun run test:db && TEST_DB_PORT=55329 bun run test:sql -- src/db/rentIncreasePricing.sqltest.ts` — Expected: PASS for the pricer block.

---

### Task 8: Migration 197 — `generate_invoices_for_year` prices through the period pricer

**Files:**
- Create: `db/migrations/197_generate_invoices_uses_period_pricer.sql`
- Test: extend `src/db/rentIncreasePricing.sqltest.ts`

- [ ] **Step 1: Write the failing test**

```ts
export async function invoiceTotals(client: PoolClient, contractId: string, year: number) {
  const { rows } = await client.query<{ period_month: number; subtotal: string; lines: string }>(
    `select i.period_month, i.subtotal,
            (select sum(amount) from public.invoice_items it where it.invoice_id = i.id and not it.is_extra_charge) as lines
       from public.invoices i where i.contract_id = $1 and i.period_year = $2 order by i.period_month`,
    [contractId, year],
  );
  return rows.map((r) => ({ month: r.period_month, subtotal: Number(r.subtotal), lines: Number(r.lines) }));
}

describe("generate_invoices_for_year with an increase", () => {
  test("future invoices on/after the anniversary carry the increase and lines equal the header", async () => {
    await withRollback(async (client) => {
      // Two years ahead so every month is FUTURE: p_include_past=false is the
      // explicit-Generate path and the only one that emits future periods.
      const fx = await seedContract(client, { startDate: "2028-02-01", endDate: "2030-01-31", units: [{ monthlyAmount: 300 }, { monthlyAmount: 200 }] });
      await setIncrease(client, fx.contractId, 1, "percent", 10);
      await client.query(`select public.generate_invoices_for_year($1, 2029, false)`, [fx.contractId]);
      const rows = await invoiceTotals(client, fx.contractId, 2029);
      expect(rows.find((r) => r.month === 1)!.subtotal).toBe(500);
      expect(rows.find((r) => r.month === 2)!.subtotal).toBe(550);
      for (const row of rows) expect(row.lines).toBe(row.subtotal);
    });
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL (February still 500).

- [ ] **Step 3: Write the migration**

Copy `generate_invoices_for_year` from 170 (the `create or replace function public.generate_invoices_for_year(...)` block through its `revoke`/`grant` at 170:260-263) verbatim. Two hunks:

Hunk A — replace

```sql
        select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
          from public.contract_units cu where cu.contract_id = v_contract.id;
        -- Rent plus the contract's recurring extra charges (migration 163).
        -- 1,000 rent with a 100 cleaning charge bills 1,100, and the two are
        -- separate lines on the invoice so the tenant can see which is which.
        v_subtotal := v_subtotal + public.contract_extra_charges_total(v_contract.id);
```

with

```sql
        -- One pricer for all four sites since 196/197: rent (with any increase
        -- in force for this period) plus the recurring extra charges.
        select pa.subtotal into v_subtotal
          from public.contract_period_amounts(v_contract.id, v_period_start) pa;
```

Hunk B — replace the line loop source

```sql
        for v_unit in
          select cu.unit_id, cu.monthly_amount, u.code
            from public.contract_units cu
            join public.units u on u.id = cu.unit_id
           where cu.contract_id = v_contract.id
           order by cu.line_order, cu.unit_id
        loop
```

with

```sql
        for v_unit in
          select upa.unit_id, upa.monthly_amount, upa.unit_code as code
            from public.contract_unit_period_amounts(v_contract.id, v_period_start) upa
           order by upa.line_order, upa.unit_id
        loop
```

`v_period_start` is the variable the free-month check at 170:182 already uses.

- [ ] **Step 4: Run** the SQL test file — Expected: PASS.

---

### Task 9: Migration 198 — `regenerate_contract_invoices` line loop uses the unit pricer

**Files:**
- Create: `db/migrations/198_regenerate_uses_period_pricer.sql`
- Test: extend `src/db/rentIncreasePricing.sqltest.ts`

- [ ] **Step 1: Write the failing test**

Regenerate and sync reprice **every existing invoice**, future months included (170:340-385, 170:515-580). The fixture therefore generates future months first with `p_include_past = false`, then adds the increase.

```ts
describe("regenerate_contract_invoices with an increase", () => {
  test("reprices unpaid future invoices after the anniversary and leaves paid ones", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2028-02-01", endDate: "2030-01-31", monthlyAmount: 500 });
      await client.query(`select public.generate_invoices_for_year($1, 2029, false)`, [fx.contractId]);
      await client.query(`update public.invoices set state='paid', paid=total where contract_id=$1 and period_year=2029 and period_month=1`, [fx.contractId]);
      await setIncrease(client, fx.contractId, 1, "fixed", 50);
      await client.query(`select * from public.regenerate_contract_invoices($1)`, [fx.contractId]);
      const rows = await invoiceTotals(client, fx.contractId, 2029);
      expect(rows.find((r) => r.month === 1)!.subtotal).toBe(500);
      expect(rows.find((r) => r.month === 2)!.subtotal).toBe(550);
      expect(rows.find((r) => r.month === 6)!.subtotal).toBe(550);
      for (const row of rows) if (row.month !== 1) expect(row.lines).toBe(row.subtotal);
    });
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL (header 550, lines 500 on repriced rows).

- [ ] **Step 3: Write the migration**

Copy `regenerate_contract_invoices` from 170 (through `revoke`/`grant` at 170:445-446) verbatim. One hunk — the line loop source at 170:363-369:

```sql
      for v_unit in
        select upa.unit_id, upa.monthly_amount, upa.unit_code as code
          from public.contract_unit_period_amounts(v_contract.id, v_period_start) upa
         order by upa.line_order, upa.unit_id
      loop
```

- [ ] **Step 4: Run** — Expected: PASS.

---

### Task 10: Migration 199 — `sync_contract_invoice_schedule` reprice and fill use the pricer

**Files:**
- Create: `db/migrations/199_sync_schedule_uses_period_pricer.sql`
- Test: extend `src/db/rentIncreasePricing.sqltest.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("sync_contract_invoice_schedule with an increase", () => {
  test("reprices existing future invoices and fills a missing month with the increase; lines equal header", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2028-02-01", endDate: "2030-01-31", monthlyAmount: 500 });
      await client.query(`select public.generate_invoices_for_year($1, 2029, false)`, [fx.contractId]);
      await client.query(`delete from public.invoice_items where invoice_id in (select id from public.invoices where contract_id=$1 and period_year=2029 and period_month=5)`, [fx.contractId]);
      await client.query(`delete from public.invoices where contract_id=$1 and period_year=2029 and period_month=5`, [fx.contractId]);
      await setIncrease(client, fx.contractId, 1, "percent", 10);
      await client.query(`select * from public.sync_contract_invoice_schedule($1)`, [fx.contractId]);
      const rows = await invoiceTotals(client, fx.contractId, 2029);
      expect(rows.find((r) => r.month === 2)!.subtotal).toBe(550);
      expect(rows.find((r) => r.month === 5)!.subtotal).toBe(550);
      for (const row of rows) expect(row.lines).toBe(row.subtotal);
    });
  });
});
```

The fill pass creates future months only for `active` contracts (170:670-676), which `seedContract` defaults to.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Write the migration**

Copy `sync_contract_invoice_schedule` from 170 (through `revoke`/`grant` at 170:769-771) verbatim. Three hunks:

Hunk A (reprice line loop, 170:571-577): same replacement as Task 9, period `v_period_start`.

Hunk B (fill pricing, 170:676-682): replace

```sql
      select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
        from public.contract_units cu where cu.contract_id = p_contract_id;
      -- This branch prices a missing period from scratch rather than asking
      -- contract_period_amounts, so it needs the extras added here too.
      v_subtotal := v_subtotal + public.contract_extra_charges_total(p_contract_id);
```

with

```sql
      -- Priced through the shared pricer since 199, so a fill and a reprice
      -- can never disagree about the same month.
      select pa.subtotal into v_subtotal
        from public.contract_period_amounts(p_contract_id, v_cursor) pa;
```

Hunk C (fill line loop, 170:713-719): same replacement, period `v_cursor`.

- [ ] **Step 4: Run** the SQL test file — Expected: PASS.

---

### Task 11: Migration 200 — `save_contract_with_units` accepts the increase and locks it

**Files:**
- Create: `db/migrations/200_save_contract_accepts_increase.sql`
- Test: extend `src/db/rentIncreasePricing.sqltest.ts`

- [ ] **Step 1: Write the failing tests**

Find how existing sqltests authenticate calls to `save_contract_with_units` (`grep -l save_contract_with_units src/db/*.sqltest.ts`) and copy that setup verbatim into a helper `asContractsAdmin(client)`. The RPC checks `has_permission(auth.uid(), 'contracts.create' | 'contracts.update')` unconditionally, so `actAsSuperuser` (which clears the identity) will NOT work; use `actAs` with a user that holds those permissions, as the neighbouring tests do.

```ts
async function saveRpc(client: PoolClient, contract: Record<string, unknown>, unitId: string, contractId: string | null) {
  return client.query<{ id: string }>(
    `select (public.save_contract_with_units($1::jsonb, $2::jsonb, $3::uuid)).id as id`,
    [JSON.stringify(contract), JSON.stringify([{ unit_id: unitId, monthly_amount: 500 }]), contractId],
  );
}

describe("save_contract_with_units increase", () => {
  test("a true create stores the trio", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2028-02-01", endDate: "2030-01-31" });
      await asContractsAdmin(client);
      const { rows } = await saveRpc(client, {
        tenant_id: fx.tenantId, start_date: "2028-02-01", end_date: "2030-01-31", duration_months: 24,
        increase_after_years: 1, increase_type: "percent", increase_value: 10,
      }, fx.unitId, null);
      const saved = await client.query(`select increase_after_years, increase_type, increase_value from public.contracts where id=$1`, [rows[0].id]);
      expect(saved.rows[0]).toMatchObject({ increase_after_years: 1, increase_type: "percent" });
      expect(Number(saved.rows[0].increase_value)).toBe(10);
    });
  });

  test("absent keys preserve, explicit null clears, unchanged patch never raises", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2028-02-01", endDate: "2030-01-31" });
      await setIncrease(client, fx.contractId, 1, "percent", 10);
      await asContractsAdmin(client);
      await saveRpc(client, { notes: "x" }, fx.unitId, fx.contractId);
      let row = await client.query(`select increase_type from public.contracts where id=$1`, [fx.contractId]);
      expect(row.rows[0].increase_type).toBe("percent");
      await saveRpc(client, { increase_after_years: 1, increase_type: "percent", increase_value: 10 }, fx.unitId, fx.contractId);
      await saveRpc(client, { increase_after_years: null, increase_type: null, increase_value: null }, fx.unitId, fx.contractId);
      row = await client.query(`select increase_type from public.contracts where id=$1`, [fx.contractId]);
      expect(row.rows[0].increase_type).toBeNull();
    });
  });

  test("refuses a change once a post-anniversary invoice carries money, including overdue partials", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2028-02-01", endDate: "2030-01-31" });
      await setIncrease(client, fx.contractId, 1, "percent", 10);
      await client.query(`select public.generate_invoices_for_year($1, 2029, false)`, [fx.contractId]);
      await client.query(`update public.invoices set state='overdue', paid=100 where contract_id=$1 and period_year=2029 and period_month=6`, [fx.contractId]);
      await asContractsAdmin(client);
      await expect(saveRpc(client, { increase_value: 15 }, fx.unitId, fx.contractId)).rejects.toThrow(/Rent increase is locked/);
      await expect(saveRpc(client, { increase_after_years: null, increase_type: null, increase_value: null }, fx.unitId, fx.contractId)).rejects.toThrow(/Rent increase is locked/);
      await expect(saveRpc(client, { start_date: "2028-01-01" }, fx.unitId, fx.contractId)).rejects.toThrow(/Rent increase is locked/);
    });
  });

  test("clearing an unlocked increase and syncing reprices back", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2028-02-01", endDate: "2030-01-31", monthlyAmount: 500 });
      await setIncrease(client, fx.contractId, 1, "percent", 10);
      await client.query(`select public.generate_invoices_for_year($1, 2029, false)`, [fx.contractId]);
      await asContractsAdmin(client);
      await saveRpc(client, { increase_after_years: null, increase_type: null, increase_value: null }, fx.unitId, fx.contractId);
      await client.query(`select * from public.sync_contract_invoice_schedule($1)`, [fx.contractId]);
      const rows = await invoiceTotals(client, fx.contractId, 2029);
      expect(rows.find((r) => r.month === 6)!.subtotal).toBe(500);
      expect(rows.find((r) => r.month === 6)!.lines).toBe(500);
    });
  });
});
```

If `saveRpc`'s `(fn(...)).id` projection does not compile against the RPC's `returns public.contracts`, use `select id from public.save_contract_with_units(...)`.

- [ ] **Step 2: Run** — Expected: FAIL (columns not saved / no lock).

- [ ] **Step 3: Write the migration**

Copy `save_contract_with_units` from `db/migrations/173_suppress_tenant_billing_docs.sql` (the `create or replace function` through its grants) verbatim. Apply:

Hunk A — create branch: append `, increase_after_years, increase_type, increase_value` to the column list and

```sql
      (p_contract->>'increase_after_years')::integer,
      p_contract->>'increase_type',
      (p_contract->>'increase_value')::numeric
```

to the values.

Hunk B — replace the start of the update branch (`else` … up to `update public.contracts c set`) so it reads:

```sql
  else
    -- قفل الزيادة: لا تتغيّر بعد تسجيل مال على فاتورة في أو بعد فترة سريانها.
    -- The candidate is built with the SAME key-presence rules as the UPDATE
    -- below (absent preserves, explicit null clears), including start_date,
    -- which moves the anniversary. Row locks are the protocol shared with
    -- set_invoice_paid / apply_payment_allocation, which lock the invoice row
    -- before writing money, so a payment and an increase change serialise.
    select c.* into v_before from public.contracts c where c.id = p_contract_id for update;
    if not found then raise exception 'Contract not found'; end if;
    v_candidate := v_before;
    v_candidate.start_date := coalesce((p_contract->>'start_date')::date, v_before.start_date);
    if p_contract ? 'increase_after_years' then
      v_candidate.increase_after_years := (p_contract->>'increase_after_years')::integer;
    end if;
    if p_contract ? 'increase_type' then
      v_candidate.increase_type := p_contract->>'increase_type';
    end if;
    if p_contract ? 'increase_value' then
      v_candidate.increase_value := (p_contract->>'increase_value')::numeric;
    end if;
    v_old_effective := public.contract_increase_effective_period(v_before);
    v_new_effective := public.contract_increase_effective_period(v_candidate);
    if v_candidate.increase_after_years is distinct from v_before.increase_after_years
       or v_candidate.increase_type is distinct from v_before.increase_type
       or v_candidate.increase_value is distinct from v_before.increase_value
       or v_new_effective is distinct from v_old_effective then
      v_lock_from := least(v_old_effective, v_new_effective);
      if v_lock_from is not null then
        perform 1 from public.invoices i
         where i.contract_id = p_contract_id
           and make_date(i.period_year, i.period_month, 1) >= v_lock_from
           and (i.state in ('paid', 'partially_paid') or coalesce(i.paid, 0) > 0)
         for update;
        if found then
          raise exception 'Rent increase is locked: an invoice on or after its effective period has been paid'
            using errcode = '22023';
        end if;
      end if;
    end if;

    update public.contracts c set
```

Declare `v_before public.contracts%rowtype; v_candidate public.contracts%rowtype; v_old_effective date; v_new_effective date; v_lock_from date;` in the function's `declare` block (no nested block).

Hunk C — in the `update public.contracts c set` list add:

```sql
      increase_after_years = case when p_contract ? 'increase_after_years' then (p_contract->>'increase_after_years')::integer else c.increase_after_years end,
      increase_type = case when p_contract ? 'increase_type' then p_contract->>'increase_type' else c.increase_type end,
      increase_value = case when p_contract ? 'increase_value' then (p_contract->>'increase_value')::numeric else c.increase_value end,
```

- [ ] **Step 4: Run** `TEST_DB_PORT=55329 bun run test:db && TEST_DB_PORT=55329 bun run test:sql` (full) — Expected: PASS, including every pre-existing sqltest.

---

### Task 12: Types, Zod trio, save payload, prefill

**Files:**
- Modify: `src/integrations/supabase/database.types.ts` (`ContractRow`, ~505-540), `src/lib/contractForm.ts:66-110,244-300`, `src/hooks/useContracts.ts:440-460`, `src/components/admin/contracts/useContractFormPrefill.ts`
- Create: `src/lib/contractIncrease.ts`
- Test: `src/lib/contractForm.test.ts` (extend or create), `src/lib/contractIncrease.test.ts`

**Interfaces:**
- Produces: `ContractFormValues.increase: { after_years: number; type: "percent" | "fixed"; value: number } | null`; `ContractSaveInput.increase_after_years/increase_type/increase_value`; `contractIncreaseEffectivePeriod(startDate: string, afterYears: number): string` (`YYYY-MM`); `contractIncreaseLabel(locale, type, value, effective): string`.

- [ ] **Step 1: Write the failing tests**

`src/lib/contractIncrease.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { contractIncreaseEffectivePeriod, contractIncreaseLabel } from "@/lib/contractIncrease";

describe("contractIncreaseEffectivePeriod", () => {
  test("adds whole years and truncates to the month", () => {
    expect(contractIncreaseEffectivePeriod("2025-02-15", 2)).toBe("2027-02");
  });
});

describe("contractIncreaseLabel", () => {
  test("percent in Arabic and English", () => {
    expect(contractIncreaseLabel("ar", "percent", 10, "2027-02")).toBe("زيادة 10% من 2027-02");
    expect(contractIncreaseLabel("en", "percent", 10, "2027-02")).toBe("Increase 10% from 2027-02");
  });
  test("fixed shows KWD", () => {
    expect(contractIncreaseLabel("en", "fixed", 100, "2027-02")).toBe("Increase 100 KWD from 2027-02");
  });
});
```

In `contractForm.test.ts` (a valid baseline needs `property_ids`, `tenant_id`, dates and one unit — existing tests in that file show the minimal valid shape; reuse their fixture):

```ts
  test("increase: percent above 100 is rejected, fixed is not capped, null is fine", () => {
    const base = validContractValues(); // the file's existing valid fixture builder; create one if absent
    expect(contractFormSchema.safeParse({ ...base, increase: { after_years: 1, type: "percent", value: 150 } }).success).toBe(false);
    expect(contractFormSchema.safeParse({ ...base, increase: { after_years: 1, type: "fixed", value: 150 } }).success).toBe(true);
    expect(contractFormSchema.safeParse({ ...base, increase: null }).success).toBe(true);
  });

  test("buildContractSavePayload flattens the increase and clears it when null", () => {
    const values = { ...contractFormDefaults, increase: { after_years: 2, type: "fixed" as const, value: 50 } };
    expect(buildContractSavePayload(values).contract).toMatchObject({ increase_after_years: 2, increase_type: "fixed", increase_value: 50 });
    expect(buildContractSavePayload({ ...contractFormDefaults, increase: null }).contract).toMatchObject({ increase_after_years: null, increase_type: null, increase_value: null });
  });
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

`database.types.ts` `ContractRow`:

```ts
  /** Migration 196 — one rent increase per contract, effective from start_date + N years. All three set or all null. */
  increase_after_years: number | null;
  increase_type: "percent" | "fixed" | null;
  increase_value: number | null;
```

`src/lib/contractIncrease.ts`:

```ts
import type { Locale } from "@/i18n/dictionary";

export type ContractIncreaseType = "percent" | "fixed";

/**
 * أول شهر تسري فيه الزيادة (YYYY-MM): بداية العقد + السنوات.
 *
 * Mirrors `contract_increase_effective_period` in migration 196 so the form
 * and the table show the same month the database prices from.
 */
export function contractIncreaseEffectivePeriod(startDate: string, afterYears: number): string {
  const [year, month] = startDate.split("-").map(Number);
  return `${year + afterYears}-${String(month).padStart(2, "0")}`;
}

/**
 * نص موجز للزيادة يُعرض في جدول العقود وملخّص النموذج.
 */
export function contractIncreaseLabel(
  locale: Locale,
  type: ContractIncreaseType,
  value: number,
  effective: string,
): string {
  const amount = type === "percent" ? `${value}%` : `${value} KWD`;
  return locale === "ar" ? `زيادة ${amount} من ${effective}` : `Increase ${amount} from ${effective}`;
}
```

`contractForm.ts` schema:

```ts
  /**
   * زيادة إيجار واحدة اختيارية؛ null يعني لا زيادة.
   */
  increase: z
    .object({
      after_years: z.preprocess((v) => Number(v), z.number().int().min(1)),
      type: z.enum(["percent", "fixed"]),
      value: z.preprocess((v) => Number(v), z.number().positive()),
    })
    .refine((v) => v.type !== "percent" || v.value <= 100, { message: "contracts.increase.percentCap", path: ["value"] })
    .nullable(),
```

`contractFormDefaults.increase = null`. In `buildContractSavePayload`, destructure `increase` out of `values` and add:

```ts
      increase_after_years: increase?.after_years ?? null,
      increase_type: increase?.type ?? null,
      increase_value: increase?.value ?? null,
```

`useContracts.ts` `ContractSaveInput`: add `increase_after_years: number | null; increase_type: "percent" | "fixed" | null; increase_value: number | null;`.

`useContractFormPrefill.ts`: where `editing` maps onto form values, set `increase: editing.increase_after_years != null && editing.increase_type ? { after_years: editing.increase_after_years, type: editing.increase_type, value: Number(editing.increase_value) } : null`.

- [ ] **Step 4: Run** `bun run test -- src/lib/contractForm.test.ts src/lib/contractIncrease.test.ts && bun run typecheck` — Expected: PASS.

---

### Task 13: Form section, lock state, i18n, contracts table label

**Files:**
- Create: `src/components/admin/contracts/ContractIncreaseSection.tsx`
- Modify: `src/components/admin/contracts/ContractFormDialog.tsx` (mount after `ContractExtraChargesField`, ~line 421), `src/components/admin/contracts/contractFormLabels.ts`, `src/components/admin/contracts/ContractsTable.tsx:239`, `src/i18n/dictionary.ts` (ar near 734, en near 2897)
- Test: `src/components/admin/contracts/ContractIncreaseSection.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { ContractIncreaseSection } from "@/components/admin/contracts/ContractIncreaseSection";

const labels = { title: "Rent increase", enable: "Apply an increase", afterYears: "After year", type: "Type", percent: "Percent", fixed: "Fixed", value: "Value", locked: "Locked: an invoice after the effective period is paid", effectiveFrom: "Effective from" };

describe("ContractIncreaseSection", () => {
  test("renders read-only with the lock note when locked", () => {
    render(<ContractIncreaseSection value={{ after_years: 1, type: "percent", value: 10 }} onChange={vi.fn()} locked startDate="2025-02-01" labels={labels} locale="en" />);
    expect(screen.getByText(/Locked:/)).toBeInTheDocument();
    expect(screen.getByLabelText("Value")).toHaveAttribute("disabled", "");
    expect(screen.getByText(/Effective from 2026-02/)).toBeInTheDocument();
  });
  test("toggling on emits a default trio", () => {
    const onChange = vi.fn();
    render(<ContractIncreaseSection value={null} onChange={onChange} locked={false} startDate="2025-02-01" labels={labels} locale="en" />);
    screen.getByRole("switch").click();
    expect(onChange).toHaveBeenCalledWith({ after_years: 1, type: "percent", value: 0 });
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

`ContractIncreaseSection.tsx` — controlled section with props `value`, `onChange`, `locked`, `startDate`, `labels`, `locale`, optional `valueError`: a shadcn `Switch` toggling `null` ↔ `{ after_years: 1, type: "percent", value: 0 }`; when set, a number input (`after_years`), a `Select` (percent/fixed) and a number input (`value`) using the dialog's primitives, each `disabled={locked}`; when locked a muted `<p>` with `labels.locked`; when set, a line `${labels.effectiveFrom} ${contractIncreaseEffectivePeriod(startDate, after_years)}`; `valueError` rendered under the value input. Wrapper `className="sm:col-span-2 lg:col-span-3"`. Under 200 lines, Arabic doc comment.

`contractFormLabels.ts`: add `contractIncreaseLabels(t)` returning the ten `contracts.increase.*` strings.

Dialog: `const increase = form.watch("increase");` mount after `ContractExtraChargesField` with `onChange={(v) => form.setValue("increase", v, { shouldDirty: true })}`, `startDate={startDate}`, `locale={locale}`, `labels={contractIncreaseLabels(t)}`, `valueError={form.formState.errors.increase?.value?.message ? t(form.formState.errors.increase.value.message) : undefined}`. `locked`: when editing and `editing.increase_after_years != null`, `useQuery(["contract-increase-locked", editing.id])` selecting `count` from `invoices` where `contract_id = editing.id`, `.or("state.in.(paid,partially_paid),paid.gt.0")`, and period on/after `contractIncreaseEffectivePeriod(editing.start_date, editing.increase_after_years)` via `.or(\`period_year.gt.${y},and(period_year.eq.${y},period_month.gte.${m})\`)`; `locked = count > 0`.

i18n keys (both locales):

```
"contracts.increase.title": "زيادة الإيجار" / "Rent increase"
"contracts.increase.enable": "تطبيق زيادة" / "Apply an increase"
"contracts.increase.afterYears": "بعد سنة رقم" / "After year"
"contracts.increase.type": "نوع الزيادة" / "Increase type"
"contracts.increase.percent": "نسبة مئوية" / "Percent"
"contracts.increase.fixed": "مبلغ ثابت" / "Fixed amount"
"contracts.increase.value": "القيمة" / "Value"
"contracts.increase.percentCap": "النسبة لا تتجاوز 100%" / "Percent cannot exceed 100%"
"contracts.increase.locked": "مقفلة: سُدِّدت فاتورة بعد فترة السريان" / "Locked: an invoice after the effective period is paid"
"contracts.increase.effectiveFrom": "تسري من" / "Effective from"
```

`ContractsTable.tsx:239`: under the monthly amount, when `contract.increase_after_years != null && contract.increase_type`, render `<div className="text-xs text-muted-foreground">{contractIncreaseLabel(locale, contract.increase_type, Number(contract.increase_value), contractIncreaseEffectivePeriod(contract.start_date, contract.increase_after_years))}</div>`. There is no contract detail page; the table is the display surface.

- [ ] **Step 4: Run** `bun run test && bun run typecheck && bun run lint` — Expected: PASS.

---

### Task 14: Orchestrator gates, guards, docs

- [ ] `bun run lint && bun run typecheck && bun run test && TEST_DB_PORT=55329 bun run test:sql` all green on the assembled branch.
- [ ] `clean-code-guard` over every production file changed; `test-guard` over every test; `docs-guard` over the migration headers and any README touched.
- [ ] `graphify update .`

---

## Debate — round 1 (Codex astra 6 high, `gpt-6-astra --effort high`, relay `--read-only`; tree verified unchanged against baseline 2a01634)

| # | Finding | Sev | Verdict | Reason |
|---|---------|-----|---------|--------|
| 1 | All-or-none CHECK accepts partial rows (NULL passes) | P1 | accept | Every populated-branch predicate now names `is not null`; six partial combinations tested (Task 7). |
| 2 | `evaluate_overdue` moves partially paid to overdue, defeating a state-only lock | P1 | accept | Lock predicate is `state in (paid, partially_paid) or coalesce(paid,0) > 0`; overdue-partial case tested (Task 11). |
| 3 | Editing `start_date` moves the anniversary past the lock | P1 | accept | Candidate built with the UPDATE's own coalesce rules incl. `start_date`; lock fires when the effective period changes; tested (Task 11). |
| 4 | Lock not serialised with payments | P1 | partial | Contract row `for update` and qualifying invoices `for update`, matching the locks `set_invoice_paid`/`apply_payment_allocation` take on the invoice row. A two-session interleaving test is out of scope; the row-lock protocol is the guarantee and is stated in the spec. |
| 5 | SQL reminders filter would silence admin expiry alerts | P1 | accept | Confirmed at `contractExpiryJob.ts:90-98`: one candidate list feeds both. SQL re-issue dropped; job + dispatcher gate on `audience === "tenant"`; admin-alert-still-sent tested (Task 6). |
| 6 | Save reports success while sync failed | P1 | reject | Pre-existing and already surfaced: `ContractFormDialog.tsx:276-278` shows `contracts.regenerateError` on sync failure, not a success toast. Spec now states the two-request shape explicitly. Atomic save+reprice is a separate change. |
| 7 | Close-out seed ignores a later move-out date | P2 | accept | `reseedUntouched` re-seeds rows the operator has not touched when the date changes; tested (Task 4). |
| 8 | Migration 195 invoice UPDATE lacks the contract predicates | P2 | accept | Predicates repeated on the invoice statement; terminated-on-day-1 test added (Task 5). |
| 9 | Last-line remainder can go negative | P2 | accept | Largest-remainder allocation in whole fils; six-units-at-0.001 test asserts every line ≥ base (Task 7). |
| 10 | Lock candidate ignores absent-key semantics | P2 | accept | Candidate assigned only for present keys; absent/explicit-null/unchanged/real-change cases tested (Task 11). |
| 11 | Future repricing described wrongly and not tested | P2 | accept | Plan text corrected (regenerate/sync reprice every existing invoice); fixtures generate future years with `p_include_past=false` and assert them (Tasks 8–10). |
| 12 | Fixtures violate pay-oldest-first / superuser identity / empty property_ids | P2 | accept | Task 1 acts on period 1; Task 11 uses the permitted-user setup other save-RPC tests use; Task 12 reuses the file's valid fixture. |
| 13 | No true create test, no clear-and-reprice test | P2 | accept | Both added (Task 11); self-review claim corrected. |
| 14 | "Every contract bills on the 1st" has no lasting enforcement | P2 | partial | Declared a one-time normalisation in spec and migration header; form/RPC keep accepting 1–28 by design. Due dates only move earlier here, so no overdue→due reversal is needed; stated. |
| 15 | Detail-page display silently replaced by table label | P2 | partial | The spec was wrong: there is no contract detail route (`src/routes` has the list and the close-out wizard only). Spec corrected to name the table as the display surface. |

## Review — superpowers:requesting-code-review (Claude general-purpose subagent, range b626db3..4413bb8)

Verdict: "With fixes". No critical findings.

| # | Finding | Sev | Verdict | Reason |
|---|---------|-----|---------|--------|
| 1 | A first increase can never be recorded on a contract already past its anniversary with paid invoices (CON-00026's own case) | Important | accept | Lock now applies only when an existing increase changes or is cleared; recording the first one is always accepted. Spec, migration 200 and two new sqltests updated. |
| 2 | Comment overstates serialisation with `set_invoice_paid` | Important | accept | Comment in 200 and the spec now describe exactly what the row locks cover and what they do not; the residual race was already accepted in debate #4. |
| 3 | `LEAST` comment wrong for PostgreSQL (it ignores NULLs) | Minor | accept | `coalesce` wrapper removed, comment corrected. |
| 4 | Zod `positive()` message untranslated; `after_years` errors never surfaced | Minor | accept | `contracts.increase.valuePositive` key in both locales; the dialog surfaces either field's message under the value input. |
| 5 | `export`ed helpers in a sqltest file | Minor | accept | Exports dropped. |
| 6 | No negative lock test for a paid invoice before the effective period | Minor | accept | Test added. |
| 7 | `ContractFormDialog.tsx` 670 lines, closeout route 1115 | Minor | partial | Plan confined the dialog change to a mount point + lock query; both files are pre-existing offenders listed for a later split. |
| 8 | Leap-day parity test for `contractIncreaseEffectivePeriod` | Minor | reject | Both sides truncate to the month; a `02-29` start yields `-02` in JS and SQL alike. Out of scope for this PR. |

## PR review — Codex round 1 (PR #199, commit f808479, `@codex review`)

| # | Finding | Sev | Verdict | Reason |
|---|---------|-----|---------|--------|
| 1 | `contract_unit_period_amounts` is SECURITY DEFINER and executable by `authenticated`; a portal tenant could read another contract's unit rents | P1 | accept | Revoked from `authenticated`; granted to `service_role` only. The four invoice functions call it as owner; no client code calls it. Grant test added. |
| 2 | Close-out seed defaults cancelled/waived future months to `write_off`, which `closeout_compute_settlement` rejects | P2 | accept | `defaultInvoiceAction` now takes the invoice state; terminal states stay `leave`. Tests added. |
| 3 | The plan document is 1,425 lines, above the file ceiling | P1 | reject | Precedent: `docs/superpowers/plans/` holds three plans between 2,313 and 2,458 lines. A plan is read whole by an implementer; splitting it by task loses the global constraints each slice must carry. The ceiling targets code. |
| 4 | `ContractFormDialog.tsx` grew from 621 to 673 lines | P1 | partial | Lock query extracted to `useContractIncreaseLock.ts`; the dialog is 643 lines, the residual delta being the mount point and its error wiring. The file was over the ceiling before this PR; a full split is a separate task. |
| 5 | `invoiceIn` test fixture lacks an Arabic doc comment | P1 | accept | Added. |

## Self-review

- Spec coverage: guard (T1), action column (T2), filter (T3), wizard seed + reseed (T4), due-day migration (T5), reminders on both channels with admin untouched (T6), schema + pricers (T7), four sites (T8–T10), save RPC lock (T11), types/Zod/payload/prefill (T12), form section, table label, i18n (T13). DANA-000024 unchanged by decision. Every spec test is named in a task.
- Placeholders: none. Three "read the neighbouring test" notes point at exact files and are about fixture plumbing, not behaviour.
- Type consistency: `contract_unit_period_amounts(unit_id, unit_code, line_order, monthly_amount)` identical in T7–T10; `increase` trio names identical across T11 JSON keys, T12 types, T13 labels; `reseedUntouched`/`defaultInvoiceAction` signatures identical between T4's test and implementation.
