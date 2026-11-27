import type { JobKind } from "@/jobs/catalog";
import type { JobHandler } from "@/worker/runJob";

import { createCronHandlers } from "./cron";
import { createDocumentHandlers } from "./documents";
import {
  createNotificationDispatchHandler,
  type NotificationDispatchDependencies,
} from "./notification";

/**
 * يبني دالة تختار معالج كل نوع مهمة من سجلّ واحد.
 *
 * `runJob` asks for the handler of the kind on the row, so a kind with no
 * handler here is a permanent failure rather than a silent no-op. Later kinds
 * are added to this map and nowhere else.
 *
 * The registry's dependencies are the notification handler's: the notify
 * worker's per-connection WhatsApp pacing lock. The document handlers do not
 * send through a provider — they render a document and leave the delivery to
 * the notify worker — so they need no pacing of their own.
 *
 * The cron handlers run the scheduled work of one company at a time; they hold
 * the same registry switch the admin panel shows.
 */
export function createHandlerRegistry(
  deps: NotificationDispatchDependencies,
): (kind: JobKind) => JobHandler | undefined {
  const handlers: Partial<Record<JobKind, JobHandler>> = {
    "notification.dispatch": createNotificationDispatchHandler(deps),
    ...createDocumentHandlers(),
    ...createCronHandlers(),
  };
  return (kind: JobKind) => handlers[kind];
}
