import { afterAll, describe, expect, test } from "vitest";

import { runAsCompanyService, seedTwoCompanies } from "@/db/isolation/twoCompanies";
import { captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

describe("migration 328 - notifications.skip_reason constraint (T129)", () => {
  test.each(["limit_reached", "module_disabled", "company_suspended", null] as const)(
    "accepts skipped notification row with skip_reason=%s",
    async (skipReason) => {
      await withRollback(async (client) => {
        const { A } = await seedTwoCompanies(client);

        await runAsCompanyService(client, A.id, async () => {
          const err = await captureRaise(client, () =>
            client.query(
              `insert into public.notifications (company_id, type, channel, state, skip_reason)
               values ($1, 'due_reminder', 'whatsapp', 'skipped', $2)`,
              [A.id, skipReason],
            ),
          );
          expect(err).toBeNull();
        });
      });
    },
  );

  test.each(["queued", "sent", "failed", "cancelled"] as const)(
    "refuses skip_reason on non-skipped notification row with state=%s",
    async (state) => {
      await withRollback(async (client) => {
        const { A } = await seedTwoCompanies(client);

        await runAsCompanyService(client, A.id, async () => {
          const err = await captureRaise(client, () =>
            client.query(
              `insert into public.notifications (company_id, type, channel, state, skip_reason)
               values ($1, 'due_reminder', 'whatsapp', $2::public.notification_states, 'limit_reached')`,
              [A.id, state],
            ),
          );
          expect(err).toContain("notifications_skip_reason_requires_skipped");
        });
      });
    },
  );

  test("refuses invalid skip_reason value and state transition that leaves skip_reason on non-skipped row", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);

      await runAsCompanyService(client, A.id, async () => {
        const invalidReasonErr = await captureRaise(client, () =>
          client.query(
            `insert into public.notifications (company_id, type, channel, state, skip_reason)
             values ($1, 'due_reminder', 'whatsapp', 'skipped', 'unknown_reason')`,
            [A.id],
          ),
        );
        expect(invalidReasonErr).toContain("notifications_skip_reason_check");

        const {
          rows: [inserted],
        } = await client.query<{ id: string }>(
          `insert into public.notifications (company_id, type, channel, state, skip_reason)
           values ($1, 'due_reminder', 'whatsapp', 'skipped', 'limit_reached')
           returning id`,
          [A.id],
        );

        const transitionErr = await captureRaise(client, () =>
          client.query(`update public.notifications set state = 'queued' where id = $1`, [
            inserted.id,
          ]),
        );
        expect(transitionErr).toContain("notifications_skip_reason_requires_skipped");
      });
    });
  });
});
