import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedContract,
  withRollback,
  type ContractFixture,
} from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 220 — the insurance panel writes `contracts.deposit` through one
 * RPC gated on insurance rights and audited in SQL.
 *
 * The accountant role is the case that motivated it: it holds insurance.create
 * and insurance.update but not contracts.update, so the old bare browser
 * update was refused for it on every save.
 */

/** ينشئ مستخدمًا في auth.users بدور تطبيق واحد ويعيد معرّفه. */
async function seedUserWithRole(client: PoolClient, role: string): Promise<string> {
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

/** يستدعي الدالة لسجل تأمين ويعيد قيمة الوديعة التي أرجعتها. */
async function syncDeposit(client: PoolClient, insuranceId: string): Promise<number> {
  const { rows } = await client.query<{ deposit: string }>(
    `select (public.sync_contract_deposit_from_insurance($1)).deposit`,
    [insuranceId],
  );
  return Number(rows[0]!.deposit);
}

/** يزرع سجل تأمين محفوظًا لعقد بمبلغ معطى ويعيد معرّفه. */
async function seedInsurance(client: PoolClient, fx: ContractFixture, amount: number) {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.insurance_payments (tenant_id, contract_id, unit_id, amount)
     values ($1, $2, $3, $4) returning id`,
    [fx.tenantId, fx.contractId, fx.unitId, amount],
  );
  return rows[0]!.id;
}

/** يقرأ وديعة العقد الحالية. */
async function contractDeposit(client: PoolClient, contractId: string): Promise<number> {
  const { rows } = await client.query<{ deposit: string }>(
    `select deposit from public.contracts where id = $1`,
    [contractId],
  );
  return Number(rows[0]!.deposit);
}

/** يقرأ صفوف تدقيق مزامنة الوديعة لعقد واحد. */
async function depositAuditRows(client: PoolClient, contractId: string) {
  const { rows } = await client.query<{ before: { deposit: number }; after: { deposit: number } }>(
    `select before, after from public.audit_logs
      where action = 'contract.deposit.sync_from_insurance' and entity_id = $1`,
    [contractId],
  );
  return rows;
}

/** يزرع عقدًا نشطًا بوديعة معروفة. */
function seedDepositContract(client: PoolClient, deposit: number) {
  return seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31", deposit });
}

describe("sync_contract_deposit_from_insurance (migration 220)", () => {
  test("an accountant without contracts.update brings the deposit in line with the saved insurance row", async () => {
    await withRollback(async (client) => {
      const fx = await seedDepositContract(client, 300);
      const insuranceId = await seedInsurance(client, fx, 450);
      const accountant = await seedUserWithRole(client, "accountant");
      await actAs(client, "authenticated", accountant);

      expect(await syncDeposit(client, insuranceId)).toBe(450);

      await actAsSuperuser(client);
      const audit = await depositAuditRows(client, fx.contractId);
      expect(audit).toHaveLength(1);
      expect(Number(audit[0]!.before.deposit)).toBe(300);
      expect(Number(audit[0]!.after.deposit)).toBe(450);
    });
  });

  test("an insurance row already matching the deposit changes nothing and writes no audit row", async () => {
    await withRollback(async (client) => {
      const fx = await seedDepositContract(client, 300);
      const insuranceId = await seedInsurance(client, fx, 300);
      const accountant = await seedUserWithRole(client, "accountant");
      await actAs(client, "authenticated", accountant);

      expect(await syncDeposit(client, insuranceId)).toBe(300);

      await actAsSuperuser(client);
      expect(await depositAuditRows(client, fx.contractId)).toHaveLength(0);
    });
  });

  // Codex review, PR #232: the caller supplies only the insurance id, so the
  // contract and amount can never be chosen freely.
  test("an id that is not a saved insurance row is refused and no deposit moves", async () => {
    await withRollback(async (client) => {
      const fx = await seedDepositContract(client, 300);
      const accountant = await seedUserWithRole(client, "accountant");
      await actAs(client, "authenticated", accountant);

      const raised = await captureRaise(client, () => syncDeposit(client, fx.contractId));
      expect(raised).toMatch(/Insurance record not found/);

      await actAsSuperuser(client);
      expect(await contractDeposit(client, fx.contractId)).toBe(300);
    });
  });

  test("a role without insurance rights is refused and the deposit is unchanged", async () => {
    await withRollback(async (client) => {
      const fx = await seedDepositContract(client, 300);
      const insuranceId = await seedInsurance(client, fx, 999);
      const collector = await seedUserWithRole(client, "collector");
      await actAs(client, "authenticated", collector);

      const raised = await captureRaise(client, () => syncDeposit(client, insuranceId));
      expect(raised).toMatch(/Permission denied/);

      await actAsSuperuser(client);
      expect(await contractDeposit(client, fx.contractId)).toBe(300);
    });
  });

  test("anon cannot execute it", async () => {
    await withRollback(async (client) => {
      const fx = await seedDepositContract(client, 300);
      const insuranceId = await seedInsurance(client, fx, 1);
      await actAs(client, "anon");
      const raised = await captureRaise(client, () => syncDeposit(client, insuranceId));
      expect(raised).toMatch(/permission denied/i);
      await actAsSuperuser(client);
    });
  });
});
