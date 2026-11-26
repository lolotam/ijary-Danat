import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { actAsSuperuser } from "@/db/testDb";
import type { AppRole, CompanyStatus } from "@/integrations/supabase/database.types";

/** جميع الأدوار الخمسة داخل كل شركة للاختبار متعدد الشركات. */
export const COMPANY_ROLES = ["admin", "accountant", "collector", "readonly", "tenant"] as const;

export interface SeededCompanyUser {
  id: string;
  role: AppRole;
  companyId: string;
  email: string;
  username: string;
  tenantId: string | null;
}

export interface SeededCompany {
  id: string;
  slug: string;
  host: string;
  users: Record<AppRole, SeededCompanyUser>;
}

export interface TwoCompaniesFixture {
  A: SeededCompany;
  B: SeededCompany;
}

export interface SeedTwoCompaniesOptions {
  statusA?: CompanyStatus;
  statusB?: CompanyStatus;
}

export interface CompanyServiceClaimOptions {
  allowSuspended?: boolean;
  extraClaims?: Record<string, unknown>;
}

/**
 * ينشئ شركة تجريبية مع نطاقها الفرعي وحساباً واحداً لكل دور من أدوارها الخمسة.
 *
 * Uses a random tag per call so multiple fixtures coexist inside rolled-back
 * SQL test transactions without colliding on `slug`, `host`, or `username`.
 */
async function seedSingleCompany(
  client: PoolClient,
  label: "a" | "b",
  tag: string,
  status: CompanyStatus,
): Promise<SeededCompany> {
  const slug = `co-${label}-${tag}`;
  const host = `${slug}.ijary.app`;
  const isSuspended = status === "suspended";

  const { rows: companyRows } = await client.query<{ id: string }>(
    `insert into public.companies (
       name_ar, name_en, slug, status, suspended_at, suspended_reason
     ) values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [
      `شركة ${label.toUpperCase()} ${tag}`,
      `Company ${label.toUpperCase()} ${tag}`,
      slug,
      status,
      isSuspended ? new Date().toISOString() : null,
      isSuspended ? "Suspended in test fixture" : null,
    ],
  );
  const companyId = companyRows[0].id;

  await client.query(
    `insert into public.company_domains (company_id, host, kind, is_primary, verification_status)
     values ($1, $2, 'subdomain', true, 'verified')`,
    [companyId, host],
  );

  const users = {} as Record<AppRole, SeededCompanyUser>;
  for (const role of COMPANY_ROLES) {
    users[role] = await seedCompanyUser(client, companyId, slug, role, tag);
  }

  return { id: companyId, slug, host, users };
}

/**
 * ينشئ مستخدماً في `auth.users` وملفه الشخصي ودوره، ويربط سجل مستأجر عند دور المستأجر.
 */
async function seedCompanyUser(
  client: PoolClient,
  companyId: string,
  slug: string,
  role: AppRole,
  tag: string,
): Promise<SeededCompanyUser> {
  const userId = randomUUID();
  const syntheticEmail = `${userId}@auth.ijary.invalid`;
  const username = `${slug}_${role}_${tag}`;
  let tenantId: string | null = null;

  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, syntheticEmail],
  );

  if (role === "tenant") {
    const { rows: tenantRows } = await client.query<{ id: string }>(
      `insert into public.tenants (code, company_id, name, lifecycle)
       values ($1, $2, $3, 'active')
       returning id`,
      [`T-${slug}-${tag}`, companyId, `مستأجر ${slug} ${tag}`],
    );
    tenantId = tenantRows[0].id;
  }

  // `on_auth_user_created` already inserts a `profiles` row; update it so
  // `company_id`, `username`, and `tenant_id` match the seeded company cleanly.
  await client.query(
    `insert into public.profiles (id, company_id, username, display_name, email, is_active, tenant_id)
     values ($1, $2, $3, $4, $5, true, $6)
     on conflict (id) do update
       set company_id = excluded.company_id,
           username = excluded.username,
           display_name = excluded.display_name,
           email = excluded.email,
           is_active = true,
           tenant_id = excluded.tenant_id`,
    [userId, companyId, username, `${slug} ${role}`, syntheticEmail, tenantId],
  );

  await client.query(
    `insert into public.user_roles (user_id, role) values ($1, $2::public.app_role)`,
    [userId, role],
  );

  return {
    id: userId,
    role,
    companyId,
    email: syntheticEmail,
    username,
    tenantId,
  };
}

/**
 * يُنشئ شركتين (A و B) في قاعدة الاختبار مع مستخدم واحد لكل دور في كل شركة.
 */
export async function seedTwoCompanies(
  client: PoolClient,
  opts?: SeedTwoCompaniesOptions,
): Promise<TwoCompaniesFixture> {
  const tag = randomUUID().replace(/-/g, "").slice(0, 8);
  const A = await seedSingleCompany(client, "a", tag, opts?.statusA ?? "active");
  const B = await seedSingleCompany(client, "b", tag, opts?.statusB ?? "active");
  return { A, B };
}

/**
 * يبدّل هوية الاتصال الحالية إلى مستخدم مصادق (`authenticated`) ضمن المعاملة الجارية.
 *
 * Mirrors `actAs()` by setting both `request.jwt.claims` and flattened
 * `request.jwt.claim.*` GUCs so Postgres 15 (`auth.uid()`) and Postgres 17
 * claim lookups agree.
 */
export async function actAsCompanyUser(
  client: PoolClient,
  user: Pick<SeededCompanyUser, "id"> | string,
  extraClaims?: Record<string, unknown>,
): Promise<void> {
  const userId = typeof user === "string" ? user : user.id;
  const claims = JSON.stringify({
    ...(extraClaims ?? {}),
    sub: userId,
    role: "authenticated",
  });
  await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  await client.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
  await client.query("select set_config('role', 'authenticated', true)");
}

/**
 * يبدّل هوية الاتصال الحالية إلى دور `company_service` مع ادعاءات الشركة المحددة.
 *
 * Pass `companyId = null` to simulate a `company_service` token missing its
 * `company_id` claim; `current_company_id()` must fail closed and return `null`.
 */
export async function actAsCompanyService(
  client: PoolClient,
  companyId: string | null,
  opts?: CompanyServiceClaimOptions,
): Promise<void> {
  const payload: Record<string, unknown> = {
    ...(opts?.extraClaims ?? {}),
    role: "company_service",
  };
  if (companyId !== null) {
    payload.company_id = companyId;
  }
  if (opts?.allowSuspended === true) {
    payload.allow_suspended = true;
  }

  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify(payload),
  ]);
  await client.query("select set_config('request.jwt.claim.sub', '', true)");
  await client.query("select set_config('request.jwt.claim.role', 'company_service', true)");
  await client.query("select set_config('role', 'company_service', true)");
}

/**
 * ينفّذ دالة الاختبار بهوية مستخدم شركة محدد ثم يعيد الدور إلى `postgres`.
 */
export async function runAsUser<T>(
  client: PoolClient,
  user: Pick<SeededCompanyUser, "id"> | string,
  fn: () => Promise<T>,
  extraClaims?: Record<string, unknown>,
): Promise<T> {
  await actAsCompanyUser(client, user, extraClaims);
  try {
    return await fn();
  } finally {
    // If `fn` aborted the transaction without a savepoint, let the caller's
    // error surface instead of masking it with a 25P02 during teardown.
    await actAsSuperuser(client).catch(() => {});
  }
}

/**
 * ينفّذ دالة الاختبار بدور `company_service` لشركة محددة ثم يعيد الدور إلى `postgres`.
 */
export async function runAsCompanyService<T>(
  client: PoolClient,
  companyId: string | null,
  fn: () => Promise<T>,
  opts?: CompanyServiceClaimOptions,
): Promise<T> {
  await actAsCompanyService(client, companyId, opts);
  try {
    return await fn();
  } finally {
    await actAsSuperuser(client).catch(() => {});
  }
}

/**
 * يحدّث حالة الشركة (نشطة أو موقوفة) مع ضبط أو مسح حقول الإيقاف بشكل متسق.
 */
export async function setCompanyStatus(
  client: PoolClient,
  companyId: string,
  status: CompanyStatus,
  reason = "Suspended in SQL test",
): Promise<void> {
  if (status === "suspended") {
    await client.query(
      `update public.companies
          set status = 'suspended',
              suspended_at = now(),
              suspended_reason = $2
        where id = $1`,
      [companyId, reason],
    );
    return;
  }

  await client.query(
    `update public.companies
        set status = 'active',
            suspended_at = null,
            suspended_reason = null,
            suspended_by = null
      where id = $1`,
    [companyId],
  );
}
