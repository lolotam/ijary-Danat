import { afterAll, describe, expect, test } from "vitest";

import { closePool, seedContract, withRollback } from "@/db/testDb";

afterAll(closePool);

const AS_OF = "2026-07-29";

/** Milestones the function emits for one contract expiring `days` from AS_OF. */
async function milestonesFor(days: number): Promise<string[]> {
  return withRollback(async (client) => {
    const end = await client.query<{ d: string }>(`select ($1::date + $2::int)::text as d`, [
      AS_OF,
      days,
    ]);
    const fx = await seedContract(client, {
      startDate: "2024-01-01",
      endDate: end.rows[0].d,
    });
    const { rows } = await client.query<{ milestone: string; contract_id: string }>(
      `select milestone, contract_id from public.identify_contract_expiry_reminders($1::date)`,
      [AS_OF],
    );
    return rows.filter((r) => r.contract_id === fx.contractId).map((r) => r.milestone);
  });
}

describe("identify_contract_expiry_reminders", () => {
  test("a contract expiring in ~4 months is flagged once, as 120d", async () => {
    // Was `4m` before migration 58. The buckets are expressed in days now —
    // mixing month arithmetic with day arithmetic is what let the old `1m` and
    // `7d` ranges overlap.
    expect(await milestonesFor(115)).toEqual(["120d"]);
  });

  test("a contract expiring beyond the furthest threshold is not flagged", async () => {
    expect(await milestonesFor(300)).toEqual([]);
  });

  test("a non-active contract is never flagged", async () => {
    const milestones = await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2024-01-01",
        endDate: "2026-08-05",
        state: "terminated",
      });
      const { rows } = await client.query<{ contract_id: string }>(
        `select contract_id from public.identify_contract_expiry_reminders($1::date)`,
        [AS_OF],
      );
      return rows.filter((r) => r.contract_id === fx.contractId);
    });
    expect(milestones).toEqual([]);
  });

  /**
   * FIXED in Batch F (migration 58).
   *
   * This was written with `test.fails` while the defect was live: the old `1m`
   * bucket was "expires within the next 30 days", which fully contained the
   * separate `7d` bucket, so a contract expiring in three days was emitted
   * twice and triggered two complete notification fan-outs — one announcing
   * "in 1 month(s)" for a contract ending that week.
   *
   * The tripwire's own instruction was to delete the `.fails` and keep the
   * assertion once the thresholds were re-cut. Migration 58 replaced them with
   * eight mutually exclusive DAY buckets computed by a single `case`, so
   * exclusivity is now structural rather than incidental.
   */
  test("a contract expiring in 3 days is flagged exactly once", async () => {
    expect(await milestonesFor(3)).toEqual(["7d"]);
  });
});
