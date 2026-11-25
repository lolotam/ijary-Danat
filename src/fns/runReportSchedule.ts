import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { dispatchNotificationRecord } from "@/fns/dispatchNotification";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json, ReportFrequency, ReportKind } from "@/integrations/supabase/database.types";
import { attachmentPayload, renderAndStorePdf } from "@/lib/reportPdfAttachment";
import { requirePermission } from "@/fns/requirePermission";

const schema = z.object({
  asOf: z.string().date().nullable().optional(),
  scheduleId: z.string().uuid(),
});

/**
 * يستخرج عناوين البريد الصالحة من حقل المستلمين في الجدول الزمني.
 *
 * The schedule stores a JSON array; anything that is not an email is dropped
 * so a typo cannot become the only visible recipient on the notification row.
 */
function recipients(value: Json): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.includes("@"));
}

function nextRun(frequency: ReportFrequency, from = new Date()): string {
  const next = new Date(from);
  if (frequency === "daily") next.setUTCDate(next.getUTCDate() + 1);
  if (frequency === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  if (frequency === "monthly") next.setUTCMonth(next.getUTCMonth() + 1);
  if (frequency === "yearly") next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next.toISOString();
}

/**
 * يستدعي مولّد HTML المناسب لنوع التقرير في الجدول الزمني.
 *
 * Two SQL builders share one output shape, so everything after the call —
 * generated_reports, PDF, notification, next run — stays one code path.
 */
async function buildReportSnapshot(
  schedule: { id: string; report_kind: ReportKind },
  asOf: string | null,
) {
  const args = { p_schedule_id: schedule.id, p_as_of: asOf };
  const htmlResult =
    schedule.report_kind === "overdue_contracts"
      ? await supabaseAdmin.rpc("build_overdue_contracts_report_html", args)
      : await supabaseAdmin.rpc("build_scheduled_report_html", args);
  if (htmlResult.error) throw new Error(htmlResult.error.message);
  const snapshot = htmlResult.data[0];
  if (!snapshot) throw new Error("The report generator returned no snapshot.");
  return snapshot;
}

/**
 * يشغّل جدولاً زمنياً لتقرير: يولّد اللقطة، يرسلها لكل المستلمين، ويحدّث موعد التشغيل التالي.
 */
export async function runReportScheduleRecord(scheduleId: string, asOf: string | null = null) {
  const scheduleResult = await supabaseAdmin
    .from("report_schedules")
    .select("*")
    .eq("id", scheduleId)
    .single();
  if (scheduleResult.error) throw new Error(scheduleResult.error.message);
  const schedule = scheduleResult.data;
  const emails = recipients(schedule.recipients);
  if (!emails.length) throw new Error("The report schedule has no valid internal recipients.");
  const snapshot = await buildReportSnapshot(schedule, asOf);
  const generatedResult = await supabaseAdmin
    .from("generated_reports")
    .insert({
      schedule_id: schedule.id,
      period_start: snapshot.period_start,
      period_end: snapshot.period_end,
      html_content: snapshot.html,
      locale: schedule.locale,
    })
    .select("*")
    .single();
  if (generatedResult.error) throw new Error(generatedResult.error.message);

  // Rendered from the same HTML that becomes the email body, so the attachment
  // cannot drift from what the recipient reads. A null result means the render
  // or upload failed and was logged; the report still goes out as HTML.
  const storedPdf = await renderAndStorePdf({
    arabic: schedule.locale === "ar",
    discriminator: `${snapshot.period_start}_${snapshot.period_end}`,
    html: snapshot.html,
    name: schedule.name_en ?? schedule.name_ar,
    prefix: "scheduled-reports",
  });

  const notificationResult = await supabaseAdmin
    .from("notifications")
    .insert({
      report_schedule_id: schedule.id,
      type: "scheduled_report",
      channel: "email",
      audience: "admin",
      locale: schedule.locale,
      subject:
        schedule.locale === "ar"
          ? `${schedule.name_ar} — ${snapshot.period_start} / ${snapshot.period_end}`
          : `${schedule.name_en ?? schedule.name_ar} — ${snapshot.period_start} / ${snapshot.period_end}`,
      body: snapshot.html,
      // The log column is a single text field. Join every recipient so the
      // table is not a one-address blind spot; `payload.recipients` stays
      // the structured list dispatch already reads.
      recipient_address: emails.join(", "),
      payload: {
        generated_report_id: generatedResult.data.id,
        recipients: emails,
        ...attachmentPayload(storedPdf),
      },
      scheduled_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (notificationResult.error) throw new Error(notificationResult.error.message);
  const dispatched = await dispatchNotificationRecord(notificationResult.data.id);
  const now = new Date();
  const sent = dispatched.state === "sent";
  const [generatedUpdate, scheduleUpdate, auditWrite] = await Promise.all([
    supabaseAdmin
      .from("generated_reports")
      .update({ sent, sent_at: sent ? now.toISOString() : null })
      .eq("id", generatedResult.data.id),
    supabaseAdmin
      .from("report_schedules")
      .update({ last_run_at: now.toISOString(), next_run_at: nextRun(schedule.frequency, now) })
      .eq("id", schedule.id),
    supabaseAdmin.rpc("write_audit", {
      p_action: "report_schedule.run",
      p_entity_type: "report_schedule",
      p_entity_id: schedule.id,
      p_before: null,
      p_after: {
        generated_report_id: generatedResult.data.id,
        notification_id: dispatched.id,
        sent,
      },
      p_result: sent ? "success" : "failure",
      p_error_code: sent ? null : "PROVIDER_DISPATCH_FAILED",
    }),
  ]);
  if (generatedUpdate.error) throw new Error(generatedUpdate.error.message);
  if (scheduleUpdate.error) throw new Error(scheduleUpdate.error.message);
  if (auditWrite.error) throw new Error(auditWrite.error.message);
  return {
    generatedReport: { ...generatedResult.data, sent, sent_at: sent ? now.toISOString() : null },
    notification: dispatched,
  };
}

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
    return runReportScheduleRecord(data.scheduleId, data.asOf ?? null);
  });
