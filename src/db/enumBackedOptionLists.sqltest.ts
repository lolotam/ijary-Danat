import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";
import { ENUM_BACKED_OPTION_LISTS } from "@/lib/enumBackedOptionLists";

afterAll(closePool);

/**
 * `src/lib/enumBackedOptionLists.ts` hand-mirrors five Postgres enums used by
 * Settings → Lists value validation. A comment there says the map must stay in
 * step with db/migrations — that is a test's job. When a migration adds a
 * member (as 88 and 92 did for notification_types), the constant goes stale and
 * the UI starts rejecting values the database would accept.
 *
 * This suite reads `pg_enum` so the constant cannot drift without a red test.
 */

/**
 * Map a Settings list code to its Postgres enum type name.
 *
 * Two codes are plural while the type is singular (`unit_statuses` →
 * `unit_status`, `tenant_lifecycles` → `tenant_lifecycle`). The other three
 * share the name. Do not strip a bare trailing "s": that would map
 * `contract_types` → `contract_type` and `payment_methods` → `payment_method`
 * (neither exists), and `pg_enum` would return zero rows — the vacuity trap this
 * suite exists to avoid.
 */
function postgresEnumTypeName(listCode: string): string {
  if (listCode.endsWith("_statuses")) {
    // unit_statuses → unit_status (drop trailing "es")
    return listCode.slice(0, -2);
  }
  if (listCode.endsWith("_lifecycles")) {
    // tenant_lifecycles → tenant_lifecycle (drop trailing "s")
    return listCode.slice(0, -1);
  }
  return listCode;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

describe("ENUM_BACKED_OPTION_LISTS stays in step with Postgres enums", () => {
  test("the constant is non-empty (empty map would make test.each vacuous)", () => {
    expect(
      Object.keys(ENUM_BACKED_OPTION_LISTS).length,
      "ENUM_BACKED_OPTION_LISTS has no entries — the suite would pass without checking anything",
    ).toBeGreaterThan(0);
  });

  test.each(Object.entries(ENUM_BACKED_OPTION_LISTS))(
    "list %s matches public enum members",
    async (listCode, constantMembers) => {
      const typeName = postgresEnumTypeName(listCode);

      await withRollback(async (client) => {
        const { rows } = await client.query<{ enumlabel: string }>(
          `select e.enumlabel
             from pg_catalog.pg_enum e
             join pg_catalog.pg_type t on t.oid = e.enumtypid
             join pg_catalog.pg_namespace n on n.oid = t.typnamespace
            where n.nspname = 'public'
              and t.typname = $1`,
          [typeName],
        );

        // Zero rows means the type was not found (or is empty). An empty
        // constant vs empty DB comparison would pass and hide a bad mapping —
        // e.g. querying plural codes against singular type names.
        expect(
          rows.length,
          `Postgres enum type public.${typeName} (for list code "${listCode}") ` +
            `does not exist or has no members. Refusing to compare against an empty set ` +
            `(vacuous pass). Check postgresEnumTypeName() and the migrations.`,
        ).toBeGreaterThan(0);

        const fromDb = sorted(rows.map((r) => r.enumlabel));
        const fromConstant = sorted(constantMembers);

        expect(
          fromConstant,
          `ENUM_BACKED_OPTION_LISTS["${listCode}"] is out of step with public.${typeName}.\n` +
            `  constant: ${JSON.stringify(fromConstant)}\n` +
            `  database: ${JSON.stringify(fromDb)}`,
        ).toEqual(fromDb);
      });
    },
  );
});
