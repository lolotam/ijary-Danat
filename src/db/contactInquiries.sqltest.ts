import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { actAs, actAsSuperuser, closePool, seedCompanyUser, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 64 — visitor messages gain the unread state the header bell needs.
 *
 * The bell consolidates unread across every inbox source, but contact inquiries
 * had no status column, so a landing-form submission notified nobody while a
 * leasing lead — a different table, with a status column — notified normally.
 */

/** ينشئ شركة اختبار جديدة ويعيد معرّفها. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة اختبار ${tag}`, `Test Co ${tag}`],
  );
  return rows[0].id;
}

/** ينشئ رسالة زائر جديدة ضمن الشركة ويعيد معرّفها. */
async function seedInquiry(client: PoolClient, companyId: string): Promise<string> {
  const { rows } = await client.query(
    `insert into public.contact_inquiries (company_id, name, email, message)
     values ($1, 'Visitor', $2, 'Testing the contact form') returning id, status`,
    [companyId, `${randomUUID()}@example.test`],
  );
  // The default is what makes a new submission light up the bell.
  expect(rows[0].status).toBe("new");
  return rows[0].id;
}

describe("visitor messages carry unread state", () => {
  test("a collector can mark one read", async () => {
    /*
     * Asserted on the stored value rather than on the absence of an error.
     * Before this migration the table had no UPDATE policy and no UPDATE grant
     * for `authenticated`, and RLS refuses by matching zero rows instead of
     * raising — so a mark-read button would have reported success and changed
     * nothing, and the bell's count would only ever climb.
     *
     * Collector rather than admin deliberately: it is the least-privileged
     * staff role, and the one an admin-only policy would exclude.
     */
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const inquiry = await seedInquiry(client, companyId);
      const collector = await seedCompanyUser(client, companyId, "collector", "inq-collector");

      await actAs(client, "authenticated", collector);
      await client.query(`update public.contact_inquiries set status = 'read' where id = $1`, [
        inquiry,
      ]);

      await actAsSuperuser(client);
      const { rows } = await client.query(
        `select status from public.contact_inquiries where id = $1`,
        [inquiry],
      );
      expect(rows[0].status).toBe("read");
    });
  });

  test("an unknown status is refused rather than stored", async () => {
    // The bell filters on exactly 'new'. A typo'd status elsewhere in the app
    // would silently drop the row out of the unread count instead of failing.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const inquiry = await seedInquiry(client, companyId);
      await expect(
        client.query(`update public.contact_inquiries set status = 'unread' where id = $1`, [
          inquiry,
        ]),
      ).rejects.toThrow(/contact_inquiries_status_check/);
    });
  });
});
