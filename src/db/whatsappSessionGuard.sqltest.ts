import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedCompanyUser,
  setCompanyClaimContext,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * Migrations 252–253: WhatsApp QR session episode tracking, atomic alert
 * claiming, staff-wide health RPC, column-grant boundaries, and workflow/template
 * seeding.
 */

/** ينشئ شركة اختبار معزولة ويضبط سياق الشركة للاتصال الحالي. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة حارس واتساب ${tag}`, `WSG Co ${tag}`],
  );
  await setCompanyClaimContext(client, rows[0].id);
  return rows[0].id;
}

/** ينشئ مستخدماً في Auth بدور محدّد ضمن الشركة المحددة لاختبار صلاحيات is_staff والأدوار. */
async function seedUserWithRole(
  client: PoolClient,
  companyId: string,
  role: string,
): Promise<string> {
  return seedCompanyUser(client, companyId, role, "wsg");
}

/** يزرع صف جلسة Evolution الوحيد بالحالة والأعمدة المطلوبة ضمن الشركة المحددة. */
async function seedConnection(
  client: PoolClient,
  companyId: string,
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
       id, company_id, instance_name, webhook_secret, connected_number,
       last_connection_state, connected_at, disconnect_alert_armed, disconnected_at
     ) values (1, $1, 'danat', 'secret-key', $2, $3, $4, $5, $6)`,
    [
      companyId,
      overrides.connectedNumber ?? null,
      overrides.state ?? null,
      overrides.connectedAt ?? null,
      overrides.armed ?? false,
      overrides.disconnectedAt ?? null,
    ],
  );
}

/**
 * يزرع اتصال QR النشط للشركة في `whatsapp_connections` بالحالة المطلوبة.
 *
 * The health RPC reads this table since migration 335; the legacy singleton
 * above stays for the migration 253 trigger and seed cases only.
 */
async function seedQrConnection(
  client: PoolClient,
  companyId: string,
  overrides: {
    status?: "disconnected" | "pairing" | "connected" | "error";
    connectedNumber?: string | null;
    connectedAt?: string | null;
    disconnectedAt?: string | null;
  } = {},
) {
  await client.query(`delete from public.whatsapp_connections where company_id = $1`, [companyId]);
  await client.query(
    `insert into public.whatsapp_connections (
       company_id, method, is_active, status, instance_name,
       connected_number, connected_at, disconnected_at
     ) values ($1, 'evolution_qr', true, $2, $3, $4, $5, $6)`,
    [
      companyId,
      overrides.status ?? "disconnected",
      `ijary-${companyId}`,
      overrides.connectedNumber ?? null,
      overrides.connectedAt ?? null,
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
      const companyId = await seedCompany(client);
      await seedConnection(client, companyId, {
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
      const companyId = await seedCompany(client);
      await seedConnection(client, companyId, { state: "open", armed: true });
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
      const companyId = await seedCompany(client);
      await seedConnection(client, companyId, { state: "open", armed: true });
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
      const companyId = await seedCompany(client);
      await seedConnection(client, companyId, { state: "open", armed: true });
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
      const companyId = await seedCompany(client);
      await seedConnection(client, companyId, { state: "open", armed: true });
      const admin = await seedUserWithRole(client, companyId, "admin");
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

describe("whatsapp_session_health RPC (migration 335)", () => {
  test("32: admin and accountant get full object; tenant gets null; anon gets permission denied", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      await seedQrConnection(client, companyId, {
        status: "disconnected",
        connectedNumber: "96550000000",
        disconnectedAt: "2026-11-11T07:10:00Z",
      });
      await client.query(
        `insert into public.provider_configs (company_id, provider, is_enabled)
         values ($1, 'evolution_api', true)
         on conflict (company_id, provider) do update set is_enabled = true`,
        [companyId],
      );

      const admin = await seedUserWithRole(client, companyId, "admin");
      const accountant = await seedUserWithRole(client, companyId, "accountant");
      const tenantUser = await seedUserWithRole(client, companyId, "tenant");

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
      const companyId = await seedCompany(client);
      const admin = await seedUserWithRole(client, companyId, "admin");

      await client.query(`delete from public.whatsapp_connections where company_id = $1`, [
        companyId,
      ]);
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.paired).toBe(false);

      await actAsSuperuser(client);
      await seedQrConnection(client, companyId, {
        status: "pairing",
        connectedNumber: null,
        connectedAt: null,
      });
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.paired).toBe(false);

      await actAsSuperuser(client);
      await seedQrConnection(client, companyId, {
        status: "disconnected",
        connectedNumber: "96550000000",
        connectedAt: null,
      });
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.paired).toBe(true);

      await actAsSuperuser(client);
      await seedQrConnection(client, companyId, {
        status: "disconnected",
        connectedNumber: null,
        connectedAt: "2026-11-11T07:00:00Z",
      });
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.paired).toBe(true);
    });
  });

  test("34: settling is true only for connecting within 60s of disconnected_at", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const admin = await seedUserWithRole(client, companyId, "admin");

      await seedQrConnection(client, companyId, { status: "pairing" });
      await client.query(
        `update public.whatsapp_connections
            set disconnected_at = now() - interval '10 seconds'
          where company_id = $1`,
        [companyId],
      );
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.settling).toBe(true);

      await actAsSuperuser(client);
      await client.query(
        `update public.whatsapp_connections
            set disconnected_at = now() - interval '2 minutes'
          where company_id = $1`,
        [companyId],
      );
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.settling).toBe(false);

      await actAsSuperuser(client);
      await client.query(
        `update public.whatsapp_connections
            set status = 'disconnected',
                disconnected_at = now() - interval '10 seconds'
          where company_id = $1`,
        [companyId],
      );
      await actAs(client, "authenticated", admin);
      expect((await readHealth(client))?.settling).toBe(false);
    });
  });

  test("35: enabled follows provider_configs and parked_count counts only failed/needs_review for the two codes", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const admin = await seedUserWithRole(client, companyId, "admin");
      await seedQrConnection(client, companyId, {
        status: "disconnected",
        connectedNumber: "96550000000",
      });
      await client.query(
        `insert into public.provider_configs (company_id, provider, is_enabled)
         values ($1, 'evolution_api', false)
         on conflict (company_id, provider) do update set is_enabled = false`,
        [companyId],
      );

      // Clear any pre-existing mock/seed notifications in rollback txn for deterministic count.
      await client.query(
        `delete from public.notifications
          where company_id = $1 and error_code in ('session_disconnected', 'instance_missing')`,
        [companyId],
      );
      await client.query(
        `insert into public.notifications (company_id, type, channel, locale, body, state, error_code) values
           ($1, 'receipt', 'whatsapp', 'en', 'a', 'failed', 'session_disconnected'),
           ($1, 'receipt', 'whatsapp', 'en', 'b', 'needs_review', 'session_disconnected'),
           ($1, 'receipt', 'whatsapp', 'en', 'c', 'needs_review', 'instance_missing'),
           ($1, 'receipt', 'whatsapp', 'en', 'd', 'sent', 'session_disconnected'),
           ($1, 'receipt', 'whatsapp', 'en', 'e', 'cancelled', 'instance_missing'),
           ($1, 'receipt', 'whatsapp', 'en', 'f', 'needs_review', 'number_not_on_whatsapp')`,
        [companyId],
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
        company_id: string;
        kind: string;
        is_active: boolean;
        recipient_targets: string[];
      }>(
        `select company_id, kind, is_active, recipient_targets
           from public.cron_jobs
          where key = 'whatsapp-session-disconnected'`,
      );
      expect(jobRes.rows).toHaveLength(1);
      const seededCompanyId = jobRes.rows[0].company_id;
      expect({
        kind: jobRes.rows[0].kind,
        is_active: jobRes.rows[0].is_active,
        recipient_targets: jobRes.rows[0].recipient_targets,
      }).toEqual({ kind: "event", is_active: true, recipient_targets: ["admin", "company"] });

      const tplRes = await client.query<{
        type: string;
        channel: string;
        is_active: boolean;
        body_ar: string | null;
        body_en: string | null;
      }>(
        `select type::text, channel::text, is_active, body_ar, body_en
           from public.notification_templates
          where company_id = $1 and code = 'whatsapp-session-disconnected'`,
        [seededCompanyId],
      );
      expect(tplRes.rows).toHaveLength(1);
      expect(tplRes.rows[0].type).toBe("whatsapp_session_alert");
      expect(tplRes.rows[0].channel).toBe("email");
      expect(tplRes.rows[0].is_active).toBe(true);
      expect(tplRes.rows[0].body_ar).toBeTruthy();
      expect(tplRes.rows[0].body_en).toBeTruthy();

      await setCompanyClaimContext(client, seededCompanyId);
      await seedConnection(client, seededCompanyId, {
        state: "open",
        connectedNumber: "96550000000",
        connectedAt: "2026-09-01T13:20:29Z",
        armed: false,
      });
      await client.query(
        `update public.cron_jobs set is_active = false
          where company_id = $1 and key = 'whatsapp-session-disconnected'`,
        [seededCompanyId],
      );
      await client.query(
        `update public.notification_templates
            set body_ar = '<p>admin custom edit</p>'
          where company_id = $1 and code = 'whatsapp-session-disconnected'`,
        [seededCompanyId],
      );

      // تكييف صيغ ON CONFLICT مع الفهارس المركّبة الجديدة `(company_id, key)` و`(company_id, code)`.
      const migration253Sql = readFileSync(
        resolve(process.cwd(), "db/migrations/253_whatsapp_session_guard.sql"),
        "utf8",
      )
        .replace("on conflict (key) do update", "on conflict (company_id, key) do update")
        .replace("on conflict (code) do nothing", "on conflict (company_id, code) do nothing");
      await client.query(migration253Sql);

      const afterJob = await client.query<{ is_active: boolean }>(
        `select is_active from public.cron_jobs
          where company_id = $1 and key = 'whatsapp-session-disconnected'`,
        [seededCompanyId],
      );
      expect(afterJob.rows[0].is_active).toBe(false);

      const afterTpl = await client.query<{ body_ar: string }>(
        `select body_ar from public.notification_templates
          where company_id = $1 and code = 'whatsapp-session-disconnected'`,
        [seededCompanyId],
      );
      expect(afterTpl.rows[0].body_ar).toBe("<p>admin custom edit</p>");

      const afterConn = await client.query<{ disconnect_alert_armed: boolean }>(
        `select disconnect_alert_armed from public.evolution_connections where id = 1`,
      );
      expect(afterConn.rows[0].disconnect_alert_armed).toBe(false);
    });
  });
});
