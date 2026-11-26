import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * يجد كل مفتاح أجنبي قديم بعمود واحد يكرّره مفتاح مركّب (company_id, …) إلى الجدول نفسه.
 *
 * Two relationships between the same pair of tables make PostgREST refuse every
 * embed between them with PGRST201 (HTTP 300); the renter dashboard's
 * `invoices → contracts!inner` was the first page seen failing (2026-11-26).
 */
const DUPLICATE_FK_SQL = `
  with fk as (
    select c.conname, c.conrelid, c.confrelid, c.conkey, c.confkey
      from pg_constraint c
      join pg_namespace s on s.oid = c.connamespace
     where c.contype = 'f' and s.nspname = 'public'
  )
  select o.conrelid::regclass::text || '.' || o.conname as legacy_fk,
         n.conname as composite_fk
    from fk o
    join fk n
      on n.conrelid = o.conrelid
     and n.confrelid = o.confrelid
     and array_length(o.conkey, 1) = 1
     and array_length(n.conkey, 1) = 2
     and o.conkey[1] = any (n.conkey)
     and o.confkey[1] = any (n.confkey)
   order by 1`;

describe("composite company foreign keys", () => {
  test("no legacy single-column foreign key duplicates a composite company foreign key", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ legacy_fk: string; composite_fk: string }>(
        DUPLICATE_FK_SQL,
      );
      expect(rows).toEqual([]);
    });
  });
});
