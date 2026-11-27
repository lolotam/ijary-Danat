import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/database.types";
import type { JobKind } from "@/jobs/catalog";
import type { JobHandler } from "@/worker/runJob";

import { createCompanyExportHandler } from "./syncExport";
import { createCompanyRestoreHandler } from "./syncRestore";
import { createWhatsappAvatarsSyncHandler, createWhatsappHistorySyncHandler } from "./syncWhatsapp";

/**
 * نتيجة حجز مهمة مزامنة أو نسخ: العمل غادر الطلب ولم يُنفَّذ بعد.
 *
 * `jobRequestId` is the `job_requests` row the worker will pick up. The caller
 * shows it as "queued", never as "done": the outcome arrives later, as the
 * requester's notice where the kind asks for one.
 */
export interface QueuedSyncJob {
  queued: true;
  jobRequestId: string;
}

/** صف طلب المهمة كما يقرأه المعالج: الشركة وصاحب الطلب. */
export interface SyncJobRequestRow {
  companyId: string;
  requestedBy: string | null;
}

/**
 * يقرأ الشركة وصاحب الطلب من صف طلب المهمة نفسه.
 *
 * The destructive handlers re-check from here and never from the payload
 * alone: a restore must know who asked and under which company before it
 * touches data, and the job row is where those two facts live (the worker
 * already scoped its own read, and this one repeats it through the company's
 * own client so another company's row finds nothing).
 */
export async function loadSyncJobRequest(
  db: SupabaseClient<Database>,
  jobRequestId: string,
): Promise<SyncJobRequestRow> {
  const { data, error } = await db
    .from("job_requests")
    .select("company_id, requested_by")
    .eq("id", jobRequestId)
    .maybeSingle();
  if (error) throw new Error(`job_requests lookup for ${jobRequestId} failed: ${error.message}`);
  if (!data) throw new Error(`job request ${jobRequestId} not found`);
  return { companyId: data.company_id, requestedBy: data.requested_by };
}

/**
 * يقرأ النسخة الاحتياطية التي تحمل مفتاح المهمة الطبيعي، أو null إن لم توجد.
 *
 * Both the export and the restore key the backup they create to the job id
 * (`period_key`), so this lookup is the "did this job already run?" check that
 * makes a retry a no-op — backed by the unique
 * `(company_id, kind, period_key)` index for the races a read cannot see.
 */
export async function loadBackupByJobKey(
  db: SupabaseClient<Database>,
  kind: "manual" | "pre_restore",
  jobRequestId: string,
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from("backups")
    .select("id")
    .eq("kind", kind)
    .eq("period_key", jobRequestId)
    .maybeSingle();
  if (error) throw new Error(`backups lookup for job ${jobRequestId} failed: ${error.message}`);
  return data ? { id: data.id } : null;
}

/**
 * يبني معالجات مهام المزامنة والتصدير والاستعادة في `src/jobs/handlers/sync.ts`.
 *
 * Four kinds are claimed here — `company.export`, `company.restore`,
 * `whatsapp.history.sync`, `whatsapp.avatars.sync`. The two other `sync`-queue
 * kinds are deliberately absent: `gmail.sync` and `payment.reconcile` are the
 * cron machinery's own (T076 registered them in `cron.ts`, where their work,
 * pause switches and run records already live), and a second registration here
 * would shadow one of the two — the registry refuses duplicates outright.
 */
export function createSyncHandlers(): Partial<Record<JobKind, JobHandler>> {
  return {
    "company.export": createCompanyExportHandler(),
    "company.restore": createCompanyRestoreHandler(),
    "whatsapp.history.sync": createWhatsappHistorySyncHandler(),
    "whatsapp.avatars.sync": createWhatsappAvatarsSyncHandler(),
  };
}
