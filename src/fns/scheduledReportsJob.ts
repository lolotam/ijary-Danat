import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { runReportScheduleRecord } from "@/fns/runReportSchedule";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requirePermission } from "@/fns/requirePermission";

const schema = z.object({ asOf: z.string().date().nullable().optional() });

export async function runScheduledReportsJob(asOf: string | null = null) {
  const now = new Date().toISOString();
  const schedules = await supabaseAdmin
    .from("report_schedules")
    .select("*")
    .eq("is_active", true)
    .or(`next_run_at.is.null,next_run_at.lte.${now}`)
    .order("created_at");
  if (schedules.error) throw new Error(schedules.error.message);
  const results = [];
  for (const schedule of schedules.data) {
    try {
      const report = await runReportScheduleRecord(schedule.id, asOf);
      results.push({ scheduleId: schedule.id, status: "completed" as const, report });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scheduled report failed.";
      const auditWrite = await supabaseAdmin.rpc("write_audit", {
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

export type ScheduledReportsJobInput = z.infer<typeof schema>;

export const scheduledReportsJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "reports.read",
      attempted: "scheduled_reports.run",
      refusal: "You do not have permission to read reports.",
    });
    return runScheduledReportsJob(data.asOf ?? null);
  });
