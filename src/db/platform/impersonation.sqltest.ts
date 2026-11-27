import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runAsUser, seedTwoCompanies } from "@/db/isolation/twoCompanies";
import { actAsSuperuser, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * ينشئ مشرف منصة نشطاً في `auth.users` و`public.platform_admins` لاستخدامه في اختبارات جلسات الدعم.
 */
async function seedPlatformAdmin(
  client: PoolClient,
  fullName = "Support Admin",
): Promise<{ userId: string; fullName: string }> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@platform.ijary.invalid`],
  );
  await client.query(
    `insert into public.platform_admins (user_id, full_name, is_active)
     values ($1, $2, true)`,
    [userId, fullName],
  );
  return { userId, fullName };
}

/**
 * ينشئ صف جلسة انتحال في `public.impersonation_sessions` ويعيد معرّفها.
 */
async function seedImpersonationSession(
  client: PoolClient,
  params: {
    platformAdminId: string;
    companyId: string;
    targetUserId: string;
    reason?: string;
    expiresAtOffsetSql?: string;
    endedAtSql?: string;
    startedAtSql?: string;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.impersonation_sessions (
       platform_admin_id, company_id, target_user_id, reason, started_at, expires_at, ended_at
     ) values (
       $1, $2, $3, $4,
       ${params.startedAtSql ?? "now()"},
       ${params.expiresAtOffsetSql ?? "now() + interval '60 minutes'"},
       ${params.endedAtSql ?? "null"}
     )
     returning id`,
    [
      params.platformAdminId,
      params.companyId,
      params.targetUserId,
      params.reason ?? "Investigate billing issue",
    ],
  );
  return rows[0].id;
}

describe("impersonation_sessions & support-session SQL contract (T175)", () => {
  test("open session grants the target user's company while ended or expired sessions grant nothing", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const admin = await seedPlatformAdmin(client);

      const openId = await seedImpersonationSession(client, {
        platformAdminId: admin.userId,
        companyId: A.id,
        targetUserId: A.users.admin.id,
      });

      const endedId = await seedImpersonationSession(client, {
        platformAdminId: admin.userId,
        companyId: A.id,
        targetUserId: A.users.admin.id,
        endedAtSql: "now()",
      });

      const expiredId = await seedImpersonationSession(client, {
        platformAdminId: admin.userId,
        companyId: A.id,
        targetUserId: A.users.admin.id,
        // The table refuses a session that ends before it starts, so the
        // expired one also started in the past.
        startedAtSql: "now() - interval '61 minutes'",
        expiresAtOffsetSql: "now() - interval '1 minute'",
      });

      await runAsUser(
        client,
        A.users.admin,
        async () => {
          const { rows } = await client.query<{ cid: string | null }>(
            `select public.current_company_id() as cid`,
          );
          expect(rows[0].cid).toBe(A.id);
        },
        { impersonator: admin.userId, impersonation_session: openId },
      );

      for (const closedSessionId of [endedId, expiredId]) {
        await runAsUser(
          client,
          A.users.admin,
          async () => {
            const { rows } = await client.query<{ cid: string | null }>(
              `select public.current_company_id() as cid`,
            );
            expect(rows[0].cid).toBeNull();
          },
          { impersonator: admin.userId, impersonation_session: closedSessionId },
        );
      }
    });
  });

  test("session whose target user belongs to another company grants nothing", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const admin = await seedPlatformAdmin(client);

      const mismatchedSessionId = await seedImpersonationSession(client, {
        platformAdminId: admin.userId,
        companyId: A.id,
        targetUserId: B.users.admin.id,
      });

      await runAsUser(
        client,
        B.users.admin,
        async () => {
          const { rows } = await client.query<{ cid: string | null }>(
            `select public.current_company_id() as cid`,
          );
          expect(rows[0].cid).toBeNull();
        },
        { impersonator: admin.userId, impersonation_session: mismatchedSessionId },
      );
    });
  });

  test("write_audit records the impersonator as actor during an open support session", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const admin = await seedPlatformAdmin(client, "Platform Support Lead");

      const sessionId = await seedImpersonationSession(client, {
        platformAdminId: admin.userId,
        companyId: A.id,
        targetUserId: A.users.admin.id,
      });

      let auditId = "";
      await runAsUser(
        client,
        A.users.admin,
        async () => {
          const { rows } = await client.query<{ id: string }>(
            `select public.write_audit(
               'support.test_action',
               'company',
               $1::uuid,
               null,
               '{"note": "checked"}'::jsonb
             ) as id`,
            [A.id],
          );
          auditId = rows[0].id;
        },
        { impersonator: admin.userId, impersonation_session: sessionId },
      );

      await actAsSuperuser(client);
      const { rows: auditRows } = await client.query<{
        company_id: string;
        actor_id: string;
        actor_label: string | null;
        role: string | null;
      }>(
        `select company_id, actor_id, actor_label, role
           from public.audit_logs
          where id = $1`,
        [auditId],
      );

      expect(auditRows).toEqual([
        {
          company_id: A.id,
          actor_id: admin.userId,
          actor_label: admin.fullName,
          role: "platform_admin",
        },
      ]);
    });
  });
});
