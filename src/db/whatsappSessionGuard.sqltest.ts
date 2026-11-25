import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { actAs, actAsSuperuser, captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migrations 252–253: WhatsApp QR session episode tracking, atomic alert
 * claiming, staff-wide health RPC, column-grant boundaries, and workflow/template
 * seeding.
 */

/** ينشئ مستخدماً في Auth بدور محدّد لاختبار صلاحيات is_staff والأدوار. */
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

/** يزرع صف جلسة Evolution الوحيد بالحالة والأعمدة المطلوبة. */
async function seedConnection(
  client: PoolClient,
  overrides: {
    state?: string | null;
    connectedNumber?: string | null;
    connectedAt?: string | null;
    armed?: boolean;
    disconnectedAt?: string | null;
  } = {},
) {
  await client.query(`delete from public.evolution_connections where id = 1`);
  await client.query(
    `insert into public.evolution_connections (
       id, instance_name, webhook_secret, connected_number,
       last_connection_state, connected_at, disconnect_alert_armed, disconnected_at
     ) values (1, 'danat', 'secret-key', $1, $2, $3, $4, $5)`,
    [
      overrides.connectedNumber ?? null,
      overrides.state ?? null,
      overrides.connectedAt ?? null,
      overrides.armed ?? false,
      overrides.disconnectedAt ?? null,
    ],
  );
}

/** يقرأ دالة whatsapp_session_health() كـ jsonb. */
async function readHealth(client: PoolClient) {
  const { rows } = await client.query<{
    health: {
      enabled: boolean;
      paired: boolean;
      state: string | null;
      settling: boolean;
      disconnected_at: string | null;
      parked_count: number;
    } | null;
  }>(`select public.whatsapp_session_health() as health`);
  return rows[0].health;
}

describe("episode trigger and atomic alert claim (migration 253)", () => {
  test("27: transitioning to open arms and clears disconnected_at; leaving open stamps it without touching arming", async () => {
    await withRollback(async (client) => {
      await seedConnection(client, {
        state: "connecting",
        armed: false,
        disconnectedAt: "2026-11-01T00:00:00Z",
      });

      await client.query(
        `update public.evolution_connections set last_connection_state = 'open' where id = 1`,
      );
      const opened = await client.query<{
        disconnect_alert_armed: boolean;
        disconnected_at: string | null;
      }>(
        `select disconnect_alert_armed, disconnected_at from public.evolution_connections where id = 1`,
      );
      expect(opened.rows[0].disconnect_alert_armed).toBe(true);
      expect(opened.rows[0].disconnected_at).toBeNull();

      await client.query(
        `update public.evolution_connections set last_connection_state = 'close' where id = 1`,
      );
      const closed = await client.query<{
        disconnect_alert_armed: boolean;
        disconnected_at: string | null;
      }>(
        `select disconnect_alert_armed, disconnected_at from public.evolution_connections where id = 1`,
      );
      expect(closed.rows[0].disconnect_alert_armed).toBe(true);
      expect(closed.rows[0].disconnected_at).not.toBeNull();
    });
  });

  test("28: atomic claim succeeds once then returns zero rows; open state claims zero rows", async () => {
    await withRollback(async (client) => {
      await seedConnection(client, { state: "open", armed: true });
      const openClaim = await client.query(
        `update public.evolution_connections
            set disconnect_alert_armed = false
          where id = 1 and disconnect_alert_armed and last_connection_state <> 'open'
          returning instance_name`,
      );
      expect(openClaim.rows).toHaveLength(0);

      await client.query(
        `update public.evolution_connections set last_connection_state = 'close' where id = 1`,
      );

      const first = await client.query<{ instance_name: string }>(
        `update public.evolution_connections
            set disconnect_alert_armed = false
          where id = 1 and disconnect_alert_armed and last_connection_state <> 'open'
          returning instance_name`,
      );
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0].instance_name).toBe("danat");

      const second = await client.query(
        `update public.evolution_connections
            set disconnect_alert_armed = false
          where id = 1 and disconnect_alert_armed and last_connection_state <> 'open'
          returning instance_name`,
      );
      expect(second.rows).toHaveLength(0);
    });
  });

  test("29: re-pairing (open) after a claimed outage arms a fresh claim on the next close", async () => {
    await withRollback(async (client) => {
      await seedConnection(client, { state: "open", armed: true });
      await client.query(
        `update public.evolution_connections set last_connection_state = 'close' where id = 1`,
      );
      const firstClaim = await client.query(
        `update public.evolution_connections
            set disconnect_alert_armed = false
          where id = 1 and disconnect_alert_armed and last_connection_state <> 'open'
          returning id`,
      );
      expect(firstClaim.rows).toHaveLength(1);

      await client.query(
        `update public.evolution_connections set last_connection_state = 'open' where id = 1`,
      );
      await client.query(
        `update public.evolution_connections set last_connection_state = 'close' where id = 1`,
      );

      const secondClaim = await client.query(
        `update public.evolution_connections
            set disconnect_alert_armed = false
          where id = 1 and disconnect_alert_armed and last_connection_state <> 'open'
          returning id`,
      );
      expect(secondClaim.rows).toHaveLength(1);
    });
  });

  test("30: close -> connecting -> close after claiming does not re-arm", async () => {
    await withRollback(async (client) => {
      await seedConnection(client, { state: "open", armed: true });
      await client.query(
        `update public.evolution_connections set last_connection_state = 'close' where id = 1`,
      );
      await client.query(
        `update public.evolution_connections
            set disconnect_alert_armed = false
          where id = 1 and disconnect_alert_armed and last_connection_state <> 'open'`,
      );

      await client.query(
        `update public.evolution_connections set last_connection_state = 'connecting' where id = 1`,
      );
      await client.query(
        `update public.evolution_connections set last_connection_state = 'close' where id = 1`,
      );

      const row = await client.query<{ disconnect_alert_armed: boolean }>(
        `select disconnect_alert_armed from public.evolution_connections where id = 1`,
      );
      expect(row.rows[0].disconnect_alert_armed).toBe(false);
    });
  });

  test("31: authenticated users cannot read the two new episode columns", async () => {
    await withRollback(async (client) => {
      await seedConnection(client, { state: "open", armed: true });
      const admin = await seedUserWithRole(client, "admin");
      await actAs(client, "authenticated", admin);

      expect(
        await captureRaise(client, () =>
          client.query(`select disconnect_alert_armed from public.evolution_connections`),
        ),
      ).toMatch(/permission denied/i);
      expect(
        await captureRaise(client, () =>
          client.query(`select disconnected_at from public.evolution_connections`),
        ),
      ).toMatch(/permission denied/i);
    });
  });
});

describe("whatsapp_session_health RPC", () => {
  test("32: admin and accountant get full object; tenant gets null; anon gets permission denied", async () => {
    await withRollback(async (client) => {
      await seedConnection(client, {
        state: "close",
        connectedNumber: "96550000000",
        armed: false,
        disconnectedAt: "2026-11-11T07:10:00Z",
      });
      await client.query(
        `insert into public.provider_configs (provider, is_enabled)
         values ('evolution_api', true)
         on conflict (provider) do update set is_enabled = true`,
      );

      const admin = await seedUserWithRole(client, "admin");
      const accountant = await seedUserWithRole(client, "accountant");
      const tenantUser = await seedUserWithRole(client, "tenant");

      await actAs(client, "authenticated", admin);
      expect(await readHealth(client)).toMatchObject({
        enabled: true,
        paired: true,
        state: "close",
        settling: false,
      });

      await actAsSuperuser(client);
      await actAs(client, "authenticated", accountant);
      expect(await readHealth(client)).toMatchObject({
        enabled: true,
        paired: true,
        state: "close",
        settling: false,
      });

      await actAsSuperuser(client);
      await actAs(client, "authenticated", tenantUser);
      expect(await readHealth(client)).toBeNull();

      await actAsSuperuser(client);
      await actAs(client, "anon");
      expect(await captureRaise(client, () => readHealth(client))).toMatch(/permission denied/i);
    });
  });

  test("33: paired reflects connected_number or connected_at, never mere row existence", async () => {
    await withRollback(async (client) => {
      const admin = await seedUserWithRole(client, "admin");

      await client.query(`delete from public.evolution_connections where id = 1`);
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.paired).toBe(false);

      await actAsSuperuser(client);
      await seedConnection(client, {
        state: "connecting",
        connectedNumber: null,
        connectedAt: null,
      });
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.paired).toBe(false);

      await actAsSuperuser(client);
      await seedConnection(client, {
        state: "close",
        connectedNumber: "96550000000",
        connectedAt: null,
      });
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.paired).toBe(true);

      await actAsSuperuser(client);
      await seedConnection(client, {
        state: "close",
        connectedNumber: null,
        connectedAt: "2026-11-11T07:00:00Z",
      });
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.paired).toBe(true);
    });
  });

  test("34: settling is true only for connecting within 60s of disconnected_at", async () => {
    await withRollback(async (client) => {
      const admin = await seedUserWithRole(client, "admin");

      await seedConnection(client, { state: "connecting" });
      await client.query(
        `update public.evolution_connections
            set disconnected_at = now() - interval '10 seconds'
          where id = 1`,
      );
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.settling).toBe(true);

      await actAsSuperuser(client);
      await client.query(
        `update public.evolution_connections
            set disconnected_at = now() - interval '2 minutes'
          where id = 1`,
      );
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.settling).toBe(false);

      await actAsSuperuser(client);
      await client.query(
        `update public.evolution_connections
            set last_connection_state = 'close',
                disconnected_at = now() - interval '10 seconds'
          where id = 1`,
      );
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.settling).toBe(false);
    });
  });

  test("35: enabled follows provider_configs and parked_count counts only failed/needs_review for the two codes", async () => {
    await withRollback(async (client) => {
      const admin = await seedUserWithRole(client, "admin");
      await seedConnection(client, { state: "close", connectedNumber: "96550000000" });
      await client.query(
        `insert into public.provider_configs (provider, is_enabled)
         values ('evolution_api', false)
         on conflict (provider) do update set is_enabled = false`,
      );

      // Clear any pre-existing mock/seed notifications in rollback txn for deterministic count.
      await client.query(
        `delete from public.notifications where error_code in ('session_disconnected', 'instance_missing')`,
      );
      await client.query(
        `insert into public.notifications (type, channel, locale, body, state, error_code) values
           ('receipt', 'whatsapp', 'en', 'a', 'failed', 'session_disconnected'),
           ('receipt', 'whatsapp', 'en', 'b', 'needs_review', 'session_disconnected'),
           ('receipt', 'whatsapp', 'en', 'c', 'needs_review', 'instance_missing'),
           ('receipt', 'whatsapp', 'en', 'd', 'sent', 'session_disconnected'),
           ('receipt', 'whatsapp', 'en', 'e', 'cancelled', 'instance_missing'),
           ('receipt', 'whatsapp', 'en', 'f', 'needs_review', 'number_not_on_whatsapp')`,
      );

      await actAs(client, "authenticated", admin);
      const health = await readHealth(client);
      expect(health?.enabled).toBe(false);
      expect(health?.parked_count).toBe(3);
    });
  });
});

describe("enum, workflow, and template seed (migrations 252–253)", () => {
  test("36: enum value, event workflow, and active bilingual template exist; replay preserves is_active=false", async () => {
    await withRollback(async (client) => {
      const enumRes = await client.query<{ enumlabel: string }>(
        `select e.enumlabel
           from pg_enum e
           join pg_type t on t.oid = e.enumtypid
           join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public' and t.typname = 'notification_types'
            and e.enumlabel = 'whatsapp_session_alert'`,
      );
      expect(enumRes.rows).toHaveLength(1);

      const jobRes = await client.query<{
        kind: string;
        is_active: boolean;
        recipient_targets: string[];
      }>(
        `select kind, is_active, recipient_targets
           from public.cron_jobs
          where key = 'whatsapp-session-disconnected'`,
      );
      expect(jobRes.rows).toEqual([
        { kind: "event", is_active: true, recipient_targets: ["admin", "company"] },
      ]);

      const tplRes = await client.query<{
        type: string;
        channel: string;
        is_active: boolean;
        body_ar: string | null;
        body_en: string | null;
      }>(
        `select type::text, channel::text, is_active, body_ar, body_en
           from public.notification_templates
          where code = 'whatsapp-session-disconnected'`,
      );
      expect(tplRes.rows).toHaveLength(1);
      expect(tplRes.rows[0].type).toBe("whatsapp_session_alert");
      expect(tplRes.rows[0].channel).toBe("email");
      expect(tplRes.rows[0].is_active).toBe(true);
      expect(tplRes.rows[0].body_ar).toBeTruthy();
      expect(tplRes.rows[0].body_en).toBeTruthy();

      await seedConnection(client, {
        state: "open",
        connectedNumber: "96550000000",
        connectedAt: "2026-09-01T13:20:29Z",
        armed: false,
      });
      await client.query(
        `update public.cron_jobs set is_active = false where key = 'whatsapp-session-disconnected'`,
      );
      await client.query(
        `update public.notification_templates
            set body_ar = '<p>admin custom edit</p>'
          where code = 'whatsapp-session-disconnected'`,
      );

      const migration253Sql = readFileSync(
        resolve(process.cwd(), "db/migrations/253_whatsapp_session_guard.sql"),
        "utf8",
      );
      await client.query(migration253Sql);

      const afterJob = await client.query<{ is_active: boolean }>(
        `select is_active from public.cron_jobs where key = 'whatsapp-session-disconnected'`,
      );
      expect(afterJob.rows[0].is_active).toBe(false);

      const afterTpl = await client.query<{ body_ar: string }>(
        `select body_ar from public.notification_templates where code = 'whatsapp-session-disconnected'`,
      );
      expect(afterTpl.rows[0].body_ar).toBe("<p>admin custom edit</p>");

      const afterConn = await client.query<{ disconnect_alert_armed: boolean }>(
        `select disconnect_alert_armed from public.evolution_connections where id = 1`,
      );
      expect(afterConn.rows[0].disconnect_alert_armed).toBe(false);
    });
  });
});
