import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { captureRaiseError, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 225: SMTP and Resend may both be enabled, one marked default
 * (`is_primary`) and the other the fallback. The invariant — exactly one email
 * default — lives in a trigger plus a partial unique index, neither of which a
 * mocked database can exercise.
 */

async function emailRows(client: PoolClient) {
  const { rows } = await client.query<{
    provider: string;
    is_enabled: boolean;
    is_primary: boolean;
  }>(
    `select provider::text as provider, is_enabled, is_primary
       from public.provider_configs
      where provider::text in ('smtp', 'resend')
      order by provider`,
  );
  return rows;
}

describe("email default and fallback providers", () => {
  test("the backfill leaves exactly one email provider marked default", async () => {
    await withRollback(async (client) => {
      const primaries = (await emailRows(client)).filter((row) => row.is_primary);
      expect(primaries).toHaveLength(1);
    });
  });

  test("enabling one email provider no longer disables the other", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.provider_configs set is_enabled = true where provider = 'resend'`,
      );
      await client.query(
        `update public.provider_configs set is_enabled = true where provider = 'smtp'`,
      );

      const rows = await emailRows(client);
      expect(rows.map((row) => [row.provider, row.is_enabled])).toEqual([
        ["resend", true],
        ["smtp", true],
      ]);
    });
  });

  test.each(["smtp", "resend"])("promoting %s demotes the other email provider", async (next) => {
    await withRollback(async (client) => {
      await client.query(
        `update public.provider_configs set is_primary = true where provider::text = $1`,
        [next],
      );

      const primaries = (await emailRows(client))
        .filter((row) => row.is_primary)
        .map((row) => row.provider);
      expect(primaries).toEqual([next]);
    });
  });

  test("a second default is refused even when the trigger is bypassed", async () => {
    await withRollback(async (client) => {
      await client.query(`set local session_replication_role = replica`);
      const error = await captureRaiseError(client, () =>
        client.query(`update public.provider_configs set is_primary = true
                       where provider::text in ('smtp', 'resend')`),
      );
      expect((error as { code?: string } | null)?.code).toBe("23505");
    });
  });

  test("a WhatsApp provider cannot be marked default", async () => {
    await withRollback(async (client) => {
      const error = await captureRaiseError(client, () =>
        client.query(
          `update public.provider_configs set is_primary = true where provider = 'whatsapp_cloud_api'`,
        ),
      );
      expect((error as { code?: string } | null)?.code).toBe("23514");
    });
  });
});
