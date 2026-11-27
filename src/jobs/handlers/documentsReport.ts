import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany, runWithRequestCompany } from "@/company/requestCompany.server";
import {
  dispatchNotificationRecord,
  retryFailedNotificationRecord,
} from "@/fns/dispatchNotification";
import type {
  Database,
  Json,
  ReportFrequency,
  ReportKind,
  Tables,
} from "@/integrations/supabase/database.types";
import type { JobPayload } from "@/jobs/catalog";
import { attachmentPayload, renderAndStorePdf } from "@/lib/reportPdfAttachment";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

import {
  documentDeliveryKey,
  findDocumentDeliveries,
  findExistingDocumentDelivery,
} from "./documentsDelivery";

/**
 * مفتاح تسليم صف تقرير: معرّف المهمة ثم قناة البريد — قناة التقرير الوحيدة.
 *
 * The handler checks this key before it sends and the two record functions
 * write it on their rows, so a retry of one `report.run` job finds the row the
 * earlier attempt wrote instead of sending the same report again.
 */
function reportDeliveryKey(jobRequestId: string): string {
  return documentDeliveryKey(jobRequestId, "email");
}

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

/** يحسب تاريخ التشغيل التالي بعد التنفيذ الحالي وفق وتيرة التقرير. */
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
  db: SupabaseClient<Database>,
  schedule: { id: string; report_kind: ReportKind },
  asOf: string | null,
) {
  const args = { p_schedule_id: schedule.id, p_as_of: asOf };
  const htmlResult =
    schedule.report_kind === "overdue_contracts"
      ? await db.rpc("build_overdue_contracts_report_html", args)
      : await db.rpc("build_scheduled_report_html", args);
  if (htmlResult.error) throw new Error(htmlResult.error.message);
  const snapshot = htmlResult.data[0];
  if (!snapshot) throw new Error("The report generator returned no snapshot.");
  return snapshot;
}

/**
 * يشغّل جدولاً زمنياً لتقرير ضمن نطاق الشركة الحالية: يولّد اللقطة، يرسلها، ويحدّث موعد التشغيل التالي.
 *
 * The work moved out of the request so the browser does not wait for a report
 * snapshot and a PDF render (contracts/jobs.md section 3).
 *
 * `jobRequestId` names the job whose run this is: its notification row is
 * written under the job's delivery key, so the handler can recognise the row
 * on a retry, and a run whose insert collides on that key reports the existing
 * row and sends nothing. A caller outside the jobs pipeline — the legacy
 * scheduled-reports job — has no job id and writes rows without the marker.
 */
export async function runReportScheduleRecord(
  scheduleId: string,
  asOf: string | null = null,
  companyId?: string,
  jobRequestId?: string,
) {
  const resolvedCompanyId = companyId ?? requireRequestCompany().id;
  const db = companyClient(resolvedCompanyId);

  const scheduleResult = await db
    .from("report_schedules")
    .select("*")
    .eq("id", scheduleId)
    .single();
  if (scheduleResult.error) throw new Error(scheduleResult.error.message);
  const schedule = scheduleResult.data;
  const emails = recipients(schedule.recipients);
  if (!emails.length) throw new Error("The report schedule has no valid internal recipients.");
  const snapshot = await buildReportSnapshot(db, schedule, asOf);
  const generatedResult = await db
    .from("generated_reports")
    .insert({
      company_id: resolvedCompanyId,
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
    companyId: resolvedCompanyId,
    discriminator: `${snapshot.period_start}_${snapshot.period_end}`,
    html: snapshot.html,
    name: schedule.name_en ?? schedule.name_ar,
    prefix: "scheduled-reports",
  });

  const notificationResult = await db
    .from("notifications")
    .insert({
      company_id: resolvedCompanyId,
      report_schedule_id: schedule.id,
      type: "scheduled_report",
      channel: "email",
      audience: "admin",
      locale: schedule.locale,
      delivery_key: jobRequestId ? reportDeliveryKey(jobRequestId) : null,
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
  if (notificationResult.error) {
    // 23505 alone means a colliding delivery key: another run of this job
    // wrote the row first — migration 312's index is the guarantee. Report the
    // existing row and send nothing: the winning run owns the dispatch and the
    // bookkeeping below. Any other error must surface as itself.
    const colliding =
      jobRequestId && notificationResult.error.code === "23505"
        ? await findExistingDocumentDelivery(db, reportDeliveryKey(jobRequestId))
        : null;
    if (colliding) return { generatedReport: generatedResult.data, notification: colliding };
    throw new Error(notificationResult.error.message);
  }
  const dispatched = await dispatchNotificationRecord(notificationResult.data.id);
  const now = new Date();
  const sent = dispatched.state === "sent";
  const [generatedUpdate, scheduleUpdate, auditWrite] = await Promise.all([
    db
      .from("generated_reports")
      .update({ sent, sent_at: sent ? now.toISOString() : null })
      .eq("id", generatedResult.data.id),
    db
      .from("report_schedules")
      .update({ last_run_at: now.toISOString(), next_run_at: nextRun(schedule.frequency, now) })
      .eq("id", schedule.id),
    db.rpc("write_audit", {
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

/**
 * يعيد صف تسليم تقرير فاشل إلى الطابور ثم يصرّفه، بحجز يضمن أن محاولة واحدة فقط ترسل.
 *
 * With `failed` inside migration 312's delivery index a retry can no longer
 * write a fresh row under the same key, so the retry IS the delivery: the row
 * is claimed back exactly the way the Notification Log's Retry button puts it
 * in `queued` — `retryFailedNotificationRecord` clears `failure_reason` and
 * `error_code` so the partner code that parked it cannot judge the new
 * attempt — and then dispatched through the same call
 * `runNotificationDrainJob`'s retry of a failed row makes.
 *
 * Returns `null` when the claim was lost (GR-005): another sender — the
 * drain's retry, a second run of this job — already owns the row and records
 * its outcome. A `null` here must stop the bookkeeping below: writing
 * `generated_reports.sent = false` and a failure audit while that sender is
 * still delivering would file a live delivery as a failure.
 */
async function requeueFailedReportDelivery(
  row: Tables<"notifications">,
  companyId: string,
): Promise<Tables<"notifications"> | null> {
  return retryFailedNotificationRecord(row.id, row.retry_count, companyId);
}

/**
 * يعيد إرسال تقرير مولَّد سابقًا إلى مستلمي جدوله الزمني.
 *
 * The work moved out of the request with the rest of the report family: the
 * `report.run` job finds the stored report and sends it again.
 *
 * `jobRequestId` marks the row the same way `runReportScheduleRecord` does: a
 * retry of one job collides on the key and sends nothing twice — a row the
 * provider refused is re-queued and dispatched again, since `failed` sits
 * inside the delivery index (migration 312) — and a resend the admin asked
 * for is a new job with a new id that still goes out.
 */
export async function resendGeneratedReportRecord(
  reportId: string,
  companyId?: string,
  jobRequestId?: string,
) {
  const resolvedCompanyId = companyId ?? requireRequestCompany().id;
  const db = companyClient(resolvedCompanyId);

  const reportResult = await db.from("generated_reports").select("*").eq("id", reportId).single();
  if (reportResult.error) throw new Error(reportResult.error.message);
  const report = reportResult.data;
  if (!report.schedule_id || !report.html_content) {
    throw new Error("The generated report has no schedule or HTML artifact.");
  }
  const scheduleResult = await db
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

  // A retry of one job must not write a second delivery row. With `failed`
  // inside migration 312's index a fresh row under the same key is refused
  // anyway, so the retry re-queues the row the failed attempt wrote and
  // dispatches it — the notification drain's retry of a failed row, done here
  // and now. A row already delivered or in flight is returned as it is: the
  // winning run owns its dispatch and bookkeeping.
  const prior = jobRequestId
    ? await findExistingDocumentDelivery(db, reportDeliveryKey(jobRequestId))
    : null;
  if (prior && prior.state !== "failed") {
    return prior;
  }

  let dispatched: Tables<"notifications">;
  if (prior) {
    const requeued = await requeueFailedReportDelivery(prior, resolvedCompanyId);
    if (!requeued) {
      // GR-005: the claim was lost — the drain's retry or a second run of
      // this job owns the row and records its outcome. Returning early skips
      // the `generated_reports` update and the failure audit: filing
      // `sent = false` while that sender is still delivering would record a
      // live delivery as a failure.
      return prior;
    }
    dispatched = requeued;
  } else {
    // Reuses the stored document when this exact report was already printed,
    // and renders when it was not — a report generated before migration 109 has
    // no stored PDF, and a resend is exactly when someone is trying to get the
    // attachment they did not receive the first time. `renderAndStorePdf` keys
    // on the content, so the decision needs nothing from this call site. A
    // re-queued row keeps its original payload — attachments included — so no
    // render runs for it.
    const storedPdf = await renderAndStorePdf({
      arabic: locale === "ar",
      companyId: resolvedCompanyId,
      discriminator: `${report.period_start ?? ""}_${report.period_end ?? ""}`,
      html: report.html_content,
      name: schedule.name_en ?? schedule.name_ar,
      prefix: "scheduled-reports",
    });

    const notificationResult = await db
      .from("notifications")
      .insert({
        company_id: resolvedCompanyId,
        report_schedule_id: schedule.id,
        type: "scheduled_report",
        audience: "admin",
        channel: "email",
        locale,
        delivery_key: jobRequestId ? reportDeliveryKey(jobRequestId) : null,
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
    if (notificationResult.error) {
      // 23505 alone means a colliding delivery key: a racing run of this job
      // inserted between the read above and this write. Its row is the
      // delivery — report it and send nothing. Any other error must surface.
      const colliding =
        jobRequestId && notificationResult.error.code === "23505"
          ? await findExistingDocumentDelivery(db, reportDeliveryKey(jobRequestId))
          : null;
      if (colliding) return colliding;
      throw new Error(notificationResult.error.message);
    }
    dispatched = await dispatchNotificationRecord(notificationResult.data.id);
  }
  const sent = dispatched.state === "sent";
  const reportUpdate = await db
    .from("generated_reports")
    .update({ sent, sent_at: sent ? new Date().toISOString() : null })
    .eq("id", report.id);
  if (reportUpdate.error) throw new Error(reportUpdate.error.message);
  const auditWrite = await db.rpc("write_audit", {
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
}

/**
 * يبحث عن تقرير مولَّد لنفس الجدول الزمني بنفس تاريخ الفترة.
 *
 * The `report.run` job carries a schedule and a date, so the worker can tell
 * a fresh run (nothing stored for that date yet) from a resend (the stored
 * report for that date is the one the admin asked to send again). The newest
 * row wins: a schedule that ran twice for one period leaves two rows, and the
 * later one is the report that was actually seen.
 */
async function findGeneratedReport(
  db: SupabaseClient<Database>,
  scheduleId: string,
  date: string,
): Promise<{ id: string } | null> {
  const result = await db
    .from("generated_reports")
    .select("id")
    .eq("schedule_id", scheduleId)
    .eq("period_end", date)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return result.data ?? null;
}

/**
 * يبني معالج مهمة `report.run`: يولّد التقرير أو يعيد إرسال تقرير محفوظ لنفس الفترة.
 *
 * The job carries a schedule and a date. A stored report for that date means
 * the admin asked for that report again, so it is sent again as it was; no
 * stored report means the schedule runs and produces a new one.
 *
 * A retry of the same job is not that ask: the delivery key the job's rows
 * carry is the marker, and a run that finds a delivered (or still queued) row
 * under its key sends nothing again. A row the provider refused is no marker —
 * the retry is what delivers the report — so the resend re-queues that very
 * row and dispatches it again: with `failed` inside the delivery index
 * (migration 312) a fresh row under the same key is refused anyway, and one
 * delivery row per job and channel is what stays on the log.
 *
 * The dispatch runs inside the job's own company context because the schedule,
 * its recipients and its template are read through the request company, and a
 * background job has no request.
 */
export function createReportRunHandler(): JobHandler {
  return async (ctx: JobHandlerContext) => {
    const { scheduleId, date } = ctx.payload as JobPayload<"report.run">;
    const result = await runWithRequestCompany(
      { id: ctx.companyId, slug: "", status: "active", host: "" },
      async () => {
        const db = companyClient(ctx.companyId);
        const priorRows = await findDocumentDeliveries(db, reportDeliveryKey(ctx.jobRequestId));
        const delivered = priorRows.find((row) => row.state !== "failed");
        if (delivered) {
          return { skipped: true, notificationId: delivered.id };
        }
        const stored = await findGeneratedReport(db, scheduleId, date);
        if (stored) {
          const notification = await resendGeneratedReportRecord(
            stored.id,
            ctx.companyId,
            ctx.jobRequestId,
          );
          return { resent: true, notification };
        }
        const report = await runReportScheduleRecord(
          scheduleId,
          date,
          ctx.companyId,
          ctx.jobRequestId,
        );
        return { resent: false, ...report };
      },
    );
    return { scheduleId, date, ...result };
  };
}
