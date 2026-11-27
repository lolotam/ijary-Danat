import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  actAsCompanyService,
  actAsCompanyUser,
  runAsCompanyService,
  runAsUser,
  seedTwoCompanies,
} from "@/db/isolation/twoCompanies";
import { actAs, actAsSuperuser, captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * يضبط حدود شركة محددة بصلاحية المشرف (محاكاةً لإجراء المشرف العام).
 */
async function setCompanyLimits(
  client: PoolClient,
  companyId: string,
  limits: {
    maxUnits?: number | null;
    maxStaffUsers?: number | null;
    maxWhatsappPerMonth?: number | null;
    maxStorageBytes?: number | null;
  },
): Promise<void> {
  await actAsSuperuser(client);
  await client.query(
    `insert into public.company_limits (
       company_id, max_units, max_staff_users, max_whatsapp_per_month, max_storage_bytes
     ) values ($1, $2, $3, $4, $5)
     on conflict (company_id) do update set
       max_units = excluded.max_units,
       max_staff_users = excluded.max_staff_users,
       max_whatsapp_per_month = excluded.max_whatsapp_per_month,
       max_storage_bytes = excluded.max_storage_bytes`,
    [
      companyId,
      limits.maxUnits ?? null,
      limits.maxStaffUsers ?? null,
      limits.maxWhatsappPerMonth ?? null,
      limits.maxStorageBytes ?? null,
    ],
  );
}

/**
 * ينشئ عقاراً تجريبياً للشركة ويعيد معرّفه لاستخدامه في اختبارات الوحدات.
 */
async function seedProperty(client: PoolClient, companyId: string, tag: string): Promise<string> {
  await actAsSuperuser(client);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.properties (company_id, code, name_ar, name_en)
     values ($1, $2, $3, $4)
     returning id`,
    [companyId, `P-${tag}`, `عقار ${tag}`, `Property ${tag}`],
  );
  return rows[0].id;
}

/**
 * ينشئ مستخدماً في `auth.users` وملفه الشخصي ودوره بالترتيب المحدد لاختبار حد الموظفين.
 */
async function insertStaffOrTenantUser(
  client: PoolClient,
  companyId: string,
  role: "admin" | "accountant" | "collector" | "readonly" | "tenant",
  options: { isActive?: boolean; order?: "profile-first" | "role-first" } = {},
): Promise<string> {
  const userId = randomUUID();
  const email = `${userId}@auth.ijary.invalid`;
  const isActive = options.isActive ?? true;
  const order = options.order ?? "profile-first";

  await client.query(
    `insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, aud, role)
     values ($1, $2, '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated')`,
    [userId, email],
  );

  if (order === "profile-first") {
    await client.query(
      `insert into public.profiles (id, company_id, username, email, is_active)
       values ($1, $2, $3, $4, $5)`,
      [userId, companyId, `u_${userId.slice(0, 8)}`, email, isActive],
    );
    await client.query(
      `insert into public.user_roles (company_id, user_id, role)
       values ($1, $2, $3::public.app_role)`,
      [companyId, userId, role],
    );
  } else {
    await client.query(
      `insert into public.user_roles (company_id, user_id, role)
       values ($1, $2, $3::public.app_role)`,
      [companyId, userId, role],
    );
    await client.query(
      `insert into public.profiles (id, company_id, username, email, is_active)
       values ($1, $2, $3, $4, $5)`,
      [userId, companyId, `u_${userId.slice(0, 8)}`, email, isActive],
    );
  }

  return userId;
}

/**
 * يستورد وحدات جماعياً بدور `company_service` كما تستدعيه دالة الخادم، ثم يعيد هوية المستخدم.
 *
 * `bulk_import_phase6` is granted to `company_service` only (migration 289);
 * the role switches sit outside `captureRaise` so a refused import cannot
 * leave the session on the wrong role.
 */
async function importUnitsAsService(
  client: PoolClient,
  companyId: string,
  userId: string,
  rows: Array<Record<string, string>>,
): Promise<string | null> {
  await actAsCompanyService(client, companyId);
  const error = await captureRaise(client, () =>
    client.query(`select public.bulk_import_phase6('units', $1::jsonb)`, [JSON.stringify(rows)]),
  );
  await actAsCompanyUser(client, userId);
  return error;
}

describe("migration 323 - company_limits, usage tracking, and enforcement (T124, T126)", () => {
  test("unit limit enforces LIMIT_UNITS on direct insert, bulk import, raising, and lowering below usage", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const tag = randomUUID().slice(0, 8);
      const propertyId = await seedProperty(client, A.id, tag);

      await setCompanyLimits(client, A.id, { maxUnits: 2 });

      await runAsUser(client, A.users.admin, async () => {
        // Direct insert up to max_units (2) succeeds.
        const firstErr = await captureRaise(client, () =>
          client.query(
            `insert into public.units (company_id, property_id, code, name)
             values ($1, $2, $3, 'Unit 1')`,
            [A.id, propertyId, `U1-${tag}`],
          ),
        );
        expect(firstErr).toBeNull();

        // Bulk import of 1 more unit reaches 2/2 and succeeds.
        const importOneErr = await importUnitsAsService(client, A.id, A.users.admin.id, [
          { property_id: propertyId, code: `U2-${tag}`, name: "Unit 2" },
        ]);
        expect(importOneErr).toBeNull();

        // Direct insert past max_units fails with LIMIT_UNITS.
        const thirdErr = await captureRaise(client, () =>
          client.query(
            `insert into public.units (company_id, property_id, code, name)
             values ($1, $2, $3, 'Unit 3')`,
            [A.id, propertyId, `U3-${tag}`],
          ),
        );
        expect(thirdErr).toContain("LIMIT_UNITS");

        // Bulk import past max_units also fails with LIMIT_UNITS.
        const importThirdErr = await importUnitsAsService(client, A.id, A.users.admin.id, [
          { property_id: propertyId, code: `U4-${tag}`, name: "Unit 4" },
        ]);
        expect(importThirdErr).toContain("LIMIT_UNITS");
      });

      // Lowering max_units below usage (2 -> 1) never deletes existing units.
      await setCompanyLimits(client, A.id, { maxUnits: 1 });
      const {
        rows: [{ count: countAfterLower }],
      } = await client.query<{ count: number }>(
        `select count(*)::int as count from public.units where company_id = $1`,
        [A.id],
      );
      expect(countAfterLower).toBe(2);

      // New insert is still refused while usage (2) >= lowered limit (1).
      await runAsUser(client, A.users.admin, async () => {
        const refusedErr = await captureRaise(client, () =>
          client.query(
            `insert into public.units (company_id, property_id, code, name)
             values ($1, $2, $3, 'Unit 5')`,
            [A.id, propertyId, `U5-${tag}`],
          ),
        );
        expect(refusedErr).toContain("LIMIT_UNITS");
      });

      // Raising max_units above usage (1 -> 3) allows inserting again.
      await setCompanyLimits(client, A.id, { maxUnits: 3 });
      await runAsUser(client, A.users.admin, async () => {
        const raisedErr = await captureRaise(client, () =>
          client.query(
            `insert into public.units (company_id, property_id, code, name)
             values ($1, $2, $3, 'Unit 6')`,
            [A.id, propertyId, `U6-${tag}`],
          ),
        );
        expect(raisedErr).toBeNull();
      });
    });
  });

  test("staff limit enforces LIMIT_STAFF across insert orders, reactivation, tenant exemption, raising, and lowering", async () => {
    await withRollback(async (client) => {
      // seedTwoCompanies creates 4 active staff users (admin, accountant, collector, readonly) + 1 tenant.
      const { A } = await seedTwoCompanies(client);

      await setCompanyLimits(client, A.id, { maxStaffUsers: 5 });

      // Adding a 5th active staff user succeeds (profile-first).
      await actAsSuperuser(client);
      const fifthStaffErr = await captureRaise(client, () =>
        insertStaffOrTenantUser(client, A.id, "accountant", { order: "profile-first" }),
      );
      expect(fifthStaffErr).toBeNull();

      // Adding a 6th active staff user fails with LIMIT_STAFF in both insert orders.
      const sixthProfileFirstErr = await captureRaise(client, () =>
        insertStaffOrTenantUser(client, A.id, "collector", { order: "profile-first" }),
      );
      expect(sixthProfileFirstErr).toContain("LIMIT_STAFF");

      const sixthRoleFirstErr = await captureRaise(client, () =>
        insertStaffOrTenantUser(client, A.id, "readonly", { order: "role-first" }),
      );
      expect(sixthRoleFirstErr).toContain("LIMIT_STAFF");

      // Adding a renter ('tenant') never counts against max_staff_users.
      const renterErr = await captureRaise(client, () =>
        insertStaffOrTenantUser(client, A.id, "tenant"),
      );
      expect(renterErr).toBeNull();

      // Lowering limit below current staff count (5 -> 3) preserves existing staff and blocks reactivation.
      const inactiveId = await insertStaffOrTenantUser(client, A.id, "collector", {
        isActive: false,
      });
      await setCompanyLimits(client, A.id, { maxStaffUsers: 3 });

      const {
        rows: [{ count: activeStaffCount }],
      } = await client.query<{ count: number }>(
        `select count(distinct p.id)::int as count
           from public.profiles p
           join public.user_roles ur on ur.user_id = p.id and ur.company_id = p.company_id
          where p.company_id = $1
            and p.is_active
            and ur.role in ('admin', 'accountant', 'collector', 'readonly')`,
        [A.id],
      );
      expect(activeStaffCount).toBe(5);

      const reactivateErr = await captureRaise(client, () =>
        client.query(`update public.profiles set is_active = true where id = $1`, [inactiveId]),
      );
      expect(reactivateErr).toContain("LIMIT_STAFF");

      // Raising limit above current count (3 -> 6) allows reactivation.
      await setCompanyLimits(client, A.id, { maxStaffUsers: 6 });
      const reactivateAfterRaiseErr = await captureRaise(client, () =>
        client.query(`update public.profiles set is_active = true where id = $1`, [inactiveId]),
      );
      expect(reactivateAfterRaiseErr).toBeNull();
    });
  });

  test("storage limit tracks bytes on insert/delete, enforces LIMIT_STORAGE, and supports rebuild_company_storage_usage", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const tag = randomUUID().slice(0, 8);

      await setCompanyLimits(client, A.id, { maxStorageBytes: 1000 });

      await runAsUser(client, A.users.admin, async () => {
        const err600 = await captureRaise(client, () =>
          client.query(
            `insert into storage.objects (bucket_id, name, metadata)
             values ('company-documents', $1, '{"size": 600}'::jsonb)`,
            [`companies/${A.id}/docs/${tag}-1.pdf`],
          ),
        );
        expect(err600).toBeNull();

        const {
          rows: [usageRow],
        } = await client.query<{ bytes: string }>(
          `select bytes::text from public.company_storage_usage where company_id = $1`,
          [A.id],
        );
        expect(Number(usageRow.bytes)).toBe(600);

        // 600 + 500 = 1100 > 1000 -> refused with LIMIT_STORAGE.
        const err500 = await captureRaise(client, () =>
          client.query(
            `insert into storage.objects (bucket_id, name, metadata)
             values ('company-documents', $1, '{"size": 500}'::jsonb)`,
            [`companies/${A.id}/docs/${tag}-2.pdf`],
          ),
        );
        expect(err500).toContain("LIMIT_STORAGE");
      });

      // Lowering limit below usage (1000 -> 400) preserves existing object and refuses new uploads.
      await setCompanyLimits(client, A.id, { maxStorageBytes: 400 });
      await runAsCompanyService(client, A.id, async () => {
        const {
          rows: [{ ok }],
        } = await client.query<{ ok: boolean }>(`select public.storage_within_limit(1) as ok`);
        expect(ok).toBe(false);

        const errAfterLower = await captureRaise(client, () =>
          client.query(
            `insert into storage.objects (bucket_id, name, metadata)
             values ('company-documents', $1, '{"size": 100}'::jsonb)`,
            [`companies/${A.id}/docs/${tag}-3.pdf`],
          ),
        );
        expect(errAfterLower).toContain("LIMIT_STORAGE");
      });

      // Raising limit to 1200 allows uploading 500 more bytes (600 + 500 = 1100 <= 1200).
      await setCompanyLimits(client, A.id, { maxStorageBytes: 1200 });
      await runAsCompanyService(client, A.id, async () => {
        const errAfterRaise = await captureRaise(client, () =>
          client.query(
            `insert into storage.objects (bucket_id, name, metadata)
             values ('company-documents', $1, '{"size": 500}'::jsonb)`,
            [`companies/${A.id}/docs/${tag}-4.pdf`],
          ),
        );
        expect(errAfterRaise).toBeNull();

        const {
          rows: [{ total }],
        } = await client.query<{ total: string }>(
          `select public.rebuild_company_storage_usage()::text as total`,
        );
        expect(Number(total)).toBe(1100);
      });

      // Deleting an object frees its bytes.
      await actAsSuperuser(client);
      await client.query(`delete from storage.objects where name = $1`, [
        `companies/${A.id}/docs/${tag}-1.pdf`,
      ]);
      const {
        rows: [afterDelete],
      } = await client.query<{ bytes: string }>(
        `select bytes::text from public.company_storage_usage where company_id = $1`,
        [A.id],
      );
      expect(Number(afterDelete.bytes)).toBe(500);
    });
  });

  test("consume_whatsapp_quota atomically enforces max_whatsapp_per_month and restricts execute to company_service", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      await setCompanyLimits(client, A.id, { maxWhatsappPerMonth: 2 });

      // authenticated cannot execute consume_whatsapp_quota().
      await runAsUser(client, A.users.admin, async () => {
        const authErr = await captureRaise(client, () =>
          client.query(`select public.consume_whatsapp_quota()`),
        );
        expect(authErr).toContain("permission denied");
      });

      // Null company context fails closed with false.
      await actAsCompanyService(client, null);
      const nullRes = await client.query<{ ok: boolean }>(
        `select public.consume_whatsapp_quota() as ok`,
      );
      expect(nullRes.rows[0].ok).toBe(false);

      // company_service consumes 2/2, then 3rd returns false without incrementing.
      await runAsCompanyService(client, A.id, async () => {
        const r1 = await client.query<{ ok: boolean }>(
          `select public.consume_whatsapp_quota() as ok`,
        );
        const r2 = await client.query<{ ok: boolean }>(
          `select public.consume_whatsapp_quota() as ok`,
        );
        const r3 = await client.query<{ ok: boolean }>(
          `select public.consume_whatsapp_quota() as ok`,
        );
        expect([r1.rows[0].ok, r2.rows[0].ok, r3.rows[0].ok]).toEqual([true, true, false]);

        const {
          rows: [usage],
        } = await client.query<{ whatsapp_sent: number }>(
          `select whatsapp_sent from public.company_usage_monthly where company_id = $1`,
          [A.id],
        );
        expect(usage.whatsapp_sent).toBe(2);
      });

      // anon cannot call storage_within_limit.
      await actAs(client, "anon");
      const anonErr = await captureRaise(client, () =>
        client.query(`select public.storage_within_limit(0)`),
      );
      expect(anonErr).toContain("permission denied");
    });
  });
});
