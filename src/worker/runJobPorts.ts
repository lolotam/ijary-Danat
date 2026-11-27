import type { SupabaseClient } from "@supabase/supabase-js";

import type { ModuleKey } from "@/company/modules";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/database.types";

import type {
  JobNotice,
  JobRequestRef,
  JobRequestRow,
  JobRequestStatus,
  RunJobPorts,
} from "./runJob";

/** قاعدة البيانات التي يقرأ منها العامل ويكتب فيها؛ `service_role` يتجاوز RLS. */
export type RunJobDatabase = SupabaseClient<Database>;

/** ما يكتبه العامل في صف طلب المهمة: حالته ومعها أعمدة النتيجة والسبب. */
type RequestUpdate = Database["public"]["Tables"]["job_requests"]["Update"] & {
  status: JobRequestStatus;
};

/**
 * أصغر شكل من PostgREST يقرأ منه العامل مفتاح القسم المفعّل.
 *
 * `company_modules` ينشئه ترحيل 290 (T107)، فهو ليس بعد في
 * `database.types.ts` المحفوظة يدوياً؛ والقراءة تمرّ من هذا الشكل وحده.
 */
interface ModuleSwitchReader {
  from(table: "company_modules"): {
    select(columns: "enabled"): {
      eq(
        column: "company_id",
        value: string,
      ): {
        eq(
          column: "module_key",
          value: string,
        ): {
          maybeSingle(): PromiseLike<{
            data: { enabled: boolean } | null;
            error: { code?: string; message: string } | null;
          }>;
        };
      };
    };
  };
}

/** رموز PostgREST وPostgres التي تعني أن الجدول المطلوب غير موجود. */
const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01"]);

/** هل نُذّر بغياب الجدول مرّة واحدة فقط؟ الجدول قادم في ترحيل 290. */
let missingModuleTableWarned = false;

/**
 * يبني منافذ `runJob` الحقيقية فوق عميل `service_role`.
 *
 * The worker runs without a request, so it has no company context: a
 * suspended company is invisible to `companyClient`, and the ports have to
 * read and write the row itself. Every write names the row's company next to
 * its id, because `service_role` bypasses RLS.
 */
export function createRunJobPorts(db: RunJobDatabase): RunJobPorts {
  return {
    loadRequest: (ref) => loadRequest(db, ref),
    companyStatus: (companyId) => readCompanyStatus(db, companyId),
    sectionEnabled: (companyId, section) => readSectionEnabled(db, companyId, section),
    markRunning: (ref, attempt) => updateRequest(db, ref, { status: "running", attempts: attempt }),
    markSucceeded: (ref, result) =>
      updateRequest(db, ref, {
        status: "succeeded",
        result: result as Json,
        finished_at: now(),
      }),
    markFailed: (ref, lastError) =>
      updateRequest(db, ref, { status: "failed", last_error: lastError, finished_at: now() }),
    markSkipped: (ref, reason) =>
      updateRequest(db, ref, { status: "skipped", last_error: reason, finished_at: now() }),
    writeNotice: (notice) => insertNotice(db, notice),
  };
}

/**
 * منافذ العامل مربوطةً بعميل `service_role` الذي يبنيه `client.server.ts`.
 */
export const runJobPorts: RunJobPorts = createRunJobPorts(supabaseAdmin);

/**
 * يقرأ صف طلب المهمة بمعرّفه وشركته معاً.
 *
 * The row of another company is invisible: the company filter is part of the
 * query, not a check afterwards.
 */
async function loadRequest(db: RunJobDatabase, ref: JobRequestRef): Promise<JobRequestRow | null> {
  const { data, error } = await db
    .from("job_requests")
    .select("id, company_id, kind, payload, status, requested_by")
    .eq("id", ref.id)
    .eq("company_id", ref.companyId)
    .maybeSingle();
  if (error) throw new Error(`loadRequest(${ref.id}) failed: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    companyId: data.company_id,
    kind: data.kind,
    payload: data.payload,
    status: data.status,
    requestedBy: data.requested_by,
  };
}

/**
 * يقرأ حالة الشركة: معلّقة أم نشطة.
 *
 * A company that does not exist is a defect, not an active company: the job
 * would run against nothing.
 */
async function readCompanyStatus(
  db: RunJobDatabase,
  companyId: string,
): Promise<"active" | "suspended"> {
  const { data, error } = await db
    .from("companies")
    .select("status")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(`companyStatus(${companyId}) failed: ${error.message}`);
  if (!data) throw new Error(`company ${companyId} not found`);
  return data.status;
}

/**
 * يقرأ مفتاح القسم المفعّل للشركة.
 *
 * The table arrives with migration 290 (T107); until it exists no company can
 * have switched a section off, so a missing table reads as "on" and the worker
 * says so once. A row that is missing reads as "off" (data-model.md), and any
 * other failure is a real error.
 */
async function readSectionEnabled(
  db: RunJobDatabase,
  companyId: string,
  section: ModuleKey,
): Promise<boolean> {
  // The cast is the one place that reads a table the hand-maintained types do
  // not know yet; the shape above is the whole of PostgREST the worker uses.
  const { data, error } = await (db as unknown as ModuleSwitchReader)
    .from("company_modules")
    .select("enabled")
    .eq("company_id", companyId)
    .eq("module_key", section)
    .maybeSingle();
  if (error) {
    if (error.code !== undefined && MISSING_TABLE_CODES.has(error.code)) {
      warnAboutMissingModuleTable();
      return true;
    }
    throw new Error(`sectionEnabled(${companyId}, ${section}) failed: ${error.message}`);
  }
  return data?.enabled ?? false;
}

/**
 * ينبّه مرّة واحدة أن جدول الأقسام غير موجود بعد، فكل قسم يُقرأ مفتوحاً.
 */
function warnAboutMissingModuleTable(): void {
  if (missingModuleTableWarned) return;
  missingModuleTableWarned = true;
  console.warn(
    "[worker] company_modules is not in the database yet (migration 290): every section reads as on.",
  );
}

/**
 * يكتب حالة صف طلب المهمة، بمعرّفه وشركته معاً.
 *
 * The row that matches neither filter is a defect: the job would end without
 * the state it claims.
 */
async function updateRequest(
  db: RunJobDatabase,
  ref: JobRequestRef,
  patch: RequestUpdate,
): Promise<void> {
  const { data, error } = await db
    .from("job_requests")
    .update(patch)
    .eq("id", ref.id)
    .eq("company_id", ref.companyId)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`job request ${ref.id} could not be marked ${patch.status}: ${error.message}`);
  }
  if (!data) throw new Error(`job request ${ref.id} of company ${ref.companyId} not found`);
}

/**
 * يكتب إشعار صاحب الطلب، مرة واحدة لكل طلب مهمة.
 *
 * The insert is idempotent per `job_request_id`: a retry of the job writes the
 * same notice again, and the unique index on that column (migration 311)
 * keeps one row.
 */
async function insertNotice(db: RunJobDatabase, notice: JobNotice): Promise<void> {
  const { error } = await db.from("user_notices").upsert(
    {
      company_id: notice.companyId,
      user_id: notice.userId,
      job_request_id: notice.jobRequestId,
      kind: notice.kind,
      title_key: `notices.${notice.kind}.${notice.level}`,
      level: notice.level,
    },
    { onConflict: "job_request_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(`writeNotice(${notice.jobRequestId}) failed: ${error.message}`);
}

/**
 * يقرأ الوقت الذي يكتب فيه العامل نهاية المهمة.
 */
function now(): string {
  return new Date().toISOString();
}
