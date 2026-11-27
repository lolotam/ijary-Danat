import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";

import { closePool, setCompanyClaimContext, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 335: the outage-episode rule on `whatsapp_connections`.
 *
 * Every writer — the webhook, the live-probe heal before a send, a disconnect —
 * must follow it, so it lives in a trigger; a heal that skipped re-arming
 * would leave the next outage without its alert email.
 */
describe("whatsapp_connections outage episode trigger (migration 335)", () => {
  test("entering connected re-arms and clears disconnected_at; leaving it stamps the time once", async () => {
    await withRollback(async (client) => {
      const tag = randomUUID().slice(0, 8);
      const company = await client.query<{ id: string }>(
        `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
        [`شركة حلقة الانقطاع ${tag}`, `Episode Co ${tag}`],
      );
      const companyId = company.rows[0].id;
      await setCompanyClaimContext(client, companyId);
      const inserted = await client.query<{ id: string }>(
        `insert into public.whatsapp_connections (
           company_id, method, is_active, status, disconnect_alert_armed, disconnected_at
         ) values ($1, 'evolution_qr', true, 'pairing', false, '2026-11-01T00:00:00Z')
         returning id`,
        [companyId],
      );
      const connectionId = inserted.rows[0].id;

      /** يقرأ عمودي حلقة الانقطاع للاتصال المزروع. */
      const readEpisode = async () =>
        (
          await client.query<{ disconnect_alert_armed: boolean; disconnected_at: Date | null }>(
            `select disconnect_alert_armed, disconnected_at
               from public.whatsapp_connections where id = $1`,
            [connectionId],
          )
        ).rows[0];

      await client.query(
        `update public.whatsapp_connections set status = 'connected' where id = $1`,
        [connectionId],
      );
      expect(await readEpisode()).toEqual({ disconnect_alert_armed: true, disconnected_at: null });

      // The alert claim disarms while connected; a later status write must not re-arm it.
      await client.query(
        `update public.whatsapp_connections set disconnect_alert_armed = false where id = $1`,
        [connectionId],
      );
      await client.query(
        `update public.whatsapp_connections set status = 'disconnected' where id = $1`,
        [connectionId],
      );
      const closed = await readEpisode();
      expect(closed.disconnect_alert_armed).toBe(false);
      expect(closed.disconnected_at).toBeInstanceOf(Date);

      await client.query(`update public.whatsapp_connections set status = 'error' where id = $1`, [
        connectionId,
      ]);
      expect((await readEpisode()).disconnected_at).toEqual(closed.disconnected_at);
    });
  });
});
