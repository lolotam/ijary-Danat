import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runAsCompanyService, runAsUser, seedTwoCompanies } from "@/db/isolation/twoCompanies";
import { actAs, captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

const SELECT_BATCH = `select id from public.import_batches where id = $1`;

/** يرحّل دفعة استيراد لشركة عبر `company_service` كما يفعل `bulkImport`، ويعيد معرّفها. */
async function stageBatchAs(
  client: PoolClient,
  companyId: string,
  requestedBy: string,
): Promise<string> {
  return runAsCompanyService(client, companyId, async () => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.import_batches (company_id, entity, rows, row_numbers, requested_by)
       values ($1, 'units', '[{"code":"U-1"}]'::jsonb, '[2]'::jsonb, $2)
       returning id`,
      [companyId, requestedBy],
    );
    return rows[0].id;
  });
}

/**
 * عزل جدول `import_batches` ومنع أي وصول من المتصفح (T069a).
 *
 * The table holds validated CSV rows staged for `import.run` so file contents
 * never enter the queue payload. Only server code (`company_service`) touches
 * it: signed-in staff and renters get no grant, so nobody can read another
 * staff member's staged rows through PostgREST.
 */
describe("import_batches RLS and grants", () => {
  test("company B's service cannot read or claim company A's staged batch", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const batchId = await stageBatchAs(client, A.id, A.users.admin.id);

      const seenByA = await runAsCompanyService(client, A.id, async () => {
        const { rows } = await client.query(SELECT_BATCH, [batchId]);
        return rows;
      });
      expect(seenByA).toHaveLength(1);

      const claimedByB = await runAsCompanyService(client, B.id, async () => {
        const { rows } = await client.query(
          `delete from public.import_batches where id = $1 returning id`,
          [batchId],
        );
        return rows;
      });
      expect(claimedByB).toHaveLength(0);

      const stillThere = await runAsCompanyService(client, A.id, async () => {
        const { rows } = await client.query(SELECT_BATCH, [batchId]);
        return rows;
      });
      expect(stillThere).toHaveLength(1);
    });
  });

  test("a batch can be claimed only once", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const batchId = await stageBatchAs(client, A.id, A.users.admin.id);

      const claims = await runAsCompanyService(client, A.id, async () => {
        const claim = `delete from public.import_batches where id = $1 returning id`;
        const first = await client.query(claim, [batchId]);
        const second = await client.query(claim, [batchId]);
        return [first.rowCount, second.rowCount];
      });
      expect(claims).toEqual([1, 0]);
    });
  });

  test.each([
    ["staff", "admin"],
    ["a renter", "tenant"],
  ] as const)("%s of the same company gets no access from the browser role", async (_who, role) => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const batchId = await stageBatchAs(client, A.id, A.users.admin.id);

      const refusal = await runAsUser(client, A.users[role], () =>
        captureRaise(client, () => client.query(SELECT_BATCH, [batchId])),
      );
      expect(refusal).toMatch(/permission denied/i);
    });
  });

  test("anon has no access to import_batches", async () => {
    await withRollback(async (client) => {
      await actAs(client, "anon");
      expect(
        await captureRaise(client, () =>
          client.query("select 1 from public.import_batches limit 1"),
        ),
      ).toMatch(/permission denied/i);
    });
  });
});
