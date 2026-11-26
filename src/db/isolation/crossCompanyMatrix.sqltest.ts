import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  NON_COMPANY_TABLES,
  seedCompanyGraph,
  type CompanyTableTarget,
} from "@/db/isolation/seedCompanyGraph";
import { actAsSuperuser, captureRaiseError, closePool, withRollback } from "@/db/testDb";
import { runAsUser, seedTwoCompanies, setCompanyStatus } from "@/db/isolation/twoCompanies";

afterAll(closePool);

/**
 * يستخرج رمز SQLSTATE من كائن خطأ PostgreSQL إن وُجد.
 */
function pgErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

/**
 * يختبر عزل صف واحد مملوك للشركة B أثناء العمل بهوية مستخدم الشركة A.
 */
async function assertTableIsolatedFromUser(
  client: PoolClient,
  target: CompanyTableTarget,
  foreignCompanyId: string,
  colMap: Map<string, Set<string>>,
): Promise<string | null> {
  const cols = colMap.get(target.table);
  if (!cols?.has("company_id")) {
    return `${target.table}: missing company_id column`;
  }

  const selectResult = await captureRaiseError(client, () =>
    client.query(
      `select 1 from public.${target.table} where ${target.whereSql}`,
      target.whereParams,
    ),
  );
  if (selectResult === null) {
    // Re-run cleanly when SELECT is permitted to assert 0 rows returned.
    const { rowCount } = await client.query(
      `select 1 from public.${target.table} where ${target.whereSql}`,
      target.whereParams,
    );
    if ((rowCount ?? 0) > 0) {
      return `${target.table}: user of A selected ${rowCount} row(s) of B`;
    }
  } else if (pgErrorCode(selectResult) !== "42501") {
    return `${target.table}: unexpected SELECT error (${pgErrorCode(selectResult)})`;
  }

  let updatedRows = 0;
  const updateErr = await captureRaiseError(client, async () => {
    const res = await client.query(
      `update public.${target.table} set ${target.updateSetSql} where ${target.whereSql}`,
      target.updateParams,
    );
    updatedRows = res.rowCount ?? 0;
  });
  if (updateErr === null && updatedRows > 0) {
    return `${target.table}: user of A updated ${updatedRows} row(s) of B`;
  }
  if (updateErr !== null && pgErrorCode(updateErr) !== "42501") {
    return `${target.table}: unexpected UPDATE error (${pgErrorCode(updateErr)})`;
  }

  let deletedRows = 0;
  const deleteErr = await captureRaiseError(client, async () => {
    const res = await client.query(
      `delete from public.${target.table} where ${target.whereSql}`,
      target.whereParams,
    );
    deletedRows = res.rowCount ?? 0;
  });
  if (deleteErr === null && deletedRows > 0) {
    return `${target.table}: user of A deleted ${deletedRows} row(s) of B`;
  }
  if (deleteErr !== null && pgErrorCode(deleteErr) !== "42501") {
    return `${target.table}: unexpected DELETE error (${pgErrorCode(deleteErr)})`;
  }

  const crossInsert = target.buildCrossCompanyInsert(foreignCompanyId, colMap);
  const insertErr = await captureRaiseError(client, () =>
    client.query(crossInsert.sql, crossInsert.params),
  );
  if (insertErr === null) {
    return `${target.table}: user of A inserted a row with company_id = B`;
  }

  return null;
}

describe("T015 cross-company isolation behaviour matrix", () => {
  test("matrix covers every public table off the platform allow-list", async () => {
    await withRollback(async (client) => {
      const { B } = await seedTwoCompanies(client);
      const graphB = await seedCompanyGraph(client, B);

      const { rows } = await client.query<{ relname: string }>(
        `select c.relname
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
          order by c.relname`,
      );

      const covered = new Set(graphB.targets.map((t) => t.table));
      const uncovered = rows
        .map((r) => r.relname)
        .filter((name) => !NON_COMPANY_TABLES.has(name) && !covered.has(name));

      expect(uncovered).toEqual([]);
    });
  });

  test("user of A selects/updates/deletes 0 rows of B and cannot insert with B's company_id on every table", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const graphB = await seedCompanyGraph(client, B);
      const failures: string[] = [];

      await runAsUser(client, A.users.admin, async () => {
        for (const target of graphB.targets) {
          const failure = await assertTableIsolatedFromUser(client, target, B.id, graphB.colMap);
          if (failure) {
            failures.push(failure);
          }
        }
      });

      await actAsSuperuser(client);
      expect(failures).toEqual([]);
    });
  });

  test("companies row is readable only for own company and cannot be updated across companies or deleted", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);

      await runAsUser(client, A.users.admin, async () => {
        const { rows: visible } = await client.query<{ id: string }>(
          `select id from public.companies where id in ($1, $2)`,
          [A.id, B.id],
        );
        expect(visible.map((r) => r.id)).toEqual([A.id]);

        const { rowCount: updatedB } = await client.query(
          `update public.companies set name_en = 'Hijacked' where id = $1`,
          [B.id],
        );
        expect(updatedB).toBe(0);

        const delErr = await captureRaiseError(client, () =>
          client.query(`delete from public.companies where id = $1`, [A.id]),
        );
        expect(pgErrorCode(delErr)).toBe("42501");
      });
    });
  });

  test("suspended company user reads 0 rows across scoped tables", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const graphA = await seedCompanyGraph(client, A);
      await setCompanyStatus(client, A.id, "suspended", "Suspension matrix check");

      const leaked: string[] = [];
      await runAsUser(client, A.users.admin, async () => {
        for (const table of [
          "companies",
          "company_domains",
          "profiles",
          "tenants",
          "properties",
          "contracts",
          "invoices",
          "payments",
        ]) {
          const where = table === "companies" ? "id = $1" : "company_id = $1";
          const colOk = table === "companies" || graphA.colMap.get(table)?.has("company_id");
          if (!colOk) {
            leaked.push(`${table}: missing company_id`);
            continue;
          }
          const { rowCount } = await client.query(`select 1 from public.${table} where ${where}`, [
            A.id,
          ]);
          if ((rowCount ?? 0) > 0) {
            leaked.push(`${table}: ${rowCount} row(s) visible while suspended`);
          }
        }
      });

      await actAsSuperuser(client);
      expect(leaked).toEqual([]);
    });
  });
});
