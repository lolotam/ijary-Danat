import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { buildScopedInsert, seedCompanyGraph } from "@/db/isolation/seedCompanyGraph";
import {
  runAsCompanyService,
  runAsUser,
  seedTwoCompanies,
  setCompanyStatus,
} from "@/db/isolation/twoCompanies";
import { actAsSuperuser, captureRaiseError, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

const REPRESENTATIVE_TABLES = [
  "company_domains",
  "profiles",
  "properties",
  "buildings",
  "units",
  "tenants",
  "contracts",
  "invoices",
  "payments",
  "deposits",
  "expenses",
  "employees",
  "notifications",
  "whatsapp_contacts",
  "landing_page_settings",
] as const;

/**
 * يستخرج رمز الخطأ من استثناء PostgreSQL.
 */
function pgErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

/**
 * يتحقق من أن الجداول الممثلة تحتوي على `company_id` وأنها تعزل B عن A لدور `company_service`.
 */
async function collectServiceVisibilityErrors(
  client: PoolClient,
  companyAId: string,
  companyBId: string,
  colMap: Map<string, Set<string>>,
  expectAVisible: boolean,
): Promise<string[]> {
  const errors: string[] = [];

  for (const table of REPRESENTATIVE_TABLES) {
    if (!colMap.get(table)?.has("company_id")) {
      errors.push(`${table}: missing company_id column`);
      continue;
    }

    const { rows: rowsA } = await client.query<{ id: string }>(
      `select id from public.${table} where company_id = $1`,
      [companyAId],
    );
    if (expectAVisible && rowsA.length === 0) {
      errors.push(`${table}: expected A rows to be visible to company_service(A)`);
    }
    if (!expectAVisible && rowsA.length > 0) {
      errors.push(`${table}: expected 0 rows of A, got ${rowsA.length}`);
    }

    const { rows: rowsB } = await client.query<{ id: string }>(
      `select id from public.${table} where company_id = $1`,
      [companyBId],
    );
    if (rowsB.length > 0) {
      errors.push(`${table}: leaked ${rowsB.length} row(s) of B`);
    }
  }

  return errors;
}

describe("T017 company_service role isolation", () => {
  test("company_service cannot login, cannot bypass RLS, and is granted to authenticator", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{
        rolcanlogin: boolean;
        rolbypassrls: boolean;
        granted_to_auth: boolean;
      }>(
        `select r.rolcanlogin,
                r.rolbypassrls,
                pg_has_role('authenticator', r.oid, 'member') as granted_to_auth
           from pg_roles r
          where r.rolname = 'company_service'`,
      );
      expect(rows).toEqual([{ rolcanlogin: false, rolbypassrls: false, granted_to_auth: true }]);
    });
  });

  test("token for A reads A's rows, reads 0 of B's rows, cannot mutate B, and rejects B inserts", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const graphA = await seedCompanyGraph(client, A);
      const graphB = await seedCompanyGraph(client, B);
      const colMap = graphA.colMap;

      let errors: string[] = [];
      await runAsCompanyService(client, A.id, async () => {
        const { rows: ctx } = await client.query<{ cid: string | null }>(
          `select public.current_company_id() as cid`,
        );
        expect(ctx[0].cid).toBe(A.id);

        errors = await collectServiceVisibilityErrors(client, A.id, B.id, colMap, true);

        const { rows: visibleCompanies } = await client.query<{ id: string }>(
          `select id from public.companies where id in ($1, $2)`,
          [A.id, B.id],
        );
        expect(visibleCompanies.map((r) => r.id)).toEqual([A.id]);

        const { rowCount: updB } = await client.query(
          `update public.properties set name_en = 'Hijacked' where id = $1`,
          [graphB.ids.propertyId],
        );
        expect(updB).toBe(0);

        const { rowCount: delB } = await client.query(`delete from public.tenants where id = $1`, [
          graphB.ids.tenantId,
        ]);
        expect(delB).toBe(0);

        const badInsert = buildScopedInsert(colMap, "properties", B.id, {
          company_id: B.id,
          code: `P-CS-${randomUUID().slice(0, 6)}`,
          name_ar: "Cross",
        });
        const insertErr = await captureRaiseError(client, () =>
          client.query(badInsert.sql, badInsert.params),
        );
        expect(insertErr).not.toBeNull();
      });

      await actAsSuperuser(client);
      expect(errors).toEqual([]);
    });
  });

  test("missing or invalid company_id claim fails closed and reads nothing", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const graphA = await seedCompanyGraph(client, A);
      await seedCompanyGraph(client, B);
      const colMap = graphA.colMap;

      for (const badClaim of [null, "not-a-uuid", ""]) {
        let errors: string[] = [];
        await runAsCompanyService(client, badClaim, async () => {
          const { rows: ctx } = await client.query<{ cid: string | null }>(
            `select public.current_company_id() as cid`,
          );
          expect(ctx[0].cid).toBeNull();

          errors = await collectServiceVisibilityErrors(client, A.id, B.id, colMap, false);

          const { rows: comps } = await client.query<{ id: string }>(
            `select id from public.companies where id in ($1, $2)`,
            [A.id, B.id],
          );
          expect(comps).toEqual([]);

          const ins = buildScopedInsert(colMap, "tenants", A.id, {
            company_id: A.id,
            code: `T-NOCLAIM-${randomUUID().slice(0, 6)}`,
            name: "Should fail",
          });
          const insertErr = await captureRaiseError(client, () =>
            client.query(ins.sql, ins.params),
          );
          expect(insertErr).not.toBeNull();
        });
        expect(errors).toEqual([]);
      }
    });
  });

  test("suspended company blocks company_service unless allow_suspended is true", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const graphA = await seedCompanyGraph(client, A);
      await seedCompanyGraph(client, B);
      await setCompanyStatus(client, A.id, "suspended", "Service suspension test");

      let blockedErrors: string[] = [];
      await runAsCompanyService(client, A.id, async () => {
        const { rows: ctx } = await client.query<{ cid: string | null }>(
          `select public.current_company_id() as cid`,
        );
        expect(ctx[0].cid).toBeNull();
        blockedErrors = await collectServiceVisibilityErrors(
          client,
          A.id,
          B.id,
          graphA.colMap,
          false,
        );
      });
      expect(blockedErrors).toEqual([]);

      let allowedErrors: string[] = [];
      await runAsCompanyService(
        client,
        A.id,
        async () => {
          const { rows: ctx } = await client.query<{ cid: string | null }>(
            `select public.current_company_id() as cid`,
          );
          expect(ctx[0].cid).toBe(A.id);
          allowedErrors = await collectServiceVisibilityErrors(
            client,
            A.id,
            B.id,
            graphA.colMap,
            true,
          );
        },
        { allowSuspended: true },
      );
      expect(allowedErrors).toEqual([]);
    });
  });

  test("enforces role boundaries against company deletion, platform admin spoofing, and forged JWT claims", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const graphB = await seedCompanyGraph(client, B);

      await runAsCompanyService(client, A.id, async () => {
        const delErr = await captureRaiseError(client, () =>
          client.query(`delete from public.companies where id = $1`, [A.id]),
        );
        expect(pgErrorCode(delErr)).toBe("42501");

        const platErr = await captureRaiseError(client, () =>
          client.query(`select public.is_platform_admin()`),
        );
        expect(pgErrorCode(platErr)).toBe("42501");
      });

      await runAsUser(
        client,
        A.users.admin,
        async () => {
          const { rows: ctx } = await client.query<{ cid: string | null }>(
            `select public.current_company_id() as cid`,
          );
          expect(ctx[0].cid).toBe(A.id);

          if (graphB.colMap.get("properties")?.has("company_id")) {
            const { rows } = await client.query(`select id from public.properties where id = $1`, [
              graphB.ids.propertyId,
            ]);
            expect(rows).toEqual([]);
          }
        },
        { role: "company_service", company_id: B.id, allow_suspended: true },
      );
    });
  });
});
