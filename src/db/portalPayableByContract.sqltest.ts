import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedCompanyUser,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

type PayableRow = {
  invoice_id: string;
  sequence_order: number;
  is_selectable: boolean;
  period_year: number;
  period_month: number;
};

/**
 * يُدخل فاتورة مستحقة مرئية للمستأجر في فترة محددة.
 *
 * balance is generated from total − paid; period_year/month drive the
 * pay-oldest-first sequence that evaluate_portal_payable_invoices computes.
 */
async function insertUnpaidInvoice(
  client: PoolClient,
  input: {
    contractId: string;
    companyId: string;
    tenantId: string;
    unitId: string;
    year: number;
    month: number;
    total?: number;
  },
): Promise<string> {
  const total = input.total ?? 500;
  const due = `${input.year}-${String(input.month).padStart(2, "0")}-01`;
  const { rows } = await client.query<{ id: string }>(
    `insert into public.invoices (
       code, company_id, contract_id, tenant_id, unit_id,
       period_year, period_month, issue_date, due_date,
       subtotal, discount, total, paid, state, is_visible_to_tenant,
       idempotency_key
     )
     values (
       'INV-pc-' || substr($1::text, 1, 8) || '-' || $5::text || '-' || $6::text,
       $2::uuid, $1::uuid, $3::uuid, $4::uuid,
       -- Explicit casts: $5/$6 are also used as ::text in the code and
       -- idempotency_key expressions above, which pins the parameter type to
       -- text, and period_year/period_month are integer columns.
       $5::integer, $6::integer, $7::date, $7::date,
       $8, 0, $8, 0, 'due', true,
       $1::text || ':' || $5::text || ':' || $6::text || ':' || substr(gen_random_uuid()::text, 1, 8)
     )
     returning id`,
    [
      input.contractId,
      input.companyId,
      input.tenantId,
      input.unitId,
      input.year,
      input.month,
      due,
      total,
    ],
  );
  return rows[0].id;
}

/**
 * يُنشئ عقدًا ثانيًا لنفس المستأجر على وحدة جديدة تحت نفس العقار.
 *
 * seedContract always creates its own tenant; multi-contract portal cases need
 * two contracts on one tenant_id without inventing a second company graph.
 */
async function addContractForTenant(
  client: PoolClient,
  base: {
    companyId: string;
    propertyId: string;
    tenantId: string;
  },
  options: { startDate: string; endDate: string; monthlyAmount?: number },
): Promise<{ contractId: string; unitId: string }> {
  const tag = randomUUID().slice(0, 8);
  const unit = await client.query<{ id: string }>(
    `insert into public.units (company_id, code, property_id, name) values ($1, $2, $3, $4) returning id`,
    [base.companyId, `U-b-${tag}`, base.propertyId, `Unit B ${tag}`],
  );
  const unitId = unit.rows[0].id;
  const contract = await client.query<{ id: string }>(
    `insert into public.contracts
       (company_id, code, tenant_id, start_date, end_date, due_day, grace_days, deposit, state)
     values ($1, $2, $3, $4::date, $5::date, 1, 0, 0, 'active'::public.contract_states)
     returning id`,
    [base.companyId, `C-b-${tag}`, base.tenantId, options.startDate, options.endDate],
  );
  const contractId = contract.rows[0].id;
  await client.query(
    `insert into public.contract_units (company_id, contract_id, unit_id, monthly_amount, line_order)
     values ($1, $2, $3, $4, 1)`,
    [base.companyId, contractId, unitId, options.monthlyAmount ?? 500],
  );
  return { contractId, unitId };
}

/**
 * يستدعي evaluate_portal_payable_invoices مرتّبة حسب sequence_order.
 */
async function evaluatePayable(
  client: PoolClient,
  tenantId: string,
  contractId?: string | null,
): Promise<PayableRow[]> {
  if (contractId) {
    const { rows } = await client.query<PayableRow>(
      `select invoice_id, sequence_order, is_selectable, period_year, period_month
         from public.evaluate_portal_payable_invoices($1, $2)
        order by sequence_order`,
      [tenantId, contractId],
    );
    return rows;
  }
  const { rows } = await client.query<PayableRow>(
    `select invoice_id, sequence_order, is_selectable, period_year, period_month
       from public.evaluate_portal_payable_invoices($1)
      order by sequence_order`,
    [tenantId],
  );
  return rows;
}

describe("evaluate_portal_payable_invoices by contract (migration 121)", () => {
  test("null contract returns every unpaid invoice; filtered set renumbers and unlocks", async () => {
    await withRollback(async (client) => {
      // Contract A: unpaid Jan + Feb. Contract B: unpaid Apr + May.
      // Tenant-wide oldest is A's January — without the SQL filter, B's April
      // would be locked by an invoice the tenant cannot see when filtered to B.
      const base = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 400,
      });
      const contractB = await addContractForTenant(client, base, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 450,
      });

      const janA = await insertUnpaidInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 1,
      });
      const febA = await insertUnpaidInvoice(client, {
        contractId: base.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: base.unitId,
        year: 2026,
        month: 2,
      });
      const aprB = await insertUnpaidInvoice(client, {
        contractId: contractB.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: contractB.unitId,
        year: 2026,
        month: 4,
      });
      const mayB = await insertUnpaidInvoice(client, {
        contractId: contractB.contractId,
        companyId: base.companyId,
        tenantId: base.tenantId,
        unitId: contractB.unitId,
        year: 2026,
        month: 5,
      });

      // 1. Null contract → today's behaviour: every unpaid invoice of the tenant.
      const all = await evaluatePayable(client, base.tenantId);
      expect(all).toHaveLength(4);
      expect(all.map((r) => r.invoice_id).sort()).toEqual([janA, febA, aprB, mayB].sort());

      // 2. Filtered → only that contract's invoices.
      const filtered = await evaluatePayable(client, base.tenantId, contractB.contractId);
      expect(filtered.map((r) => r.invoice_id).sort()).toEqual([aprB, mayB].sort());

      // 3. sequence_order renumbers WITHIN the filtered set, starting at 1.
      expect(filtered.map((r) => r.sequence_order)).toEqual([1, 2]);

      // 4. The oldest row of the filtered set is selectable even though an OLDER
      //    invoice of the other contract is still unpaid. This is the whole point.
      expect(filtered[0].is_selectable).toBe(true);
      expect(filtered[0].invoice_id).toBe(aprB);
      expect(filtered[1].is_selectable).toBe(false);
    });
  });

  test("a contract belonging to a different tenant is rejected", async () => {
    await withRollback(async (client) => {
      const mine = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const other = await seedContract(client, {
        companyId: mine.companyId,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      const message = await captureRaise(client, () =>
        client.query(`select * from public.evaluate_portal_payable_invoices($1, $2)`, [
          mine.tenantId,
          other.contractId,
        ]),
      );
      expect(message).toMatch(/does not belong/i);
    });
  });
});

/** ينشئ مستخدمًا بدور محدد في auth.users و profiles و user_roles ضمن الشركة. */
async function seedUserWithRole(
  client: PoolClient,
  companyId: string,
  role: string,
): Promise<string> {
  return seedCompanyUser(client, companyId, role, "ppay");
}

/** يستدعي الدالة مع طلب تضمين العقود المخفية. */
async function evaluatePayableIncludingHidden(
  client: PoolClient,
  tenantId: string,
): Promise<PayableRow[]> {
  const { rows } = await client.query<PayableRow>(
    `select invoice_id, sequence_order, is_selectable, period_year, period_month
       from public.evaluate_portal_payable_invoices($1, null, true)
      order by sequence_order`,
    [tenantId],
  );
  return rows;
}

/**
 * Migration 210. A tenant renting both a shop and a rooftop must see only the
 * shop; the office collects the roof rent through a link it generates by hand.
 * The rule has to hold in the database, because `createPayment` — the same
 * server function behind the admin's KNET button and behind the portal's pay
 * button — validates every selection against this function.
 */
describe("evaluate_portal_payable_invoices hides hide_from_portal contracts (migration 210)", () => {
  test("a hidden contract's invoices leave the set, and the visible ones renumber to fill the gap", async () => {
    await withRollback(async (client) => {
      // The roof contract holds the OLDER arrears on purpose: under
      // pay-oldest-first it would otherwise sit at sequence 1 and lock the shop
      // invoice behind an invoice the tenant is never shown.
      const roof = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 400,
      });
      const shop = await addContractForTenant(client, roof, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 450,
      });

      const roofJan = await insertUnpaidInvoice(client, {
        contractId: roof.contractId,
        companyId: roof.companyId,
        tenantId: roof.tenantId,
        unitId: roof.unitId,
        year: 2026,
        month: 1,
      });
      const shopMar = await insertUnpaidInvoice(client, {
        contractId: shop.contractId,
        companyId: roof.companyId,
        tenantId: roof.tenantId,
        unitId: shop.unitId,
        year: 2026,
        month: 3,
      });

      const before = await evaluatePayable(client, roof.tenantId);
      expect(before.map((row) => row.invoice_id)).toEqual([roofJan, shopMar]);
      expect(before[1].is_selectable).toBe(false);

      await client.query(`update public.contracts set hide_from_portal = true where id = $1`, [
        roof.contractId,
      ]);

      const after = await evaluatePayable(client, roof.tenantId);
      expect(after.map((row) => row.invoice_id)).toEqual([shopMar]);
      expect(after[0].sequence_order).toBe(1);
      // The point of renumbering: the shop invoice is payable now, rather than
      // locked behind a roof arrear the tenant can neither see nor settle.
      expect(after[0].is_selectable).toBe(true);
    });
  });

  test("p_include_hidden brings them back for staff, which is what keeps the admin link working", async () => {
    await withRollback(async (client) => {
      const roof = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 400,
      });
      const roofJan = await insertUnpaidInvoice(client, {
        contractId: roof.contractId,
        companyId: roof.companyId,
        tenantId: roof.tenantId,
        unitId: roof.unitId,
        year: 2026,
        month: 1,
      });
      await client.query(`update public.contracts set hide_from_portal = true where id = $1`, [
        roof.contractId,
      ]);

      expect(await evaluatePayable(client, roof.tenantId)).toEqual([]);
      const included = await evaluatePayableIncludingHidden(client, roof.tenantId);
      expect(included.map((row) => row.invoice_id)).toEqual([roofJan]);
      expect(included[0].is_selectable).toBe(true);
    });
  });

  test("a tenant asking for hidden invoices is downgraded to their own view", async () => {
    await withRollback(async (client) => {
      const roof = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        monthlyAmount: 400,
      });
      await insertUnpaidInvoice(client, {
        contractId: roof.contractId,
        companyId: roof.companyId,
        tenantId: roof.tenantId,
        unitId: roof.unitId,
        year: 2026,
        month: 1,
      });
      await client.query(`update public.contracts set hide_from_portal = true where id = $1`, [
        roof.contractId,
      ]);

      const tenantUser = await seedUserWithRole(client, roof.companyId, "tenant");
      await client.query(`update public.profiles set tenant_id = $1 where id = $2`, [
        roof.tenantId,
        tenantUser,
      ]);

      await actAs(client, "authenticated", tenantUser);
      // Passing the flag is not the same as being granted it. This is the
      // security property: a crafted request cannot start a portal payment for
      // a contract the office collects by hand.
      const { rows } = await client.query<PayableRow>(
        `select invoice_id from public.evaluate_portal_payable_invoices($1, null, true)`,
        [roof.tenantId],
      );
      await actAsSuperuser(client);
      expect(rows).toEqual([]);
    });
  });
});

/**
 * The switch itself. Written as its own RPC rather than another pass through
 * `save_contract_with_units`, so it carries its own permission check and its
 * own audit row.
 */
describe("update_contract_portal_visibility (migration 210)", () => {
  test("flips the flag and records who did it", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const admin = await seedUserWithRole(client, fixture.companyId, "admin");

      await actAs(client, "authenticated", admin);
      await client.query(`select public.update_contract_portal_visibility($1, true)`, [
        fixture.contractId,
      ]);
      await actAsSuperuser(client);

      const { rows } = await client.query<{ hide_from_portal: boolean }>(
        `select hide_from_portal from public.contracts where id = $1`,
        [fixture.contractId],
      );
      expect(rows[0].hide_from_portal).toBe(true);

      const audit = await client.query<{ action: string; after: { hide_from_portal: boolean } }>(
        `select action, after from public.audit_logs
          where entity_id = $1 and action = 'contract.portal_visibility'`,
        [fixture.contractId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].after.hide_from_portal).toBe(true);
    });
  });

  test("refuses a caller without contracts.update and changes nothing", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const tenantUser = await seedUserWithRole(client, fixture.companyId, "tenant");

      await actAs(client, "authenticated", tenantUser);
      const raised = await captureRaise(client, () =>
        client.query(`select public.update_contract_portal_visibility($1, true)`, [
          fixture.contractId,
        ]),
      );
      await actAsSuperuser(client);

      expect(raised).toMatch(/Permission denied/i);
      const { rows } = await client.query<{ hide_from_portal: boolean }>(
        `select hide_from_portal from public.contracts where id = $1`,
        [fixture.contractId],
      );
      expect(rows[0].hide_from_portal).toBe(false);
    });
  });
});
