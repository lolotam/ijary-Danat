import type { JobKind } from "@/jobs/catalog";
import type { JobHandler } from "@/worker/runJob";

import { createInvoicesGenerateHandler, createInvoicesRegenerateHandler } from "./bulkInvoices";
import { createElectricityGenerateHandler } from "./bulkElectricity";
import { createNotificationBulkHandler } from "./bulkNotification";

/**
 * نتيجة حجز مهمة ضخمة: العمل غادر الطلب ولم يُنفَّذ بعد.
 *
 * `jobRequestId` is the `job_requests` row the worker will pick up. The caller
 * shows it as "queued", never as "done": the rows are still to be processed
 * and the outcome arrives as the requester's notice with the counts the
 * handler returned.
 */
export interface QueuedBulkJob {
  queued: true;
  jobRequestId: string;
}

/**
 * يبني معالجات أنواع المهام الضخمة: كل نوع يعالِج صفوفه على دفعات من 200.
 *
 * Two kinds of the bulk queue live elsewhere, deliberately:
 *
 * - `salaries.generate` stays the cron handler in `cron.ts` (T076 registered
 *   it there): its work is one `generate_salaries_for_month` call for the
 *   whole company — the SQL has no per-employee entry point to chunk over —
 *   and it records its run in the workflow registry the admin panel reads.
 *   A second registration here would shadow that one silently; the registry
 *   now refuses duplicates outright.
 * - `import.run` has no handler yet: its payload can only carry an upload id
 *   (contracts/jobs.md section 1 keeps file contents out of the queue), and
 *   there is no staging table to hold the parsed rows for the worker. Until
 *   one exists, `bulkImport` keeps importing synchronously (the task brief's
 *   own instruction: do not invent a staging table).
 */
export function createBulkHandlers(): Partial<Record<JobKind, JobHandler>> {
  return {
    "notification.bulk": createNotificationBulkHandler(),
    "invoices.generate": createInvoicesGenerateHandler(),
    "invoices.regenerate": createInvoicesRegenerateHandler(),
    "electricity.generate": createElectricityGenerateHandler(),
  };
}
