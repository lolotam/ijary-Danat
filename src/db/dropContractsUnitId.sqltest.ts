import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 118 — the last step of the multi-unit-contracts feature.
 * contract_units (migration 110) has been the source of truth for which
 * units a contract holds since migrations 111-117 moved every SQL reader off
 * contracts.unit_id. This migration drops the column itself.
 *
 * PostgreSQL does not track column references inside plpgsql function bodies
 * as dependencies, so `drop column` succeeds regardless of whether a
 * function body still names it — this suite (in particular the second test
 * below) is the only real check that nothing was missed.
 */
describe("contracts.unit_id is gone", () => {
  it("no longer exists as a column", async () => {
    await withRollback(async (client: PoolClient) => {
      const column = await client.query(
        `select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'contracts' and column_name = 'unit_id'`,
      );
      expect(column.rowCount).toBe(0);
    });
  });

  /**
   * The sweep, and why it is shaped this way (final review M4).
   *
   * The first version matched three literal spellings —
   * `c.unit_id`, `v_contract.unit_id`, `contracts.unit_id` — which is not the
   * general check its comment promised: a function aliasing `contracts` as
   * anything but `c`, and not going through a `v_contract` record, walked
   * straight past. That is not hypothetical here; migration 118 aliases
   * contracts as `ct` in its own SQL.
   *
   * This is the broader sweep instead: any function that names `unit_id`, does
   * NOT mention `contract_units`, and references `public.contracts` or a
   * `v_contract` record.
   *
   * The three original literals are kept as an extra disjunct so the check only
   * ever GROWS. On its own the broader form is not a superset: its
   * `!~ 'contract_units'` clause excludes a function that legitimately reads
   * `contract_units` while still carrying a stale `contracts.unit_id`
   * reference — precisely the shape a half-finished migration leaves behind,
   * and precisely what the old pattern was good at.
   *
   * ALLOWLIST — these two read `invoices.unit_id` / `payments.unit_id`, both of
   * which still exist and are both nullable by design (migration 112). They
   * reference `public.contracts` for unrelated reasons, so the sweep cannot
   * tell them apart from a genuine survivor. Adding a name here is a decision
   * about a specific function, not a way to quiet the check.
   */
  const KNOWN_NON_CONTRACT_UNIT_ID_READERS = [
    "set_invoice_paid",
    "reverse_payment",
    // Stage 3B-2 added `public.contracts` company_id checks/filters to functions
    // that touch `invoice_items.unit_id`, `partial_payments.unit_id`, or
    // `contract_unit_period_amounts(...).unit_id` (none read `contracts.unit_id`).
    "append_extra_charge_items",
    "edit_partial_payment",
    "get_property_monthly_rent_totals",
  ];

  const SWEEP = `select p.proname from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and (
          p.prosrc ~ '\\mc\\.unit_id|v_contract\\.unit_id|contracts\\.unit_id'
          or (
            p.prosrc ~ '\\munit_id'
            and p.prosrc !~ 'contract_units'
            and p.prosrc ~ '(public\\.contracts|v_contract)'
          )
        )
        and p.proname <> all ($1::text[])
      order by p.proname`;

  it("is not referenced by any remaining function body", async () => {
    await withRollback(async (client: PoolClient) => {
      // Postgres does NOT track column references inside plpgsql bodies, so
      // `drop column` succeeded regardless. This is the only check there is.
      const offenders = await client.query(SWEEP, [KNOWN_NON_CONTRACT_UNIT_ID_READERS]);
      expect(offenders.rows.map((r) => r.proname)).toEqual([]);
    });
  });

  it("would catch a survivor that aliases contracts as something other than c", async () => {
    await withRollback(async (client: PoolClient) => {
      // Proves the sweep is a real check and not three lucky string matches.
      // plpgsql does not resolve column references at CREATE time, so this
      // body compiles fine even though the column is gone — which is exactly
      // the situation the sweep exists to detect. Rolled back with the
      // transaction; never visible to another session.
      await client.query(
        `create function public.decoy_reads_contracts_unit_id() returns uuid
         language plpgsql as $decoy$
         declare v uuid;
         begin
           select ct.unit_id into v from public.contracts ct limit 1;
           return v;
         end;
         $decoy$`,
      );
      const offenders = await client.query(SWEEP, [KNOWN_NON_CONTRACT_UNIT_ID_READERS]);
      expect(offenders.rows.map((r) => r.proname)).toContain("decoy_reads_contracts_unit_id");
    });
  });

  it("keeps exactly one double-booking index, on contract_units", async () => {
    await withRollback(async (client: PoolClient) => {
      const indexes = await client.query(
        `select tablename, indexname from pg_indexes
            where indexname like 'one_active_contract_per_unit%' order by indexname`,
      );
      expect(indexes.rows).toEqual([
        { tablename: "contract_units", indexname: "one_active_contract_per_unit" },
      ]);
    });
  });
});
