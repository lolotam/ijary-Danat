import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getRequest } from "@tanstack/react-start/server";

import type { Database } from "@/integrations/supabase/database.types";

import { PLATFORM_ADMIN_REQUIRED, requirePlatformAdmin } from "./requirePlatformAdmin.server";

/**
 * عملية لوحة المشرف العام التي تقرأ حالة المنصة كلها (قصة المستخدم 12).
 *
 * The two SQL functions are the only way to read across companies, and the
 * database — not this file — decides who may call them: each refuses every
 * caller that `public.is_platform_admin()` does not recognise. The call
 * therefore carries the caller's own token instead of the service role: a
 * service-role request carries no `sub` and no `aal2` claim, so the database
 * would answer `PLATFORM_ADMIN_REQUIRED` to the platform's own key.
 */

/** سطر الإجماليات كما ترده دالة `platform_overview_totals`. */
export type PlatformOverviewTotals =
  Database["public"]["Functions"]["platform_overview_totals"]["Returns"][number];

/** سطر حالة الشركة كما ترده دالة `platform_company_health`. */
export type PlatformCompanyHealth =
  Database["public"]["Functions"]["platform_company_health"]["Returns"][number];

/** ما تعرضه شاشة النظرة العامة: إجماليات المنصة وحالة كل شركة. */
export interface PlatformOverview {
  totals: PlatformOverviewTotals;
  companies: PlatformCompanyHealth[];
}

/**
 * يقرأ رمز الوصول من ترويسة الطلب الحالي.
 *
 * The platform guard has already refused a request without a bearer token; the
 * check here keeps a header of another shape from becoming a truncated token.
 */
function readAccessToken(): string {
  const header = getRequest().headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    throw new Error(PLATFORM_ADMIN_REQUIRED);
  }
  return header.slice("bearer ".length).trim();
}

/**
 * يبني عميل PostgREST يقرأ بصلاحية المستدعي نفسه: المفتاح العام مع رمز الجلسة.
 *
 * The publishable key plus the caller's own token is what makes PostgREST run
 * the request as that user, so `is_platform_admin()` reads their real claims
 * — the `aal2` claim included — instead of the service role's.
 *
 * `requirePlatformAdmin.server.ts` builds the same client privately. The copy
 * stays here until that file exports the helper: it belongs to another slice
 * of this batch, and one caller's copy cannot be edited from here.
 */
function createCallerClient(accessToken: string): SupabaseClient<Database> {
  const url = process.env.SUPABASE_URL || process.env.SELF_SUPABASE_URL;
  const publishableKey =
    process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SELF_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY for the platform panel.");
  }

  return createClient<Database>(url, publishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * يقرأ إجماليات المنصة وحالة كل شركة.
 *
 * The guard runs before any read: a refused caller must leave no trace. Both
 * functions are read-only, so nothing is written and nothing is audited.
 */
export async function platformOverview(): Promise<PlatformOverview> {
  await requirePlatformAdmin();

  const client = createCallerClient(readAccessToken());

  const [totals, health] = await Promise.all([
    client.rpc("platform_overview_totals"),
    client.rpc("platform_company_health"),
  ]);

  if (totals.error) {
    throw new Error(`platform_overview_totals failed: ${totals.error.message}`);
  }
  if (health.error) {
    throw new Error(`platform_company_health failed: ${health.error.message}`);
  }

  const totalsRows = totals.data ?? [];
  const totalsRow = totalsRows[0];
  if (!totalsRow) {
    throw new Error("platform_overview_totals returned no row");
  }

  return {
    totals: totalsRow,
    companies: health.data ?? [],
  };
}
