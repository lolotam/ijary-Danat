import { z } from "zod";

import type { CompanyLimitsRow } from "@/integrations/supabase/database.types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { writePlatformAudit } from "./audit";
import { requirePlatformAdmin } from "./requirePlatformAdmin.server";

/**
 * المخططات الحقلية لحدود الشركة: `null` تعني بلا حد، والصفر حد صالح يمنع كل إضافة.
 *
 * The check constraints in migration 323 accept exactly these values. Keeping
 * the same rule here means a form cannot send a negative or fractional ceiling
 * that the database would refuse with an opaque constraint error.
 */
const limitSchema = z.number().int().min(0).nullable();

/** مدخل تعديل حدود شركة كما تقبله العملية والمتصفح. */
export const setLimitsSchema = z.object({
  companyId: z.string().uuid(),
  maxUnits: limitSchema,
  maxStaffUsers: limitSchema,
  maxWhatsappPerMonth: limitSchema,
  maxStorageBytes: limitSchema,
});

/** مدخل تعديل حدود شركة كما تقبله العملية والمتصفح. */
export type SetLimitsInput = z.infer<typeof setLimitsSchema>;

/** حدود شركة واحدة كما يقرأها مشرف المنصة. */
export type PlatformLimits = Omit<SetLimitsInput, "companyId"> & { companyId: string };

/** الأعمدة التي يقرأها مشرف المنصة من صف الحدود. */
type LimitsReadRow = Pick<
  CompanyLimitsRow,
  "company_id" | "max_units" | "max_staff_users" | "max_whatsapp_per_month" | "max_storage_bytes"
>;

/** الحقول القابلة للتغيير، مرتبة كما تظهر في النموذج والسجل. */
const LIMIT_FIELDS = [
  "maxUnits",
  "maxStaffUsers",
  "maxWhatsappPerMonth",
  "maxStorageBytes",
] as const satisfies ReadonlyArray<keyof PlatformLimits>;

/**
 * يحوّل صف الحدود إلى صورة العملية، مع اعتبار الصف الغائب حدوداً غير محدودة.
 */
function toLimits(row: LimitsReadRow | null, companyId: string): PlatformLimits {
  if (!row) {
    return {
      companyId,
      maxUnits: null,
      maxStaffUsers: null,
      maxWhatsappPerMonth: null,
      maxStorageBytes: null,
    };
  }
  return {
    companyId: row.company_id,
    maxUnits: row.max_units,
    maxStaffUsers: row.max_staff_users,
    maxWhatsappPerMonth: row.max_whatsapp_per_month,
    maxStorageBytes: row.max_storage_bytes,
  };
}

/**
 * يقرأ حدود شركة واحدة من صفها، أو القيم الافتراضية إن لم يكن لها صف بعد.
 */
async function readLimits(companyId: string): Promise<PlatformLimits> {
  const { data, error } = await supabaseAdmin
    .from("company_limits")
    .select("company_id, max_units, max_staff_users, max_whatsapp_per_month, max_storage_bytes")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw new Error(`company_limits lookup failed: ${error.message}`);
  return toLimits(data, companyId);
}

/**
 * يقرأ حدود شركة لعرضها على مشرف المنصة.
 */
export async function platformGetLimits(companyId: string): Promise<PlatformLimits> {
  await requirePlatformAdmin();
  return readLimits(companyId);
}

/**
 * يحدّث حدود شركة ويكتب سطر تدقيق واحداً بالحالة قبل وبعد.
 *
 * The guard runs before any read: a refused caller must leave no trace (SC-015).
 * A request that changes nothing writes neither a row nor an audit entry, and
 * lowering a ceiling never deletes existing data — it only blocks new adds.
 */
export async function platformSetLimits(input: SetLimitsInput): Promise<PlatformLimits> {
  const { userId: actorId } = await requirePlatformAdmin();
  const limits = setLimitsSchema.parse(input);

  const before = await readLimits(limits.companyId);
  const after: PlatformLimits = {
    companyId: limits.companyId,
    maxUnits: limits.maxUnits,
    maxStaffUsers: limits.maxStaffUsers,
    maxWhatsappPerMonth: limits.maxWhatsappPerMonth,
    maxStorageBytes: limits.maxStorageBytes,
  };
  if (LIMIT_FIELDS.every((field) => before[field] === after[field])) return before;

  const { error } = await supabaseAdmin.from("company_limits").upsert(
    {
      company_id: after.companyId,
      max_units: after.maxUnits,
      max_staff_users: after.maxStaffUsers,
      max_whatsapp_per_month: after.maxWhatsappPerMonth,
      max_storage_bytes: after.maxStorageBytes,
      updated_by: actorId,
    },
    { onConflict: "company_id" },
  );
  if (error) throw new Error(`company_limits upsert failed: ${error.message}`);

  await writePlatformAudit({
    action: "company.limits.update",
    entity: "company",
    entityId: after.companyId,
    companyId: after.companyId,
    actorId,
    before,
    after,
  });
  return after;
}
