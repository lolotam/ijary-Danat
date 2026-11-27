import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runAsCompanyService, runAsUser, seedTwoCompanies } from "@/db/isolation/twoCompanies";
import { actAs, actAsSuperuser, captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/** صفٌّ في `job_requests` كما يراه المرحِّل. */
interface ClaimedRow {
  id: string;
  company_id: string;
  kind: string;
}

/** صفٌّ يُزرع في صندوق المهام. */
interface JobSeed {
  companyId: string;
  kind: string;
  status: string;
  publishedAt?: string | null;
  createdAt?: string | null;
}

/**
 * يزرع صف مهمة بحالة معيّنة وتاريخ نشر ووقت إنشاء اختياريين.
 *
 * The rows are written as the table owner: what the suite checks is who may
 * *claim* them, not who may enqueue them.
 */
async function seedJob(client: PoolClient, seed: JobSeed): Promise<string> {
  await actAsSuperuser(client);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.job_requests (company_id, kind, status, published_at, created_at)
     values ($1, $2, $3, $4, coalesce($5::timestamptz, now()))
     returning id`,
    [seed.companyId, seed.kind, seed.status, seed.publishedAt ?? null, seed.createdAt ?? null],
  );
  return rows[0].id;
}

/** يحجز الصفوف بدور المرحِّل الحقيقي (`service_role`) ويعيد ما حجزه. */
async function claimAsServiceRole(client: PoolClient, limit = 100): Promise<ClaimedRow[]> {
  await actAs(client, "service_role");
  const { rows } = await client.query<ClaimedRow>(
    "select id, company_id, kind from public.relay_claim_jobs($1)",
    [limit],
  );
  await actAsSuperuser(client);
  return rows;
}

/**
 * يقرأ حالة الصفوف المطلوبة بصلاحية المشرف العام، مقرونةً بمعرّف كل صف.
 *
 * A map, not a list: the ids are random uuids, so a list would be ordered by
 * uuid and every expectation would lean on that order instead of on the rows.
 */
async function statusesOf(client: PoolClient, ids: string[]): Promise<Map<string, string>> {
  await actAsSuperuser(client);
  const { rows } = await client.query<{ id: string; status: string }>(
    "select id, status from public.job_requests where id = any($1::uuid[])",
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row.status]));
}

/**
 * معرّفات الصفوف المحجوزة مرتّبةً — ترتيب `UPDATE … RETURNING` غير مضمون.
 */
function claimedIds(rows: ClaimedRow[]): string[] {
  return rows.map((row) => row.id).sort();
}

/** يقرأ وقت نشر صف واحد بالثواني منذepoch. */
async function publishedEpoch(client: PoolClient, id: string): Promise<number> {
  await actAsSuperuser(client);
  const { rows } = await client.query<{ epoch: string }>(
    "select extract(epoch from published_at) as epoch from public.job_requests where id = $1",
    [id],
  );
  return Number(rows[0].epoch);
}

describe("relay_claim_jobs claims rows for the relay (T063, contracts/jobs.md section 2)", () => {
  test("pending rows of two companies are claimed and become published", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const jobA = await seedJob(client, {
        companyId: A.id,
        kind: "notification.dispatch",
        status: "pending",
      });
      const jobB = await seedJob(client, {
        companyId: B.id,
        kind: "invoice.send",
        status: "pending",
      });

      const claimed = await claimAsServiceRole(client);

      expect(claimedIds(claimed)).toEqual([jobA, jobB].sort());
      expect(await statusesOf(client, [jobA, jobB])).toEqual(
        new Map([
          [jobA, "published"],
          [jobB, "published"],
        ]),
      );
    });
  });

  test("a row published ten minutes ago is re-claimed, one published a minute ago is not", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const stale = await seedJob(client, {
        companyId: A.id,
        kind: "notification.dispatch",
        status: "published",
        publishedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });
      const fresh = await seedJob(client, {
        companyId: A.id,
        kind: "invoice.send",
        status: "published",
        publishedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      });

      const claimed = await claimAsServiceRole(client);

      expect(claimedIds(claimed)).toEqual([stale]);
      // A re-claim refreshes `published_at`; the fresh row keeps its own.
      expect(await publishedEpoch(client, stale)).toBeGreaterThan(
        await publishedEpoch(client, fresh),
      );
    });
  });

  test.each(["succeeded", "failed", "running", "skipped"])(
    "a %s row is never claimed",
    async (status) => {
      await withRollback(async (client) => {
        const { A } = await seedTwoCompanies(client);
        await seedJob(client, { companyId: A.id, kind: "notification.dispatch", status });

        expect(await claimAsServiceRole(client)).toEqual([]);
      });
    },
  );

  test("the claim stops at the requested limit and leaves the rest pending", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const base = Date.now();
      const first = await seedJob(client, {
        companyId: A.id,
        kind: "notification.dispatch",
        status: "pending",
        createdAt: new Date(base - 3000).toISOString(),
      });
      const second = await seedJob(client, {
        companyId: A.id,
        kind: "invoice.send",
        status: "pending",
        createdAt: new Date(base - 2000).toISOString(),
      });
      const third = await seedJob(client, {
        companyId: A.id,
        kind: "notification.bulk",
        status: "pending",
        createdAt: new Date(base - 1000).toISOString(),
      });

      const claimed = await claimAsServiceRole(client, 2);

      expect(claimedIds(claimed)).toEqual([first, second].sort());
      expect(await statusesOf(client, [first, second, third])).toEqual(
        new Map([
          [first, "published"],
          [second, "published"],
          [third, "pending"],
        ]),
      );
    });
  });
});

describe("relay_claim_jobs stays the relay's own", () => {
  test("company_service cannot execute it", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);

      const error = await runAsCompanyService(client, A.id, () =>
        captureRaise(client, () => client.query("select * from public.relay_claim_jobs(10)")),
      );

      expect(error).toMatch(/permission denied/);
    });
  });

  test("a signed-in user cannot execute it either", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);

      const error = await runAsUser(client, A.users.admin, () =>
        captureRaise(client, () => client.query("select * from public.relay_claim_jobs(10)")),
      );

      expect(error).toMatch(/permission denied/);
    });
  });
});
