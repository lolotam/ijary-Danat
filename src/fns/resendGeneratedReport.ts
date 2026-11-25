import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { dispatchNotificationRecord } from "@/fns/dispatchNotification";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { attachmentPayload, renderAndStorePdf } from "@/lib/reportPdfAttachment";
import { requirePermission } from "@/fns/requirePermission";

const schema = z.object({ reportId: z.string().uuid() });

export const resendGeneratedReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "reports.read",
      attempted: "report.resend",
      refusal: "You do not have permission to read reports.",
    });
    const reportResult = await supabaseAdmin
      .from("generated_reports")
      .select("*")
      .eq("id", data.reportId)
      .single();
    if (reportResult.error) throw new Error(reportResult.error.message);
    const report = reportResult.data;
    if (!report.schedule_id || !report.html_content) {
      throw new Error("The generated report has no schedule or HTML artifact.");
    }
    const scheduleResult = await supabaseAdmin
      .from("report_schedules")
      .select("*")
      .eq("id", report.schedule_id)
      .single();
    if (scheduleResult.error) throw new Error(scheduleResult.error.message);
    const schedule = scheduleResult.data;
    if (!Array.isArray(schedule.recipients)) throw new Error("Report recipients are invalid.");
    const emails = schedule.recipients.filter(
      (item): item is string => typeof item === "string" && item.includes("@"),
    );
    const locale = report.locale ?? schedule.locale;

    // Reuses the stored document when this exact report was already printed,
    // and renders when it was not — a report generated before migration 109 has
    // no stored PDF, and a resend is exactly when someone is trying to get the
    // attachment they did not receive the first time. `renderAndStorePdf` keys
    // on the content, so the decision needs nothing from this call site.
    const storedPdf = await renderAndStorePdf({
      arabic: locale === "ar",
      discriminator: `${report.period_start ?? ""}_${report.period_end ?? ""}`,
      html: report.html_content,
      name: schedule.name_en ?? schedule.name_ar,
      prefix: "scheduled-reports",
    });

    const notificationResult = await supabaseAdmin
      .from("notifications")
      .insert({
        report_schedule_id: schedule.id,
        type: "scheduled_report",
        audience: "admin",
        channel: "email",
        locale,
        subject: `${locale === "ar" ? schedule.name_ar : (schedule.name_en ?? schedule.name_ar)} — ${report.period_start ?? ""} / ${report.period_end ?? ""}`,
        body: report.html_content,
        // Same join as runReportSchedule: the log column is one text field,
        // and leaving it null made a resend worse than the original one-address
        // blind spot.
        recipient_address: emails.join(", "),
        payload: {
          generated_report_id: report.id,
          recipients: emails,
          ...attachmentPayload(storedPdf),
        },
        scheduled_at: new Date().toISOString(),
      })
      .select("*")
      .single();
    if (notificationResult.error) throw new Error(notificationResult.error.message);
    const dispatched = await dispatchNotificationRecord(notificationResult.data.id);
    const sent = dispatched.state === "sent";
    const reportUpdate = await supabaseAdmin
      .from("generated_reports")
      .update({ sent, sent_at: sent ? new Date().toISOString() : null })
      .eq("id", report.id);
    if (reportUpdate.error) throw new Error(reportUpdate.error.message);
    const auditWrite = await context.supabase.rpc("write_audit", {
      p_action: "generated_report.resend",
      p_entity_type: "generated_report",
      p_entity_id: report.id,
      p_before: null,
      p_after: { notification_id: dispatched.id, sent },
      p_result: sent ? "success" : "failure",
      p_error_code: sent ? null : "PROVIDER_DISPATCH_FAILED",
    });
    if (auditWrite.error) throw new Error(auditWrite.error.message);
    return dispatched;
  });

export type ResendGeneratedReportInput = z.infer<typeof schema>;
