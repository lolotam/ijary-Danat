import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { createBackupArchive } from "@/fns/backupCore";
import { isBackupDue, type AutoBackupState } from "@/lib/backupArchive";

/**
 * هل هذا الخطأ انتهاك لقيد التفرد (23505) من بوستجرس؟
 *
 * Reads the SQLSTATE off `code`. It used to also string-match the message,
 * which was a symptom rather than a fix: `createBackupArchive` was discarding
 * the code when it wrapped the PostgREST error, so the message was the only
 * thing left. It now throws a `BackupInsertError` carrying the code, and
 * matching a message is no longer necessary — or reliable.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code } = error as { code?: unknown };
  if (code === "23505") return true;
  return false;
}

/**
 * يشغل وظيفة النسخ الاحتياطي التلقائي إذا كانت مستحقة.
 *
 * Reads backup configuration from the oldest company row, determines if a
 * backup is due via `isBackupDue`, and attempts to create one.
 * Idempotent by construction: the period key for today (or this Kuwait ISO
 * week) is compared against the newest automatic backup's, and the partial
 * unique index on `(kind, period_key)` is the invariant behind that check, so a
 * tick that races another is reported as skipped rather than failing.
 *
 * `asOf` is accepted and deliberately IGNORED, like `notification-drain`. Every
 * other job can be replayed for a past date because it acts on rows dated then;
 * a snapshot cannot. Honouring it would file today's data under an earlier
 * period key — an archive whose name claims a day it does not contain — and
 * would let a backdated run consume a period that the real day still needs.
 */
/**
 * يشغل وظيفة النسخ الاحتياطي التلقائي للشركة الحالية إذا كانت مستحقة.
 */
export async function runBackupJob(
  _asOfIgnored?: string | null,
  companyId?: string,
): Promise<{
  skipped?: string;
  created?: string;
}> {
  const resolvedCompanyId = companyId ?? requireRequestCompany().id;
  const db = companyClient(resolvedCompanyId);

  const { data: company, error: cmpError } = await db
    .from("companies")
    .select("backup_daily_enabled, backup_weekly_enabled")
    .eq("id", resolvedCompanyId)
    .maybeSingle();

  if (cmpError) throw new Error(`Could not fetch company settings: ${cmpError.message}`);

  const dailyEnabled = company?.backup_daily_enabled ?? false;
  const weeklyEnabled = company?.backup_weekly_enabled ?? false;

  // Read newest automatic backup
  const { data: newest, error: newestError } = await db
    .from("backups")
    .select("created_at, period_key")
    .eq("kind", "automatic")
    .order("created_at", { ascending: false })
    .limit(1);

  if (newestError) throw new Error(`Could not fetch newest backup: ${newestError.message}`);

  // المفتاح الزمني للفترة، لا وقت آخر نسخة — الفترات التقويمية لا تنجرف.
  //
  // Keyed on the stored period_key rather than a timestamp: comparing elapsed
  // time makes a weekly backup drift a few seconds later each week until it
  // lands on the following day and walks through the calendar.
  const state: AutoBackupState = {
    dailyEnabled,
    weeklyEnabled,
    lastPeriodKey: newest?.[0]?.period_key ?? null,
  };

  const now = new Date();
  const { due, reason, periodKey } = isBackupDue(state, now);

  if (!due) {
    return { skipped: reason };
  }

  // لا يوجد قفل استشاري هنا عن قصد؛ الفهرس الفريد هو الضمان الحقيقي.
  //
  // A `pg_advisory_xact_lock` was specified here and then removed: a
  // transaction-scoped advisory lock lives exactly as long as its transaction,
  // and PostgREST wraps every RPC in its own, so the lock would be released
  // before the backup below even starts. It would read as concurrency
  // protection while providing none, which is worse than none — the next reader
  // stops looking. The partial unique index on (kind, period_key) is the real
  // invariant: two racing ticks both pass the due check, and exactly one
  // survives the insert. The loser is reported as skipped just below.
  try {
    const record = await createBackupArchive({
      kind: "automatic",
      createdBy: null,
      periodKey,
    });
    return { created: record.id };
  } catch (error: unknown) {
    // 23505 هو انتهاك قيد التفرد — أي أن نبضة أخرى سبقتنا لنفس الفترة.
    //
    // Narrowed rather than typed `any`: the only error this swallows is the
    // one that means "another tick already made this period's backup", which is
    // a success for the system even though it is a failure for this call.
    // Anything else propagates.
    if (isUniqueViolation(error)) {
      return { skipped: "racing-tick-duplicate" };
    }
    throw error;
  }
}
