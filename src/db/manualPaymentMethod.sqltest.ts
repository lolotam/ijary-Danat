import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";
import { readFileSync } from "node:fs";

import { captureRaise, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * يُدخل فاتورة مستحقة بمبلغ معلوم، جاهزة للتسوية اليدوية.
 *
 * Kept local rather than shared with the other `set_invoice_paid` suites: the
 * unique (contract_id, period_year, period_month) constraint means every suite
 * needs its own code prefix and period, and a shared helper would couple them.
 */
async function insertDueInvoice(
  client: PoolClient,
  base: { contractId: string; companyId: string; tenantId: string; unitId: string },
  month: number,
  total = 500,
): Promise<string> {
  const due = `2026-${String(month).padStart(2, "0")}-01`;
  const { rows } = await client.query<{ id: string }>(
    `insert into public.invoices (
       code, company_id, contract_id, tenant_id, unit_id,
       period_year, period_month, issue_date, due_date,
       subtotal, discount, total, paid, state, is_visible_to_tenant, idempotency_key
     ) values (
       'INV-mpm-' || substr($1::text, 1, 8) || '-' || $5::text,
       $2::uuid, $1::uuid, $3::uuid, $4::uuid,
       2026, $5::integer, $6::date, $6::date,
       $7, 0, $7, 0, 'due'::public.invoice_states, true,
       $1::text || ':mpm:' || $5::text || ':' || substr(gen_random_uuid()::text, 1, 8)
     )
     returning id`,
    [base.contractId, base.companyId, base.tenantId, base.unitId, month, due, total],
  );
  return rows[0].id;
}

/** يقرأ طريقة الدفع المسجَّلة على الفاتورة وعلى الدفعة الناتجة عنها. */
async function methodsFor(
  client: PoolClient,
  invoiceId: string,
): Promise<{ invoiceMethod: string | null; paymentMethod: string | null; reason: string | null }> {
  const { rows } = await client.query<{
    invoice_method: string | null;
    payment_method: string | null;
    reason: string | null;
  }>(
    `select i.payment_method as invoice_method,
            i.manual_payment_reason as reason,
            (select p.method::text
               from public.payment_allocations pa
               join public.payments p on p.id = pa.payment_id
              where pa.invoice_id = i.id
              order by p.created_at desc
              limit 1) as payment_method
       from public.invoices i where i.id = $1::uuid`,
    [invoiceId],
  );
  return {
    invoiceMethod: rows[0].invoice_method,
    paymentMethod: rows[0].payment_method,
    reason: rows[0].reason,
  };
}

/**
 * يستخرج جملة إضافة عنصر القائمة من ملف الترحيل 159 نفسه.
 *
 * Reading the shipped bytes rather than restating them: the property under test
 * is `on conflict … do nothing`, and a test that carried its own copy of the
 * statement would go on passing after someone changed the migration to
 * `do update` — which would silently re-enable an item an admin had disabled.
 */
function seedCatalogItemStatement(): string {
  const sql = readFileSync("db/migrations/159_manual_payment_method.sql", "utf8");
  const match = sql.match(/do \$\$[\s\S]*?option_list_items[\s\S]*?end \$\$;/);
  if (!match) throw new Error("migration 159 no longer contains the catalog-seed block");
  return match[0]
    .replace("_list uuid;", "_list uuid; _company uuid;")
    .replace("select id into _list", "select id, company_id into _list, _company")
    .replace("(list_id, value,", "(company_id, list_id, value,")
    .replace("values (_list,", "values (_company, _list,")
    .replace("on conflict (list_id, value)", "on conflict (company_id, list_id, value)");
}

describe("set_invoice_paid records the method the admin chose (migration 159)", () => {
  test("an explicit method wins over the reason catalog's mapping", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      const invoice = await insertDueInvoice(client, base, 1);

      // `audit_adjustment` maps to itself now, but the point of the assertion is
      // precedence: the reason argument says bank_transfer and must lose.
      await client.query(
        `select public.set_invoice_paid($1::uuid, true, 'bank_transfer', 'audit_adjustment')`,
        [invoice],
      );

      const result = await methodsFor(client, invoice);
      expect(result.paymentMethod).toBe("audit_adjustment");
      expect(result.invoiceMethod).toBe("audit_adjustment");
    });
  });

  test("the reason catalog still drives the method when no method is passed", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      const {
        rows: [listRow],
      } = await client.query<{ id: string }>(
        `insert into public.option_lists (company_id, code, name_ar, name_en, is_system)
         values ($1, 'manual_payment_reasons', 'أسباب السداد اليدوي', 'Manual payment reasons', true)
         on conflict (company_id, code) do update set name_en = excluded.name_en
         returning id`,
        [base.companyId],
      );
      await client.query(
        `insert into public.option_list_items
           (company_id, list_id, value, label_ar, label_en, sort_order, is_active, metadata)
         values ($1, $2, 'bank_transfer', 'تحويل بنكي', 'Bank transfer', 1, true, '{"payment_method": "bank_transfer"}'::jsonb)
         on conflict (company_id, list_id, value) do update set metadata = excluded.metadata, is_active = true`,
        [base.companyId, listRow.id],
      );
      const invoice = await insertDueInvoice(client, base, 1);

      // This is the three-argument shape the previous bundle calls with. It has
      // to keep working across the window between the migration and the deploy.
      await client.query(`select public.set_invoice_paid($1::uuid, true, 'bank_transfer')`, [
        invoice,
      ]);

      expect((await methodsFor(client, invoice)).paymentMethod).toBe("bank_transfer");
    });
  });

  test("an unmapped reason still settles, falling back to cash", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      const invoice = await insertDueInvoice(client, base, 1);

      await client.query(`select public.set_invoice_paid($1::uuid, true, 'no-such-reason')`, [
        invoice,
      ]);

      expect((await methodsFor(client, invoice)).paymentMethod).toBe("cash");
    });
  });

  test.each(["payment_link", "knet", "card", "applepay", "googlepay"])(
    "refuses to record %s by hand, because no gateway transaction backs it",
    async (method) => {
      await withRollback(async (client) => {
        const base = await seedContract(client, {
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          monthlyAmount: 500,
        });
        const invoice = await insertDueInvoice(client, base, 1);

        const message = await captureRaise(client, () =>
          client.query(`select public.set_invoice_paid($1::uuid, true, null, $2::text)`, [
            invoice,
            method,
          ]),
        );
        expect(message).toMatch(/cannot be recorded manually/i);
      });
    },
  );

  test("the reason column falls back to the method when only a method was given", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      const invoice = await insertDueInvoice(client, base, 1);

      await client.query(`select public.set_invoice_paid($1::uuid, true, null, 'cheque')`, [
        invoice,
      ]);

      // Both columns describe the same event; neither goes blank just because
      // the admin answered with a method instead of a reason.
      const result = await methodsFor(client, invoice);
      expect(result.reason).toBe("cheque");
      expect(result.paymentMethod).toBe("cheque");
    });
  });
});

describe("a reversed payment is not how the invoice was settled (migration 159)", () => {
  test("the invoice method ignores a payment that was reversed", async () => {
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      const invoice = await insertDueInvoice(client, base, 1);

      await client.query(`select public.set_invoice_paid($1::uuid, true, null, 'bank_transfer')`, [
        invoice,
      ]);
      expect((await methodsFor(client, invoice)).invoiceMethod).toBe("bank_transfer");

      const { rows } = await client.query<{ id: string }>(
        `select p.id
           from public.payment_allocations pa
           join public.payments p on p.id = pa.payment_id
          where pa.invoice_id = $1::uuid
          limit 1`,
        [invoice],
      );
      await client.query(`select public.reverse_payment($1::uuid, 'test reversal')`, [rows[0].id]);

      // Before migration 159 the only trigger fired on `payment_allocations`.
      // `reverse_payment` inserts its mirror allocation *before* flipping the
      // original to `status = 'reversed'`, so the invoice was stamped while the
      // original still counted, and the status flip — an UPDATE on `payments` —
      // had nothing listening to it.
      expect((await methodsFor(client, invoice)).invoiceMethod).toBeNull();
    });
  });

  test("a stale hand-settlement reason is dropped even when other money remains", async () => {
    // Codex review, 2026-08-24. Clearing the reason only when `payment_method`
    // goes null leaves it attached to an invoice that some *other* payment now
    // settles — the reason would then describe money nobody entered by hand.
    await withRollback(async (client) => {
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 500,
      });
      const invoice = await insertDueInvoice(client, base, 1, 500);

      await client.query(`select public.set_invoice_paid($1::uuid, true, null, 'cheque')`, [
        invoice,
      ]);
      const manual = await client.query<{ id: string }>(
        `select p.id from public.payment_allocations pa
           join public.payments p on p.id = pa.payment_id
          where pa.invoice_id = $1::uuid limit 1`,
        [invoice],
      );

      // A second, ordinary payment against the same invoice — not a hand
      // settlement, so it carries no AUTO-INV reference.
      const { rows: extra } = await client.query<{ id: string }>(
        `insert into public.payments
           (code, company_id, tenant_id, unit_id, account_type, method, amount, currency,
            payment_date, reference, status)
         values (public.next_payment_code(), $1::uuid, $2::uuid, $3::uuid,
                 'commercial_account', 'bank_transfer', 100, 'KWD',
                 current_date, 'WIRE-1', 'confirmed')
         returning id`,
        [base.companyId, base.tenantId, base.unitId],
      );
      await client.query(
        `insert into public.payment_allocations (payment_id, invoice_id, amount)
         values ($1::uuid, $2::uuid, 100)`,
        [extra[0].id, invoice],
      );

      await client.query(`select public.reverse_payment($1::uuid, 'test reversal')`, [
        manual.rows[0].id,
      ]);

      const result = await methodsFor(client, invoice);
      // The wire transfer still stands, so the invoice keeps a method...
      expect(result.invoiceMethod).toBe("bank_transfer");
      // ...but nothing was settled by hand any more, so the reason must go.
      expect(result.reason).toBeNull();
    });
  });
});

describe("payment_methods catalog seeding (migration 159)", () => {
  test("audit_adjustment is offered as a payment method", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ is_active: boolean; is_system: boolean }>(
        `select oli.is_active, oli.is_system
           from public.option_list_items oli
           join public.option_lists ol on ol.id = oli.list_id
          where ol.code = 'payment_methods' and oli.value = 'audit_adjustment'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].is_active).toBe(true);
    });
  });

  test("re-running the seed does not resurrect an item an admin disabled", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.option_list_items oli set is_active = false
           from public.option_lists ol
          where ol.id = oli.list_id
            and ol.code = 'payment_methods' and oli.value = 'audit_adjustment'`,
      );

      // Runs the statement out of the migration file itself, not a copy of it.
      // A copied block would keep passing if someone changed the real one to
      // `on conflict … do update`, which is exactly the regression this guards.
      await client.query(seedCatalogItemStatement());

      const { rows } = await client.query<{ is_active: boolean; count: string }>(
        `select oli.is_active, count(*) over () as count
           from public.option_list_items oli
           join public.option_lists ol on ol.id = oli.list_id
          where ol.code = 'payment_methods' and oli.value = 'audit_adjustment'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].is_active).toBe(false);
    });
  });
});
