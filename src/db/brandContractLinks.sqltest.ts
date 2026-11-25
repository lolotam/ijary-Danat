import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 162 — a storefront brand links to MANY contracts.
 *
 * Split out of contractExtraCharges.sqltest.ts, which crossed this
 * repository's 500-600 line ceiling once both feature areas lived in it. The
 * two share a migration batch and nothing else: this file is about the join
 * table's cardinality and its save RPC's replace-the-set semantics.
 */

/** السنة التي تعمل عليها هذه الاختبارات. */
const THIS_YEAR = new Date().getFullYear();

/** عقد لسنة كاملة. */
async function seedYearContract(client: PoolClient) {
  return seedContract(client, {
    startDate: `${THIS_YEAR}-01-01`,
    endDate: `${THIS_YEAR}-12-31`,
  });
}

describe("commercial_brand_contracts", () => {
  /** ينشئ علامة تجارية على عقار العقد. */
  async function seedBrand(client: PoolClient, propertyId: string) {
    const tag = randomUUID().slice(0, 8);
    const { rows } = await client.query<{ id: string }>(
      `insert into public.commercial_brands
         (property_id, name_original, name_ar, name_en, slug)
       values ($1, $2, $3, $4, $5) returning id`,
      [propertyId, `Shop ${tag}`, `محل ${tag}`, `Shop ${tag}`, `shop-${tag}`],
    );
    return rows[0].id;
  }

  async function linkedContractIds(client: PoolClient, brandId: string) {
    const { rows } = await client.query<{ contract_id: string }>(
      `select contract_id from public.commercial_brand_contracts
        where brand_id = $1 order by contract_id`,
      [brandId],
    );
    return rows.map((row) => row.contract_id);
  }

  test("one shop links to several contracts", async () => {
    await withRollback(async (client) => {
      const first = await seedYearContract(client);
      const second = await seedContract(client, {
        startDate: `${THIS_YEAR}-01-01`,
        endDate: `${THIS_YEAR}-12-31`,
      });
      const brandId = await seedBrand(client, first.propertyId);

      await client.query(`select * from public.save_brand_contracts($1, $2::uuid[])`, [
        brandId,
        [first.contractId, second.contractId],
      ]);

      expect(await linkedContractIds(client, brandId)).toEqual(
        [first.contractId, second.contractId].sort(),
      );
    });
  });

  test("saving replaces the set, dropping links no longer named", async () => {
    await withRollback(async (client) => {
      const first = await seedYearContract(client);
      const second = await seedContract(client, {
        startDate: `${THIS_YEAR}-01-01`,
        endDate: `${THIS_YEAR}-12-31`,
      });
      const brandId = await seedBrand(client, first.propertyId);
      await client.query(`select * from public.save_brand_contracts($1, $2::uuid[])`, [
        brandId,
        [first.contractId, second.contractId],
      ]);

      await client.query(`select * from public.save_brand_contracts($1, $2::uuid[])`, [
        brandId,
        [second.contractId],
      ]);

      expect(await linkedContractIds(client, brandId)).toEqual([second.contractId]);
    });
  });

  test("an empty array unlinks the shop entirely", async () => {
    await withRollback(async (client) => {
      const { contractId, propertyId } = await seedYearContract(client);
      const brandId = await seedBrand(client, propertyId);
      await client.query(`select * from public.save_brand_contracts($1, $2::uuid[])`, [
        brandId,
        [contractId],
      ]);

      await client.query(`select * from public.save_brand_contracts($1, '{}'::uuid[])`, [brandId]);

      expect(await linkedContractIds(client, brandId)).toEqual([]);
    });
  });

  test("saving the same set twice is idempotent, not a duplicate-key failure", async () => {
    await withRollback(async (client) => {
      const { contractId, propertyId } = await seedYearContract(client);
      const brandId = await seedBrand(client, propertyId);
      await client.query(`select * from public.save_brand_contracts($1, $2::uuid[])`, [
        brandId,
        [contractId],
      ]);

      await client.query(`select * from public.save_brand_contracts($1, $2::uuid[])`, [
        brandId,
        [contractId],
      ]);

      expect(await linkedContractIds(client, brandId)).toEqual([contractId]);
    });
  });

  test("deleting a contract takes its links with it, leaving the shop", async () => {
    await withRollback(async (client) => {
      const { contractId, propertyId } = await seedYearContract(client);
      const brandId = await seedBrand(client, propertyId);
      await client.query(`select * from public.save_brand_contracts($1, $2::uuid[])`, [
        brandId,
        [contractId],
      ]);

      await client.query(`delete from public.invoices where contract_id = $1`, [contractId]);
      await client.query(`delete from public.contracts where id = $1`, [contractId]);

      expect(await linkedContractIds(client, brandId)).toEqual([]);
      const { rows } = await client.query(`select 1 from public.commercial_brands where id = $1`, [
        brandId,
      ]);
      expect(rows).toHaveLength(1);
    });
  });
});
