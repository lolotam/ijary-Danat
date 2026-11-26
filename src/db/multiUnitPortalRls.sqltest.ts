import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { actAs, actAsSuperuser, closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Portal RLS after migration 115 — public.units and public.properties
 * visibility must follow public.contract_units (migration 110), not the
 * legacy contracts.unit_id column that 17_tenant_portal_units_rls.sql relied
 * on. A tenant on a multi-unit contract must see every one of their units and
 * every property those units belong to, and nothing belonging to anyone else.
 */
describe("portal RLS with several units", () => {
  it("shows the tenant all their units and none belonging to anyone else", async () => {
    await withRollback(async (client: PoolClient) => {
      const mine = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
        units: [{ monthlyAmount: 400 }, { monthlyAmount: 400 }, { monthlyAmount: 400 }],
      });
      const theirs = await seedContract(client, {
        companyId: mine.companyId,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        state: "active",
      });

      const portalUser = randomUUID();
      await client.query(
        `insert into auth.users (id, instance_id, aud, role, email)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
        [portalUser, `${portalUser}@example.test`],
      );
      await client.query(
        `insert into public.profiles (id, company_id, tenant_id, display_name, is_active)
         values ($1, $2, $3, 'Portal User', true)
         on conflict (id) do update
           set company_id = excluded.company_id,
               tenant_id = excluded.tenant_id,
               is_active = true`,
        [portalUser, mine.companyId, mine.tenantId],
      );

      // actAs sets all four GUCs. Do not hand-roll this: setting only
      // request.jwt.claims leaves auth.uid() NULL in this image, and every
      // isolation assertion then passes for the wrong reason. See testDb.ts:60-70.
      await actAs(client, "authenticated", portalUser);

      // Guard against the vacuous pass: if auth.uid() were NULL here, both
      // policies below would deny everything and "sees nothing" would look
      // like a correctly scoped result instead of a broken one.
      const identity = await client.query<{ uid: string | null }>(`select auth.uid() as uid`);
      expect(identity.rows[0].uid).toBe(portalUser);

      const visible = await client.query<{ id: string }>(`select id from public.units`);
      const ids = visible.rows.map((r) => r.id).sort();
      expect(ids).toEqual([...mine.unitIds].sort());
      expect(ids).not.toContain(theirs.unitId);

      const properties = await client.query<{ id: string }>(`select id from public.properties`);
      expect(properties.rowCount).toBe(1);
      expect(properties.rows[0].id).toBe(mine.propertyId);

      await actAsSuperuser(client);
    });
  });
});
