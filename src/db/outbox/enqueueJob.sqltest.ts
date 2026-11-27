import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runAsCompanyService, runAsUser, seedTwoCompanies } from "@/db/isolation/twoCompanies";
import { actAs, actAsSuperuser, captureRaise, closePool, withRollback } from "@/db/testDb";

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
      // One notice names one job request (migration 311), and a job names the
      // staff member who asked for it — so each user gets a notice of their
      // own job.
      const [adminJob, accountantJob] = await runAsCompanyService(client, A.id, async () => [
        (
          await client.query<{ id: string }>(
            "select public.enqueue_job('notification.bulk', '{}', null, $1) as id",
            [A.users.admin.id],
          )
        ).rows[0].id,
        (
          await client.query<{ id: string }>(
            "select public.enqueue_job('notification.bulk', '{}', null, $1) as id",
            [A.users.accountant.id],
          )
        ).rows[0].id,
      ]);
      await actAsSuperuser(client);
      await client.query(
        `insert into public.user_notices (company_id, user_id, job_request_id, kind, title_key, level)
         values ($1, $2, $4, 'notification.bulk', 'notices.bulk.done', 'success'),
                ($1, $3, $5, 'notification.bulk', 'notices.bulk.done', 'success')`,
        [A.id, A.users.admin.id, A.users.accountant.id, adminJob, accountantJob],
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

/** يزرع مهمة وإشعاراً مرتبطاً بها لمستخدم في الشركة المعطاة بصلاحية المشرف العام. */
async function seedJobAndNotice(
  client: PoolClient,
  companyId: string,
  userId: string,
): Promise<void> {
  await actAsSuperuser(client);
  await client.query(
    `with j as (
       insert into public.job_requests (company_id, kind, payload)
       values ($1, 'notification.bulk', '{}') returning id)
     insert into public.user_notices (company_id, user_id, job_request_id, kind, title_key, level)
     select $1, $2, j.id, 'notification.bulk', 'notices.bulk.done', 'success' from j`,
    [companyId, userId],
  );
}

describe("the server write path stays inside the company (review GR-001 to GR-004)", () => {
  test("a server-side requester is recorded, and only if they belong to the company", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const [ownJob, foreign] = await runAsCompanyService(client, A.id, async () => [
        (
          await client.query<{ id: string }>(
            "select public.enqueue_job('report.export', '{}', null, $1) as id",
            [A.users.admin.id],
          )
        ).rows[0].id,
        await captureRaise(client, () =>
          client.query("select public.enqueue_job('report.export', '{}', null, $1)", [
            B.users.admin.id,
          ]),
        ),
      ]);

      await actAsSuperuser(client);
      const { rows } = await client.query(
        "select requested_by from public.job_requests where id = $1",
        [ownJob],
      );
      expect(rows).toEqual([{ requested_by: A.users.admin.id }]);
      expect(foreign).toMatch(/violates foreign key constraint/);
    });
  });

  test.each([
    {
      table: "job_requests",
      forgeSql: "insert into public.job_requests (company_id, kind) values ($1, 'x.y')",
      withUser: false,
    },
    {
      table: "user_notices",
      forgeSql: `insert into public.user_notices (company_id, user_id, kind, title_key, level)
                 values ($1, $2, 'x.y', 't', 'success')`,
      withUser: true,
    },
  ])(
    "company_service of B cannot update $table rows of A or insert them under A",
    async ({ table, forgeSql, withUser }) => {
      await withRollback(async (client) => {
        const { A, B } = await seedTwoCompanies(client);
        await seedJobAndNotice(client, A.id, A.users.admin.id);
        const forgeParams = withUser ? [A.id, A.users.admin.id] : [A.id];

        const { updated, forged } = await runAsCompanyService(client, B.id, async () => ({
          updated: (
            await client.query(`update public.${table} set kind = 'x.y' where company_id = $1`, [
              A.id,
            ])
          ).rowCount,
          forged: await captureRaise(client, () => client.query(forgeSql, forgeParams)),
        }));

        expect(updated).toBe(0);
        expect(forged).toMatch(/row-level security/);
      });
    },
  );

  test("company_service cannot delete outbox rows, even its own", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      await seedJobAndNotice(client, A.id, A.users.admin.id);

      const error = await runAsCompanyService(client, A.id, () =>
        captureRaise(client, () => client.query("delete from public.job_requests")),
      );

      expect(error).toMatch(/permission denied/);
    });
  });

  test("a notice cannot name a user of another company", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const error = await runAsCompanyService(client, A.id, () =>
        captureRaise(client, () =>
          client.query(
            `insert into public.user_notices (company_id, user_id, kind, title_key, level)
             values ($1, $2, 'notification.bulk', 'notices.bulk.done', 'success')`,
            [A.id, B.users.admin.id],
          ),
        ),
      );

      expect(error).toMatch(/violates foreign key constraint/);
    });
  });
});

describe("one job request names one notice (T071 review)", () => {
  test("a second notice for the same job request is rejected", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const jobId = await runAsCompanyService(client, A.id, () =>
        enqueue(client, "notification.bulk", { requestId: "r-1" }),
      );
      await actAsSuperuser(client);
      const insertNotice = () =>
        client.query(
          `insert into public.user_notices (company_id, user_id, job_request_id, kind, title_key, level)
           values ($1, $2, $3, 'notification.bulk', 'notices.bulk.done', 'success')`,
          [A.id, A.users.admin.id, jobId],
        );

      await insertNotice();
      const error = await captureRaise(client, insertNotice);

      expect(error).toMatch(/duplicate key|unique/i);
    });
  });

  test("the worker's upsert on job_request_id works", async () => {
    // The worker writes the notice of a finished job with onConflict
    // job_request_id, so the unique index has to serve ON CONFLICT without a
    // predicate — a partial index cannot.
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const jobId = await runAsCompanyService(client, A.id, () =>
        enqueue(client, "notification.bulk", { requestId: "r-1" }),
      );
      await actAsSuperuser(client);
      const upsertNotice = () =>
        client.query(
          `insert into public.user_notices (company_id, user_id, job_request_id, kind, title_key, level)
           values ($1, $2, $3, 'notification.bulk', 'notices.bulk.done', 'success')
           on conflict (job_request_id) do update set title_key = excluded.title_key`,
          [A.id, A.users.admin.id, jobId],
        );

      await upsertNotice();
      await upsertNotice();

      const { rows } = await client.query<{ n: number }>(
        "select count(*)::int as n from public.user_notices where job_request_id = $1",
        [jobId],
      );
      expect(rows[0].n).toBe(1);
    });
  });
});

describe("enqueue_job_for_company is the money functions' own door (GR-003)", () => {
  test("it refuses a null company and an unknown one", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);

      const nullCompany = await captureRaise(client, () =>
        client.query(
          "select public.enqueue_job_for_company(null, 'payment.succeeded', '{}'::jsonb, null)",
        ),
      );
      const unknownCompany = await captureRaise(client, () =>
        client.query(
          "select public.enqueue_job_for_company($1::uuid, 'payment.succeeded', '{}'::jsonb, null)",
          [randomUUID()],
        ),
      );

      expect(nullCompany).toMatch(/COMPANY_REQUIRED/);
      expect(unknownCompany).toMatch(/Company not found/);
      expect(await countJobs(client, A.id)).toBe(0);
    });
  });

  test("a company client and a signed-in user may not call it", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const call = () =>
        client.query(
          "select public.enqueue_job_for_company($1::uuid, 'payment.succeeded', '{}'::jsonb, null)",
          [A.id],
        );

      const asCompany = await runAsCompanyService(client, A.id, () => captureRaise(client, call));
      const asUser = await runAsUser(client, A.users.admin, () => captureRaise(client, call));

      expect(asCompany).toMatch(/permission denied/);
      expect(asUser).toMatch(/permission denied/);
      expect(await countJobs(client, A.id)).toBe(0);
    });
  });

  test("the platform files the row for the company it names", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);

      await actAs(client, "service_role");
      const { rows } = await client.query<{ id: string }>(
        `select public.enqueue_job_for_company(
           $1::uuid, 'payment.succeeded', '{"paymentId": "p-1"}'::jsonb, 'platform-key'
         ) as id`,
        [A.id],
      );
      await actAsSuperuser(client);

      const { rows: job } = await client.query(
        "select company_id, kind, dedupe_key from public.job_requests where id = $1",
        [rows[0].id],
      );
      expect(job).toEqual([
        { company_id: A.id, kind: "payment.succeeded", dedupe_key: "platform-key" },
      ]);
    });
  });
});
