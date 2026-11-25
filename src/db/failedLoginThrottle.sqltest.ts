import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

interface AuditRow {
  action: string;
  result: string;
  error_code: string | null;
  after: { identifier?: string; attempts?: number } | null;
}

/**
 * يضبط عنوان الزائر كما يقرأه write_audit من ترويسات PostgREST.
 *
 * `record_failed_login` reads the same `x-danat-client-ip` header as
 * `write_audit` (migration 209), so the test sets the `request.headers` GUC
 * directly instead of going through PostgREST.
 */
async function setClientIp(client: PoolClient, ip: string): Promise<void> {
  await client.query(`select set_config('request.headers', $1, true)`, [
    JSON.stringify({ "x-danat-client-ip": ip }),
  ]);
}

/**
 * يُنفّذ عدداً من محاولات الدخول الفاشلة ويُرجع العدّاد الأخير.
 *
 * Returns the count the final call reported, so the caller can assert the
 * counter kept climbing even while `audit_logs` stayed still.
 */
async function recordFailures(
  client: PoolClient,
  identifier: string,
  count: number,
): Promise<number> {
  let last = 0;
  for (let i = 0; i < count; i += 1) {
    const { rows } = await client.query<{ record_failed_login: number }>(
      `select public.record_failed_login($1::text, null, 'INVALID_CREDENTIALS')`,
      [identifier],
    );
    last = rows[0].record_failed_login;
  }
  return last;
}

/**
 * يجلب صفوف التدقيق الخاصة بمعرّف واحد، بمعزل عن بيانات البذور.
 *
 * The database is not empty at rest (11/15_mock seed rows), so every
 * assertion scopes to the identifier the test itself used.
 */
async function auditRows(client: PoolClient, identifier: string): Promise<AuditRow[]> {
  const { rows } = await client.query<AuditRow>(
    `select action, result, error_code, after from public.audit_logs
      where after ->> 'identifier' = $1
      order by created_at`,
    [identifier],
  );
  return rows;
}

/** يعدّ كل صفوف التدقيق الصادرة عن عنوان واحد في النافذة الحالية. */
async function ipScopedAuditCount(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `select count(*) from public.audit_logs
      where action = 'auth.login.throttled' and after ->> 'scope' = 'client_ip'`,
  );
  return Number(rows[0].count);
}

/**
 * يقرأ العدّاد الحالي لمعرّف وعنوان معيّنين.
 *
 * Asserts against the counter table directly: past the IP budget the
 * identifier row stops at 25 while the IP aggregate keeps climbing.
 */
async function counterAttempts(
  client: PoolClient,
  identifier: string,
  ip: string,
): Promise<number | null> {
  const { rows } = await client.query<{ attempts: number }>(
    `select attempts from public.failed_login_attempts
      where scope = 'identifier' and identifier_key = lower(trim($1)) and client_ip = $2`,
    [identifier, ip],
  );
  return rows.length ? rows[0].attempts : null;
}

/** يقرأ العدّاد المجمّع لعنوان واحد في النافذة الحالية. */
async function ipCounterAttempts(client: PoolClient, ip: string): Promise<number | null> {
  const { rows } = await client.query<{ attempts: number }>(
    `select attempts from public.failed_login_attempts
      where scope = 'client_ip' and client_ip = $1`,
    [ip],
  );
  return rows.length ? rows[0].attempts : null;
}

/**
 * Migration 215. `signInWithIdentifier` is public and unauthenticated, and
 * every failure used to append one `audit_logs` row — a loop of bad
 * credentials grew the append-only forensic table without bound. Identifier-
 * scoped writes land on 1, 5 and 25; past the IP budget the IP-scoped ×5
 * ladder continues (125, 625, …).
 */
describe("failed-login audit throttle (migration 215)", () => {
  test("the first failure writes one auth.login failure row", async () => {
    await withRollback(async (client) => {
      const identifier = "throttle-first@example.test";
      await setClientIp(client, "203.0.113.7");
      await recordFailures(client, identifier, 1);

      const rows = await auditRows(client, identifier);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "auth.login",
        result: "failure",
        error_code: "INVALID_CREDENTIALS",
      });
    });
  });

  test("attempts 2, 3 and 4 write no further rows", async () => {
    await withRollback(async (client) => {
      const identifier = "throttle-quiet@example.test";
      await setClientIp(client, "203.0.113.7");
      await recordFailures(client, identifier, 4);

      expect(await auditRows(client, identifier)).toHaveLength(1);
    });
  });

  test("the fifth failure writes a second auth.login row", async () => {
    await withRollback(async (client) => {
      const identifier = "throttle-fifth@example.test";
      await setClientIp(client, "203.0.113.7");
      await recordFailures(client, identifier, 5);

      const rows = await auditRows(client, identifier);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.action)).toEqual(["auth.login", "auth.login"]);
    });
  });

  test("the twenty-fifth failure writes one throttled summary carrying attempts = 25", async () => {
    await withRollback(async (client) => {
      const identifier = "throttle-summary@example.test";
      await setClientIp(client, "203.0.113.7");
      await recordFailures(client, identifier, 25);

      const rows = await auditRows(client, identifier);
      expect(rows).toHaveLength(3);
      const summary = rows.find((row) => row.action === "auth.login.throttled");
      expect(summary).toMatchObject({ result: "failure" });
      expect(summary?.after?.attempts).toBe(25);
    });
  });

  /**
   * Review round 2 on PR #211. The identifier counter used to keep climbing
   * past the IP budget, which meant a rotating-username spray inserted a row
   * per username and held it for 24 hours — the unbounded growth this migration
   * exists to stop, moved one table across. Past the budget the identifier is
   * not counted at all, and the IP aggregate is the only thing that advances.
   */
  test("attempts 26 through 100 write nothing, and stop touching the identifier counter", async () => {
    await withRollback(async (client) => {
      const identifier = "throttle-flood@example.test";
      const ip = "203.0.113.7";
      await setClientIp(client, ip);
      await recordFailures(client, identifier, 100);

      expect(await counterAttempts(client, identifier, ip)).toBe(25);
      expect(await ipCounterAttempts(client, ip)).toBe(100);
      expect(await auditRows(client, identifier)).toHaveLength(3);
    });
  });

  test("a different client IP starts its own window and its own count", async () => {
    await withRollback(async (client) => {
      const identifier = "throttle-other-ip@example.test";
      await setClientIp(client, "203.0.113.7");
      await recordFailures(client, identifier, 1);
      await setClientIp(client, "198.51.100.9");
      await recordFailures(client, identifier, 1);

      // Each IP's first attempt audits; a shared counter would have kept the
      // second quiet as attempt 2.
      expect(await auditRows(client, identifier)).toHaveLength(2);
      expect(await counterAttempts(client, identifier, "198.51.100.9")).toBe(1);
    });
  });
});

/**
 * Review round 1 on PR #211. Keying only on (identifier, client IP) is defeated
 * by the ordinary shape of password spraying: vary the submitted username and
 * every request is a fresh `attempts = 1`, so every request still appended one
 * `audit_logs` row — the unbounded growth migration 215 exists to stop, reached
 * by changing one field.
 */
describe("the per-IP budget survives a rotating identifier (migration 215)", () => {
  /** يجرّب معرّفاً مختلفاً في كل محاولة من العنوان نفسه. */
  async function sprayDistinctIdentifiers(client: PoolClient, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await client.query(
        `select public.record_failed_login($1::text, null, 'INVALID_CREDENTIALS')`,
        [`spray-${i}@example.test`],
      );
    }
  }

  test("a spray of 100 distinct identifiers does not buy 100 audit rows", async () => {
    await withRollback(async (client) => {
      await setClientIp(client, "203.0.113.55");
      await sprayDistinctIdentifiers(client, 100);

      // 25 first-attempt rows inside the IP's budget, then the IP ladder takes
      // over and 125 is not reached — so nothing between 26 and 100.
      const { rows } = await client.query<{ count: string }>(
        `select count(*) from public.audit_logs where after ->> 'identifier' like 'spray-%'`,
      );
      expect(Number(rows[0].count)).toBe(25);
      expect(await ipScopedAuditCount(client)).toBe(0);
      // The counter table is bounded as well, which is the round-2 finding: 25
      // identifier rows and one aggregate, not one row per username tried.
      const counters = await client.query<{ count: string }>(
        `select count(*) from public.failed_login_attempts where scope = 'identifier'`,
      );
      expect(Number(counters.rows[0].count)).toBe(25);
    });
  });

  test("the IP's own ladder records the magnitude once it passes its budget", async () => {
    await withRollback(async (client) => {
      await setClientIp(client, "203.0.113.56");
      await sprayDistinctIdentifiers(client, 125);

      // One IP-scoped summary at 125, carrying the count that the per-identifier
      // rows can no longer express.
      expect(await ipScopedAuditCount(client)).toBe(1);
      const { rows } = await client.query<{ attempts: number }>(
        `select (after ->> 'attempts')::int as attempts from public.audit_logs
          where action = 'auth.login.throttled' and after ->> 'scope' = 'client_ip'`,
      );
      expect(rows[0].attempts).toBe(125);
    });
  });

  /**
   * The ladder replaces "write nothing past 25", which made the trail read the
   * same whether an attack stopped at 26 or reached a million — while the only
   * accurate counter is pruned at 24 hours.
   */
  test("one identifier hammered 125 times records the 125 as well as the 25", async () => {
    await withRollback(async (client) => {
      const identifier = "ladder@example.test";
      await setClientIp(client, "203.0.113.57");
      // A single identifier means the IP counter tracks it exactly, so the IP
      // budget is spent at the same moment — the IP ladder is what continues.
      await recordFailures(client, identifier, 125);

      const summaries = await client.query<{ attempts: number; scope: string }>(
        `select (after ->> 'attempts')::int as attempts, after ->> 'scope' as scope
           from public.audit_logs where action = 'auth.login.throttled' order by attempts`,
      );
      expect(summaries.rows.map((row) => row.attempts)).toEqual([25, 125]);
    });
  });
});

/**
 * Review round 2 on PR #211. The IP aggregate used to live under the sentinel
 * identifier `*`, which is submittable — the validator accepts it and the
 * legacy mapping tries `*@users.local`. A caller sending it collided with the
 * aggregate, incremented one row twice per request, and so kept the count
 * permanently even: the ladder milestones 25, 125 and 625 are all odd, so the
 * continuation summaries vanished for exactly the caller who chose that name.
 */
describe("the IP aggregate cannot collide with a submitted identifier", () => {
  test("an identifier of '*' counts separately from the IP aggregate", async () => {
    await withRollback(async (client) => {
      await setClientIp(client, "203.0.113.90");
      await recordFailures(client, "*", 3);

      // Three requests: three on the identifier row, three on the aggregate —
      // not six on one row.
      expect(await counterAttempts(client, "*", "203.0.113.90")).toBe(3);
      expect(await ipCounterAttempts(client, "203.0.113.90")).toBe(3);
    });
  });
});

/**
 * `failed_login_is_milestone` used integer `v_step`, so `v_step * 5` overflowed
 * for every argument above 1_220_703_125 (the last in-range ×5 step). Direct
 * calls, not 2^31 inserts: the helper is the subject.
 */
describe("failed_login_is_milestone covers the integer domain", () => {
  test.each([
    [1, true],
    [5, true],
    [25, true],
    [125, true],
    [1_220_703_125, true],
    [2, false],
    [24, false],
    [26, false],
    [1_220_703_126, false],
    [2_147_483_647, false],
  ] as const)("failed_login_is_milestone(%i) is %s", async (count, expected) => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ failed_login_is_milestone: boolean }>(
        `select public.failed_login_is_milestone($1::integer)`,
        [count],
      );
      expect(rows[0].failed_login_is_milestone).toBe(expected);
    });
  });
});
