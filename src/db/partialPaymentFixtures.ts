import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { seedCompanyUser, seedContract } from "@/db/testDb";

/**
 * تجهيزات مشتركة لاختبارات تعديل الدفعة الجزئية (الهجرة 191).
 *
 * Shared by the partial-payment SQL suites — the resync trigger on a direct
 * UPDATE, the `edit_partial_payment` RPC, the migration's own preflight, and
 * the delete-path lock — so all of them agree on what a settled partial
 * looks like. The RPC helper mirrors the dialog: it sends every editable
 * column, defaulting the untouched ones to the row's current values.
 */

export type Scenario = Awaited<ReturnType<typeof scenario>>;

/**
 * عقد بفواتير مولّدة، جاهز لاستقبال دفعات جزئية.
 */
export async function scenario(client: PoolClient, monthlyAmount = 500) {
  const fx = await seedContract(client, {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    monthlyAmount,
  });
  await client.query(`select public.generate_invoices($1::uuid, 2026)`, [fx.contractId]);
  const invoices = await client.query<{
    id: string;
    total: string;
    period_month: number;
  }>(
    `select id, total, period_month from public.invoices
      where contract_id = $1 order by period_year, period_month`,
    [fx.contractId],
  );
  return { ...fx, invoices: invoices.rows };
}

/**
 * ينشئ دفعة جزئية مرتبطة بفاتورة، ويعيد معرّفها.
 */
export async function insertPartial(
  client: PoolClient,
  fx: Scenario,
  options: { amount: number; invoiceId?: string | null; paidDate?: string },
): Promise<string> {
  const linked = options.invoiceId !== undefined ? options.invoiceId : fx.invoices[0].id;
  const row = await client.query<{ id: string }>(
    `insert into public.partial_payments
       (company_id, tenant_id, contract_id, invoice_id, amount, paid_date)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      fx.companyId,
      fx.tenantId,
      linked ? fx.contractId : null,
      linked,
      options.amount,
      options.paidDate ?? "2026-01-10",
    ],
  );
  return row.rows[0].id;
}

/**
 * حالة الفاتورة ومبلغها المسدَّد ورصيدها.
 */
export async function invoiceState(client: PoolClient, invoiceId: string) {
  const row = await client.query<{ state: string; paid: string; balance: string }>(
    `select state, paid, balance from public.invoices where id = $1`,
    [invoiceId],
  );
  return row.rows[0];
}

/**
 * الدفعات المملوكة لهذه الدفعة الجزئية، مُحدَّدة بـ `source_partial_payment_id` وحده.
 */
export async function ownedPayments(client: PoolClient, partialId: string) {
  const row = await client.query<{
    id: string;
    amount: string;
    status: string;
    note: string | null;
    payment_date: string;
  }>(
    `select id, amount, status, note, payment_date::text as payment_date
       from public.payments where source_partial_payment_id = $1`,
    [partialId],
  );
  return row.rows;
}

/**
 * يستدعي RPC التعديل كما يستدعيه الحوار.
 */
export async function editPartial(
  client: PoolClient,
  id: string,
  values: {
    amount: number;
    paidDate?: string;
    invoiceId?: string | null;
    note?: string | null;
    contractId?: string | null;
    status?: string;
  },
) {
  const current = await client.query<{
    paid_date: string;
    invoice_id: string | null;
    note: string | null;
  }>(`select paid_date, invoice_id, note from public.partial_payments where id = $1`, [id]);
  const row = current.rows[0];
  const link = await client.query<{
    tenant_id: string;
    contract_id: string | null;
    unit_id: string | null;
    building_id: string | null;
    status: string;
  }>(
    `select tenant_id, contract_id, unit_id, building_id, status from public.partial_payments where id = $1`,
    [id],
  );
  const linkRow = link.rows[0];
  return client.query(
    `select public.edit_partial_payment($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      values.amount,
      values.paidDate ?? row.paid_date,
      values.invoiceId === undefined ? row.invoice_id : values.invoiceId,
      values.note === undefined ? row.note : values.note,
      linkRow.tenant_id,
      values.contractId === undefined ? linkRow.contract_id : values.contractId,
      linkRow.unit_id,
      linkRow.building_id,
      values.status === undefined ? linkRow.status : values.status,
    ],
  );
}

/**
 * مستخدم إداري حقيقي لاختبار صلاحية RPC التعديل.
 */
export async function seedUserWithRole(
  client: PoolClient,
  role: string,
  companyId?: string,
): Promise<string> {
  let cid = companyId;
  if (!cid) {
    const { rows } = await client.query<{ id: string | null }>(
      `select public.current_company_id() as id`,
    );
    if (rows[0]?.id) {
      cid = rows[0].id;
    } else {
      const created = await client.query<{ id: string }>(
        `insert into public.companies (name_ar, name_en) values ('شركة اختبار', 'Test Co') returning id`,
      );
      cid = created.rows[0].id;
    }
  }
  return seedCompanyUser(client, cid, role, "pp");
}

/**
 * نص أي هجرة ملفوفة بمعاملة واحدة، بعد تجريد غالفي begin/commit الخارجيين،
 * حتى لا تُغلق معاملة withRollback أو تُفتح معاملة متداخلة.
 *
 * The begin pattern is line-anchored because the plpgsql `begin` keywords in
 * these files carry no semicolon — only the wrapper statement matches.
 */
export function migrationBody(fileName: string): string {
  const sql = readFileSync(resolve(process.cwd(), "db/migrations", fileName), "utf8");
  return sql.replace(/^\s*begin;\s*/im, "").replace(/\s*commit;\s*$/i, "");
}
