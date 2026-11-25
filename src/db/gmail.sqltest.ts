import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { actAs, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * gmail_messages: the uniqueness contract and the RLS the inbox depends on.
 *
 * These assertions cannot be made against a mock. The de-dup bug in particular
 * was invisible to unit tests because it lived in the *interaction* between a
 * nullable column and a unique constraint: Postgres treats null as never equal
 * to null, so `unique (company_id, message_id)` silently permitted unlimited
 * duplicates of any message that lacked a Message-ID header.
 */

async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة ${tag}`, `Co ${tag}`],
  );
  return rows[0].id;
}

/** Creates an auth user holding `role`, so is_staff/has_role resolve for it. */
async function seedUserWithRole(client: PoolClient, role: string): Promise<string> {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, `${userId}@example.test`],
  );
  await client.query(
    `insert into public.user_roles (user_id, role) values ($1, $2::public.app_role)`,
    [userId, role],
  );
  return userId;
}

async function insertMessage(
  client: PoolClient,
  companyId: string,
  messageId: string,
  overrides: { isRead?: boolean; receivedAt?: string } = {},
) {
  return client.query(
    `insert into public.gmail_messages
       (company_id, message_id, from_address, received_at, is_read)
     values ($1, $2, 'sender@example.test', $3::timestamptz, $4)
     returning id`,
    [
      companyId,
      messageId,
      overrides.receivedAt ?? "2026-07-01T09:00:00Z",
      overrides.isRead ?? false,
    ],
  );
}

describe("gmail_messages uniqueness", () => {
  test("message_id is NOT NULL", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      await expect(insertMessage(client, companyId, null as unknown as string)).rejects.toThrow(
        /not-null|null value/i,
      );
    });
  });

  test("the same message twice in one company is rejected", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      await insertMessage(client, companyId, "<abc@mail.example>");
      await expect(insertMessage(client, companyId, "<abc@mail.example>")).rejects.toThrow(
        /duplicate key|unique/i,
      );
    });
  });

  test("the worker's synthetic key de-duplicates a header-less message", async () => {
    // resolveMessageKey() produces this shape when a message carries no
    // Message-ID header. Before message_id was NOT NULL these rows all had
    // null here and re-inserted on every cron tick.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      await insertMessage(client, companyId, "gmail:18f0abc");
      await expect(insertMessage(client, companyId, "gmail:18f0abc")).rejects.toThrow(
        /duplicate key|unique/i,
      );
    });
  });

  test("the same message id in a different company is allowed", async () => {
    await withRollback(async (client) => {
      const companyA = await seedCompany(client);
      const companyB = await seedCompany(client);
      await insertMessage(client, companyA, "<shared@mail.example>");
      const second = await insertMessage(client, companyB, "<shared@mail.example>");
      expect(second.rows).toHaveLength(1);
    });
  });
});

describe("gmail_messages RLS", () => {
  test("staff can read and mark messages read", async () => {
    // The inbox renders for any staff member, so an admin-only UPDATE policy
    // would make the mark-read button fail silently for accountants.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const { rows } = await insertMessage(client, companyId, "<staff@mail.example>");
      const messageId = rows[0].id;
      const accountant = await seedUserWithRole(client, "accountant");

      await actAs(client, "authenticated", accountant);

      const read = await client.query(`select id from public.gmail_messages where id = $1`, [
        messageId,
      ]);
      expect(read.rows).toHaveLength(1);

      const updated = await client.query(
        `update public.gmail_messages set is_read = true where id = $1 returning is_read`,
        [messageId],
      );
      expect(updated.rows).toHaveLength(1);
      expect(updated.rows[0].is_read).toBe(true);
    });
  });

  test("a signed-in non-staff user sees nothing", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      await insertMessage(client, companyId, "<private@mail.example>");

      await actAs(client, "authenticated", randomUUID());

      const { rows } = await client.query(`select id from public.gmail_messages`);
      expect(rows).toHaveLength(0);
    });
  });

  test("anon sees nothing", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      await insertMessage(client, companyId, "<anon@mail.example>");

      await actAs(client, "anon");

      const { rows } = await client.query(`select id from public.gmail_messages`);
      expect(rows).toHaveLength(0);
    });
  });

  test("deletion stays admin-only", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const { rows } = await insertMessage(client, companyId, "<delete@mail.example>");
      const messageId = rows[0].id;
      const collector = await seedUserWithRole(client, "collector");

      await actAs(client, "authenticated", collector);
      const asCollector = await client.query(
        `delete from public.gmail_messages where id = $1 returning id`,
        [messageId],
      );
      expect(asCollector.rows).toHaveLength(0);
    });
  });

  test("an admin can delete gmail messages", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const { rows } = await insertMessage(client, companyId, "<admin-delete@mail.example>");
      const messageId = rows[0].id;
      const admin = await seedUserWithRole(client, "admin");

      await actAs(client, "authenticated", admin);
      const deleted = await client.query(
        `delete from public.gmail_messages where id = $1 returning id`,
        [messageId],
      );
      expect(deleted.rows).toHaveLength(1);
    });
  });
});

describe("gmail_connections", () => {
  async function seedConnection(client: PoolClient, companyId: string, connectedBy: string) {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.gmail_connections
         (company_id, email_address, refresh_token, connected_by)
       values ($1, 'inbox@example.test', 'super-secret-refresh-token', $2)
       returning id`,
      [companyId, connectedBy],
    );
    return rows[0].id;
  }

  test("an admin can read the status but NOT the refresh token", async () => {
    // The whole security model of this table is one column grant. A policy
    // alone would expose every column to any admin, and the token grants
    // read access to a real mailbox — it must never leave the server.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const admin = await seedUserWithRole(client, "admin");
      await seedConnection(client, companyId, admin);

      await actAs(client, "authenticated", admin);

      const status = await client.query(
        `select email_address, connected_at, last_sync_error from public.gmail_connections`,
      );
      expect(status.rows).toHaveLength(1);
      expect(status.rows[0].email_address).toBe("inbox@example.test");

      await expect(
        client.query(`select refresh_token from public.gmail_connections`),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  test("select * fails rather than leaking, because the grant omits the token", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const admin = await seedUserWithRole(client, "admin");
      await seedConnection(client, companyId, admin);

      await actAs(client, "authenticated", admin);
      await expect(client.query(`select * from public.gmail_connections`)).rejects.toThrow(
        /permission denied/i,
      );
    });
  });

  test("a non-admin staff member sees no connection at all", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const admin = await seedUserWithRole(client, "admin");
      await seedConnection(client, companyId, admin);
      const accountant = await seedUserWithRole(client, "accountant");

      await actAs(client, "authenticated", accountant);
      const { rows } = await client.query(`select email_address from public.gmail_connections`);
      expect(rows).toHaveLength(0);
    });
  });

  test("only one mailbox can be connected per company", async () => {
    // company_id is unique so reconnecting replaces the grant in place rather
    // than leaving a second, stale refresh token behind.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const admin = await seedUserWithRole(client, "admin");
      await seedConnection(client, companyId, admin);
      await expect(seedConnection(client, companyId, admin)).rejects.toThrow(
        /duplicate key|unique/i,
      );
    });
  });
});

/**
 * gmail_id: the column the sync job diffs against, and the one row shape it
 * must NOT treat as already held.
 *
 * Only a real database can answer this — the value is a generated column's
 * expression, so every assertion below is about what Postgres computes, not
 * about anything TypeScript does.
 */
describe("gmail_messages.gmail_id", () => {
  /** يدخل صفاً بحمولة raw_payload معيّنة ويعيد gmail_id المحسوب. */
  async function insertWithPayload(
    client: PoolClient,
    companyId: string,
    messageId: string,
    rawPayload: unknown,
  ): Promise<string | null> {
    const { rows } = await client.query<{ gmail_id: string | null }>(
      `insert into public.gmail_messages
         (company_id, message_id, from_address, received_at, is_read, raw_payload)
       values ($1, $2, 'sender@example.test', '2026-07-01T09:00:00Z', false, $3::jsonb)
       returning gmail_id`,
      [companyId, messageId, JSON.stringify(rawPayload)],
    );
    return rows[0].gmail_id;
  }

  test("projects Gmail's own id from a full format=full payload", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const gmailId = await insertWithPayload(client, companyId, "<abc@mail.example>", {
        id: "18f0abc",
        payload: { headers: [], body: {} },
      });

      // Deliberately different from message_id, which holds the RFC 822 header.
      expect(gmailId).toBe("18f0abc");
    });
  });

  /**
   * `recordLocalSentMessage` writes this shape the moment a message leaves the
   * app: the Gmail id, a snippet, and no MIME tree. Three readers need that
   * tree — the message sheet, the attachment fetch, and the reply threading
   * headers — so the sync must still fetch the real payload. It can only do
   * that if the diff never matches this row, which means gmail_id must be NULL
   * despite `id` being present.
   */
  test("leaves a thin sent placeholder NULL so the sync still fetches its payload", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const gmailId = await insertWithPayload(client, companyId, "18f0sent", {
        id: "18f0sent",
        threadId: "t1",
        snippet: "sent from the app",
        source: "gmailSend",
      });

      expect(gmailId).toBeNull();
    });
  });

  test("is NULL for a row that carries no payload at all", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      expect(await insertWithPayload(client, companyId, "<no@mail.example>", {})).toBeNull();
    });
  });

  /** Generated columns are read-only; naming one in an INSERT is an error. */
  test("cannot be written by hand", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      await expect(
        client.query(
          `insert into public.gmail_messages
             (company_id, message_id, from_address, received_at, is_read, gmail_id)
           values ($1, $2, 'sender@example.test', '2026-07-01T09:00:00Z', false, 'forged')`,
          [companyId, "<forge@mail.example>"],
        ),
        // SQLSTATE rather than message text: Postgres 17 words this as
        // "cannot insert a non-DEFAULT value", with "generated" only in DETAIL.
      ).rejects.toMatchObject({ code: "428C9" });
    });
  });
});
