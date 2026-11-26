import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";

import { actAs, actAsSuperuser, closePool, seedCompanyUser, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 62 — app-local categories on synced Gmail messages.
 */

describe("gmail categories", () => {
  test("the starter vocabulary actually seeded", async () => {
    /*
     * `_seed_option_items` opens with `select id into _list_id ... if _list_id
     * is null then return; end if` — it exits quietly when the list is missing.
     * So a typo in the `option_lists` insert above it would leave the catalogue
     * empty with no error anywhere, and the category dropdown would render as a
     * blank list on a screen nobody thinks to check. This is the assertion that
     * makes that failure loud.
     */
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `select i.value
           from public.option_list_items i
           join public.option_lists l on l.id = i.list_id
          where l.code = 'gmail_categories'
          order by i.sort_order`,
      );
      expect(rows.map((row) => row.value)).toEqual([
        "inquiry",
        "complaint",
        "maintenance",
        "payment",
        "contract",
        "supplier",
        "spam",
        "other",
      ]);
    });
  });

  test("a collector can categorise a message without a new column grant", async () => {
    /*
     * `useSetGmailCategory` claims the existing staff UPDATE policy from
     * migration 50 already covers this because it carries no column list. If
     * that were wrong the update would not raise — RLS refuses by matching zero
     * rows — so the button would appear to work and change nothing. Asserting
     * on the stored value is the only way to tell those apart.
     *
     * Collector rather than admin on purpose: it is the least-privileged staff
     * role, so it is the one a column-level grant would exclude first.
     */
    await withRollback(async (client) => {
      const company = await client.query(`select id from public.companies limit 1`);
      const { rows: message } = await client.query(
        `insert into public.gmail_messages
           (company_id, message_id, from_address, received_at)
         values ($1, $2, 'sender@example.test', now())
         returning id`,
        [company.rows[0].id, `<${randomUUID()}@example.test>`],
      );
      const collector = await seedCompanyUser(client, company.rows[0].id, "collector");

      await actAs(client, "authenticated", collector);
      await client.query(`update public.gmail_messages set category = 'complaint' where id = $1`, [
        message[0].id,
      ]);

      await actAsSuperuser(client);
      const { rows: after } = await client.query(
        `select category from public.gmail_messages where id = $1`,
        [message[0].id],
      );
      expect(after[0].category).toBe("complaint");
    });
  });
});
