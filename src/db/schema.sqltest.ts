import { afterAll, describe, expect, test } from "vitest";

import { closePool, getPool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Guards on the shape of a freshly-provisioned database.
 *
 * The suite reaching this file at all is the headline assertion: globalSetup
 * applies every file in db/migrations with ON_ERROR_STOP=1, so a migration that
 * does not parse — the defect that shipped in the removed migration 52 — fails
 * the run before a single test executes.
 */
describe("migration set", () => {
  test("every object the money path depends on exists", async () => {
    const { rows } = await getPool().query<{ missing: string }>(
      `select t.name as missing
         from (values ('public.invoices'), ('public.payments'), ('public.payment_allocations'),
                      ('public.receipts'), ('public.contracts'), ('public.tenants'),
                      ('public.payment_requests')) as t(name)
        where to_regclass(t.name) is null`,
    );
    expect(rows.map((r) => r.missing)).toEqual([]);
  });

  test("every RPC the app calls is present with the expected arity", async () => {
    const { rows } = await getPool().query<{ missing: string }>(
      `select t.sig as missing
         from (values ('public.generate_invoices(uuid,integer)'),
                      ('public.backfill_contract_invoices(uuid)'),
                      ('public.reapply_contract_invoices(uuid)'),
                      ('public.evaluate_portal_payable_invoices(uuid,uuid,boolean)'),
                      ('public.apply_payment_allocation(uuid,jsonb)'),
                      ('public.reverse_payment(uuid,text)'),
                      ('public.set_invoice_paid(uuid,boolean,text,text)'),
                      ('public.evaluate_overdue(date)'),
                      ('public.has_permission(uuid,text)'),
                      ('public.get_budget_summary(date,date,uuid,uuid)')) as t(sig)
        where to_regprocedure(t.sig) is null`,
    );
    expect(rows.map((r) => r.missing)).toEqual([]);
  });

  test.each([
    ["(uuid, integer)", "public.evaluate_portal_payable_invoices(uuid, integer)"],
    ["(uuid)", "public.evaluate_portal_payable_invoices(uuid)"],
    ["(uuid, uuid)", "public.evaluate_portal_payable_invoices(uuid, uuid)"],
  ])("the legacy evaluate_portal_payable_invoices %s form is gone", async (_form, signature) => {
    // Migration 97 dropped (uuid, integer); 121 dropped (uuid); 210 dropped
    // (uuid, uuid) to add p_include_hidden. A leftover overload would hide
    // the live body from default PostgREST/psql resolution, and PostgREST
    // answers the ambiguity with a 300 rather than a readable error.
    const { rows } = await getPool().query<{ present: string | null }>(
      `select to_regprocedure($1)::text as present`,
      [signature],
    );
    expect(rows[0].present).toBeNull();
  });

  test("evaluate_portal_payable_invoices has exactly the (uuid, uuid, boolean) form", async () => {
    // regprocedure, not pg_get_function_identity_arguments: the latter includes
    // parameter NAMES ("p_tenant_id uuid, p_contract_id uuid"), so asserting on
    // it would fail the day someone renames an argument without changing the
    // signature. regprocedure renders the types alone, which is the identity
    // that actually decides overload resolution.
    const { rows } = await getPool().query<{ signature: string }>(
      `select p.oid::regprocedure::text as signature
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'evaluate_portal_payable_invoices'`,
    );
    expect(rows.map((r) => r.signature)).toEqual([
      "evaluate_portal_payable_invoices(uuid,uuid,boolean)",
    ]);
  });

  test("the regeneration engine is the UPSERT-diff design, not migration 52's", async () => {
    // Migration 52 was deleted in Gate 0 (invalid `create type if not exists`,
    // and it destroyed payment_allocations). This test used to assert the
    // function was absent, with the note "if this comes back it must come back
    // as the UPSERT-diff design, with its own tests". Migration 55 is that
    // design, so the tripwire becomes a check on which one is installed.
    //
    // `invoice_has_pending_request` is the discriminator: migration 52 had no
    // such concept, and it is the guard that stops a delete orphaning a KNET
    // link a tenant is mid-payment against.
    const { rows } = await getPool().query<{ sig: string; present: string | null }>(
      `select t.sig, to_regprocedure(t.sig)::text as present
         from (values ('public.regenerate_contract_invoices(uuid)'),
                      ('public.invoice_has_pending_request(uuid)'),
                      ('public.contract_period_amounts(uuid,date)')) as t(sig)`,
    );
    expect(rows.filter((r) => r.present === null)).toEqual([]);
  });

  test("invoices are unique per contract period", async () => {
    // The whole UPSERT-diff strategy for T15 rests on this constraint, and on
    // it being addressable by name (contract_id is also an OUT parameter of
    // generate_invoices, so a column-list ON CONFLICT is ambiguous).
    const { rows } = await getPool().query<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid = 'public.invoices'::regclass
          and conname = 'invoices_contract_id_period_year_period_month_key'`,
    );
    expect(rows).toHaveLength(1);
  });

  test("payment_allocations.invoice_id restricts deletes", async () => {
    // This is why "regenerate = delete + recreate" cannot work: the database
    // refuses to drop an invoice that carries money.
    const { rows } = await getPool().query<{ confdeltype: string }>(
      `select confdeltype from pg_constraint
        where conrelid = 'public.payment_allocations'::regclass
          and confrelid = 'public.invoices'::regclass`,
    );
    expect(rows[0]?.confdeltype).toBe("r"); // r = RESTRICT
  });
});

describe("fixtures", () => {
  test("seedContract produces a queryable contract and rolls back", async () => {
    const { seedContract } = await import("@/db/testDb");
    let createdId = "";
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2025-05-01",
        endDate: "2025-09-30",
      });
      createdId = fx.contractId;
      const { rows } = await client.query(
        `select state, monthly_amount from public.contracts where id = $1`,
        [fx.contractId],
      );
      expect(rows[0].state).toBe("active");
    });

    // Outside the transaction the row must be gone, or every later test in the
    // suite would be reading someone else's leftovers.
    const { rows } = await getPool().query(`select 1 from public.contracts where id = $1`, [
      createdId,
    ]);
    expect(rows).toHaveLength(0);
  });
});
