import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

const FUNCTIONS = [
  "public.contract_brand_assets(uuid[])",
  "public.contract_list_relations(uuid[])",
  "public.tenant_list_relations(uuid[])",
] as const;

/**
 * Migration 244 — the contracts and tenants lists read their relations in one
 * request. The functions are SECURITY INVOKER so RLS still decides every row;
 * these tests pin the parts a refactor could silently loosen.
 */
describe("list relation RPCs (migration 244)", () => {
  test("run with the caller's rights, never the owner's", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ name: string; definer: boolean }>(
        `select p.oid::regprocedure::text as name, p.prosecdef as definer
           from pg_proc p where p.oid = any ($1::regprocedure[])`,
        [FUNCTIONS],
      );
      expect(rows).toHaveLength(FUNCTIONS.length);
      expect(rows.filter((row) => row.definer)).toEqual([]);
    });
  });

  test("anon cannot call them; authenticated can", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ name: string; anon: boolean; authed: boolean }>(
        `select f as name,
                has_function_privilege('anon', f, 'execute') as anon,
                has_function_privilege('authenticated', f, 'execute') as authed
           from unnest($1::text[]) as f`,
        [FUNCTIONS],
      );
      expect(rows.every((row) => !row.anon && row.authed)).toBe(true);
    });
  });

  test("an empty page returns every key as an empty list", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{
        c: Record<string, unknown>;
        t: Record<string, unknown>;
      }>(
        `select public.contract_list_relations('{}') as c, public.tenant_list_relations('{}') as t`,
      );
      expect(rows[0].c).toEqual({
        tenants: [],
        contract_units: [],
        units: [],
        properties: [],
        concessions: [],
        brands: [],
        overdue_contract_ids: [],
      });
      expect(rows[0].t).toEqual({
        contracts: [],
        contract_units: [],
        units: [],
        properties: [],
        brands: [],
        overdue: [],
      });
    });
  });
});
