import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { actAs, actAsSuperuser, closePool, withRollback } from "@/db/testDb";
import { actAsCompanyService, seedTwoCompanies } from "@/db/isolation/twoCompanies";

afterAll(closePool);

/** The all-zero id `findPlatformMessageOwner` signs for the platform lookup. */
const PLATFORM_LOOKUP_COMPANY_ID = "00000000-0000-0000-0000-000000000000";

/**
 * يُدرج إشعار بريد لشركة بمعرّف رسالة مزوّد محدد ويعيد معرّف الإشعار.
 */
async function insertEmailNotification(
  client: PoolClient,
  companyId: string,
  providerMessageId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.notifications (company_id, type, channel, state, provider_message_id)
     values ($1, 'due_reminder', 'email', 'sent', $2)
     returning id`,
    [companyId, providerMessageId],
  );
  return rows[0].id;
}

/**
 * يستدعي دالة البحث عن مالك رسالة البريد ويعيد الصفوف التي رجعت.
 */
async function lookupOwner(client: PoolClient, messageId: string) {
  const { rows } = await client.query<{ company_id: string; notification_id: string }>(
    `select company_id, notification_id from public.platform_email_notification_owner($1)`,
    [messageId],
  );
  return rows;
}

describe("platform_email_notification_owner (T201 F4)", () => {
  test("the platform lookup claim finds a message owned by any company", async () => {
    await withRollback(async (client) => {
      const { B } = await seedTwoCompanies(client);
      const messageId = `re_${randomUUID()}`;
      const notificationId = await insertEmailNotification(client, B.id, messageId);

      await actAsCompanyService(client, PLATFORM_LOOKUP_COMPANY_ID, { allowSuspended: true });
      expect(await lookupOwner(client, messageId)).toEqual([
        { company_id: B.id, notification_id: notificationId },
      ]);

      await actAs(client, "service_role");
      expect(await lookupOwner(client, messageId)).toHaveLength(1);
      await actAsSuperuser(client);
    });
  });

  test("a suspended company's token whose context failed closed finds nothing", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client, { statusA: "suspended" });
      const messageId = `re_${randomUUID()}`;
      await insertEmailNotification(client, B.id, messageId);

      // Before migration 336 a null current_company_id() opened the
      // cross-company branch; a suspended company read B's notification.
      await actAsCompanyService(client, A.id);
      expect(await lookupOwner(client, messageId)).toEqual([]);

      await actAsCompanyService(client, null);
      expect(await lookupOwner(client, messageId)).toEqual([]);
      await actAsSuperuser(client);
    });
  });

  test("an active company finds only its own message, including a comma-joined id", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const ownId = `re_${randomUUID()}`;
      const otherId = `re_${randomUUID()}`;
      const ownNotification = await insertEmailNotification(client, A.id, `re_x, ${ownId}`);
      await insertEmailNotification(client, B.id, otherId);

      await actAsCompanyService(client, A.id);
      expect(await lookupOwner(client, ownId)).toEqual([
        { company_id: A.id, notification_id: ownNotification },
      ]);
      expect(await lookupOwner(client, otherId)).toEqual([]);
      await actAsSuperuser(client);
    });
  });
});
