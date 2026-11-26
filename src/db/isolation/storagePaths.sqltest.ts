import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runAsCompanyService, runAsUser, seedTwoCompanies } from "@/db/isolation/twoCompanies";
import { actAs, actAsSuperuser, captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/** الحاويات العامة الـ 3 التي تبقى قراءتها متاحة للعموم مع تقييد الكتابة بالشركة. */
const PUBLIC_READ_BUCKETS = ["branding", "landing", "property-images"] as const;

/** الحاويات الخاصة الـ 11 التي تُقيَّد قراءتها وكتابتها بمسار `companies/<company_id>/`. */
const PRIVATE_BUCKETS = [
  "backups",
  "company-documents",
  "deposit-attachments",
  "employee-documents",
  "expense-attachments",
  "gmail-attachments",
  "payment-attachments",
  "report-documents",
  "tenant-documents",
  "tenant-messages",
  "whatsapp-media",
] as const;

/** جميع حاويات التخزين الـ 14 في المنصة. */
const ALL_14_BUCKETS = [...PUBLIC_READ_BUCKETS, ...PRIVATE_BUCKETS] as const;

/**
 * يزرع كائناً تجريبياً في `storage.objects` بصلاحية المشرف لإجراء اختبارات القراءة والتعديل والحذف.
 */
async function seedStorageObject(
  client: PoolClient,
  bucketId: string,
  objectName: string,
): Promise<void> {
  await client.query(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [
    bucketId,
    objectName,
  ]);
}

/**
 * يحاول إدراج كائن في `storage.objects` بالهوية النشطة ويعيد رسالة الرفض أو `null` عند النجاح.
 */
async function tryInsertStorageObject(
  client: PoolClient,
  bucketId: string,
  objectName: string,
): Promise<string | null> {
  return captureRaise(client, () =>
    client.query(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [
      bucketId,
      objectName,
    ]),
  );
}

describe("storage path isolation across all 14 buckets (T018)", () => {
  test("contains the exact 14 expected buckets and grants storage.objects access to company_service", async () => {
    await withRollback(async (client) => {
      const { rows: bucketRows } = await client.query<{ id: string }>(
        `select id from storage.buckets order by id`,
      );
      expect(bucketRows.map((r) => r.id)).toEqual([...ALL_14_BUCKETS].sort());

      const { rows: privRows } = await client.query<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>(
        `select has_table_privilege('company_service', 'storage.objects', 'SELECT') as can_select,
                has_table_privilege('company_service', 'storage.objects', 'INSERT') as can_insert,
                has_table_privilege('company_service', 'storage.objects', 'UPDATE') as can_update,
                has_table_privilege('company_service', 'storage.objects', 'DELETE') as can_delete`,
      );
      expect(privRows[0]).toEqual({
        can_select: true,
        can_insert: true,
        can_update: true,
        can_delete: true,
      });
    });
  });

  test("enforces companies/<company_id>/ prefix on insert, update, and delete across all 14 buckets", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const tag = randomUUID().slice(0, 8);

      for (const bucketId of ALL_14_BUCKETS) {
        const seedA = `companies/${A.id}/seed/${tag}.txt`;
        const seedB = `companies/${B.id}/seed/${tag}.txt`;
        const unscopedSeed = `unscoped/${tag}.txt`;

        await seedStorageObject(client, bucketId, seedA);
        await seedStorageObject(client, bucketId, seedB);
        await seedStorageObject(client, bucketId, unscopedSeed);

        await runAsUser(client, A.users.admin, async () => {
          const ownInsertErr = await tryInsertStorageObject(
            client,
            bucketId,
            `companies/${A.id}/user-upload/${tag}.txt`,
          );
          expect(ownInsertErr, `${bucketId} own insert as admin`).toBeNull();

          const crossInsertErr = await tryInsertStorageObject(
            client,
            bucketId,
            `companies/${B.id}/cross/${tag}.txt`,
          );
          expect(crossInsertErr, `${bucketId} cross-company insert as admin`).not.toBeNull();

          const unscopedInsertErr = await tryInsertStorageObject(
            client,
            bucketId,
            `legacy-path/${tag}.txt`,
          );
          expect(unscopedInsertErr, `${bucketId} unscoped insert as admin`).not.toBeNull();

          const updCross = await client.query(
            `update storage.objects set metadata = '{"touched":true}'::jsonb
              where bucket_id = $1 and name in ($2, $3)`,
            [bucketId, seedB, unscopedSeed],
          );
          expect(updCross.rowCount, `${bucketId} cross/unscoped update count`).toBe(0);

          const delCross = await client.query(
            `delete from storage.objects where bucket_id = $1 and name in ($2, $3)`,
            [bucketId, seedB, unscopedSeed],
          );
          expect(delCross.rowCount, `${bucketId} cross/unscoped delete count`).toBe(0);
        });

        await runAsCompanyService(client, A.id, async () => {
          const svcOwnErr = await tryInsertStorageObject(
            client,
            bucketId,
            `companies/${A.id}/svc-upload/${tag}.txt`,
          );
          expect(svcOwnErr, `${bucketId} own insert as company_service`).toBeNull();

          const svcCrossErr = await tryInsertStorageObject(
            client,
            bucketId,
            `companies/${B.id}/svc-cross/${tag}.txt`,
          );
          expect(svcCrossErr, `${bucketId} cross insert as company_service`).not.toBeNull();
        });
      }
    });
  });

  test("isolates reads on all 11 private buckets and preserves public read on branding and landing", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const tag = randomUUID().slice(0, 8);

      for (const bucketId of PRIVATE_BUCKETS) {
        const pathA = `companies/${A.id}/priv/${tag}.txt`;
        const pathB = `companies/${B.id}/priv/${tag}.txt`;
        const unscoped = `unscoped-priv/${tag}.txt`;

        await seedStorageObject(client, bucketId, pathA);
        await seedStorageObject(client, bucketId, pathB);
        await seedStorageObject(client, bucketId, unscoped);

        await runAsUser(client, A.users.admin, async () => {
          const { rows } = await client.query<{ name: string }>(
            `select name from storage.objects
              where bucket_id = $1 and name in ($2, $3, $4)`,
            [bucketId, pathA, pathB, unscoped],
          );
          expect(
            rows.map((r) => r.name),
            `${bucketId} admin select`,
          ).toEqual([pathA]);
        });

        await runAsCompanyService(client, A.id, async () => {
          const { rows } = await client.query<{ name: string }>(
            `select name from storage.objects
              where bucket_id = $1 and name in ($2, $3, $4)`,
            [bucketId, pathA, pathB, unscoped],
          );
          expect(
            rows.map((r) => r.name),
            `${bucketId} company_service select`,
          ).toEqual([pathA]);
        });
      }

      for (const publicBucket of ["branding", "landing"] as const) {
        const publicPath = `companies/${A.id}/pub/${tag}.png`;
        await seedStorageObject(client, publicBucket, publicPath);

        await actAs(client, "anon");
        const { rows } = await client.query<{ name: string }>(
          `select name from storage.objects where bucket_id = $1 and name = $2`,
          [publicBucket, publicPath],
        );
        expect(
          rows.map((r) => r.name),
          `${publicBucket} public read`,
        ).toEqual([publicPath]);
        await actAsSuperuser(client);
      }
    });
  });
});
