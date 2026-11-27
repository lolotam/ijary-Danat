import { runWithRequestCompany } from "@/company/requestCompany.server";
import { dispatchNotificationRecord } from "@/fns/dispatchNotification";
import type { JobPayload } from "@/jobs/catalog";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

/**
 * الاعتماديات التي يحتاجها معالج إشعار الإرسال: منظّم إيقاع اتصال واتساب.
 */
export interface NotificationDispatchDependencies {
  /**
   * ينتظر حتى تتحرّر خانة الإرسال على اتصال واتساب واحد.
   *
   * The connection key is the Evolution instance name — one instance per
   * company connection (FR-067, research.md R7) — so the gap is honoured per
   * company connection and not per worker process.
   */
  pace: (connectionKey: string) => Promise<void>;
}

/**
 * يبني معالج مهمة `notification.dispatch`: يرسل صف الإشعار ويكتب حالته النهائية.
 *
 * The worker already validated the payload against the catalogue schema, so
 * the notification id is read straight from it — re-parsing it here would
 * reject a payload the worker already accepted.
 *
 * The dispatch runs inside the job's own company context because the WhatsApp
 * channel reaches for the request company (the template mapping and the
 * Evolution instance) and a background job has no request. The same wrapping
 * the notification drain job uses.
 */
export function createNotificationDispatchHandler(
  deps: NotificationDispatchDependencies,
): JobHandler {
  return async (ctx: JobHandlerContext) => {
    const { notificationId } = ctx.payload as JobPayload<"notification.dispatch">;
    const row = await runWithRequestCompany(
      { id: ctx.companyId, slug: "", status: "active", host: "" },
      () =>
        dispatchNotificationRecord(notificationId, {
          companyId: ctx.companyId,
          pace: deps.pace,
        }),
    );
    return { notificationId: row.id, state: row.state };
  };
}
