import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runAsCompanyService, runAsUser, seedTwoCompanies } from "@/db/isolation/twoCompanies";
import { actAsSuperuser, captureRaiseError, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * يستخرج رمز SQLSTATE من كائن خطأ PostgreSQL إن وُجد.
 */
function pgErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

/**
 * يدرج رمز إعادة تعيين كلمة مرور مشفّراً لمستخدم شركة ويعيد معرّف الصف.
 *
 * Created through `company_service` — the same role the T085 server function
 * runs as — so every fixture doubles as proof that role can write the table.
 */
async function insertResetToken(
  client: PoolClient,
  companyId: string,
  userId: string,
  tokenHash: string,
): Promise<string> {
  return runAsCompanyService(client, companyId, async () => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.password_reset_tokens (company_id, user_id, token_hash, expires_at)
       values ($1, $2, $3, now() + interval '1 hour')
       returning id`,
      [companyId, userId, tokenHash],
    );
    return rows[0].id;
  });
}

/**
 * يولّد بصمة فريدة تمثّل مجزوءة رمز إعادة التعيين المخزّنة.
 */
function freshTokenHash(): string {
  return randomUUID().replace(/-/g, "");
}

describe("T082 password_reset_tokens are company-scoped and single-use (research.md R3)", () => {
  test("token of company A is invisible and unconsumable to company_service of company B", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const hash = freshTokenHash();
      await insertResetToken(client, A.id, A.users.admin.id, hash);

      await runAsCompanyService(client, B.id, async () => {
        const { rowCount: seen } = await client.query(
          `select 1 from public.password_reset_tokens where token_hash = $1`,
          [hash],
        );
        expect(seen).toBe(0);

        const { rowCount: consumed } = await client.query(
          `update public.password_reset_tokens set used_at = now() where token_hash = $1`,
          [hash],
        );
        expect(consumed).toBe(0);
      });

      await actAsSuperuser(client);
      const { rows } = await client.query<{ used_at: string | null }>(
        `select used_at from public.password_reset_tokens where token_hash = $1`,
        [hash],
      );
      expect(rows).toEqual([{ used_at: null }]);
    });
  });

  test("company_service of the owning company consumes its token by marking used_at", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const hash = freshTokenHash();
      await insertResetToken(client, A.id, A.users.admin.id, hash);

      await runAsCompanyService(client, A.id, async () => {
        const { rowCount: consumed } = await client.query(
          `update public.password_reset_tokens set used_at = now() where token_hash = $1 and used_at is null`,
          [hash],
        );
        expect(consumed).toBe(1);
      });

      await actAsSuperuser(client);
      const { rows } = await client.query<{ used_at: string | null }>(
        `select used_at from public.password_reset_tokens where token_hash = $1`,
        [hash],
      );
      expect(rows[0].used_at).not.toBeNull();
    });
  });

  test.each([
    { who: "staff admin", role: "admin" },
    { who: "renter", role: "tenant" },
  ] as const)(
    "an authenticated $who cannot read or consume password_reset_tokens",
    async ({ role }) => {
      await withRollback(async (client) => {
        const { A } = await seedTwoCompanies(client);
        const hash = freshTokenHash();
        await insertResetToken(client, A.id, A.users[role].id, hash);

        await runAsUser(client, A.users[role], async () => {
          const selectErr = await captureRaiseError(client, () =>
            client.query(`select 1 from public.password_reset_tokens where token_hash = $1`, [
              hash,
            ]),
          );
          expect(pgErrorCode(selectErr)).toBe("42501");

          const updateErr = await captureRaiseError(client, () =>
            client.query(
              `update public.password_reset_tokens set used_at = now() where token_hash = $1`,
              [hash],
            ),
          );
          expect(pgErrorCode(updateErr)).toBe("42501");
        });
      });
    },
  );

  test("a token cannot reference a profile of another company", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      await actAsSuperuser(client);
      const err = await captureRaiseError(client, () =>
        client.query(
          `insert into public.password_reset_tokens (company_id, user_id, token_hash, expires_at)
           values ($1, $2, $3, now() + interval '1 hour')`,
          [A.id, B.users.admin.id, freshTokenHash()],
        ),
      );
      expect(pgErrorCode(err)).toBe("23503");
    });
  });

  test("the same token hash cannot be stored twice", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const hash = freshTokenHash();
      await insertResetToken(client, A.id, A.users.admin.id, hash);

      const err = await runAsCompanyService(client, A.id, () =>
        captureRaiseError(client, () =>
          client.query(
            `insert into public.password_reset_tokens (company_id, user_id, token_hash, expires_at)
             values ($1, $2, $3, now() + interval '1 hour')`,
            [A.id, A.users.accountant.id, hash],
          ),
        ),
      );
      expect(pgErrorCode(err)).toBe("23505");
    });
  });

  test("must_change_password defaults to false and can be raised for a profile", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      await actAsSuperuser(client);

      const { rows: before } = await client.query<{ must_change_password: boolean }>(
        `select must_change_password from public.profiles where id = $1`,
        [A.users.admin.id],
      );
      expect(before).toEqual([{ must_change_password: false }]);

      await client.query(`update public.profiles set must_change_password = true where id = $1`, [
        A.users.admin.id,
      ]);
      const { rows: after } = await client.query<{ must_change_password: boolean }>(
        `select must_change_password from public.profiles where id = $1`,
        [A.users.admin.id],
      );
      expect(after).toEqual([{ must_change_password: true }]);
    });
  });
});
