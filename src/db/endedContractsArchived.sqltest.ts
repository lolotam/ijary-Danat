import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

type ContractsSummary = {
  active: number;
  archived_count: number;
  current_count: number;
  ended: number;
  total: number;
};

/**
 * يستدعي ملخّص العقود، مقصورًا على مستأجر واحد أو على المحفظة كاملة.
 *
 * Scoping to one tenant is what keeps these assertions exact: the seeded
 * database carries contracts from every other fixture, so a portfolio-wide
 * count would only ever support a relative assertion.
 */
async function summaryForTenant(
  client: PoolClient,
  tenantId: string | null,
  mode: string,
): Promise<ContractsSummary> {
  const { rows } = await client.query<{ get_contracts_summary: ContractsSummary }>(
    `select public.get_contracts_summary(null, null, $1::uuid, $2)`,
    [tenantId, mode],
  );
  return rows[0].get_contracts_summary;
}

/**
 * Migration 211. `close_out_contract` stamps `archived_at` only for the
 * `archive` outcome; `keep_terminated` and `freeze` change `state` and leave it
 * NULL. Splitting the archive tabs on `archived_at` alone therefore stranded
 * every contract closed out as terminated in "Current" — four of them in
 * production — each still offering a Close-out action the database refuses.
 */
describe("contract_is_ended (migration 211)", () => {
  test.each([
    ["an archived contract, whatever its state", "active", true, true],
    ["a terminated contract with no archived_at", "terminated", false, true],
    ["an expired contract with no archived_at", "expired", false, true],
    ["a plain active contract", "active", false, false],
    ["a frozen contract, which is paused rather than over", "frozen", false, false],
    // Superseded, not ended — and `ended` in the summary has never counted it.
    ["a renewed contract", "renewed", false, false],
  ])("calls %s ended = %s", async (_scenario, state, archived, expected) => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ ended: boolean }>(
        `select public.contract_is_ended($1::timestamptz, $2::public.contract_states) as ended`,
        [archived ? "2026-01-01T00:00:00Z" : null, state],
      );
      expect(rows[0].ended).toBe(expected);
    });
  });
});

describe("get_contracts_summary counts ended contracts as archived (migration 211)", () => {
  test("a terminated contract with no archived_at leaves Current for Archived", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      const asActive = await summaryForTenant(client, fixture.tenantId, "current");
      expect(asActive.current_count).toBe(1);
      expect(asActive.archived_count).toBe(0);

      // Exactly what close_out_contract's `keep_terminated` outcome writes: a
      // final state, and archived_at deliberately left alone.
      await client.query(
        `update public.contracts
            set state = 'terminated'::public.contract_states
          where id = $1`,
        [fixture.contractId],
      );

      const afterCloseOut = await summaryForTenant(client, fixture.tenantId, "current");
      expect(afterCloseOut.current_count).toBe(0);
      expect(afterCloseOut.archived_count).toBe(1);
      // The mode-scoped total follows the same rule, so the Current tab's own
      // KPI row cannot disagree with the tab badge beside it.
      expect(afterCloseOut.total).toBe(0);

      const archivedMode = await summaryForTenant(client, fixture.tenantId, "archived");
      expect(archivedMode.total).toBe(1);
      expect(archivedMode.ended).toBe(1);
    });
  });

  /**
   * The Active KPI reads `state = 'active'`, so it already excluded terminated
   * and expired rows. Pinned here because it is the card the office watches,
   * and because migration 211 rewrote the query it sits in.
   */
  test("the active KPI never counts an ended contract", async () => {
    await withRollback(async (client) => {
      const fixture = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      expect((await summaryForTenant(client, fixture.tenantId, "all")).active).toBe(1);

      await client.query(
        `update public.contracts
            set state = 'expired'::public.contract_states
          where id = $1`,
        [fixture.contractId],
      );

      const allModes = await summaryForTenant(client, fixture.tenantId, "all");
      expect(allModes.active).toBe(0);
      expect(allModes.ended).toBe(1);
    });
  });

  // Guard on the whole-portfolio call the screen actually makes: the two slice
  // counts partition the table, so a contract cannot be missing from both tabs.
  test("current_count and archived_count still partition every contract", async () => {
    await withRollback(async (client) => {
      const summary = await summaryForTenant(client, null, "current");
      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n from public.contracts`,
      );
      expect(summary.current_count + summary.archived_count).toBe(Number(rows[0].n));
    });
  });
});
