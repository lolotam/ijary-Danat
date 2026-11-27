import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { closePool, getPool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 315 — حجز إرسال الإشعارات: مهلة على الصف تضمن إرسالاً واحداً بالضبط.
 *
 * Real SQL against a real Postgres built from db/migrations. The claim is one
 * conditional UPDATE (the shape `src/fns/dispatchNotification.server.ts` sends), so
 * these tests pin its three promises: of two concurrent claims exactly one
 * gets the row back, an expired lease is reclaimable while a fresh one is
 * not, and every terminal write releases the lease (migration 315's trigger).
 * The ten-minute window below is `DISPATCH_LEASE_MS` in that module — the two
 * must agree or a claim would be refused while its sender is still working.
 */

/** ادعاء الإرسال كما يبنيه التطبيق: مهلة عشر دقائق، والحالة قابلة للتصريف. */
const CLAIM_SQL = `
  update public.notifications
     set dispatch_claimed_at = $1
   where id = $2
     and company_id = $3
     and state in ('queued', 'failed')
     and (dispatch_claimed_at is null
          or dispatch_claimed_at < now() - interval '10 minutes')
  returning *`;

/** ينشئ شركة اختبار جديدة ويعيد معرّفها. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة اختبار ${tag}`, `Test Co ${tag}`],
  );
  return rows[0].id;
}

/** يزرع صف إشعار بالحالة والمهلة المعطاة ويعيد معرّفه. */
async function seedNotification(
  client: PoolClient,
  companyId: string,
  options: { state?: string; claimedAt?: string | null } = {},
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.notifications
       (company_id, type, channel, locale, body, state, dispatch_claimed_at)
     values ($1, 'receipt', 'email', 'ar', 'test body', $2, $3)
     returning id`,
    [companyId, options.state ?? "queued", options.claimedAt ?? null],
  );
  return rows[0].id;
}

describe("the dispatch lease claims one queued row exactly once (migration 315)", () => {
  test("two concurrent claims of one queued row give it back to exactly one caller", async () => {
    // مهمتان متزامنتان على اتصالين منفصلين — البستانيان يتنافسان على صف
    // واحد. التحديث الشرطي هو ما يفرز الفائز: الثاني يرى المهلة محجوزة فلا
    // يطابق أي صف.
    const pool = getPool();
    const first = await pool.connect();
    const second = await pool.connect();
    let companyId = "";
    let notificationId = "";
    try {
      companyId = await seedCompany(first);
      notificationId = await seedNotification(first, companyId);

      const [firstClaim, secondClaim] = await Promise.all([
        first.query(CLAIM_SQL, [new Date().toISOString(), notificationId, companyId]),
        second.query(CLAIM_SQL, [new Date().toISOString(), notificationId, companyId]),
      ]);

      const winners = [firstClaim, secondClaim].filter((result) => result.rows.length === 1);
      expect(winners).toHaveLength(1);
      expect(winners[0].rows[0].id).toBe(notificationId);
      expect(winners[0].rows[0].dispatch_claimed_at).not.toBeNull();
    } finally {
      // خارج معاملة التراجع: الاتصالان المستقلان لا يريان صفوف غير ملتزمة،
      // فالبذور تُحذف صراحةً حتى يبقى النظيف قابلاً للتكرار.
      await first.query("delete from public.notifications where id = $1", [notificationId]);
      await first.query("delete from public.companies where id = $1", [companyId]);
      first.release();
      second.release();
    }
  });

  test.each([
    {
      expectation: "a fresh lease blocks the claim while its sender works",
      claimedAt: () => new Date().toISOString(),
      expectedRows: 0,
    },
    {
      expectation: "an expired lease is reclaimed by the next claim",
      claimedAt: () => new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      expectedRows: 1,
    },
  ])("$expectation", async ({ claimedAt, expectedRows }) => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const notificationId = await seedNotification(client, companyId, {
        claimedAt: claimedAt(),
      });

      const claim = await client.query(CLAIM_SQL, [
        new Date().toISOString(),
        notificationId,
        companyId,
      ]);

      expect(claim.rows).toHaveLength(expectedRows);
    });
  });

  test.each(["sent", "failed", "needs_review", "skipped", "cancelled"] as const)(
    "a terminal write to %s releases the lease",
    async (terminalState) => {
      // كل كتابة نهائية تحرّر المهلة (زناد مиграة 315): صف أنهى إرساله لا
      // يبقى معلَّقاً كأن مُرسِلاً ما زال يملكه.
      await withRollback(async (client) => {
        const companyId = await seedCompany(client);
        const notificationId = await seedNotification(client, companyId, {
          claimedAt: new Date().toISOString(),
        });

        await client.query("update public.notifications set state = $2 where id = $1", [
          notificationId,
          terminalState,
        ]);

        const { rows } = await client.query<{ dispatch_claimed_at: string | null }>(
          "select dispatch_claimed_at from public.notifications where id = $1",
          [notificationId],
        );
        expect(rows[0].dispatch_claimed_at).toBeNull();
      });
    },
  );

  test.each([
    {
      expectation: "a row in a terminal state is not claimable",
      seed: { state: "needs_review", claimedAt: null },
    },
    {
      expectation: "another company's row is not claimable",
      seed: { state: "queued", claimedAt: null, otherCompany: true },
    },
  ])("$expectation", async ({ seed }) => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const otherCompanyId = await seedCompany(client);
      const notificationId = await seedNotification(
        client,
        seed.otherCompany ? otherCompanyId : companyId,
        { state: seed.state, claimedAt: seed.claimedAt },
      );

      const claim = await client.query(CLAIM_SQL, [
        new Date().toISOString(),
        notificationId,
        companyId,
      ]);

      expect(claim.rows).toHaveLength(0);
    });
  });
});
