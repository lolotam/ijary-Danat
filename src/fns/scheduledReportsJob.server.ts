import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { runReportScheduleRecord } from "@/jobs/handlers/documentsReport";

/**
 * يشغّل جميع جداول التقارير المستحقة ضمن نطاق الشركة الحالية.
 *
 * Server-only: it reaches the report builder, which renders PDFs with
 * Chromium through `node:*` modules. The browser-imported
 * `scheduledReportsJob.ts` calls it only from inside its server function
 * handler, so the bundler drops this module from the client.
 */
export async function runScheduledReportsJob(asOf: string | null = null, companyId?: string) {
  const resolvedCompanyId = companyId ?? requireRequestCompany().id;
  const db = companyClient(resolvedCompanyId);
  const now = new Date().toISOString();
  const schedules = await db
    .from("report_schedules")
    .select("*")
    .eq("is_active", true)
    .or(`next_run_at.is.null,next_run_at.lte.${now}`)
    .order("created_at");
  if (schedules.error) throw new Error(schedules.error.message);
  const results = [];
  for (const schedule of schedules.data) {
    try {
      const report = await runReportScheduleRecord(schedule.id, asOf, resolvedCompanyId);
      results.push({ scheduleId: schedule.id, status: "completed" as const, report });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scheduled report failed.";
      const auditWrite = await db.rpc("write_audit", {
        p_action: "report_schedule.run",
        p_entity_type: "report_schedule",
        p_entity_id: schedule.id,
        p_before: null,
        p_after: { error: message },
        p_result: "failure",
        p_error_code: "REPORT_GENERATION_FAILED",
      });
      if (auditWrite.error) throw new Error(auditWrite.error.message, { cause: error });
      results.push({ scheduleId: schedule.id, status: "failed" as const, error: message });
    }
  }
  return { count: results.length, results };
}
