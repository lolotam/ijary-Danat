import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { CompanyStatus, Database } from "@/integrations/supabase/database.types";
import { parseServerInput } from "@/lib/parseServerInput";
import { writePlatformAudit } from "@/platform/audit";
import { COMPANY_NOT_FOUND } from "@/platform/companyStaffAccount";
import { requirePlatformAdmin } from "@/platform/requirePlatformAdmin.server";

/**
 * إيقاف شركة أو إعادة تفعيلها، مع تسجيل السبب الذي قُرِّر به.
 *
 * Suspension is the owner's own decision and reactivation is a decision too.
 * The reason is required in both directions, because a decision nobody can
 * explain is exactly the one a company cannot appeal afterwards.
 *
 * A company is never deleted: there is no delete grant on the table, and the
 * suspension columns are what take it out of reach (migration 254).
 */

/** أقل طول مقبول لسبب الإيقاف أو التفعيل. */
const MIN_REASON_LENGTH = 3;

/** أقصى طول مقبول لسبب الإيقاف أو التفعيل. */
const MAX_REASON_LENGTH = 500;

/** مخطط تغيير حالة الشركة؛ السبب إلزامي في الاتجاهين. */
export const companyStatusSchema = z.object({
  companyId: z.string().uuid(),
  status: z.enum(["active", "suspended"]),
  reason: z.string().trim().min(MIN_REASON_LENGTH).max(MAX_REASON_LENGTH),
});

/** مدخل تغيير حالة الشركة كما تقبلها العملية. */
export type SetCompanyStatusInput = z.infer<typeof companyStatusSchema>;

/** أعمدة الشركة التي تهم تغيير الحالة. */
const STATUS_COLUMNS = "id, slug, status, suspended_at, suspended_reason, suspended_by";

/** صف الشركة كما تقرأه عملية تغيير الحالة. */
interface CompanyStatusRow {
  id: string;
  slug: string;
  status: CompanyStatus;
  suspended_at: string | null;
  suspended_reason: string | null;
  suspended_by: string | null;
}

/** لقطة الحالة كما تُكتب في سجل تدقيق المنصة. */
type StatusSnapshot = {
  status: CompanyStatus;
  suspended_at: string | null;
  suspended_reason: string | null;
};

/**
 * يبني ما يُكتب على صف الشركة عند تغيير حالتها.
 *
 * Reactivation clears the suspension columns: a company that is active again
 * must not keep the reason that took it out of reach, or the panel would show
 * a stale reason next to a live company.
 */
function statusPatch(
  status: CompanyStatus,
  reason: string,
  actorId: string,
): Database["public"]["Tables"]["companies"]["Update"] {
  if (status === "active") {
    return { status, suspended_at: null, suspended_reason: null, suspended_by: null };
  }
  return {
    status,
    suspended_at: new Date().toISOString(),
    suspended_reason: reason,
    suspended_by: actorId,
  };
}

/**
 * يبني لقطة الحالة كما تُكتب في سجل التدقيق.
 *
 * The audit records the columns in the database's own words, so a row can be
 * read without the screen that wrote it.
 */
function statusSnapshot(row: StatusSnapshot): StatusSnapshot {
  return {
    status: row.status,
    suspended_at: row.suspended_at,
    suspended_reason: row.suspended_reason,
  };
}

/**
 * يقرأ صف الشركة الذي يحمل حالتها وسبب إيقافها.
 */
async function readCompanyStatusRow(companyId: string): Promise<CompanyStatusRow> {
  const { data, error } = await supabaseAdmin
    .from("companies")
    .select(STATUS_COLUMNS)
    .eq("id", companyId)
    .maybeSingle();

  if (error) {
    throw new Error(`company lookup failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(COMPANY_NOT_FOUND);
  }
  return data;
}

/**
 * يكتب الحالة الجديدة على صف الشركة، ويعيد ما استقر عليه.
 */
async function writeCompanyStatus(
  companyId: string,
  patch: Database["public"]["Tables"]["companies"]["Update"],
): Promise<CompanyStatusRow> {
  const { data, error } = await supabaseAdmin
    .from("companies")
    .update(patch)
    .eq("id", companyId)
    .select(STATUS_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error(
      `company status update failed: ${error?.message ?? "the update returned no row"}`,
    );
  }
  return data;
}

/**
 * يوقف شركة أو يعيد تفعيلها، ويكتب سطر تدقيق واحداً بحالة الشركة قبل وبعد.
 *
 * The guard runs before anything is read: an operation that is not audited
 * must not look audited (SC-015), and a refused caller must leave no trace.
 *
 * A company that is already in the requested state is returned as it is and
 * nothing is written: no decision was taken, so there is nothing to audit —
 * the same rule `platformUpdateCompany` follows for a patch that changes
 * nothing.
 */
export async function platformSetCompanyStatus(
  input: SetCompanyStatusInput,
): Promise<{ companyId: string; status: CompanyStatus }> {
  const admin = await requirePlatformAdmin();
  const change = parseServerInput(companyStatusSchema, input);

  const company = await readCompanyStatusRow(change.companyId);
  if (company.status === change.status) {
    return { companyId: change.companyId, status: company.status };
  }

  const updated = await writeCompanyStatus(
    change.companyId,
    statusPatch(change.status, change.reason, admin.userId),
  );

  await writePlatformAudit({
    action: "company.status.update",
    entity: "company",
    entityId: change.companyId,
    companyId: change.companyId,
    actorId: admin.userId,
    before: statusSnapshot(company),
    after: statusSnapshot(updated),
  });

  return { companyId: change.companyId, status: updated.status };
}
