import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * Migrations 163-166 — recurring extra charges on a contract.
 *
 * The requirement in one sentence: 1,000 rent with a 100 cleaning charge bills
 * 1,100 every month, as two lines, for the whole term — and editing the charge
 * later rewrites the unpaid invoices while leaving the paid ones alone.
 *
 * These run against a real Postgres because the whole change lives in plpgsql.
 * FOUR functions price an invoice in this database and each was edited
 * separately; a unit test of the TypeScript would prove nothing about any of
 * them, and the failure mode when one is missed is not an error — it is an
 * invoice that bills rent alone and balances perfectly against its own items.
 */

/** السنة التي تعمل عليها هذه الاختبارات — الحالية، فالمولّد لا يتجاوزها. */
const THIS_YEAR = new Date().getFullYear();

/**
 * ينشئ تصنيف مصروف ويعيد معرّفه.
 *
 * A fresh category per test rather than a shared seed: `expense_categories`
 * has a unique `code`, and two tests reusing one name would pass or fail
 * together for reasons unrelated to what either is checking.
 */
async function seedExpenseCategory(client: PoolClient, nameAr: string, nameEn: string) {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.expense_categories (code, name_ar, name_en)
     values ($1, $2, $3) returning id`,
    [`EC-${tag}`, nameAr, nameEn],
  );
  return rows[0].id;
}

/**
 * مستخدم إداري لاستدعاء دوال الحفظ التي تفرض الصلاحيات.
 *
 * `save_contract_with_units` checks `has_permission(auth.uid(), ...)`
 * unconditionally, not only when `auth.role() = 'authenticated'`. Calling it as
 * the pool's own superuser leaves `auth.uid()` null, and the function refuses —
 * so these tests must adopt a real identity, then hand the role back before
 * asserting through RLS-protected tables.
 */
async function seedAdmin(client: PoolClient): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `insert into public.user_roles (user_id, role) values ($1, 'admin'::public.app_role)`,
    [userId],
  );
  await client.query(
    `insert into public.profiles (id, email, display_name, is_active)
     values ($1, $2, 'Extra Charges Admin', true)
     on conflict (id) do nothing`,
    [userId, `${userId}@example.test`],
  );
  return userId;
}

/** عقد لسنة كاملة بإيجار واحد، جاهز للتوليد. */
async function seedYearContract(client: PoolClient, monthlyAmount = 1000) {
  return seedContract(client, {
    startDate: `${THIS_YEAR}-01-01`,
    endDate: `${THIS_YEAR}-12-31`,
    monthlyAmount,
  });
}

/** يضيف مصروفاً شهرياً على العقد. */
async function addExtraCharge(
  client: PoolClient,
  contractId: string,
  categoryId: string,
  amount: number,
) {
  await client.query(
    `insert into public.contract_extra_charges (contract_id, category_id, amount, line_order)
     values ($1, $2, $3, 1)`,
    [contractId, categoryId, amount],
  );
}

/** يولّد فواتير السنة الحالية للعقد بما فيها الأشهر الماضية. */
async function generateYear(client: PoolClient, contractId: string) {
  await client.query(`select * from public.generate_invoices_for_year($1, $2, true)`, [
    contractId,
    THIS_YEAR,
  ]);
}

/** بنود فاتورة واحدة بترتيب السطر. */
async function itemsOf(client: PoolClient, invoiceId: string) {
  const { rows } = await client.query<{
    line: number;
    unit_id: string | null;
    description_ar: string;
    description_en: string;
    amount: string;
  }>(
    `select line, unit_id, description_ar, description_en, amount
       from public.invoice_items where invoice_id = $1 order by line`,
    [invoiceId],
  );
  return rows;
}

/** أول فاتورة للعقد بترتيب الفترة. */
async function firstInvoice(client: PoolClient, contractId: string) {
  const { rows } = await client.query<{
    id: string;
    subtotal: string;
    total: string;
    state: string;
  }>(
    `select id, subtotal, total, state::text as state from public.invoices
      where contract_id = $1 order by period_year, period_month limit 1`,
    [contractId],
  );
  return rows[0];
}

describe("contract_extra_charges_total", () => {
  test("is zero for a contract carrying none", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client);
      const { rows } = await client.query<{ total: string }>(
        `select public.contract_extra_charges_total($1) as total`,
        [contractId],
      );
      expect(Number(rows[0].total)).toBe(0);
    });
  });

  test("sums every charge on the contract, not just the first", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client);
      await addExtraCharge(
        client,
        contractId,
        await seedExpenseCategory(client, "نظافة", "Cleaning"),
        100,
      );
      await client.query(
        `insert into public.contract_extra_charges (contract_id, category_id, amount, line_order)
         values ($1, $2, 30, 2)`,
        [contractId, await seedExpenseCategory(client, "حراسة", "Security")],
      );
      const { rows } = await client.query<{ total: string }>(
        `select public.contract_extra_charges_total($1) as total`,
        [contractId],
      );
      expect(Number(rows[0].total)).toBe(130);
    });
  });

  test.each([0, -50])(
    "refuses an amount of %d at the table, not only in the form",
    async (amount) => {
      // The form rejects these too, but the bulk importer and any future caller
      // go straight to the table — the same gap migration 150 had to close for
      // contract_units.
      await withRollback(async (client) => {
        const { contractId } = await seedYearContract(client);
        const categoryId = await seedExpenseCategory(client, "نظافة", "Cleaning");
        await expect(addExtraCharge(client, contractId, categoryId, amount)).rejects.toThrow();
      });
    },
  );

  test("refuses a second charge on the same category", async () => {
    // Two "cleaning" rows would render as two identical PDF lines nobody can
    // tell apart; raising the amount means editing the row, not adding another.
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client);
      const categoryId = await seedExpenseCategory(client, "نظافة", "Cleaning");
      await addExtraCharge(client, contractId, categoryId, 100);
      await expect(addExtraCharge(client, contractId, categoryId, 150)).rejects.toThrow();
    });
  });
});

describe("generate_invoices_for_year with extra charges", () => {
  test("bills 1000 rent + 100 cleaning as 1100 across two lines", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 1000);
      await addExtraCharge(
        client,
        contractId,
        await seedExpenseCategory(client, "نظافة", "Cleaning"),
        100,
      );

      await generateYear(client, contractId);

      const invoice = await firstInvoice(client, contractId);
      expect(Number(invoice.subtotal)).toBe(1100);
      expect(Number(invoice.total)).toBe(1100);

      const items = await itemsOf(client, invoice.id);
      expect(items).toHaveLength(2);
      expect(Number(items[0].amount)).toBe(1000);
      expect(Number(items[1].amount)).toBe(100);
      // The charge is raised by the CONTRACT, not by one of its units.
      // Attributing it to a unit would corrupt the per-unit revenue split
      // `invoice_items.unit_id` exists to carry.
      expect(items[0].unit_id).not.toBeNull();
      expect(items[1].unit_id).toBeNull();
      expect(items[1].description_ar).toBe("نظافة");
      expect(items[1].description_en).toBe("Cleaning");
    });
  });

  test("bills every month of the term, not only the first", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 1000);
      await addExtraCharge(
        client,
        contractId,
        await seedExpenseCategory(client, "نظافة", "Cleaning"),
        100,
      );

      await generateYear(client, contractId);

      const { rows } = await client.query<{ count: string; wrong: string }>(
        `select count(*) as count,
                count(*) filter (where total <> 1100) as wrong
           from public.invoices where contract_id = $1`,
        [contractId],
      );
      expect(Number(rows[0].count)).toBeGreaterThan(1);
      expect(Number(rows[0].wrong)).toBe(0);
    });
  });

  test("bills rent alone when the contract carries no charges", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 1000);
      await generateYear(client, contractId);
      const invoice = await firstInvoice(client, contractId);
      expect(Number(invoice.total)).toBe(1000);
      expect(await itemsOf(client, invoice.id)).toHaveLength(1);
    });
  });
});

describe("regenerate_contract_invoices with extra charges", () => {
  test("rewrites an unpaid invoice to the new charge and leaves a paid one alone", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 1000);
      const categoryId = await seedExpenseCategory(client, "نظافة", "Cleaning");
      await addExtraCharge(client, contractId, categoryId, 100);
      await generateYear(client, contractId);

      // Settle the first invoice, then raise the charge.
      const paid = await firstInvoice(client, contractId);
      await client.query(`update public.invoices set paid = total, state = 'paid' where id = $1`, [
        paid.id,
      ]);
      await client.query(
        `update public.contract_extra_charges set amount = 150 where contract_id = $1`,
        [contractId],
      );

      await client.query(`select * from public.regenerate_contract_invoices($1)`, [contractId]);

      const { rows } = await client.query<{ id: string; total: string; state: string }>(
        `select id, total, state::text as state from public.invoices
          where contract_id = $1 order by period_year, period_month`,
        [contractId],
      );
      // Settled money is sacred: the paid invoice keeps the figure it was paid
      // against, whatever the contract says today.
      expect(Number(rows[0].total)).toBe(1100);
      expect(rows[0].state).toBe("paid");
      // Every unpaid one moves to the new figure.
      for (const row of rows.slice(1)) {
        expect(Number(row.total)).toBe(1150);
      }
      const items = await itemsOf(client, rows[1].id);
      expect(items).toHaveLength(2);
      expect(Number(items[1].amount)).toBe(150);
    });
  });

  test("removes the extra line when the charge is deleted", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 1000);
      await addExtraCharge(
        client,
        contractId,
        await seedExpenseCategory(client, "نظافة", "Cleaning"),
        100,
      );
      await generateYear(client, contractId);

      await client.query(`delete from public.contract_extra_charges where contract_id = $1`, [
        contractId,
      ]);
      await client.query(`select * from public.regenerate_contract_invoices($1)`, [contractId]);

      const invoice = await firstInvoice(client, contractId);
      expect(Number(invoice.total)).toBe(1000);
      expect(await itemsOf(client, invoice.id)).toHaveLength(1);
    });
  });
});

describe("sync_contract_invoice_schedule with extra charges", () => {
  test("reprices an existing invoice through the extras", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 1000);
      await generateYear(client, contractId);
      await addExtraCharge(
        client,
        contractId,
        await seedExpenseCategory(client, "نظافة", "Cleaning"),
        100,
      );

      await client.query(`select * from public.sync_contract_invoice_schedule($1)`, [contractId]);

      const invoice = await firstInvoice(client, contractId);
      expect(Number(invoice.total)).toBe(1100);
      expect(await itemsOf(client, invoice.id)).toHaveLength(2);
    });
  });

  test("prices a period it has to CREATE through the extras too", async () => {
    // The branch that is easy to miss: this function prices a missing period by
    // summing contract_units inline rather than asking contract_period_amounts,
    // so widening only the reprice branch leaves newly-created months billing
    // rent alone — with nothing to show for it, since each invoice still
    // balances against its own items.
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 1000);
      await addExtraCharge(
        client,
        contractId,
        await seedExpenseCategory(client, "نظافة", "Cleaning"),
        100,
      );

      // No prior generation: every period is missing, so every row this
      // produces comes from the insert branch.
      await client.query(`select * from public.sync_contract_invoice_schedule($1)`, [contractId]);

      const { rows } = await client.query<{ count: string; wrong: string }>(
        `select count(*) as count,
                count(*) filter (where total <> 1100) as wrong
           from public.invoices where contract_id = $1`,
        [contractId],
      );
      expect(Number(rows[0].count)).toBeGreaterThan(0);
      expect(Number(rows[0].wrong)).toBe(0);

      const invoice = await firstInvoice(client, contractId);
      const items = await itemsOf(client, invoice.id);
      expect(items).toHaveLength(2);
      expect(items[1].unit_id).toBeNull();
    });
  });
});

describe("save_contract_with_units extra charges", () => {
  /** يستدعي دالة الحفظ بحمولة العقد الحالية زائد المصروفات المطلوبة. */
  async function save(client: PoolClient, contractId: string, extraCharges: unknown) {
    const { rows } = await client.query<Record<string, unknown>>(
      `select tenant_id, type::text as type, state::text as state, start_date, end_date,
              duration_months, due_day, grace_days, deposit
         from public.contracts where id = $1`,
      [contractId],
    );
    const contract: Record<string, unknown> = { ...rows[0] };
    if (extraCharges !== undefined) contract.extra_charges = extraCharges;
    const units = await client.query<{ unit_id: string; monthly_amount: string }>(
      `select unit_id, monthly_amount from public.contract_units where contract_id = $1`,
      [contractId],
    );
    await actAs(client, "authenticated", await seedAdmin(client));
    try {
      await client.query(`select public.save_contract_with_units($1::jsonb, $2::jsonb, $3)`, [
        JSON.stringify(contract),
        JSON.stringify(
          units.rows.map((row) => ({
            unit_id: row.unit_id,
            monthly_amount: Number(row.monthly_amount),
          })),
        ),
        contractId,
      ]);
    } finally {
      // Restored even when the call raises, or every later statement in the
      // transaction — including the assertions — runs as the wrong role.
      await actAsSuperuser(client);
    }
  }

  async function chargeCount(client: PoolClient, contractId: string) {
    const { rows } = await client.query<{ count: string }>(
      `select count(*) as count from public.contract_extra_charges where contract_id = $1`,
      [contractId],
    );
    return Number(rows[0].count);
  }

  test("writes the charges the payload names", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client);
      const categoryId = await seedExpenseCategory(client, "نظافة", "Cleaning");

      await save(client, contractId, [{ category_id: categoryId, amount: 100 }]);

      const { rows } = await client.query<{ amount: string }>(
        `select amount from public.contract_extra_charges where contract_id = $1`,
        [contractId],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].amount)).toBe(100);
    });
  });

  test("an ABSENT key leaves the existing charges alone", async () => {
    // This is what the bundle still being served during a deploy sends, and
    // what any future caller that only edits the contract's own fields sends.
    // Treating it as "there are none" would delete them on an unrelated save.
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client);
      await addExtraCharge(
        client,
        contractId,
        await seedExpenseCategory(client, "نظافة", "Cleaning"),
        100,
      );

      await save(client, contractId, undefined);

      expect(await chargeCount(client, contractId)).toBe(1);
    });
  });

  test("an EMPTY array clears them", async () => {
    // Different request, different answer: the caller IS managing the charges
    // and says there are none.
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client);
      await addExtraCharge(
        client,
        contractId,
        await seedExpenseCategory(client, "نظافة", "Cleaning"),
        100,
      );

      await save(client, contractId, []);

      expect(await chargeCount(client, contractId)).toBe(0);
    });
  });

  test("replaces the whole set rather than accumulating", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client);
      const cleaning = await seedExpenseCategory(client, "نظافة", "Cleaning");
      const security = await seedExpenseCategory(client, "حراسة", "Security");
      await save(client, contractId, [
        { category_id: cleaning, amount: 100 },
        { category_id: security, amount: 30 },
      ]);

      await save(client, contractId, [{ category_id: security, amount: 45 }]);

      const { rows } = await client.query<{ category_id: string; amount: string }>(
        `select category_id, amount from public.contract_extra_charges where contract_id = $1`,
        [contractId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].category_id).toBe(security);
      expect(Number(rows[0].amount)).toBe(45);
    });
  });

  test("updates the amount of a charge already on the contract", async () => {
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client);
      const cleaning = await seedExpenseCategory(client, "نظافة", "Cleaning");
      await save(client, contractId, [{ category_id: cleaning, amount: 100 }]);

      await save(client, contractId, [{ category_id: cleaning, amount: 150 }]);

      const { rows } = await client.query<{ amount: string }>(
        `select amount from public.contract_extra_charges where contract_id = $1`,
        [contractId],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].amount)).toBe(150);
    });
  });
});

describe("append_extra_charge_items is not reachable as an RPC", () => {
  test("an authenticated user cannot call it directly", async () => {
    // It is SECURITY DEFINER and inserts into invoice_items with no permission
    // check of its own — correct for a helper the four pricing functions call,
    // and a hole if a tenant can reach it: they could add billed lines to an
    // invoice by naming a contract id and a free line number.
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 1000);
      await addExtraCharge(
        client,
        contractId,
        await seedExpenseCategory(client, "نظافة", "Cleaning"),
        100,
      );
      await generateYear(client, contractId);
      const invoice = await firstInvoice(client, contractId);

      await actAs(client, "authenticated", await seedAdmin(client));
      // Through captureRaise: Postgres aborts the whole transaction on an
      // error, so a bare rejects.toThrow() here would take the teardown — and
      // every later assertion — down with it.
      const refused = await captureRaise(client, () =>
        client.query(`select public.append_extra_charge_items($1, $2, 99)`, [
          invoice.id,
          contractId,
        ]),
      );
      await actAsSuperuser(client);

      expect(refused, "the helper must not be callable as an RPC").toMatch(/permission denied/i);
    });
  });

  test("but generation still emits the extra lines for that same user", async () => {
    // The revoke must not break the callers. Inside a SECURITY DEFINER body
    // `current_user` is the owner, so EXECUTE is checked against the owner
    // rather than against whoever invoked the outer function — this is what
    // proves that reasoning rather than assuming it.
    await withRollback(async (client) => {
      const { contractId } = await seedYearContract(client, 1000);
      await addExtraCharge(
        client,
        contractId,
        await seedExpenseCategory(client, "نظافة", "Cleaning"),
        100,
      );

      await actAs(client, "authenticated", await seedAdmin(client));
      try {
        await client.query(`select * from public.generate_invoices_for_year($1, $2, true)`, [
          contractId,
          THIS_YEAR,
        ]);
      } finally {
        await actAsSuperuser(client);
      }

      const invoice = await firstInvoice(client, contractId);
      expect(Number(invoice.total)).toBe(1100);
      expect(await itemsOf(client, invoice.id)).toHaveLength(2);
    });
  });
});
