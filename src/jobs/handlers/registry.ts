import type { JobKind } from "@/jobs/catalog";
import type { JobHandler } from "@/worker/runJob";

import { createBulkHandlers } from "./bulk";
import { createCronHandlers } from "./cron";
import { createDocumentHandlers } from "./documents";
import { eventHandlers } from "./events";
import {
  createNotificationDispatchHandler,
  type NotificationDispatchDependencies,
} from "./notification";
import { createInboundHandlers } from "./inbound";
import { createSyncHandlers } from "./sync";

/** خريطة معالجات جزئية: بعض الأنواع مسجَّلة وبعضها مقصود غيابه. */
export type HandlerMap = Partial<Record<JobKind, JobHandler>>;

/**
 * يبني كل خرائط المعالجات: الإرسال، والمستندات، والدورية، والضخمة، والمزامنة،
 * والأحداث المالية.
 *
 * Split out from the registry so a test can see the maps before they merge
 * and prove no kind is claimed twice — a silent spread would let one map
 * shadow another's handler and nothing would say so.
 */
export function handlerMaps(deps: NotificationDispatchDependencies): HandlerMap[] {
  return [
    { "notification.dispatch": createNotificationDispatchHandler(deps) },
    createDocumentHandlers(),
    createCronHandlers(),
    createBulkHandlers(),
    createSyncHandlers(),
    createInboundHandlers(),
    eventHandlers,
  ];
}

/**
 * يدمج خرائط المعالجات في سجل واحد ويرفض أي نوع مسجَّل مرتين.
 *
 * Two handlers for one kind is a wiring defect, not a preference: whichever
 * map lost the spread would run never, and the kind's real behaviour would be
 * whatever the winner happens to do. Failing here fails at startup rather
 * than at 01:30 on a Saturday.
 */
export function mergeHandlerMaps(maps: HandlerMap[]): HandlerMap {
  const merged: HandlerMap = {};
  for (const map of maps) {
    for (const [kind, handler] of Object.entries(map)) {
      if (!handler) continue;
      if (merged[kind as JobKind]) {
        throw new Error(`duplicate handler registered for job kind: ${kind}`);
      }
      merged[kind as JobKind] = handler;
    }
  }
  return merged;
}

/**
 * يبني دالة تختار معالج كل نوع مهمة من سجلّ واحد.
 *
 * `runJob` asks for the handler of the kind on the row, so a kind with no
 * handler here is a permanent failure rather than a silent no-op. Later kinds
 * are added to the maps of `handlerMaps` and nowhere else.
 *
 * The registry's dependencies are the notification handler's: the notify
 * worker's per-connection WhatsApp pacing lock. The document and bulk
 * handlers do not send through a provider — they render or fan out and leave
 * the delivery to the notify worker — so they need no pacing of their own.
 *
 * The cron handlers run the scheduled work of one company at a time; they
 * hold the same registry switch the admin panel shows.
 */
export function createHandlerRegistry(
  deps: NotificationDispatchDependencies,
): (kind: JobKind) => JobHandler | undefined {
  const handlers = mergeHandlerMaps(handlerMaps(deps));
  return (kind: JobKind) => handlers[kind];
}
