import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import {
  actAs,
  actAsSuperuser,
  closePool,
  seedCompanyUser,
  setCompanyClaimContext,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/** ينشئ شركة اختبار ويعيد معرّفها. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة كلمة مرور ${tag}`, `Password Co ${tag}`],
  );
  return rows[0].id;
}

/** يرفع علامة تغيير كلمة المرور على المستخدم بصلاحية المالك. */
async function flagUser(client: PoolClient, userId: string): Promise<void> {
  await client.query(`update public.profiles set must_change_password = true where id = $1`, [
    userId,
  ]);
}

/** يقرأ علامة تغيير كلمة المرور بصلاحية المالك. */
async function readFlag(client: PoolClient, userId: string): Promise<boolean> {
  await actAsSuperuser(client);
  const { rows } = await client.query<{ must_change_password: boolean }>(
    `select must_change_password from public.profiles where id = $1`,
    [userId],
  );
  return rows[0].must_change_password;
}

describe("migration 316 - a user cannot clear their own must-change-password flag", () => {
  // `admin` holds users.update, `collector` does not: neither may clear it.
  test.each(["admin", "collector"])(
    "a signed-in %s clearing the flag on their own row leaves it set",
    async (role) => {
      await withRollback(async (client) => {
        const companyId = await seedCompany(client);
        await setCompanyClaimContext(client, companyId);
        const userId = await seedCompanyUser(client, companyId, role);
        await flagUser(client, userId);

        await actAs(client, "authenticated", userId);
        const { rowCount } = await client.query(
          `update public.profiles set must_change_password = false where id = $1`,
          [userId],
        );

        // RLS lets a user update their own row, so the update reaches it and
        // it is the guard, not a refused write, that keeps the flag.
        expect(rowCount).toBe(1);
        expect(await readFlag(client, userId)).toBe(true);
      });
    },
  );

  test("an admin can still clear the flag on another user's row", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      await setCompanyClaimContext(client, companyId);
      const adminId = await seedCompanyUser(client, companyId, "admin");
      const staffId = await seedCompanyUser(client, companyId, "collector");
      await flagUser(client, staffId);

      await actAs(client, "authenticated", adminId);
      const { rowCount } = await client.query(
        `update public.profiles set must_change_password = false where id = $1`,
        [staffId],
      );

      // Guards against a vacuous pass: the update must have reached the row.
      expect(rowCount).toBe(1);
      expect(await readFlag(client, staffId)).toBe(false);
    });
  });

  test("the password change server path (company_service) clears the flag", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      await setCompanyClaimContext(client, companyId);
      const userId = await seedCompanyUser(client, companyId, "collector");
      await flagUser(client, userId);

      await client.query("select set_config('role', 'company_service', true)");
      await client.query(`update public.profiles set must_change_password = false where id = $1`, [
        userId,
      ]);

      expect(await readFlag(client, userId)).toBe(false);
    });
  });
});
