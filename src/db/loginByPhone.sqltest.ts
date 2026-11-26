import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { closePool, setCompanyClaimContext, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 65 — matching a typed mobile number against `profiles.phone`.
 *
 * The column is free text, so the same number lives in the database in
 * whatever shape whoever recorded it used. These tests exist because an
 * equality match would pass a naive review and fail for most real people.
 */

/** ينشئ شركة اختبارية ويضبط سياقها لاختبارات البحث برقم الهاتف. */
async function seedPhoneCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة هاتف ${tag}`, `Phone Co ${tag}`],
  );
  await setCompanyClaimContext(client, rows[0].id);
  return rows[0].id;
}

/** ينشئ مستخدماً وملفاً شخصياً مرتبطاً بالشركة ورقم الهاتف المحدد. */
async function seedProfile(
  client: PoolClient,
  companyId: string,
  phone: string | null,
  email: string,
) {
  const id = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [id, email],
  );
  // Inserting the auth user already creates the profile row via the
  // handle_new_user trigger, so this fills it in rather than creating it.
  await client.query(
    `insert into public.profiles (id, company_id, email, phone, display_name)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update
       set company_id = excluded.company_id,
           email = excluded.email,
           phone = excluded.phone`,
    [id, companyId, email, phone, `User ${id.slice(0, 8)}`],
  );
  return id;
}

async function lookup(client: PoolClient, digits: string) {
  const { rows } = await client.query(`select * from public.find_profiles_by_phone_digits($1)`, [
    digits,
  ]);
  return rows as Array<{ id: string; email: string }>;
}

describe("finding an account by mobile number", () => {
  test.each(["+965 5123 4567", "00965-51234567", "51234567", "(965) 5123-4567"])(
    "matches a profile whose number is stored as %s",
    async (stored) => {
      await withRollback(async (client) => {
        const companyId = await seedPhoneCompany(client);
        const email = `${randomUUID()}@example.test`;
        const id = await seedProfile(client, companyId, stored, email);

        const found = await lookup(client, "51234567");

        expect(found.map((row) => row.id)).toContain(id);
      });
    },
  );

  test("refuses to guess when two people share a number", async () => {
    /*
     * `profiles.phone` has no unique constraint and a household can share a
     * line. The caller treats anything other than exactly one row as no match.
     *
     * This is the case that matters most: if the lookup returned the first of
     * two rows, a correct password for that account would sign the person into
     * a portal that may not be theirs. Returning both is what lets the caller
     * refuse.
     */
    await withRollback(async (client) => {
      const companyId = await seedPhoneCompany(client);
      const shared = "+965 9999 8888";
      await seedProfile(client, companyId, shared, `${randomUUID()}@example.test`);
      await seedProfile(client, companyId, shared, `${randomUUID()}@example.test`);

      expect(await lookup(client, "99998888")).toHaveLength(2);
    });
  });

  test("finds a portal user by the mobile on their tenant record", async () => {
    /*
     * The case the whole feature turns on, and the one that nearly shipped
     * broken. `profiles.phone` is empty for every account on production — 0 of
     * 5 — because tenant mobile numbers are captured on the tenant record, not
     * the profile. A lookup against profiles alone matched nobody while looking
     * entirely correct.
     */
    await withRollback(async (client) => {
      const companyId = await seedPhoneCompany(client);
      const email = `${randomUUID()}@example.test`;
      const id = await seedProfile(client, companyId, null, email);
      const { rows: tenant } = await client.query(
        `insert into public.tenants (company_id, name, mobile)
         values ($1, 'مستأجر اختبار', '+965 9999 0731')
         returning id`,
        [companyId],
      );
      await client.query(`update public.profiles set tenant_id = $1 where id = $2`, [
        tenant[0].id,
        id,
      ]);

      expect((await lookup(client, "99990731")).map((row) => row.id)).toContain(id);
    });
  });

  test("does not match a profile with no phone recorded", async () => {
    await withRollback(async (client) => {
      const companyId = await seedPhoneCompany(client);
      const id = await seedProfile(client, companyId, null, `${randomUUID()}@example.test`);

      expect((await lookup(client, "51234567")).map((row) => row.id)).not.toContain(id);
    });
  });

  test("a short stored number cannot match on a partial suffix", async () => {
    // A profile holding '4567' must not be found by someone typing 51234567.
    await withRollback(async (client) => {
      const companyId = await seedPhoneCompany(client);
      const id = await seedProfile(client, companyId, "4567", `${randomUUID()}@example.test`);

      expect((await lookup(client, "51234567")).map((row) => row.id)).not.toContain(id);
    });
  });
});
