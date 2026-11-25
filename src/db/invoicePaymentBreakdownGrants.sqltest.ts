import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 203 — the server role can execute the payment-snapshot RPC that
 * every PDF attachment (receipt and invoice) depends on, explicitly rather than
 * through default privileges.
 */
describe("get_invoice_payment_breakdown grants", () => {
  test("service_role and authenticated can execute; anon cannot", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ role: string; can: boolean }>(
        `select r.role, has_function_privilege(r.role, 'public.get_invoice_payment_breakdown(uuid)', 'EXECUTE') as can
           from (values ('anon'), ('authenticated'), ('service_role')) as r(role)`,
      );
      expect(Object.fromEntries(rows.map((r) => [r.role, r.can]))).toEqual({
        anon: false,
        authenticated: true,
        service_role: true,
      });
    });
  });
});
