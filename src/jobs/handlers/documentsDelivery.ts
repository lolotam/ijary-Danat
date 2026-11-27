import type { SupabaseClient } from "@supabase/supabase-js";

import { pickExistingDelivery } from "@/fns/enqueueNotification";
import type {
  Database,
  NotificationChannel,
  NotificationState,
  Tables,
} from "@/integrations/supabase/database.types";
import { notificationDispatchDedupeKey } from "@/jobs/catalog";
import { enqueueJob } from "@/jobs/enqueue";

/**
 * حالات صف الإشعار التي تمثّل تسليماً قيد النظر أو تمّ: صفوف التسليم الحيّة.
 *
 * These are exactly the states the unique delivery indexes put inside
 * themselves (migrations 251 and 312): one row per delivery key across all of
 * them is the point. `cancelled` stays outside — a withdrawn row must never
 * block a real delivery — and so a retry after a cancellation writes a fresh
 * row.
 */
const LIVE_DELIVERY_STATES: readonly NotificationState[] = [
  "queued",
  "sent",
  "failed",
  "needs_review",
  "skipped",
];

/**
 * يبني مفتاح تسليم مستند: معرّف المهمة ثم القناة.
 *
 * `delivery_key = <jobRequestId>:<channel>` is what makes a BullMQ retry of one
 * job collide with the row the earlier attempt wrote, while a deliberate
 * resend — a NEW job with a new id — sails past it and sends. No recipient is
 * appended: every document job writes at most one row per channel (a report
 * run carries its many recipients inside its single row), so the channel alone
 * already names the delivery.
 */
export function documentDeliveryKey(jobRequestId: string, channel: NotificationChannel): string {
  return `${jobRequestId}:${channel}`;
}

/**
 * يقرأ صفوف التسليم الحيّة لمفتاح تسليم واحد، الأحدث أولاً.
 *
 * The read is the FAST PATH, not the guarantee: migration 312's unique index
 * on `notifications(delivery_key)` is what decides a collision, and this
 * lookup exists so a retry of one job reuses the row the earlier attempt wrote
 * before doing any work — no second report generation, PDF render or insert.
 * The race the index closes is exactly the window between this read and the
 * insert.
 */
export async function findDocumentDeliveries(
  db: SupabaseClient<Database>,
  deliveryKey: string,
): Promise<Tables<"notifications">[]> {
  const result = await db
    .from("notifications")
    .select("*")
    .eq("delivery_key", deliveryKey)
    .in("state", [...LIVE_DELIVERY_STATES])
    .order("created_at", { ascending: false });
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

/**
 * يقرأ صف التسليم القائم الذي يجب أن تعود إليه إضافة اصطدمت بمفتاحها الفريد.
 *
 * The 23505 fallback shared by the direct-insert paths, mirroring what
 * `enqueueNotification` does when the unique delivery index refuses its
 * insert: the delivery already exists, so the caller returns this row and
 * sends nothing. Returns null when no live row is left — the colliding row was
 * cancelled between the insert and this read — and the caller then throws the
 * original insert error.
 */
export async function findExistingDocumentDelivery(
  db: SupabaseClient<Database>,
  deliveryKey: string,
): Promise<Tables<"notifications"> | null> {
  const rows = await findDocumentDeliveries(db, deliveryKey);
  return pickExistingDelivery(rows) ?? null;
}

/**
 * يعيد صف التسليم القائم لمفتاح تسليم إن وُجد، ويضمن تصريف صفه المعلّق فوراً.
 *
 * The one reuse path for the enqueue-pipeline document handlers (invoice and
 * company-info): the pick is `pickExistingDelivery`'s policy, the same one the
 * report handler reuses by, and a reused `queued` row gets its
 * `notification.dispatch` job re-claimed here (GR-003). An earlier attempt can
 * die between writing the row and enqueueing its dispatch — the enqueue call
 * that `enqueueNotification` and `queueCompanyInfoDelivery` make after the
 * insert — and without this claim the row waits for the daily drain. The
 * claim uses the same dedupe key the insert path uses, so a repeat is
 * collapsed by `enqueue_job` onto the job that already exists (GR-003).
 *
 * Report rows deliberately get none of this: they are dispatched inline by
 * their own handler, and a `notification.dispatch` job for one would send it
 * twice.
 */
export async function reuseExistingDocumentDelivery(
  db: SupabaseClient<Database>,
  deliveryKey: string,
): Promise<Tables<"notifications"> | null> {
  const existing = await findExistingDocumentDelivery(db, deliveryKey);
  if (!existing) return null;
  if (existing.state === "queued") {
    await enqueueJob(
      db,
      "notification.dispatch",
      { notificationId: existing.id },
      { dedupeKey: notificationDispatchDedupeKey(existing.id) },
    );
  }
  return existing;
}
