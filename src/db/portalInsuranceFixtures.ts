import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { seedContract } from "@/db/testDb";

/**
 * تجهيزات مشتركة لاختبارات إجمالي تأمين البوابة (الهجرة 216).
 *
 * Shared by the portal-insurance SQL suites so the original visibility
 * regressions and the close-out netting cases agree on how a collected
 * holding and a close-out header are written. A fixture that drifted
 * between them would make one suite assert a number the other cannot
 * reproduce.
 */

export type CloseoutDisposition = {
  contractId: string;
  tenantId: string;
  actorId: string;
  status: "draft" | "completed" | "cancelled";
  depositHeld: number;
  deductionsTotal?: number;
  settledTotal?: number;
  refundTotal?: number;
  refundId?: string | null;
  outcome?: "keep_terminated" | "freeze" | "archive";
};

/** ينشئ مستخدمًا بدور محدد في auth.users و user_roles. */
export async function seedUserWithRole(client: PoolClient, role: string): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `insert into public.user_roles (user_id, role) values ($1, $2::public.app_role)`,
    [userId, role],
  );
  return userId;
}

/** يُسجّل تأمينًا محصّلًا على عقد بعينه. */
export async function collectInsurance(
  client: PoolClient,
  input: { contractId: string; tenantId: string; unitId: string; amount: number },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.insurance_payments (contract_id, tenant_id, unit_id, amount)
     values ($1::uuid, $2::uuid, $3::uuid, $4::numeric)
     returning id`,
    [input.contractId, input.tenantId, input.unitId, input.amount],
  );
  return rows[0].id;
}

/** يقرأ الإجمالي الذي تُرجعه الدالة للجالس الحالي. */
export async function insuranceTotal(
  client: PoolClient,
  tenantId: string,
  contractId: string | null = null,
): Promise<number> {
  const { rows } = await client.query<{ portal_insurance_total: string }>(
    `select public.portal_insurance_total($1::uuid, $2::uuid)`,
    [tenantId, contractId],
  );
  return Number(rows[0].portal_insurance_total);
}

/**
 * يُسجّل تصرّف إغلاق في التأمين على صف `contract_closeouts` مباشرة.
 *
 * The portal total reads these header columns, not the refunds/payments
 * `close_out_contract` also writes. Calling the engine would refuse an
 * already-ended lease and mutate invoices, which is outside what these
 * cases assert.
 */
export async function recordCloseoutDisposition(
  client: PoolClient,
  input: CloseoutDisposition,
): Promise<string> {
  const completed = input.status === "completed";
  const cancelled = input.status === "cancelled";
  const { rows } = await client.query<{ id: string }>(
    `insert into public.contract_closeouts (
       contract_id, tenant_id, status, outcome, final_contract_state,
       archive_tenant, move_out_date, deposit_held, deductions_total,
       settled_total, refund_total, refund_id, idempotency_key,
       completed_by, completed_at, cancelled_by, cancelled_at, created_by
     ) values (
       $1, $2, $3, $4, 'terminated'::public.contract_states,
       false, current_date, $5, $6, $7, $8, $9, $10,
       $11, case when $12 then now() else null end,
       $13, case when $14 then now() else null end, $15
     ) returning id`,
    [
      input.contractId,
      input.tenantId,
      input.status,
      input.outcome ?? "keep_terminated",
      input.depositHeld,
      input.deductionsTotal ?? 0,
      input.settledTotal ?? 0,
      input.refundTotal ?? 0,
      input.refundId ?? null,
      randomUUID(),
      completed ? input.actorId : null,
      completed,
      cancelled ? input.actorId : null,
      cancelled,
      input.actorId,
    ],
  );
  return rows[0].id;
}

/**
 * يجهّز عقدًا ظاهرًا بتأمين محصّل ومستخدمًا يُنسب إليه الإغلاق.
 */
export async function arrangeHeldDeposit(client: PoolClient, amount: number) {
  const shop = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31" });
  await collectInsurance(client, {
    contractId: shop.contractId,
    tenantId: shop.tenantId,
    unitId: shop.unitId,
    amount,
  });
  const actorId = await seedUserWithRole(client, "admin");
  return { ...shop, actorId };
}

/**
 * يُنشئ عقدًا ظاهرًا ثانيًا لنفس المستأجر مع تأمين محصّل.
 *
 * `seedContract` always creates a new tenant, so a mixed-lease case cannot
 * come from two `seedContract` calls.
 */
export async function addVisibleLeaseWithInsurance(
  client: PoolClient,
  owner: { tenantId: string; propertyId: string; contractId: string },
  amount: number,
): Promise<{ contractId: string; unitId: string }> {
  const tag = owner.contractId.slice(0, 8);
  const unit = await client.query<{ id: string }>(
    `insert into public.units (code, property_id, name) values ($1, $2, 'Lease B') returning id`,
    [`U-b-${tag}`, owner.propertyId],
  );
  const contract = await client.query<{ id: string }>(
    `insert into public.contracts
       (code, tenant_id, start_date, end_date, due_day, grace_days, deposit, state)
     values ($1, $2, '2026-01-01'::date, '2026-12-31'::date, 1, 0, 0, 'active'::public.contract_states)
     returning id`,
    [`C-b-${tag}`, owner.tenantId],
  );
  await client.query(
    `insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
     values ($1, $2, 200, 1)`,
    [contract.rows[0].id, unit.rows[0].id],
  );
  await collectInsurance(client, {
    contractId: contract.rows[0].id,
    tenantId: owner.tenantId,
    unitId: unit.rows[0].id,
    amount,
  });
  return { contractId: contract.rows[0].id, unitId: unit.rows[0].id };
}

/**
 * يُدرج استردادًا مرحّلًا يمكن ربطه بإغلاق مكتمل عبر `refund_id`.
 *
 * `void_refund` / `reverse_refund` require status = posted. The close-out
 * engine writes this row itself; tests that exercise those RPCs need the
 * same shape without calling `close_out_contract`.
 */
export async function insertPostedRefund(
  client: PoolClient,
  input: { tenantId: string; contractId: string; amount: number },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.refunds (tenant_id, contract_id, amount, refund_date, post_action, status)
     values ($1, $2, $3, current_date, 'store', 'posted')
     returning id`,
    [input.tenantId, input.contractId, input.amount],
  );
  return rows[0].id;
}
