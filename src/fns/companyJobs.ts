import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Tables } from "@/integrations/supabase/database.types";

/**
 * صلاحية لوحة المهام: نفس مفتاح `PERMISSIONS.COMPANY_UPDATE` الذي يحرس صفحة
 * إعدادات الشركة، فلا تُختلق صلاحية جديدة لوظيفة مهام.
 */
const COMPANY_SETTINGS_PERMISSION = "company.update";

/** أقصى عدد مهام فاشلة تعرضها البطاقة؛ الأحدث أولاً. */
const FAILED_JOB_LIMIT = 50;

/**
 * رمز رفض إعادة المحاولة: الصف غير موجود، أو لا يخصّ الشركة، أو ليس فاشلاً.
 *
 * The three cases are one refusal: naming which one happened would tell the
 * caller whether a job id belongs to another company.
 */
export const JOB_NOT_RETRYABLE = "JOB_NOT_RETRYABLE";

/** مهمة فاشلة كما تراها شاشة إعدادات الشركة. */
export interface FailedJob {
  id: string;
  /** نوع المهمة (`notification.dispatch` …)؛ الحمولة لا تُعرض أبداً. */
  kind: string;
  /** سبب الفشل كما كتبه العامل. */
  lastError: string | null;
  /** عدد المحاولات التي استنفدها العامل. */
  attempts: number;
  /** وقت إنشاء الطلب. */
  createdAt: string;
  /** وقت الفشل؛ `null` إن لم يُكتب. */
  finishedAt: string | null;
}

/** صف الطلب كما تقرؤه قاعدة البيانات. */
type FailedJobRow = Pick<
  Tables<"job_requests">,
  "id" | "kind" | "last_error" | "attempts" | "created_at" | "finished_at"
>;

/**
 * رفض إعادة محاولة لا تصلح.
 *
 * The code travels in the message too: a thrown error crosses the server
 * boundary as text, and the browser must be able to tell this refusal from a
 * database failure.
 */
export class JobNotRetryableError extends Error {
  readonly code = JOB_NOT_RETRYABLE;

  constructor() {
    super(`${JOB_NOT_RETRYABLE}: this job is not a failed job of your company.`);
    this.name = "JobNotRetryableError";
  }
}

/**
 * يحوّل صف الطلب الفاشل إلى ما يراه العميل: أسماء أعمدة مريحة بلا حمولة.
 */
function toFailedJob(row: FailedJobRow): FailedJob {
  return {
    id: row.id,
    kind: row.kind,
    lastError: row.last_error,
    attempts: row.attempts,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/**
 * يجلب المهام الخلفية الفاشلة للشركة، الأحدث أولاً، بحدّ أقصى ٥٠ صفاً.
 *
 * `job_requests` grants nothing to `authenticated`, so the read goes through
 * the company-scoped client: its policy limits the rows to this company, and
 * the payload column is never selected.
 */
export const companyFailedJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<FailedJob[]> => {
    await requirePermission(context, {
      code: COMPANY_SETTINGS_PERMISSION,
      attempted: "job.failed.list",
      refusal: "You do not have permission to view failed background jobs.",
    });

    const db = companyClient(requireRequestCompany().id);

    const { data, error } = await db
      .from("job_requests")
      .select("id, kind, last_error, attempts, created_at, finished_at")
      .eq("status", "failed")
      .order("finished_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(FAILED_JOB_LIMIT);

    if (error) throw new Error(`Failed jobs read failed: ${error.message}`);

    return (data ?? []).map(toFailedJob);
  });

/** مدخلات إعادة المحاولة: معرّف الطلب وحده. */
export const retryJobSchema = z.object({
  id: z.string().uuid(),
});

/**
 * يعيد مهمة فاشلة إلى قائمة الانتظار.
 *
 * The same row is reused — same id, same dedupe key — so a retry cannot
 * produce a second row. The BullMQ job id is the row id, so the queue must
 * have released that id (see `src/worker/queues.ts`), or the relay's re-add
 * would be ignored and the job would never run again.
 */
export const retryJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(retryJobSchema)
  .handler(async ({ data, context }): Promise<{ id: string }> => {
    await requirePermission(context, {
      code: COMPANY_SETTINGS_PERMISSION,
      attempted: "job.retry",
      refusal: "You do not have permission to retry background jobs.",
    });

    const db = companyClient(requireRequestCompany().id);

    // The row is only writable while it is failed, so a second click on the
    // same row matches nothing and is refused like a row of another company.
    const { data: retried, error } = await db
      .from("job_requests")
      .update({
        status: "pending",
        attempts: 0,
        last_error: null,
        finished_at: null,
        published_at: null,
      })
      .eq("id", data.id)
      .eq("status", "failed")
      .select("id")
      .maybeSingle();

    if (error) throw new Error(`Job retry failed: ${error.message}`);
    if (!retried) throw new JobNotRetryableError();

    return { id: retried.id };
  });
