import { z } from "zod";

import { companySubdomainHost } from "@/company/hostCompany.server";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { CompanyStatus, Database } from "@/integrations/supabase/database.types";
import { parseServerInput } from "@/lib/parseServerInput";
import { writePlatformAudit } from "@/platform/audit";
import { deleteAuthUser } from "@/platform/authAdmin.server";
import { COMPANY_NOT_FOUND, createPlatformStaffAccount } from "@/platform/companyStaffAccount";
import { requirePlatformAdmin } from "@/platform/requirePlatformAdmin.server";
import { assertSlugAvailable, assertValidCompanySlug, SLUG_IMMUTABLE } from "@/platform/slug";

/**
 * عمليات سوبر الأدمن على الشركات: إنشاء شركة بمديرها الأول، وسرد الشركات،
 * وتعديل بياناتها.
 *
 * A company is never deleted — there is no delete grant on the table, and
 * suspension is the only way its access is withdrawn (migration 254). A
 * creation that fails halfway therefore leaves a suspended company behind,
 * not a deleted one.
 */

/** الحد الأقصى لعدد الشركات في صفحة واحدة. */
const MAX_PAGE_SIZE = 200;

/** حجم الصفحة الافتراضي. */
const DEFAULT_PAGE_SIZE = 50;

/** سبب الإيقاف الذي تحمله شركة فشل إنشاؤها. */
const CREATION_FAILED_REASON = "creation failed";

/** صف الشركة كما تعرضه لوحة المنصة. */
export type PlatformCompanyRow = {
  id: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  status: CompanyStatus;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  addressAr: string | null;
  addressEn: string | null;
  createdAt: string;
};

/** صف الشركة في قائمة الشركات، بعدد حساباتها. */
export type PlatformCompanySummary = PlatformCompanyRow & {
  userCount: number;
};

/** صف الشركة الخام كما يقرأ من قاعدة البيانات. */
type CompanyRowRecord = {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  status: CompanyStatus;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  address_ar: string | null;
  address_en: string | null;
  created_at: string;
};

/** أعمدة الشركة التي تقرأها اللوحة وتكتبها عمليات التحديث. */
const COMPANY_COLUMNS =
  "id, slug, name_ar, name_en, status, email, phone, whatsapp, address_ar, address_en, created_at";

/** يحوّل صف الشركة الخام إلى الشكل الذي تعرضه اللوحة. */
function toCompanyRow(row: CompanyRowRecord): PlatformCompanyRow {
  return {
    id: row.id,
    slug: row.slug,
    nameAr: row.name_ar,
    nameEn: row.name_en,
    status: row.status,
    email: row.email,
    phone: row.phone,
    whatsapp: row.whatsapp,
    addressAr: row.address_ar,
    addressEn: row.address_en,
    createdAt: row.created_at,
  };
}

/**
 * يبني حمولة سطر التدقيق من صف الشركة.
 *
 * The audit log records what changed in the database's own words — the column
 * names — so a row can be read without the screen that wrote it.
 */
function companyAuditSnapshot(row: CompanyRowRecord): {
  name_ar: string;
  name_en: string;
  status: CompanyStatus;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  address_ar: string | null;
  address_en: string | null;
} {
  return {
    name_ar: row.name_ar,
    name_en: row.name_en,
    status: row.status,
    email: row.email,
    phone: row.phone,
    whatsapp: row.whatsapp,
    address_ar: row.address_ar,
    address_en: row.address_en,
  };
}

/**
 * يكتب صف الشركة ويعيد معرّفها.
 */
async function insertCompanyRow(nameAr: string, nameEn: string, slug: string): Promise<string> {
  const inserted = await supabaseAdmin
    .from("companies")
    .insert({ name_ar: nameAr, name_en: nameEn, slug })
    .select("id")
    .single();

  if (inserted.error || !inserted.data) {
    throw new Error(
      `company insert failed: ${inserted.error?.message ?? "the insert returned no row"}`,
    );
  }
  return inserted.data.id;
}

/**
 * يسجل نطاق الشركة الفرعي.
 *
 * The subdomain row is created with the company and is always verified — the
 * database refuses a subdomain row that is not.
 */
async function createSubdomainRow(companyId: string, host: string): Promise<void> {
  const domain = await supabaseAdmin.from("company_domains").insert({
    company_id: companyId,
    host,
    kind: "subdomain",
    is_primary: true,
    verification_status: "verified",
  });

  if (domain.error) {
    throw new Error(`company_domains insert failed: ${domain.error.message}`);
  }
}

/**
 * يهبّئ الشركة بالأدوار والقوالب والقوائم وسير العمل والأقسام والحدود.
 *
 * The copies come from the platform's own catalogue (`platform.default_rows`),
 * so no company begins with an empty panel or with another company's rows.
 */
async function seedCompanyDefaults(companyId: string): Promise<void> {
  const seeded = await supabaseAdmin.rpc("seed_company_defaults", { _company_id: companyId });

  if (seeded.error) {
    throw new Error(`seed_company_defaults failed: ${seeded.error.message}`);
  }
}

/**
 * يوقف الشركة التي فشل إنشاؤها ويمحو حساب المدير الأول، ثم يبلّغ عن الفشل.
 *
 * The company row stays: there is no delete grant on `companies`, and a row
 * left active would be a company with no administrator and a live address.
 * Suspending it takes it out of reach, and the reason on the row says why.
 *
 * Every problem met here is reported, never swallowed: the caller gets the
 * original failure and everything that could not be undone.
 */
async function unwindFailedCreation(
  companyId: string,
  actorId: string,
  slug: string,
  userId: string | null,
  cause: unknown,
): Promise<never> {
  const problems: string[] = [];

  if (userId) {
    const deleted = await deleteAuthUser(userId);
    if (deleted.error) {
      problems.push(`the administrator account could not be deleted: ${deleted.error.message}`);
    }
  }

  const suspended = await supabaseAdmin
    .from("companies")
    .update({
      status: "suspended",
      suspended_at: new Date().toISOString(),
      suspended_reason: CREATION_FAILED_REASON,
      suspended_by: actorId,
    })
    .eq("id", companyId);

  if (suspended.error) {
    problems.push(`the company could not be suspended: ${suspended.error.message}`);
  }

  try {
    await writePlatformAudit({
      action: "company.create_failed",
      entity: "company",
      entityId: companyId,
      companyId,
      actorId,
      before: null,
      after: { slug, status: "suspended", reason: CREATION_FAILED_REASON },
    });
  } catch (auditError) {
    problems.push(
      `the platform audit row could not be written: ${auditError instanceof Error ? auditError.message : String(auditError)}`,
    );
  }

  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  throw new Error(
    problems.length > 0
      ? `company creation failed: ${causeMessage} (${problems.join("; ")})`
      : `company creation failed: ${causeMessage}`,
  );
}

const createCompanySchema = z.object({
  nameAr: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(64),
  firstAdmin: z.object({
    fullName: z.string().trim().min(1).max(120),
    username: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional()
      .nullable(),
    email: z.string().trim().email().max(320).optional().nullable(),
    phone: z.string().trim().max(32).optional().nullable(),
  }),
});

/** الحمولة التي يسجّلها سجل تدقيق المنصة عند إنشاء شركة. */
function companyCreationAuditPayload(
  creation: z.infer<typeof createCompanySchema>,
  host: string,
): Record<string, string | null> {
  return {
    name_ar: creation.nameAr,
    name_en: creation.nameEn,
    slug: creation.slug,
    host,
    first_admin: creation.firstAdmin.username ?? creation.firstAdmin.email ?? null,
  };
}

/**
 * ينشئ شركة بمديرها الأول، ويعيد معرّفها ونطاقها وكلمة المرور المؤقتة.
 *
 * The temporary password is returned once and never written anywhere: not to
 * a row, not to the audit payload, not to a log line. The account is flagged
 * `must_change_password`, so the password is spent at the first sign-in.
 */
export async function platformCreateCompany(input: {
  nameAr: string;
  nameEn: string;
  slug: string;
  firstAdmin: {
    fullName: string;
    username?: string | null;
    email?: string | null;
    phone?: string | null;
  };
}): Promise<{ companyId: string; host: string; tempPassword: string }> {
  const admin = await requirePlatformAdmin();
  const creation = parseServerInput(createCompanySchema, input);

  assertValidCompanySlug(creation.slug);
  await assertSlugAvailable(creation.slug);

  const host = companySubdomainHost(creation.slug);
  const companyId = await insertCompanyRow(creation.nameAr, creation.nameEn, creation.slug);

  let adminUserId: string | null = null;
  try {
    await createSubdomainRow(companyId, host);
    await seedCompanyDefaults(companyId);

    const account = await createPlatformStaffAccount({
      grantedBy: admin.userId,
      companyId,
      fullName: creation.firstAdmin.fullName,
      username: creation.firstAdmin.username,
      email: creation.firstAdmin.email,
      phone: creation.firstAdmin.phone,
      role: "admin",
    });
    adminUserId = account.userId;

    await writePlatformAudit({
      action: "company.create",
      entity: "company",
      entityId: companyId,
      companyId,
      actorId: admin.userId,
      before: null,
      after: companyCreationAuditPayload(creation, host),
    });

    return { companyId, host, tempPassword: account.tempPassword };
  } catch (cause) {
    return unwindFailedCreation(companyId, admin.userId, creation.slug, adminUserId, cause);
  }
}

const listCompaniesSchema = z.object({
  status: z.enum(["active", "suspended"]).optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.number().int().min(0).optional(),
});

/**
 * يسرد شركات المنصة مع حالتها وعدد حسابات كل منها.
 *
 * The account count comes from one query over the listed companies rather than
 * one count query per company: the panel shows a whole page of companies at
 * once, and a count per row would turn one page into dozens of round trips.
 */
export async function platformListCompanies(input: {
  status?: CompanyStatus;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: PlatformCompanySummary[]; count: number }> {
  await requirePlatformAdmin();
  const listing = parseServerInput(listCompaniesSchema, input);

  let query = supabaseAdmin.from("companies").select(COMPANY_COLUMNS, { count: "exact" });

  if (listing.status) {
    query = query.eq("status", listing.status);
  }

  if (listing.search) {
    const term = normalizePostgrestSearch(listing.search);
    if (term) {
      query = query.or(`name_ar.ilike.%${term}%,name_en.ilike.%${term}%,slug.ilike.%${term}%`);
    }
  }

  const {
    data: companies,
    error,
    count,
  } = await query
    .order("created_at", { ascending: false })
    .range(listing.offset ?? 0, (listing.offset ?? 0) + (listing.limit ?? DEFAULT_PAGE_SIZE) - 1);

  if (error) {
    throw new Error(`companies lookup failed: ${error.message}`);
  }

  const rows = companies ?? [];
  const userCounts = await countAccountsPerCompany(rows.map((row) => row.id));

  return {
    rows: rows.map((row) => ({
      ...toCompanyRow(row),
      userCount: userCounts.get(row.id) ?? 0,
    })),
    count: count ?? rows.length,
  };
}

/**
 * يعدّ حسابات كل شركة في القائمة، بجملة واحدة.
 */
async function countAccountsPerCompany(companyIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (companyIds.length === 0) {
    return counts;
  }

  const { data: profiles, error } = await supabaseAdmin
    .from("profiles")
    .select("company_id")
    .in("company_id", companyIds);

  if (error) {
    throw new Error(`profiles count failed: ${error.message}`);
  }

  for (const profile of profiles ?? []) {
    if (!profile.company_id) continue;
    counts.set(profile.company_id, (counts.get(profile.company_id) ?? 0) + 1);
  }
  return counts;
}

const updateCompanySchema = z.object({
  companyId: z.string().uuid(),
  nameAr: z.string().trim().min(1).max(120).optional(),
  nameEn: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().max(320).optional().nullable(),
  phone: z.string().trim().max(32).optional().nullable(),
  whatsapp: z.string().trim().max(32).optional().nullable(),
  addressAr: z.string().trim().max(240).optional().nullable(),
  addressEn: z.string().trim().max(240).optional().nullable(),
  slug: z.string().optional(),
});

/**
 * يبني ما يتغيّر في صف الشركة من طلب التحديث.
 *
 * A field the request did not mention stays out of the patch, so a partial
 * update never blanks the fields it says nothing about.
 */
function companyPatchFromInput(
  update: z.infer<typeof updateCompanySchema>,
): Database["public"]["Tables"]["companies"]["Update"] {
  const patch: Database["public"]["Tables"]["companies"]["Update"] = {};
  if (update.nameAr !== undefined) patch.name_ar = update.nameAr;
  if (update.nameEn !== undefined) patch.name_en = update.nameEn;
  if (update.email !== undefined) patch.email = update.email;
  if (update.phone !== undefined) patch.phone = update.phone;
  if (update.whatsapp !== undefined) patch.whatsapp = update.whatsapp;
  if (update.addressAr !== undefined) patch.address_ar = update.addressAr;
  if (update.addressEn !== undefined) patch.address_en = update.addressEn;
  return patch;
}

/**
 * يحدّث اسم الشركة وبيانات الاتصال بها.
 *
 * The short name is not editable: the database freezes `companies.slug` after
 * the insert (migration 254), because the company's address is built on it.
 * A request that carries one is refused rather than ignored, so the panel
 * never reports a change that did not happen.
 */
export async function platformUpdateCompany(input: {
  companyId: string;
  nameAr?: string;
  nameEn?: string;
  email?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  addressAr?: string | null;
  addressEn?: string | null;
  slug?: string;
}): Promise<PlatformCompanyRow> {
  const admin = await requirePlatformAdmin();
  const update = parseServerInput(updateCompanySchema, input);

  if (update.slug !== undefined) {
    throw new Error(SLUG_IMMUTABLE);
  }

  const { data: company, error: lookupError } = await supabaseAdmin
    .from("companies")
    .select(COMPANY_COLUMNS)
    .eq("id", update.companyId)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`company lookup failed: ${lookupError.message}`);
  }
  if (!company) {
    throw new Error(COMPANY_NOT_FOUND);
  }

  const patch = companyPatchFromInput(update);
  if (Object.keys(patch).length === 0) {
    // Nothing changed, so nothing is audited: an audit row would claim a
    // mutation that never happened.
    return toCompanyRow(company);
  }

  const updated = await supabaseAdmin
    .from("companies")
    .update(patch)
    .eq("id", update.companyId)
    .select(COMPANY_COLUMNS)
    .single();

  if (updated.error || !updated.data) {
    throw new Error(
      `company update failed: ${updated.error?.message ?? "the update returned no row"}`,
    );
  }

  await writePlatformAudit({
    action: "company.update",
    entity: "company",
    entityId: update.companyId,
    companyId: update.companyId,
    actorId: admin.userId,
    before: companyAuditSnapshot(company),
    after: companyAuditSnapshot(updated.data),
  });

  return toCompanyRow(updated.data);
}
