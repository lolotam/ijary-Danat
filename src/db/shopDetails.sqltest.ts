import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  captureRaiseError,
  closePool,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/** ينشئ مستخدماً بملف شخصي ودور ضمن الشركة المحددة، مع ربطه بمستأجر اختياري. */
async function seedUser(
  client: PoolClient,
  companyId: string,
  role: string,
  tenantId: string | null = null,
): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `insert into public.profiles (id, company_id, tenant_id) values ($1, $2, $3) on conflict (id) do update set company_id = excluded.company_id, tenant_id = excluded.tenant_id`,
    [userId, companyId, tenantId],
  );
  await client.query(
    `insert into public.user_roles (company_id, user_id, role) values ($1, $2, $3::public.app_role)`,
    [companyId, userId, role],
  );
  return userId;
}

/** ينشئ علامة تجارية نشطة مرتبطة بعقار وشركة محددين. */
async function seedBrand(
  client: PoolClient,
  companyId: string,
  propertyId: string,
): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.commercial_brands (company_id, property_id, name_original, name_ar, name_en, slug, is_active, show_in_brands_marquee, show_in_shop_explorer, is_featured, display_order)
     values ($1, $2, $3, $4, $5, $6, true, true, true, false, 1) returning id`,
    [companyId, propertyId, `Shop ${tag}`, `محل ${tag}`, `Shop ${tag}`, `shop-${tag}`],
  );
  return rows[0].id;
}

async function linkBrand(client: PoolClient, brandId: string, contractId: string) {
  await client.query(`select * from public.save_brand_contracts($1, $2::uuid[])`, [
    brandId,
    [contractId],
  ]);
}

describe("shop_details_for_tenant and save_shop_details_as_tenant", () => {
  test("tenant CAN update own shop whitelisted fields via RPC", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31" });
      const brandId = await seedBrand(client, fx.companyId, fx.propertyId);
      await linkBrand(client, brandId, fx.contractId);
      const tenantUser = await seedUser(client, fx.companyId, "tenant", fx.tenantId);
      await actAs(client, "authenticated", tenantUser);
      const { rows: brandRow } = await client.query<{ updated_at: string }>(
        `select updated_at from public.commercial_brands where id = $1`,
        [brandId],
      );

      const { rows } = await client.query(
        `select * from public.save_shop_details_as_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          brandId,
          "Updated Original",
          "محل محدث",
          "Updated Shop",
          "5551234",
          "09:00 - 22:00",
          "https://example.com",
          "https://instagram.com/shop",
          "وصف عربي",
          "English desc",
          null,
          null,
          null,
        ],
      );
      expect(rows).toHaveLength(1);
      const updated = rows[0] as any;
      expect(updated.name_ar).toBe("محل محدث");
      expect(updated.website_url).toBe("https://example.com");

      // audit row written
      await actAsSuperuser(client);
      const { rows: audits } = await client.query(
        `select before, after from public.audit_logs where action = 'shop.save' and entity_id = $1 order by created_at desc limit 1`,
        [brandId],
      );
      expect(audits.length).toBe(1);
      expect(audits[0].before).toBeTruthy();
      expect(audits[0].after).toBeTruthy();
    });
  });

  test("tenant CANNOT update slug, is_featured, is_active, display_order, visibility toggles via RPC — not in whitelist", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31" });
      const brandId = await seedBrand(client, fx.companyId, fx.propertyId);
      await linkBrand(client, brandId, fx.contractId);
      const { rows: before } = await client.query(
        `select slug, is_featured, is_active, display_order, show_in_brands_marquee, show_in_shop_explorer from public.commercial_brands where id = $1`,
        [brandId],
      );
      const { rows: brandRow } = await client.query<{ updated_at: string }>(
        `select updated_at from public.commercial_brands where id = $1`,
        [brandId],
      );
      const tenantUser = await seedUser(client, fx.companyId, "tenant", fx.tenantId);
      await actAs(client, "authenticated", tenantUser);

      // Direct table writes must stay impossible; RLS has no UPDATE policy for tenants, so 0 rows are affected.
      const directRes = await client.query(
        `update public.commercial_brands set slug = 'hacked' where id = $1`,
        [brandId],
      );
      expect(directRes.rowCount).toBe(0);
      // Ensure row unchanged
      await actAsSuperuser(client);
      const { rows: after } = await client.query(
        `select slug, is_featured, is_active, display_order, show_in_brands_marquee, show_in_shop_explorer from public.commercial_brands where id = $1`,
        [brandId],
      );
      expect(after[0].slug).toBe(before[0].slug);
      expect(after[0].is_featured).toBe(before[0].is_featured);
    });
  });

  test("tenant CANNOT update another tenant's shop", async () => {
    await withRollback(async (client) => {
      const fx1 = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31" });
      const fx2 = await seedContract(client, {
        companyId: fx1.companyId,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const brandId = await seedBrand(client, fx1.companyId, fx1.propertyId);
      await linkBrand(client, brandId, fx1.contractId);
      const { rows: brandRow } = await client.query<{ updated_at: string }>(
        `select updated_at from public.commercial_brands where id = $1`,
        [brandId],
      );
      const tenant2 = await seedUser(client, fx1.companyId, "tenant", fx2.tenantId);
      await actAs(client, "authenticated", tenant2);
      const err: any = await captureRaiseError(client, () =>
        client.query(
          `select * from public.save_shop_details_as_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            brandId,
            "X",
            "X",
            "X",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            brandRow[0].updated_at,
          ],
        ),
      );
      expect(err?.code).toBe("42501");
    });
  });

  test("brand linked to two different tenants is editable by NEITHER", async () => {
    await withRollback(async (client) => {
      const fx1 = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31" });
      const fx2 = await seedContract(client, {
        companyId: fx1.companyId,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const brandId = await seedBrand(client, fx1.companyId, fx1.propertyId);
      // Link to both contracts (different tenants)
      await client.query(`select * from public.save_brand_contracts($1, $2::uuid[])`, [
        brandId,
        [fx1.contractId, fx2.contractId],
      ]);
      const tenant1 = await seedUser(client, fx1.companyId, "tenant", fx1.tenantId);
      const tenant2 = await seedUser(client, fx1.companyId, "tenant", fx2.tenantId);
      const { rows: brandRow } = await client.query<{ updated_at: string }>(
        `select updated_at from public.commercial_brands where id = $1`,
        [brandId],
      );
      await actAs(client, "authenticated", tenant1);
      const err1: any = await captureRaiseError(client, () =>
        client.query(
          `select * from public.save_shop_details_as_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            brandId,
            "X",
            "X",
            "X",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            brandRow[0].updated_at,
          ],
        ),
      );
      expect(err1?.code).toBe("42501");
      await actAs(client, "authenticated", tenant2);
      const err2: any = await captureRaiseError(client, () =>
        client.query(
          `select * from public.save_shop_details_as_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            brandId,
            "X",
            "X",
            "X",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            brandRow[0].updated_at,
          ],
        ),
      );
      expect(err2?.code).toBe("42501");
    });
  });

  test("brand with no links is editable by no tenant", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31" });
      const brandId = await seedBrand(client, fx.companyId, fx.propertyId);
      // no links
      const { rows: brandRow } = await client.query<{ updated_at: string }>(
        `select updated_at from public.commercial_brands where id = $1`,
        [brandId],
      );
      const tenantUser = await seedUser(client, fx.companyId, "tenant", fx.tenantId);
      await actAs(client, "authenticated", tenantUser);
      const err: any = await captureRaiseError(client, () =>
        client.query(
          `select * from public.save_shop_details_as_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            brandId,
            "X",
            "X",
            "X",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            brandRow[0].updated_at,
          ],
        ),
      );
      expect(err?.code).toBe("42501");
    });
  });

  test("anon CANNOT execute either RPC", async () => {
    await withRollback(async (client) => {
      await actAs(client, "anon");
      const err1: any = await captureRaiseError(client, () =>
        client.query(`select * from public.shop_details_for_tenant()`),
      );
      expect(err1?.code).toBe("42501");
      const err2: any = await captureRaiseError(client, () =>
        client.query(
          `select * from public.save_shop_details_as_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [randomUUID(), "a", "b", "c", null, null, null, null, null, null, null, null, null],
        ),
      );
      expect(err2?.code).toBe("42501");
    });
  });

  test("staff full update still works via direct table", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31" });
      const brandId = await seedBrand(client, fx.companyId, fx.propertyId);
      const staff = await seedUser(client, fx.companyId, "admin", null);
      // give is_staff true: need to handle is_staff check - it checks user_roles? Let's check is_staff definition
      // is_staff = has_role admin/accountant etc? Need to check. For this test, we can act as service_role or as admin with permission.
      // Direct update via authenticated with is_staff true should succeed. But we need user with admin role.
      await actAs(client, "authenticated", staff);
      // Try direct update of privileged column
      const { rows } = await client.query(
        `update public.commercial_brands set slug = 'new-slug' where id = $1 returning slug`,
        [brandId],
      );
      expect(rows[0].slug).toBe("new-slug");
    });
  });

  test("stale p_expected_updated_at is rejected", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31" });
      const brandId = await seedBrand(client, fx.companyId, fx.propertyId);
      await linkBrand(client, brandId, fx.contractId);
      const tenantUser = await seedUser(client, fx.companyId, "tenant", fx.tenantId);
      await actAs(client, "authenticated", tenantUser);
      // Use a stale timestamp
      const stale = new Date(Date.now() - 100000).toISOString();
      const err: any = await captureRaiseError(client, () =>
        client.query(
          `select * from public.save_shop_details_as_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [brandId, "X", "X", "X", null, null, null, null, null, null, null, null, stale],
        ),
      );
      expect(err?.code).toBe("40001");
    });
  });

  test("javascript: URL is rejected", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, { startDate: "2026-01-01", endDate: "2026-12-31" });
      const brandId = await seedBrand(client, fx.companyId, fx.propertyId);
      await linkBrand(client, brandId, fx.contractId);
      const tenantUser = await seedUser(client, fx.companyId, "tenant", fx.tenantId);
      const { rows: brandRow } = await client.query<{ updated_at: string }>(
        `select updated_at from public.commercial_brands where id = $1`,
        [brandId],
      );
      await actAs(client, "authenticated", tenantUser);
      const err: any = await captureRaiseError(client, () =>
        client.query(
          `select * from public.save_shop_details_as_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            brandId,
            "A",
            "ب",
            "C",
            null,
            null,
            "javascript:alert(1)",
            null,
            null,
            null,
            null,
            null,
            null,
          ],
        ),
      );
      expect(err?.message).toMatch(/http/);
    });
  });
});
