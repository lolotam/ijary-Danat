import { afterAll, describe, expect, test } from "vitest";

import { actAsSuperuser, captureRaise, closePool, withRollback } from "@/db/testDb";
import {
  actAsCompanyService,
  actAsCompanyUser,
  seedTwoCompanies,
} from "@/db/isolation/twoCompanies";

afterAll(closePool);

/**
 * يختبر بوابة إطلاق الوضع الفعلي لبوابات الدفع في قاعدة البيانات (T151 / SC-012).
 */
describe("gateway live-mode launch gate (T151)", () => {
  test("refuses live mode while live_allowed is false and allows it once enabled", async () => {
    await withRollback(async (client) => {
      const fixture = await seedTwoCompanies(client);

      await actAsCompanyService(client, fixture.A.id);

      // Test mode is always allowed even when live_allowed is false.
      const { rows: testRows } = await client.query<{ id: string; mode: string }>(
        `insert into public.gateway_connections (company_id, provider, mode)
         values ($1, 'myfatoorah', 'test')
         returning id, mode`,
        [fixture.A.id],
      );
      expect(testRows[0].mode).toBe("test");

      // Inserting live mode directly is refused with GATEWAY_LIVE_NOT_ALLOWED.
      const insertLiveMsg = await captureRaise(client, () =>
        client.query(
          `insert into public.gateway_connections (company_id, provider, mode)
           values ($1, 'tap', 'live')`,
          [fixture.A.id],
        ),
      );
      expect(insertLiveMsg).toBe("GATEWAY_LIVE_NOT_ALLOWED");

      // Updating an existing test connection to live mode is also refused.
      const updateLiveMsg = await captureRaise(client, () =>
        client.query(
          `update public.gateway_connections
              set mode = 'live'
            where id = $1`,
          [testRows[0].id],
        ),
      );
      expect(updateLiveMsg).toBe("GATEWAY_LIVE_NOT_ALLOWED");

      // Superuser (service_role) enables live_allowed for myfatoorah.
      await actAsSuperuser(client);
      await client.query(
        `update public.platform_gateway_launch
            set live_allowed = true
          where provider = 'myfatoorah'`,
      );

      await actAsCompanyService(client, fixture.A.id);
      const { rows: liveRows } = await client.query<{ mode: string }>(
        `update public.gateway_connections
            set mode = 'live'
          where id = $1
          returning mode`,
        [testRows[0].id],
      );
      expect(liveRows[0].mode).toBe("live");

      // Turning the flag back off does not break unrelated updates on existing live connections.
      await actAsSuperuser(client);
      await client.query(
        `update public.platform_gateway_launch
            set live_allowed = false
          where provider = 'myfatoorah'`,
      );

      await actAsCompanyService(client, fixture.A.id);
      const { rows: updatedLiveRows } = await client.query<{ last_test_ok: boolean }>(
        `update public.gateway_connections
            set last_test_ok = true,
                last_test_at = now()
          where id = $1
          returning last_test_ok`,
        [testRows[0].id],
      );
      expect(updatedLiveRows[0].last_test_ok).toBe(true);
    });
  });

  test("forbids companies (authenticated and company_service) from reading or writing platform_gateway_launch", async () => {
    await withRollback(async (client) => {
      const fixture = await seedTwoCompanies(client);

      await actAsCompanyUser(client, fixture.A.users.admin);
      const staffReadErr = await captureRaise(client, () =>
        client.query(`select provider, live_allowed from public.platform_gateway_launch`),
      );
      expect(staffReadErr).toBeTruthy();

      const staffWriteErr = await captureRaise(client, () =>
        client.query(
          `update public.platform_gateway_launch set live_allowed = true where provider = 'myfatoorah'`,
        ),
      );
      expect(staffWriteErr).toBeTruthy();

      await actAsCompanyService(client, fixture.A.id);
      const serviceReadErr = await captureRaise(client, () =>
        client.query(`select provider, live_allowed from public.platform_gateway_launch`),
      );
      expect(serviceReadErr).toBeTruthy();

      const serviceWriteErr = await captureRaise(client, () =>
        client.query(
          `update public.platform_gateway_launch set live_allowed = true where provider = 'myfatoorah'`,
        ),
      );
      expect(serviceWriteErr).toBeTruthy();
    });
  });
});
