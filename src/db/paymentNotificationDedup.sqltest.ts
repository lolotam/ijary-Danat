import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { captureRaiseError, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * يدرج إشعار دفع بقيمته الفريدة وحالته وقناته.
 *
 * The columns are the ones the sender fills (see `enqueueNotification`): the
 * type and the channel name the delivery, `delivery_key` is what migration
 * 251's unique index is built on, and `state` decides whether the row is
 * inside that index at all — every state that can still be dispatched is
 * (`queued`, `sent`, `failed`, `needs_review`, `skipped`), while only
 * `cancelled` stays outside it.
 */
async function insertPaymentNotification(
  client: PoolClient,
  options: {
    type: "payment_admin_alert" | "receipt";
    channel: "email" | "whatsapp";
    audience: "admin" | "tenant";
    state: "queued" | "sent" | "failed" | "needs_review" | "cancelled" | "skipped";
    deliveryKey: string | null;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.notifications
       (type, channel, audience, state, delivery_key, payload, recipient_address)
     values ($1::public.notification_types, $2::public.notification_channels,
             $3::public.notification_audience, $4::public.notification_states,
             $5, '{"payment_ids":["p1"]}'::jsonb, 'dedup@example.test')
     returning id`,
    [options.type, options.channel, options.audience, options.state, options.deliveryKey],
  );
  return rows[0].id;
}

/** يقرأ رمز خطأ SQLSTATE من الخطأ المرفوض، أو null إن لم يُرفض الإدراج. */
function sqlState(error: unknown): string | null {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === "string" ? code : null;
}

describe("migration 251 - one payment notification per payment set per channel", () => {
  test("the unique index on the payment delivery keys exists", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'public' and indexname = 'notifications_payment_delivery_idx'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toContain("UNIQUE");
      expect(rows[0].indexdef).toContain("payment_admin_alert");
      expect(rows[0].indexdef).toContain("receipt");
      // Every state that can still be dispatched is inside the index, so there
      // is one row per delivery key across all of them.
      expect(rows[0].indexdef).toContain("failed");
      expect(rows[0].indexdef).toContain("needs_review");
      // A paused tenant's row can still be dispatched after unpausing, so it
      // is inside too. Only `cancelled` — withdrawn on purpose — is outside.
      expect(rows[0].indexdef).toContain("skipped");
      expect(rows[0].indexdef).not.toContain("cancelled");
    });
  });

  test("a second queued admin alert with the same delivery key is refused", async () => {
    // The webhook and the return page both settle the same payment; the second
    // one must not be able to queue a second "payment received" email.
    await withRollback(async (client) => {
      await insertPaymentNotification(client, {
        type: "payment_admin_alert",
        channel: "email",
        audience: "admin",
        state: "sent",
        deliveryKey: "payment_admin_alert:email:p1",
      });

      const error = await captureRaiseError(client, () =>
        insertPaymentNotification(client, {
          type: "payment_admin_alert",
          channel: "email",
          audience: "admin",
          state: "queued",
          deliveryKey: "payment_admin_alert:email:p1",
        }),
      );

      expect(sqlState(error)).toBe("23505");
    });
  });

  test("a failed admin alert blocks a second row with the same delivery key", async () => {
    // `failed` is inside the index on purpose: the drain job retries that very
    // row, so a second row with the same key would sit next to it and the
    // retry's update to `sent` would collide with it on every drain.
    await withRollback(async (client) => {
      await insertPaymentNotification(client, {
        type: "payment_admin_alert",
        channel: "email",
        audience: "admin",
        state: "failed",
        deliveryKey: "payment_admin_alert:email:p1",
      });

      const error = await captureRaiseError(client, () =>
        insertPaymentNotification(client, {
          type: "payment_admin_alert",
          channel: "email",
          audience: "admin",
          state: "queued",
          deliveryKey: "payment_admin_alert:email:p1",
        }),
      );

      expect(sqlState(error)).toBe("23505");
    });
  });

  test("a cancelled admin alert does not block a second row with the same key", async () => {
    // A cancelled delivery was withdrawn on purpose, so it must not stand in
    // the way of a real delivery carrying the same key.
    await withRollback(async (client) => {
      await insertPaymentNotification(client, {
        type: "payment_admin_alert",
        channel: "email",
        audience: "admin",
        state: "sent",
        deliveryKey: "payment_admin_alert:email:p1",
      });

      const id = await insertPaymentNotification(client, {
        type: "payment_admin_alert",
        channel: "email",
        audience: "admin",
        state: "cancelled",
        deliveryKey: "payment_admin_alert:email:p1",
      });

      expect(id).toBeTruthy();
    });
  });

  test("a skipped tenant receipt blocks a second skipped row with the same key", async () => {
    // صف `skipped` لمستأجر موقوف ما زال قابلاً للشحن بعد رفع الإيقاف، فهو
    // داخل الفهرس: لولا ذلك لأنشأ تسويقان متسابقان صفين بنفس المفتاح،
    // وتصادم تحديث الأول إلى `sent` مع الثاني يُبقيه `skipped` فيُعاد
    // الإرسال مرتين.
    //
    // A paused tenant's receipt row is still dispatchable once the tenant is
    // unpaused, so `skipped` must sit inside the index: two racing
    // settlements would otherwise leave two `skipped` rows with the same
    // key, and the first row's update to `sent` would collide with the
    // second — it would stay `skipped` and the receipt would go out twice.
    await withRollback(async (client) => {
      await insertPaymentNotification(client, {
        type: "receipt",
        channel: "email",
        audience: "tenant",
        state: "skipped",
        deliveryKey: "receipt:email:p1",
      });

      const error = await captureRaiseError(client, () =>
        insertPaymentNotification(client, {
          type: "receipt",
          channel: "email",
          audience: "tenant",
          state: "skipped",
          deliveryKey: "receipt:email:p1",
        }),
      );

      expect(sqlState(error)).toBe("23505");
    });
  });

  test("the tenant receipt is deduped the same way", async () => {
    await withRollback(async (client) => {
      await insertPaymentNotification(client, {
        type: "receipt",
        channel: "email",
        audience: "tenant",
        state: "sent",
        deliveryKey: "receipt:email:p1",
      });

      const error = await captureRaiseError(client, () =>
        insertPaymentNotification(client, {
          type: "receipt",
          channel: "email",
          audience: "tenant",
          state: "queued",
          deliveryKey: "receipt:email:p1",
        }),
      );

      expect(sqlState(error)).toBe("23505");
    });
  });

  test("a failed tenant receipt blocks a second row with the same delivery key", async () => {
    // The same rule as the admin alert: the retry reuses the failed row, so a
    // second row with the same key must be refused.
    await withRollback(async (client) => {
      await insertPaymentNotification(client, {
        type: "receipt",
        channel: "whatsapp",
        audience: "tenant",
        state: "failed",
        deliveryKey: "receipt:whatsapp:p1",
      });

      const error = await captureRaiseError(client, () =>
        insertPaymentNotification(client, {
          type: "receipt",
          channel: "whatsapp",
          audience: "tenant",
          state: "queued",
          deliveryKey: "receipt:whatsapp:p1",
        }),
      );

      expect(sqlState(error)).toBe("23505");
    });
  });

  test("two notifications without a delivery key are both allowed", async () => {
    // A null key is outside the index — that is what keeps every row written
    // before migration 251 (and every row that carries no key at all) out of
    // it.
    await withRollback(async (client) => {
      const first = await insertPaymentNotification(client, {
        type: "payment_admin_alert",
        channel: "email",
        audience: "admin",
        state: "sent",
        deliveryKey: null,
      });
      const second = await insertPaymentNotification(client, {
        type: "payment_admin_alert",
        channel: "email",
        audience: "admin",
        state: "sent",
        deliveryKey: null,
      });

      expect(first).not.toBe(second);
    });
  });
});
