import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runAsCompanyService, runAsUser, seedTwoCompanies } from "@/db/isolation/twoCompanies";
import { captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * يتحقق من صلاحية تنفيذ دالة لدور معيّن عبر `has_function_privilege`.
 */
async function canExecute(client: PoolClient, role: string, signature: string): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>(
    "select has_function_privilege($1, $2, 'EXECUTE') as ok",
    [role, signature],
  );
  return rows[0].ok;
}

describe("platform-only guards (review fixes before T052)", () => {
  test("erase_all_data no longer exists", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query(
        "select 1 from pg_proc where proname = 'erase_all_data' and pronamespace = 'public'::regnamespace",
      );
      expect(rows).toHaveLength(0);
    });
  });

  test("reassign_contract_tenant_records is reachable only through its trigger", async () => {
    await withRollback(async (client) => {
      const sig = "public.reassign_contract_tenant_records(uuid, uuid, uuid, uuid)";
      for (const role of ["anon", "authenticated", "company_service"]) {
        expect(await canExecute(client, role, sig), role).toBe(false);
      }
      const { rows } = await client.query(
        "select 1 from pg_proc where proname = 'reassign_contract_tenant_records' and pronargs = 3",
      );
      expect(rows).toHaveLength(0);
    });
  });

  test("_legacy_single_company_id refuses to guess between two companies", async () => {
    await withRollback(async (client) => {
      await seedTwoCompanies(client);
      const message = await captureRaise(client, () =>
        client.query("select public._legacy_single_company_id()"),
      );
      expect(message).toMatch(/LEGACY_BACKFILL_AMBIGUOUS/);
      expect(await canExecute(client, "authenticated", "public._legacy_single_company_id()")).toBe(
        false,
      );
    });
  });

  test("a company admin edits the profile but not slug or suspension columns", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);

      await runAsUser(client, A.users.admin, async () => {
        const { rowCount } = await client.query(
          "update public.companies set name_en = 'Renamed' where id = $1",
          [A.id],
        );
        expect(rowCount).toBe(1);

        for (const assignment of [
          "status = 'suspended'",
          "slug = 'taken-elsewhere'",
          "suspended_reason = 'self'",
        ]) {
          const message = await captureRaise(client, () =>
            client.query(`update public.companies set ${assignment} where id = $1`, [A.id]),
          );
          expect(message, assignment).toMatch(/PLATFORM_COLUMNS_READ_ONLY/);
        }
      });
    });
  });

  test("company_service cannot change its own company's status", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);

      await runAsCompanyService(client, A.id, async () => {
        const message = await captureRaise(client, () =>
          client.query("update public.companies set status = 'suspended' where id = $1", [A.id]),
        );
        expect(message).toMatch(/PLATFORM_COLUMNS_READ_ONLY/);
      });
    });
  });

  test("anon is refused by the column guard even when a policy lets it update", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      // Simulate a future mistaken grant: the trigger must still hold.
      await client.query("grant update on public.companies to anon");
      await client.query(
        "create policy companies_test_anon_update on public.companies for update to anon using (true) with check (true)",
      );
      await client.query(
        "create policy companies_test_anon_select on public.companies for select to anon using (true)",
      );

      await client.query("select set_config('role', 'anon', true)");
      const message = await captureRaise(client, () =>
        client.query("update public.companies set status = 'suspended' where id = $1", [A.id]),
      );
      await client.query("select set_config('role', 'postgres', true)");
      expect(message).toMatch(/PLATFORM_COLUMNS_READ_ONLY/);
    });
  });

  test("the platform (no API role) still changes suspension columns", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const { rowCount } = await client.query(
        "update public.companies set status = 'suspended', suspended_at = now(), suspended_reason = 'platform' where id = $1",
        [A.id],
      );
      expect(rowCount).toBe(1);
    });
  });
});
