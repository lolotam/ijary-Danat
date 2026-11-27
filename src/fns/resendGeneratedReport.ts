import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { enqueueJob } from "@/jobs/enqueue";
import type { QueuedDocumentJob } from "@/jobs/handlers/documents";

const schema = z.object({ reportId: z.string().uuid() });

/**
 * يعيد إرسال تقرير مولَّد إلى مستلمي جدوله الزمني.
 *
 * The request no longer resends anything: it validates, checks the permission,
 * reads the report, and hands one `report.run` job to the worker
 * (contracts/jobs.md section 1). The stored report is sent again there.
 *
 * The job carries the schedule and the report's period end, which is how the
 * worker tells a resend from a fresh run: a stored report for that schedule
 * and date is the one the admin asked to send again.
 *
 * No dedupe key: an admin may resend the same report on purpose.
 */
export const resendGeneratedReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "reports.read",
      attempted: "report.resend",
      refusal: "You do not have permission to read reports.",
    });

    const company = requireRequestCompany();
    const db = companyClient(company.id);

    const reportResult = await db
      .from("generated_reports")
      .select("id, schedule_id, period_end")
      .eq("id", data.reportId)
      .single();
    if (reportResult.error || !reportResult.data) {
      throw new Error(reportResult.error?.message ?? "The generated report was not found.");
    }
    if (!reportResult.data.schedule_id) {
      throw new Error("The generated report has no schedule or HTML artifact.");
    }
    // A report stored before the period columns existed has no period end; the
    // job then runs the schedule for today instead of resending that report.
    const date = reportResult.data.period_end ?? new Date().toISOString().slice(0, 10);

    const { jobId } = await enqueueJob(db, "report.run", {
      scheduleId: reportResult.data.schedule_id,
      date,
    });

    return { queued: true, jobRequestIds: [jobId] } satisfies QueuedDocumentJob;
  });

export type ResendGeneratedReportInput = z.infer<typeof schema>;
