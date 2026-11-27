import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type {
  CompanyDomainKind,
  DomainVerificationStatus,
  TablesInsert,
  TablesUpdate,
} from "@/integrations/supabase/database.types";
import { parseServerInput } from "@/lib/parseServerInput";

import { writePlatformAudit } from "./audit";
import {
  createCloudflareCustomHostname,
  readCloudflareCustomHostname,
  type CustomHostnameVerification,
} from "./cloudflare.server";
import { requirePlatformAdmin } from "./requirePlatformAdmin.server";

export type { CustomHostnameVerification };

/**
 * نمط اسم المضيف: حروف وأرقام وشرطات، وكل جزء لا يبدأ أو ينتهي بشرطة.
 *
 * The same shape the server environment accepts for its own hosts, minus the
 * port: a custom domain is a name, never an address with a port.
 */
const HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** مخطط إضافة نطاق مخصّص لشركة. */
export const addCustomDomainSchema = z.object({
  companyId: z.string().uuid(),
  host: z.string().trim().min(1).max(255),
});

/** مدخل إضافة نطاق مخصّص كما تقبله العملية. */
export type AddCustomDomainInput = z.input<typeof addCustomDomainSchema>;

/** مخطط التحقق من نطاق مخصّص. */
export const verifyCustomDomainSchema = z.object({
  domainId: z.string().uuid(),
});

/** مدخل التحقق من نطاق مخصّص كما تقبله العملية. */
export type VerifyCustomDomainInput = z.input<typeof verifyCustomDomainSchema>;

/** نطاق شركة كما تعرضه لوحة المنصة. */
export interface PlatformCompanyDomain {
  id: string;
  companyId: string;
  host: string;
  kind: CompanyDomainKind;
  isPrimary: boolean;
  verificationStatus: DomainVerificationStatus;
  providerRef: string | null;
  verificationRecords: CustomHostnameVerification | null;
  lastCheckedAt: string | null;
}

/**
 * صف النطاق كما تقرأه اللوحة، بعمودَي التحقق اللذين أضافهما الترحيل 331.
 *
 * Declared on its own instead of extending `CompanyDomainRow`, so the shape
 * stays the same whether or not the two columns have reached the generated
 * types yet.
 */
interface CompanyDomainRowWithCheck {
  id: string;
  company_id: string;
  host: string;
  kind: CompanyDomainKind;
  is_primary: boolean;
  verification_status: DomainVerificationStatus;
  provider_ref: string | null;
  verification_records: CustomHostnameVerification | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * حمولة إدراج نطاق: عمودا التحقق الجديدان (الترحيل 331) غير موجودين في
 * الأنواع المحفوظة حتى يضيفهما المشرف، فالحمولة تُوسَم بنوع مستقل.
 */
type CompanyDomainInsert = Omit<
  TablesInsert<"company_domains">,
  "verification_records" | "last_checked_at"
> & {
  verification_records: CustomHostnameVerification | null;
  last_checked_at: string | null;
};

/** حمولة تحديث نطاق: عمودا التحقق الجديدان (الترحيل 331) على ما سبق. */
type CompanyDomainUpdate = Omit<
  TablesUpdate<"company_domains">,
  "verification_records" | "last_checked_at"
> & {
  verification_records: CustomHostnameVerification | null;
  last_checked_at: string | null;
};

/**
 * يحوّل صف النطاق إلى صورة اللوحة.
 */
function toPlatformDomain(row: CompanyDomainRowWithCheck): PlatformCompanyDomain {
  return {
    id: row.id,
    companyId: row.company_id,
    host: row.host,
    kind: row.kind,
    isPrimary: row.is_primary,
    verificationStatus: row.verification_status,
    providerRef: row.provider_ref,
    verificationRecords: row.verification_records,
    lastCheckedAt: row.last_checked_at,
  };
}

/**
 * يطبع اسم المضيف ويحذف النقطة الأخيرة منه.
 *
 * The host is stored lower-case and trimmed (the table's own check constraint
 * demands it), and a trailing dot is the same name written with a root label.
 */
function normalizeCustomHost(rawHost: string): string {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || !HOST_PATTERN.test(host)) {
    throw new Error("DOMAIN_INVALID");
  }
  return host;
}

/**
 * يقرأ مضيف المنصة، ويرفض العمل إن لم يُضبط.
 *
 * Without it the platform cannot tell its own hosts from a company's, and a
 * custom domain could take over the platform's own address.
 */
function platformRootHost(): string {
  const rootHost = (process.env.PLATFORM_ROOT_HOST ?? "").trim().toLowerCase();
  if (!rootHost) {
    throw new Error("PLATFORM_ROOT_HOST must be set before custom domains can be managed");
  }
  return rootHost;
}

/**
 * يرفض المضيف المحجوز: مضيف المنصة، ومضيف لوحة المشرف العام، وأي اسم تحت نطاق المنصة.
 */
function assertHostIsNotReserved(host: string): void {
  const rootHost = platformRootHost();
  const adminHost = (process.env.PLATFORM_ADMIN_HOST ?? "").trim().toLowerCase();
  if (host === adminHost) throw new Error("DOMAIN_RESERVED");
  if (host === rootHost || host.endsWith(`.${rootHost}`)) throw new Error("DOMAIN_RESERVED");
}

/**
 * يرفض المضيف المستعمل في صفّ نطاق آخر، لأن المضيف فريد على المنصة كلها.
 */
async function assertHostIsFree(host: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("company_domains")
    .select("id")
    .eq("host", host)
    .maybeSingle();
  if (error) throw new Error(`company_domains lookup failed: ${error.message}`);
  if (data) throw new Error("DOMAIN_TAKEN");
}

/**
 * يحوّل حالة Cloudflare إلى حالة التحقق التي تحفظها المنصة.
 *
 * Cloudflare's own states, read from the API reference on 2026-11-27:
 * `active` once the hostname serves with its certificate, `pending` while the
 * ownership check is still open, and the blocked, failed and deleted states
 * for a hostname that cannot be activated.
 */
function toVerificationStatus(providerStatus: string): DomainVerificationStatus {
  if (providerStatus === "active") return "verified";
  if (providerStatus === "pending" || providerStatus.startsWith("pending_")) return "pending";
  if (providerStatus === "provisioned") return "pending";
  return "failed";
}

/**
 * يقرأ نطاقاً مخصّصاً بمعرّفه.
 */
async function readDomainRow(domainId: string): Promise<CompanyDomainRowWithCheck> {
  const { data, error } = await supabaseAdmin
    .from("company_domains")
    .select("*")
    .eq("id", domainId)
    .maybeSingle();
  if (error) throw new Error(`company_domains lookup failed: ${error.message}`);
  if (!data) throw new Error("DOMAIN_NOT_FOUND");
  return data as CompanyDomainRowWithCheck;
}

/**
 * يسرد نطاقات شركة: التلقائية والمخصّصة، بحالتها كما يحفظها المنصة.
 *
 * The super admin reads this to see which address a company is reached on and
 * whether the ownership check of a custom domain has passed.
 */
export async function platformListCompanyDomains(
  companyId: string,
): Promise<PlatformCompanyDomain[]> {
  await requirePlatformAdmin();

  const { data, error } = await supabaseAdmin
    .from("company_domains")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`company_domains lookup failed: ${error.message}`);

  return (data ?? []).map((row) => toPlatformDomain(row as CompanyDomainRowWithCheck));
}

/**
 * يكتب صف النطاق الجديد ويعيده كما تقرأه اللوحة.
 *
 * The Cloudflare id travels in the failure message: a row that could not be
 * written leaves a hostname at the provider, and only that id can clean it up.
 */
async function insertCustomDomainRow(payload: CompanyDomainInsert): Promise<PlatformCompanyDomain> {
  const { data, error } = await supabaseAdmin
    .from("company_domains")
    .insert(payload)
    .select("*")
    .single();
  if (error) {
    throw new Error(
      `company_domains insert failed for ${payload.provider_ref ?? "the new hostname"}: ${error.message}`,
    );
  }
  return toPlatformDomain(data as CompanyDomainRowWithCheck);
}

/**
 * يحدّث صف النطاق ويعيده كما تقرأه اللوحة.
 */
async function updateCustomDomainRow(
  domainId: string,
  payload: CompanyDomainUpdate,
): Promise<PlatformCompanyDomain> {
  const { data, error } = await supabaseAdmin
    .from("company_domains")
    .update(payload)
    .eq("id", domainId)
    .select("*")
    .single();
  if (error) throw new Error(`company_domains update failed: ${error.message}`);
  return toPlatformDomain(data as CompanyDomainRowWithCheck);
}

/**
 * يضيف نطاقاً مخصّصاً لشركة: يتحقق من المضيف، ثم يطلبه من Cloudflare، ثم يسجّله.
 *
 * The provider is asked first and the row is written after it answers: a row
 * without `provider_ref` could never be verified later, while a hostname that
 * Cloudflare rejected never reaches the database at all. The row starts
 * `pending` — only the ownership check moves it to `verified`.
 */
export async function platformAddCustomDomain(
  input: AddCustomDomainInput,
): Promise<PlatformCompanyDomain> {
  const { userId: actorId } = await requirePlatformAdmin();
  const { companyId, host } = addCustomDomainSchema.parse(input);

  const normalizedHost = normalizeCustomHost(host);
  assertHostIsNotReserved(normalizedHost);
  await assertHostIsFree(normalizedHost);

  const created = await createCloudflareCustomHostname(normalizedHost);

  const domain = await insertCustomDomainRow({
    company_id: companyId,
    host: normalizedHost,
    kind: "custom",
    is_primary: false,
    verification_status: "pending",
    provider_ref: created.id,
    verification_records: created.verification,
    last_checked_at: new Date().toISOString(),
  });

  await writePlatformAudit({
    action: "company.domain.add",
    entity: "company_domain",
    entityId: domain.id,
    companyId,
    actorId,
    before: null,
    after: {
      host: domain.host,
      verificationStatus: domain.verificationStatus,
      providerRef: domain.providerRef,
    },
  });

  return domain;
}

/**
 * يقرأ حالة النطاق من المزوّد ويحدّث حالة التحقق في المنصة.
 *
 * The status is Cloudflare's, never the platform's guess: the ownership check
 * and the certificate both live at the provider, and only the provider knows
 * when the company published the record it was asked for.
 */
export async function platformVerifyCustomDomain(
  input: VerifyCustomDomainInput,
): Promise<PlatformCompanyDomain> {
  const { userId: actorId } = await requirePlatformAdmin();
  const { domainId } = verifyCustomDomainSchema.parse(input);

  const row = await readDomainRow(domainId);
  if (!row.provider_ref) throw new Error("DOMAIN_NOT_CLOUDFLARE");

  const providerStatus = await readCloudflareCustomHostname(row.provider_ref);

  const domain = await updateCustomDomainRow(domainId, {
    verification_status: toVerificationStatus(providerStatus.status),
    verification_records: providerStatus.verification,
    last_checked_at: new Date().toISOString(),
  });

  await writePlatformAudit({
    action: "company.domain.verify",
    entity: "company_domain",
    entityId: domain.id,
    companyId: domain.companyId,
    actorId,
    before: { verificationStatus: row.verification_status },
    after: { verificationStatus: domain.verificationStatus },
  });

  return domain;
}

/**
 * رمز رفض الطلب الذي لا يحمل جلسة مشرف منصة.
 *
 * The platform guard authenticates the caller from the request, and the
 * browser session lives in local storage rather than in a cookie, so the
 * token has to travel with the call.
 */
const NO_PLATFORM_SESSION = "PLATFORM_ADMIN_REQUIRED";

/**
 * ينفّذ عملية لوحة منصة مرفقاً بها رمز جلسة المشرف العام.
 */
async function callPlatformOperation<TOutput>(
  serverFn: (options: { data: unknown; headers: { Authorization: string } }) => Promise<TOutput>,
  input: unknown,
): Promise<TOutput> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error(NO_PLATFORM_SESSION);
  return serverFn({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}

/** يقرأ نطاقات شركة. */
const listCompanyDomainsFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(z.object({ companyId: z.string().uuid() }), data))
  .handler(async ({ data }) => platformListCompanyDomains(data.companyId));

/** يضيف نطاقاً مخصّصاً لشركة. */
const addCustomDomainFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(addCustomDomainSchema, data))
  .handler(async ({ data }) => platformAddCustomDomain(data));

/** يقرأ حالة نطاق مخصّص من المزوّد ويحدّثها. */
const verifyCustomDomainFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseServerInput(verifyCustomDomainSchema, data))
  .handler(async ({ data }) => platformVerifyCustomDomain(data));

/** يقرأ نطاقات شركة من المتصفح، مع رمز الجلسة. */
export function fetchPlatformCompanyDomains(input: {
  companyId: string;
}): Promise<PlatformCompanyDomain[]> {
  return callPlatformOperation(listCompanyDomainsFn, input);
}

/** يضيف نطاقاً مخصّصاً من المتصفح، مع رمز الجلسة. */
export function addPlatformCustomDomain(
  input: AddCustomDomainInput,
): Promise<PlatformCompanyDomain> {
  return callPlatformOperation(addCustomDomainFn, input);
}

/** يتحقق من نطاق مخصّص من المتصفح، مع رمز الجلسة. */
export function verifyPlatformCustomDomain(
  input: VerifyCustomDomainInput,
): Promise<PlatformCompanyDomain> {
  return callPlatformOperation(verifyCustomDomainFn, input);
}
