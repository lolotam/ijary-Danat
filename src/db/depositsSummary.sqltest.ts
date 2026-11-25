import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { actAs, actAsSuperuser, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 81 — get_deposits_summary behind the admin deposits KPI cards.
 * Assertions are scoped to a unique bank_name so seed data and parallel files
 * cannot inflate totals (same rule as moduleSummaries.sqltest.ts).
 */

type SummaryJson = Record<string, any>;

async function summary(
  client: PoolClient,
  placeholders: string,
  params: unknown[],
): Promise<SummaryJson> {
  const { rows } = await client.query<{ result: SummaryJson }>(
    `select public.get_deposits_summary(${placeholders}) as result`,
    params,
  );
  return rows[0].result;
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

async function seedDeposit(
  client: PoolClient,
  opts: { bank: string; amount: number; status: string; date: string },
) {
  await client.query(
    `insert into public.deposits (bank_name, amount, currency, status, deposit_date)
     values ($1, $2, 'KWD', $3, $4::date)`,
    [opts.bank, opts.amount, opts.status, opts.date],
  );
}

describe("get_deposits_summary", () => {
  test("splits confirmed from pending and honours the bank filter", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const bank = `SQLTEST-DEP-${crypto.randomUUID().slice(0, 8)}`;

      await seedDeposit(client, {
        bank,
        amount: 200,
        status: "confirmed",
        date: "2026-02-01",
      });
      await seedDeposit(client, {
        bank,
        amount: 50,
        status: "pending",
        date: "2026-02-02",
      });

      // Scope by bank so seed deposits elsewhere cannot affect the numbers.
      const scoped = await summary(client, "null, $1, null, null, null", [bank]);
      expect(num(scoped.total.amount)).toBe(250);
      expect(num(scoped.total.count)).toBe(2);
      expect(num(scoped.confirmed.amount)).toBe(200);
      expect(num(scoped.confirmed.count)).toBe(1);
      expect(num(scoped.pending.amount)).toBe(50);
      expect(num(scoped.pending.count)).toBe(1);

      const other = await summary(client, "null, $1, null, null, null", ["no-such-bank-zzzz"]);
      expect(num(other.total.amount)).toBe(0);
      expect(num(other.total.count)).toBe(0);
    });
  });

  test("total amount matches get_deposit_total for the same filters", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const bank = `SQLTEST-DEP-TOT-${crypto.randomUUID().slice(0, 8)}`;

      await seedDeposit(client, {
        bank,
        amount: 111.111,
        status: "confirmed",
        date: "2026-03-01",
      });
      await seedDeposit(client, {
        bank,
        amount: 22.222,
        status: "cancelled",
        date: "2026-03-02",
      });

      const card = await summary(client, "null, $1, null, null, null", [bank]);
      const { rows } = await client.query<{ total: string }>(
        `select public.get_deposit_total(null, null, $1, null, null) as total`,
        [bank],
      );
      expect(num(card.total.amount)).toBe(num(rows[0].total));
      expect(num(card.total.amount)).toBe(133.333);
    });
  });
});

describe("grants", () => {
  test("anon cannot execute get_deposits_summary", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ allowed: boolean }>(
        `select has_function_privilege(
           'anon',
           'public.get_deposits_summary(text,text,text,date,date)',
           'execute'
         ) as allowed`,
      );
      expect(rows[0].allowed).toBe(false);
    });
  });
});

describe("permission guard", () => {
  test("an authenticated user without deposits.read is refused", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ id: string }>(
        `insert into auth.users (id, instance_id, aud, role, email)
         values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
                 'authenticated', 'authenticated', 'dep-nobody@example.test')
         returning id`,
      );
      await actAs(client, "authenticated", rows[0].id);

      await expect(
        client.query(`select public.get_deposits_summary(null, null, null, null, null)`),
      ).rejects.toThrow(/Permission denied/);
    });
  });
});
