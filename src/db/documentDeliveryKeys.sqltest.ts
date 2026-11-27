import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { captureRaiseError, closePool, setCompanyClaimContext, withRollback } from "@/db/testDb";

afterAll(closePool);

/** ينشئ شركة اختبار معزولة ويضبط سياق الشركة للاتصال الحالي. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة مستندات ${tag}`, `Docs Co ${tag}`],
  );
  await setCompanyClaimContext(client, rows[0].id);
  return rows[0].id;
}

/** أنواع الإشعارات التي تكتبها معالجو المستندات — نوع كل عائلة. */
type DocumentNotificationType = "document_send" | "company_info" | "scheduled_report";

/** نوعا عائلتين أخريين يحملان شكل المفتاح نفسه خارج مجموعة الفهرس. */
type OtherFamilyType = "receipt" | "manual_message";

/**
 * يدرج صف إشعار مستند بقيمته الفريدة وحالته وقناته.
 *
 * The columns are the ones the document handlers fill: the type names the
 * document family, `delivery_key` is what migration 312's unique index is
 * built on, and `state` decides whether the row is inside that index at all —
 * every state that can still be dispatched is (`queued`, `sent`, `failed`,
 * `needs_review`, `skipped`), while only `cancelled` stays outside it.
 */
async function insertDocumentNotification(
  client: PoolClient,
  options: {
    companyId: string;
    type: DocumentNotificationType | OtherFamilyType;
    state: "queued" | "sent" | "failed" | "needs_review" | "cancelled" | "skipped";
    deliveryKey: string | null;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.notifications
       (company_id, type, channel, audience, state, delivery_key, payload, recipient_address)
     values ($1, $2::public.notification_types, 'email'::public.notification_channels,
             'admin'::public.notification_audience, $3::public.notification_states,
             $4, '{"generated_report_id":"r1"}'::jsonb, 'docs@example.test')
     returning id`,
    [options.companyId, options.type, options.state, options.deliveryKey],
  );
  return rows[0].id;
}

/** يقرأ رمز خطأ SQLSTATE من الخطأ المرفوض، أو null إن لم يُرفض الإدراج. */
function sqlState(error: unknown): string | null {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === "string" ? code : null;
}

describe("migration 312 - one document delivery row per job and channel", () => {
  test("the unique index on the document delivery keys exists", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'public' and indexname = 'notifications_document_delivery_idx'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toContain("UNIQUE");
      // The shape the migration promises: unique per company on
      // `delivery_key`, as migration 273 rebuilt the other delivery indexes,
      // with the three types as the partial-index filter.
      expect(rows[0].indexdef).toContain("(company_id, delivery_key)");
      // Exactly the three types the document handlers write — a fourth type
      // here would let the index refuse rows it has no business refusing.
      expect(rows[0].indexdef).toContain("document_send");
      expect(rows[0].indexdef).toContain("company_info");
      expect(rows[0].indexdef).toContain("scheduled_report");
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

  // The three rows the document handlers write: `document_send` (invoice),
  // `company_info` (company information) and `scheduled_report` (scheduled
  // report). A fourth type in the set would let the index refuse rows it has
  // no business refusing.
  test.each<DocumentNotificationType>(["document_send", "company_info", "scheduled_report"])(
    "a second %s row with the same delivery key is refused",
    async (type) => {
      // Two workers on the same job (BullMQ stalled-job takeover) both pass
      // the application read and both insert; the second insert must collide
      // in the database instead of reaching the renter twice.
      await withRollback(async (client) => {
        const companyId = await seedCompany(client);
        await insertDocumentNotification(client, {
          companyId,
          type,
          state: "sent",
          deliveryKey: "33333333-3333-4333-8333-333333333333:email",
        });

        const error = await captureRaiseError(client, () =>
          insertDocumentNotification(client, {
            companyId,
            type,
            state: "queued",
            deliveryKey: "33333333-3333-4333-8333-333333333333:email",
          }),
        );

        expect(sqlState(error)).toBe("23505");
      });
    },
  );

  // `failed` is inside the index on purpose: the retry re-queues that very
  // row, so a second row with the same key would sit next to it and the drain
  // job's update of the failed row to `sent` would collide with it.
  // `needs_review` is parked for a human but still dispatchable once re-queued,
  // and `skipped` — a paused tenant's row — is dispatchable after unpausing,
  // so both are inside the index like the payment index (migration 251).
  test.each<["failed" | "needs_review" | "skipped"]>([["failed"], ["needs_review"], ["skipped"]])(
    "a %s row blocks a second row with the same delivery key",
    async (state) => {
      await withRollback(async (client) => {
        const companyId = await seedCompany(client);
        await insertDocumentNotification(client, {
          companyId,
          type: "document_send",
          state,
          deliveryKey: "33333333-3333-4333-8333-333333333333:email",
        });

        const error = await captureRaiseError(client, () =>
          insertDocumentNotification(client, {
            companyId,
            type: "document_send",
            state: "queued",
            deliveryKey: "33333333-3333-4333-8333-333333333333:email",
          }),
        );

        expect(sqlState(error)).toBe("23505");
      });
    },
  );

  test("a cancelled row does not block a second row with the same key", async () => {
    // A cancelled delivery was withdrawn on purpose, so it must not stand in
    // the way of a real delivery carrying the same key.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      await insertDocumentNotification(client, {
        companyId,
        type: "scheduled_report",
        state: "cancelled",
        deliveryKey: "33333333-3333-4333-8333-333333333333:email",
      });

      const id = await insertDocumentNotification(client, {
        companyId,
        type: "scheduled_report",
        state: "queued",
        deliveryKey: "33333333-3333-4333-8333-333333333333:email",
      });

      expect(id).toBeTruthy();
    });
  });

  test.each<OtherFamilyType>(["receipt", "manual_message"])(
    "a %s row from another notification family with the same key is unaffected",
    async (otherType) => {
      // البند `type in (...)` هو ما يُخرج بقية العائلات من الفهرس: إيصال
      // الدفع أو رسالة جماعية تحمل شكل المفتاح نفسه ليست من شأن هذه الهجرة،
      // فتُكتب بحرية.
      //
      // The partial-index `type` clause is what keeps other families out: a
      // payment receipt or bulk message carrying the same key shape is not
      // this migration's business.
      await withRollback(async (client) => {
        const companyId = await seedCompany(client);
        await insertDocumentNotification(client, {
          companyId,
          type: "document_send",
          state: "sent",
          deliveryKey: "33333333-3333-4333-8333-333333333333:email",
        });

        const id = await insertDocumentNotification(client, {
          companyId,
          type: otherType,
          state: "queued",
          deliveryKey: "33333333-3333-4333-8333-333333333333:email",
        });

        expect(id).toBeTruthy();
      });
    },
  );

  test("two document rows without a delivery key are both allowed", async () => {
    // A null key is outside the index — that is what keeps every row written
    // before this migration (and every row that carries no key at all, like
    // the legacy scheduled-reports job's rows) out of it.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const first = await insertDocumentNotification(client, {
        companyId,
        type: "scheduled_report",
        state: "sent",
        deliveryKey: null,
      });
      const second = await insertDocumentNotification(client, {
        companyId,
        type: "scheduled_report",
        state: "sent",
        deliveryKey: null,
      });

      expect(first).not.toBe(second);
    });
  });
});
