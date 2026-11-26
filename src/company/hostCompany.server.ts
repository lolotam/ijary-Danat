import { type HostResolution, type RequestCompany } from "@/company/requestCompany.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { CompanyStatus } from "@/integrations/supabase/database.types";

const HOST_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 1_000;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

interface HostCacheEntry {
  resolution: HostResolution;
  expiresAt: number;
}

export interface HostLookupDeps {
  findDomainCompany?: (host: string) => Promise<RequestCompany | null>;
  findCompanyBySlug?: (slug: string) => Promise<RequestCompany | null>;
  rootHost?: string;
  adminHost?: string;
  now?: () => number;
}

const hostCache = new Map<string, HostCacheEntry>();

/**
 * يطبع اسم المضيف بأحرف صغيرة ويزيل أي منفذ أو مضيفين مضافين في الترويسة.
 */
export function normalizeHost(rawHost: string | null | undefined): string {
  if (!rawHost) return "";
  const first = rawHost.split(",")[0]?.trim().toLowerCase() ?? "";
  if (!first) return "";

  if (first.startsWith("[")) {
    const closingIdx = first.indexOf("]");
    return closingIdx === -1 ? first : first.slice(0, closingIdx + 1);
  }

  return first.replace(/:\d+$/, "");
}

/**
 * يستخرج اسم المضيف المطبَّع من طلب HTTP، ولا يقرأ X-Forwarded-Host إلا خلف وكيل موثوق.
 *
 * Any client can send `X-Forwarded-Host`, and the host picks the company, so
 * trusting it unconditionally let a request to one company's address run under
 * another company's context. Traefik routes on `Host` and passes it through
 * unchanged, so `Host` is the default; set `TRUST_FORWARDED_HOST=true` only
 * when a proxy in front overwrites `X-Forwarded-Host` itself.
 */
export function extractRequestHost(
  request: Request,
  trustForwardedHost = process.env.TRUST_FORWARDED_HOST === "true",
): string {
  const forwarded = trustForwardedHost ? request.headers.get("x-forwarded-host") : null;
  if (forwarded && forwarded.trim()) {
    return normalizeHost(forwarded);
  }

  const hostHeader = request.headers.get("host");
  if (hostHeader && hostHeader.trim()) {
    return normalizeHost(hostHeader);
  }

  try {
    return normalizeHost(new URL(request.url).host);
  } catch {
    return "";
  }
}

/**
 * يستخرج المعرّف المختصر للشركة من نطاق فرعي بمستوى واحد تحت مضيف الجذر (`<slug>.<root>`).
 */
export function extractSubdomainSlug(hostname: string, rootHost: string): string | null {
  const suffix = `.${rootHost}`;
  if (!rootHost || !hostname.endsWith(suffix)) return null;
  const slug = hostname.slice(0, -suffix.length);
  return SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * يقرأ أسماء مضيفي الجذر والإدارة من متغيرات البيئة مع قيم تطوير افتراضية.
 */
function readPlatformHosts(deps?: HostLookupDeps): { rootHost: string; adminHost: string } {
  const rootHost = normalizeHost(deps?.rootHost ?? process.env.PLATFORM_ROOT_HOST ?? "localhost");
  const adminHost = normalizeHost(
    deps?.adminHost ?? process.env.PLATFORM_ADMIN_HOST ?? "admin.localhost",
  );
  return { rootHost, adminHost };
}

/**
 * يحفظ نتيجة حسم المضيف في ذاكرة التخزين المؤقت لمدة 60 ثانية مع سقف للحجم.
 */
function setCachedResolution(host: string, resolution: HostResolution, nowMs: number): void {
  if (hostCache.size >= MAX_CACHE_ENTRIES && !hostCache.has(host)) {
    const oldestKey = hostCache.keys().next().value;
    if (oldestKey !== undefined) {
      hostCache.delete(oldestKey);
    }
  }
  hostCache.set(host, { resolution, expiresAt: nowMs + HOST_CACHE_TTL_MS });
}

/**
 * يفرغ ذاكرة التخزين المؤقت لحسم المضيفين (يُستخدم في الاختبارات أو عند تغيير النطاقات).
 */
export function clearHostCompanyCache(): void {
  hostCache.clear();
}

/**
 * يحوّل صف الشركة الخام إلى كائن RequestCompany قياسي.
 */
function toRequestCompany(
  row: { id: string; slug: string; status: CompanyStatus },
  host: string,
): RequestCompany {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    host,
  };
}

/**
 * يبحث في قاعدة البيانات عن شركة مرتبطة بنطاق متحقق منه في `company_domains`.
 */
async function queryDomainCompany(host: string): Promise<RequestCompany | null> {
  const { data: domainRow, error: domainError } = await supabaseAdmin
    .from("company_domains")
    .select("company_id")
    .eq("host", host)
    .eq("verification_status", "verified")
    .maybeSingle();

  if (domainError) {
    throw new Error(`company_domains lookup failed: ${domainError.message}`);
  }
  if (!domainRow) return null;

  const { data: companyRow, error: companyError } = await supabaseAdmin
    .from("companies")
    .select("id, slug, status")
    .eq("id", domainRow.company_id)
    .maybeSingle();

  if (companyError) {
    throw new Error(`companies lookup failed: ${companyError.message}`);
  }
  return companyRow ? toRequestCompany(companyRow, host) : null;
}

/**
 * يبحث في قاعدة البيانات عن شركة بالمعرّف المختصر لحسم `<slug>.<root>`.
 */
async function queryCompanyBySlug(slug: string, host: string): Promise<RequestCompany | null> {
  const { data: companyRow, error: companyError } = await supabaseAdmin
    .from("companies")
    .select("id, slug, status")
    .eq("slug", slug)
    .maybeSingle();

  if (companyError) {
    throw new Error(`companies slug lookup failed: ${companyError.message}`);
  }
  return companyRow ? toRequestCompany(companyRow, host) : null;
}

/**
 * يحسم المضيف: نطاق متحقق منه في `company_domains` أولاً، ثم `<slug>.<root>` بالمعرّف المختصر.
 *
 * Nothing writes `subdomain` rows to `company_domains`, so every company's
 * automatic address resolves through its slug; `company_domains` carries the
 * verified custom domains.
 */
async function lookupCompanyForHost(
  host: string,
  rootHost: string,
  deps?: HostLookupDeps,
): Promise<{ company: RequestCompany | null; cacheable: boolean }> {
  try {
    const findDomain = deps?.findDomainCompany ?? queryDomainCompany;
    const domainCompany = await findDomain(host);
    if (domainCompany) {
      return { company: domainCompany, cacheable: true };
    }

    const slug = extractSubdomainSlug(host, rootHost);
    if (slug) {
      const findBySlug =
        deps?.findCompanyBySlug ?? ((candidate: string) => queryCompanyBySlug(candidate, host));
      const slugCompany = await findBySlug(slug);
      if (slugCompany) {
        return { company: slugCompany, cacheable: true };
      }
    }

    return { company: null, cacheable: true };
  } catch (error) {
    // Do not cache transient database failures so the next request recovers immediately.
    console.error(
      "[company/hostCompany] Failed to resolve host:",
      error instanceof Error ? error.message : String(error),
    );
    return { company: null, cacheable: false };
  }
}

/**
 * يحسم هوية المضيف إلى صفحة المنصة الرئيسية أو لوحة المشرف العام أو شركة محددة أو مضيف غير معروف.
 *
 * Uses a 60-second in-memory cache (`HOST_CACHE_TTL_MS`) for company and unknown
 * lookups so suspension or domain changes propagate within one minute.
 */
export async function resolveHostCompany(
  rawHost: string | null | undefined,
  deps?: HostLookupDeps,
): Promise<HostResolution> {
  const host = normalizeHost(rawHost);
  if (!host) {
    return { kind: "unknown", host: "", company: null };
  }

  const { rootHost, adminHost } = readPlatformHosts(deps);
  if (host === adminHost) {
    return { kind: "platform_admin", host, company: null };
  }
  if (host === rootHost) {
    return { kind: "platform_root", host, company: null };
  }

  const nowMs = (deps?.now ?? Date.now)();
  const cached = hostCache.get(host);
  if (cached && cached.expiresAt > nowMs) {
    return cached.resolution;
  }

  const { company, cacheable } = await lookupCompanyForHost(host, rootHost, deps);
  const resolution: HostResolution = company
    ? { kind: "company", host, company }
    : { kind: "unknown", host, company: null };

  if (cacheable) {
    setCachedResolution(host, resolution, nowMs);
  }
  return resolution;
}

/**
 * يبني عنوان الشركة التلقائي `<slug>.<root>` من المعرّف المختصر.
 */
export function companySubdomainHost(slug: string): string {
  return `${slug}.${readPlatformHosts().rootHost}`;
}

/**
 * يعيد قائمة الشركات النشطة لتشغيل المهام الدورية المعزولة لكل شركة.
 */
export async function listActiveCompanies(): Promise<RequestCompany[]> {
  const { data, error } = await supabaseAdmin
    .from("companies")
    .select("id, slug, status")
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Could not list active companies: ${error.message}`);
  }

  return (data ?? []).map((row) => toRequestCompany(row, companySubdomainHost(row.slug)));
}
