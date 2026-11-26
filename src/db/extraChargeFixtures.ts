import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { expect } from "vitest";

import { seedContract } from "@/db/testDb";

/**
 * تجهيزات مشتركة لاختبارات المصروفات الدورية على العقود.
 *
 * Shared by the two suites that migrations 170 and 171 split into — free-month
 * generation and the fully-discounted waiver. Extracted rather than duplicated
 * because both need the same contract shape, and a fixture that drifted between
 * them would make the two suites disagree about what "500 rent + 50 cleaning"
 * even means.
 */

export const THIS_YEAR = new Date().getFullYear();

/** تصنيف مصروف جديد لكل اختبار — `code` فريد فلا تتشارك الاختبارات صفاً. */
async function seedExpenseCategory(client: PoolClient, companyId: string) {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.expense_categories (company_id, code, name_ar, name_en)
     values ($1, $2, 'نظافة', 'Cleaning') returning id`,
    [companyId, `EC-${tag}`],
  );
  return rows[0].id;
}

/** يجلب معرّف الشركة لعقد معيّن لربط الصفوف التابعة به. */
async function contractCompanyId(client: PoolClient, contractId: string): Promise<string> {
  const { rows } = await client.query<{ company_id: string }>(
    `select company_id from public.contracts where id = $1`,
    [contractId],
  );
  return rows[0].company_id;
}

/** عقد لسنة كاملة بإيجار واحد. */
export async function seedYearContract(client: PoolClient, monthlyAmount = 500) {
  return seedContract(client, {
    startDate: `${THIS_YEAR}-01-01`,
    endDate: `${THIS_YEAR}-12-31`,
    monthlyAmount,
  });
}

export async function addExtraCharge(client: PoolClient, contractId: string, amount: number) {
  const companyId = await contractCompanyId(client, contractId);
  await client.query(
    `insert into public.contract_extra_charges (company_id, contract_id, category_id, amount, line_order)
     values ($1, $2, $3, $4, 1)`,
    [companyId, contractId, await seedExpenseCategory(client, companyId), amount],
  );
}

/**
 * يجعل شهر يناير مجانياً، كما يفعل حوار التنازلات.
 *
 * January specifically: it is the contract's first month in every fixture here,
 * so the free period and the billed periods are never the same row.
 */
export async function makeJanuaryFree(client: PoolClient, contractId: string) {
  const companyId = await contractCompanyId(client, contractId);
  await client.query(
    `insert into public.concessions
       (company_id, contract_id, type, status, start_date, end_date, free_months)
     values ($1, $2, 'free_months', 'active', $3::date, $4::date, 1)`,
    [companyId, contractId, `${THIS_YEAR}-01-01`, `${THIS_YEAR}-01-31`],
  );
}

export async function generateYear(client: PoolClient, contractId: string) {
  await client.query(`select * from public.generate_invoices_for_year($1, $2, true)`, [
    contractId,
    THIS_YEAR,
  ]);
}

export interface InvoiceRow {
  id: string;
  subtotal: string;
  discount: string;
  total: string;
  state: string;
}

/** فاتورة شهر بعينه، أو undefined إن لم تُصدر. */
export async function invoiceForMonth(client: PoolClient, contractId: string, month: number) {
  const { rows } = await client.query<InvoiceRow>(
    `select id, subtotal, discount, total, state::text as state from public.invoices
      where contract_id = $1 and period_year = $2 and period_month = $3`,
    [contractId, THIS_YEAR, month],
  );
  return rows[0];
}

export async function itemsOf(client: PoolClient, invoiceId: string) {
  const { rows } = await client.query<{
    line: number;
    amount: string;
    is_extra_charge: boolean;
    is_concession: boolean;
  }>(
    `select line, amount, is_extra_charge, is_concession
       from public.invoice_items where invoice_id = $1 order by line`,
    [invoiceId],
  );
  return rows;
}

/**
 * يؤكّد أن بنود الفاتورة غير التنازلية تساوي إجماليها الفرعي.
 *
 * The invariant a pricing change breaks silently. An invoice whose subtotal
 * moved while its lines did not looks entirely normal in the invoices table —
 * the contradiction is only visible against the items.
 */
export async function expectItemsToSumToSubtotal(client: PoolClient, invoiceId: string) {
  const { rows } = await client.query<{ subtotal: string; items: string | null }>(
    `select i.subtotal,
            (select sum(ii.amount) from public.invoice_items ii
              where ii.invoice_id = i.id and not ii.is_concession) as items
       from public.invoices i where i.id = $1`,
    [invoiceId],
  );
  expect(Number(rows[0].items ?? 0)).toBe(Number(rows[0].subtotal));
}
