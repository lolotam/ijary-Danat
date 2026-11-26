import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runAsCompanyService, runAsUser, seedTwoCompanies } from "@/db/isolation/twoCompanies";
import { actAsSuperuser, captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/** يضيف طلب مهمة عبر `enqueue_job` ويعيد معرّفه. */
async function enqueue(
  client: PoolClient,
  kind: string,
  payload: Record<string, unknown>,
  dedupeKey: string | null = null,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "select public.enqueue_job($1, $2::jsonb, $3) as id",
    [kind, JSON.stringify(payload), dedupeKey],
  );
  return rows[0].id;
}

/** يعدّ صفوف `job_requests` لشركة معيّنة بصلاحية المشرف العام. */
async function countJobs(client: PoolClient, companyId: string): Promise<number> {
  await actAsSuperuser(client);
  const { rows } = await client.query<{ n: number }>(
    "select count(*)::int as n from public.job_requests where company_id = $1",
    [companyId],
  );
  return rows[0].n;
}

describe("enqueue_job is transactional (T053, contracts/jobs.md section 1)", () => {
  test("work that commits leaves exactly one pending job", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      await runAsCompanyService(client, A.id, async () => {
        await client.query("savepoint change");
        await enqueue(client, "notification.dispatch", { notificationId: "n-1" });
        await client.query("release savepoint change");
      });

      await actAsSuperuser(client);
      const { rows } = await client.query(
        "select kind, status, requested_by, payload from public.job_requests where company_id = $1",
        [A.id],
      );
      expect(rows).toEqual([
        {
          kind: "notification.dispatch",
          status: "pending",
          requested_by: null,
          payload: { notificationId: "n-1" },
        },
      ]);
    });
  });

  test("work that rolls back leaves no job", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      await runAsCompanyService(client, A.id, async () => {
        await client.query("savepoint change");
        await enqueue(client, "notification.dispatch", { notificationId: "n-1" });
        await client.query("rollback to savepoint change");
      });

      expect(await countJobs(client, A.id)).toBe(0);
    });
  });

  test("the same dedupe key returns the existing job instead of a second one", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const [first, second, otherKind] = await runAsCompanyService(client, A.id, async () => [
        await enqueue(client, "invoice.send", { invoiceId: "i-1" }, "i-1__email__2026-11-26"),
        await enqueue(client, "invoice.send", { invoiceId: "i-1" }, "i-1__email__2026-11-26"),
        await enqueue(client, "payment.receipt", { paymentId: "p-1" }, "i-1__email__2026-11-26"),
      ]);

      expect(second).toBe(first);
      expect(otherKind).not.toBe(first);
      expect(await countJobs(client, A.id)).toBe(2);
    });
  });

  test("dedupe is per company: B's key does not resolve to A's job", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const jobA = await runAsCompanyService(client, A.id, () =>
        enqueue(client, "invoice.send", { invoiceId: "i-1" }, "same-key"),
      );
      const jobB = await runAsCompanyService(client, B.id, () =>
        enqueue(client, "invoice.send", { invoiceId: "i-1" }, "same-key"),
      );

      expect(jobB).not.toBe(jobA);
    });
  });
});

describe("enqueue_job refuses what it must not accept", () => {
  test("no company context raises COMPANY_REQUIRED and writes nothing", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const error = await runAsCompanyService(client, null, () =>
        captureRaise(client, () => enqueue(client, "notification.dispatch", {})),
      );

      expect(error).toMatch(/COMPANY_REQUIRED/);
      expect(await countJobs(client, A.id)).toBe(0);
    });
  });

  test("a signed-in user cannot call it or write the table directly", async () => {
    // The only enqueue paths are server code (company_service) and SQL functions
    // running as their owner, so a renter cannot queue `company.restore`.
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const [rpc, insert] = await runAsUser(client, A.users.admin, async () => [
        await captureRaise(client, () => enqueue(client, "notification.dispatch", {})),
        await captureRaise(client, () =>
          client.query(
            `insert into public.job_requests (company_id, kind, payload)
             values ($1, 'notification.dispatch', '{}')`,
            [A.id],
          ),
        ),
      ]);

      expect(rpc).toMatch(/permission denied/);
      expect(insert).toMatch(/permission denied/);
    });
  });

  test.each([
    ["a malformed kind", "Notification Dispatch", {}],
    ["an oversized payload", "notification.dispatch", { blob: "x".repeat(20_000) }],
  ])("%s is rejected", async (_label, kind, payload) => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const error = await runAsCompanyService(client, A.id, () =>
        captureRaise(client, () => enqueue(client, kind, payload)),
      );

      expect(error).toMatch(/violates check constraint/);
    });
  });
});

describe("job_requests and user_notices stay inside the company", () => {
  test("company_service of B sees none of A's jobs", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      await runAsCompanyService(client, A.id, () => enqueue(client, "notification.dispatch", {}));

      const { rowCount } = await runAsCompanyService(client, B.id, () =>
        client.query("select 1 from public.job_requests"),
      );
      expect(rowCount).toBe(0);
    });
  });

  test("a user reads and marks only their own notices", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const jobId = await runAsCompanyService(client, A.id, () =>
        enqueue(client, "notification.bulk", { requestId: "r-1" }),
      );
      await actAsSuperuser(client);
      await client.query(
        `insert into public.user_notices (company_id, user_id, job_request_id, kind, title_key, level)
         values ($1, $2, $4, 'notification.bulk', 'notices.bulk.done', 'success'),
                ($1, $3, $4, 'notification.bulk', 'notices.bulk.done', 'success')`,
        [A.id, A.users.admin.id, A.users.accountant.id, jobId],
      );

      const { visible, marked, edited } = await runAsUser(client, A.users.admin, async () => ({
        visible: (await client.query("select user_id from public.user_notices")).rows,
        marked: (await client.query("update public.user_notices set read_at = now()")).rowCount,
        edited: await captureRaise(client, () =>
          client.query("update public.user_notices set level = 'error'"),
        ),
      }));

      expect(visible).toEqual([{ user_id: A.users.admin.id }]);
      expect(marked).toBe(1);
      expect(edited).toMatch(/permission denied/);
    });
  });
});
