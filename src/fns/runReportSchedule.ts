import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { enqueueJob } from "@/jobs/enqueue";
import type { QueuedDocumentJob } from "@/jobs/handlers/documents";

export { runReportScheduleRecord } from "@/jobs/handlers/documentsReport";

const schema = z.object({
  asOf: z.string().date().nullable().optional(),
  scheduleId: z.string().uuid(),
});

/**
 * مفتاح منع تكرار تشغيل جدول زمني في يوم واحد.
 *
 * The same schedule on the same day is one job: the daily fan-out and a
 * manual "run now" must not produce two reports for the same day.
 */
function reportRunDedupeKey(scheduleId: string, date: string): string {
  return `report.run:${scheduleId}:${date}`;
}

/**
 * يشغّل جدولاً زمنياً لتقرير ضمن نطاق الشركة الحالية.
 *
 * The request no longer builds the report: it validates, checks the
 * permission, and hands one `report.run` job to the worker (contracts/jobs.md
 * section 1). The snapshot, the PDF and the mail all happen there.
 *
 * The job carries the schedule and the day it runs for, so the same schedule
 * on the same day is one job — the daily fan-out and a manual run cannot
 * produce two reports for one day.
 */
export type RunReportScheduleInput = z.infer<typeof schema>;

export const runReportSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "reports.read",
      attempted: "report_schedule.run",
      refusal: "You do not have permission to read reports.",
    });

    const company = requireRequestCompany();
    const db = companyClient(company.id);
    // The catalogue's `report.run` payload carries the day the report runs
    // for, and that day is half of its dedupe key.
    const date = data.asOf ?? new Date().toISOString().slice(0, 10);

    const { jobId } = await enqueueJob(
      db,
      "report.run",
      { scheduleId: data.scheduleId, date },
      { dedupeKey: reportRunDedupeKey(data.scheduleId, date) },
    );

    return { queued: true, jobRequestIds: [jobId] } satisfies QueuedDocumentJob;
  });
