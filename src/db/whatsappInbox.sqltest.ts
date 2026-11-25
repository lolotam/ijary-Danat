import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { actAs, captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migrations 177–180: the Evolution provider enum + trigger, the
 * evolution_connections secret grants, the WhatsApp inbox tables, and the
 * ingest_whatsapp_messages RPC.
 *
 * These assertions cannot be made against a mock. The two that matter most:
 * the column grant that keeps webhook_secret/last_qr server-only (same class
 * of leak the gmail_connections REVOKE fixed), and the idempotent unread
 * arithmetic inside the RPC — a webhook replay incrementing unread_count
 * twice is invisible to unit tests that fake the database.
 */

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

async function seedConnection(client: PoolClient) {
  await client.query(
    `insert into public.evolution_connections (id, instance_name, webhook_secret, connected_number)
     values (1, 'danat', 'super-secret-webhook-key', '96550000000')
     on conflict (id) do update set webhook_secret = excluded.webhook_secret`,
  );
}

function ingestRow(overrides: Record<string, unknown> = {}) {
  return {
    message_id: `wamid-${randomUUID().slice(0, 8)}`,
    chat_number: "96550123456",
    direction: "inbound",
    from_me: false,
    body: "السلام عليكم",
    message_type: "text",
    media_type: null,
    media_id: null,
    media_filename: null,
    sent_at: "2026-09-01T10:00:00Z",
    push_name: "أحمد",
    raw: null,
    ...overrides,
  };
}

async function ingest(client: PoolClient, rows: Record<string, unknown>[]) {
  const { rows: result } = await client.query<{ inserted: number }>(
    `select public.ingest_whatsapp_messages($1::jsonb) as inserted`,
    [JSON.stringify(rows)],
  );
  return result[0].inserted;
}

describe("evolution_connections secrets", () => {
  test("an admin can read the status but NOT the webhook secret or the QR", async () => {
    // The webhook secret authenticates the public endpoint and the QR is a
    // pairing credential; both must never be readable through PostgREST.
    await withRollback(async (client) => {
      await seedConnection(client);
      const admin = await seedUserWithRole(client, "admin");

      await actAs(client, "authenticated", admin);

      const status = await client.query(
        `select instance_name, connected_number, last_connection_state
           from public.evolution_connections`,
      );
      expect(status.rows).toHaveLength(1);
      expect(status.rows[0].instance_name).toBe("danat");

      // Each forbidden read sits in its own savepoint: Postgres aborts the
      // whole transaction on the first "permission denied", and a bare
      // rejects.toThrow would leave the second and third reads failing with
      // "current transaction is aborted" instead of the grant error.
      expect(
        await captureRaise(client, () =>
          client.query(`select webhook_secret from public.evolution_connections`),
        ),
      ).toMatch(/permission denied/i);
      expect(
        await captureRaise(client, () =>
          client.query(`select last_qr from public.evolution_connections`),
        ),
      ).toMatch(/permission denied/i);
      expect(
        await captureRaise(client, () =>
          client.query(`select * from public.evolution_connections`),
        ),
      ).toMatch(/permission denied/i);
    });
  });

  test("a non-admin staff member sees no connection row at all", async () => {
    await withRollback(async (client) => {
      await seedConnection(client);
      const accountant = await seedUserWithRole(client, "accountant");

      await actAs(client, "authenticated", accountant);
      const { rows } = await client.query(`select instance_name from public.evolution_connections`);
      expect(rows).toHaveLength(0);
    });
  });

  test("the table is a singleton: a second row is rejected", async () => {
    await withRollback(async (client) => {
      await seedConnection(client);
      await expect(
        client.query(
          `insert into public.evolution_connections (id, webhook_secret) values (2, 'x')`,
        ),
      ).rejects.toThrow(/check constraint/i);
    });
  });
});

describe("whatsapp inbox RLS", () => {
  test("an admin reads chats and messages; clients cannot write them", async () => {
    await withRollback(async (client) => {
      await ingest(client, [ingestRow({ message_id: "wamid-rls-1" })]);
      const admin = await seedUserWithRole(client, "admin");

      await actAs(client, "authenticated", admin);

      const chats = await client.query(`select chat_number from public.whatsapp_chats`);
      expect(chats.rows).toHaveLength(1);
      const messages = await client.query(`select message_id from public.whatsapp_messages`);
      expect(messages.rows).toHaveLength(1);

      // Writes are server-only: every mutation goes through server fns with
      // the service role, so table-level INSERT is not granted at all.
      await expect(
        client.query(
          `insert into public.whatsapp_messages (message_id, chat_number, direction)
           values ('forged', '96550123456', 'inbound')`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  test("a signed-in non-staff user sees nothing", async () => {
    await withRollback(async (client) => {
      await ingest(client, [ingestRow({ message_id: "wamid-rls-2" })]);

      await actAs(client, "authenticated", randomUUID());

      const chats = await client.query(`select chat_number from public.whatsapp_chats`);
      expect(chats.rows).toHaveLength(0);
      const contacts = await client.query(`select phone from public.whatsapp_contacts`);
      expect(contacts.rows).toHaveLength(0);
    });
  });

  test("the ingest RPC is not executable by clients", async () => {
    await withRollback(async (client) => {
      await actAs(client, "authenticated", randomUUID());
      await expect(ingest(client, [ingestRow()])).rejects.toThrow(/permission denied/i);
    });
  });
});

describe("ingest_whatsapp_messages", () => {
  test("a webhook replay of the same message does not bump unread twice", async () => {
    await withRollback(async (client) => {
      const row = ingestRow({ message_id: "wamid-replay" });
      expect(await ingest(client, [row])).toBe(1);
      expect(await ingest(client, [row])).toBe(0);

      const { rows } = await client.query(
        `select unread_count from public.whatsapp_chats where chat_number = '96550123456'`,
      );
      expect(rows[0].unread_count).toBe(1);
    });
  });

  test("history rows (count_unread=false) advance the chat without lighting the badge", async () => {
    // Migration 181 — a backfilled year of old chats must not show as unread.
    await withRollback(async (client) => {
      await ingest(client, [
        ingestRow({ message_id: "hist-1", body: "قديمة", count_unread: false }),
      ]);
      const { rows } = await client.query(
        `select unread_count, last_message_preview from public.whatsapp_chats
          where chat_number = '96550123456'`,
      );
      expect(rows[0].unread_count).toBe(0);
      expect(rows[0].last_message_preview).toBe("قديمة");
    });
  });

  test("outbound (fromMe) rows never increment unread", async () => {
    await withRollback(async (client) => {
      await ingest(client, [
        ingestRow({ message_id: "out-1", direction: "outbound", from_me: true, push_name: null }),
      ]);
      const { rows } = await client.query(
        `select unread_count from public.whatsapp_chats where chat_number = '96550123456'`,
      );
      expect(rows[0].unread_count).toBe(0);
    });
  });

  test("a delayed older message cannot regress the chat preview", async () => {
    await withRollback(async (client) => {
      await ingest(client, [
        ingestRow({ message_id: "new-1", body: "الأحدث", sent_at: "2026-09-01T12:00:00Z" }),
      ]);
      await ingest(client, [
        ingestRow({ message_id: "old-1", body: "الأقدم", sent_at: "2026-09-01T08:00:00Z" }),
      ]);

      const { rows } = await client.query(
        `select last_message_preview, unread_count from public.whatsapp_chats
          where chat_number = '96550123456'`,
      );
      expect(rows[0].last_message_preview).toBe("الأحدث");
      // Both messages are real and unread — only the preview is ordered.
      expect(rows[0].unread_count).toBe(2);
    });
  });

  test("contact auto-capture fills an empty name but never overwrites an admin's", async () => {
    await withRollback(async (client) => {
      await client.query(
        `insert into public.whatsapp_contacts (phone, name) values ('96550123456', 'اسم يدوي')`,
      );
      await ingest(client, [ingestRow({ message_id: "cap-1", push_name: "اسم تلقائي" })]);

      const { rows } = await client.query(
        `select name from public.whatsapp_contacts where phone = '96550123456'`,
      );
      expect(rows[0].name).toBe("اسم يدوي");
    });
  });

  test("a media-only message gets a bracketed preview", async () => {
    await withRollback(async (client) => {
      await ingest(client, [
        ingestRow({
          message_id: "doc-1",
          body: null,
          message_type: "document",
          media_type: "document",
          media_filename: "contract.pdf",
        }),
      ]);
      const { rows } = await client.query(
        `select last_message_preview from public.whatsapp_chats where chat_number = '96550123456'`,
      );
      expect(rows[0].last_message_preview).toBe("[document]");
    });
  });
});

describe("provider mutual exclusivity with evolution_api", () => {
  test("enabling evolution_api auto-disables the other WhatsApp providers", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.provider_configs set is_enabled = true where provider = 'whatsapp_cloud_api'`,
      );
      await client.query(
        `update public.provider_configs set is_enabled = true where provider = 'evolution_api'`,
      );

      const { rows } = await client.query(
        `select provider::text as provider, is_enabled from public.provider_configs
          where provider::text in ('whatsapp_cloud_api', 'twilio', 'postora', 'evolution_api')
          order by provider`,
      );
      const enabled = rows.filter((row) => row.is_enabled).map((row) => row.provider);
      expect(enabled).toEqual(["evolution_api"]);
    });
  });

  test("enabling the Cloud API back auto-disables evolution_api", async () => {
    await withRollback(async (client) => {
      await client.query(
        `update public.provider_configs set is_enabled = true where provider = 'evolution_api'`,
      );
      await client.query(
        `update public.provider_configs set is_enabled = true where provider = 'whatsapp_cloud_api'`,
      );

      const { rows } = await client.query(
        `select is_enabled from public.provider_configs where provider = 'evolution_api'`,
      );
      expect(rows[0].is_enabled).toBe(false);
    });
  });

  test("the evolution_api seed row exists, disabled, with env-name-only config", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `select is_enabled, config from public.provider_configs where provider = 'evolution_api'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].is_enabled).toBe(false);
      expect(rows[0].config.api_key_env).toBe("EVOLUTION_API_KEY");
      // No instance_name in config: evolution_connections is the single source
      // of truth for it (the two must never disagree).
      expect(rows[0].config.instance_name).toBeUndefined();
    });
  });
});
