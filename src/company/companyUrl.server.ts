import type { SupabaseClient } from "@supabase/supabase-js";

import { companySubdomainHost } from "@/company/hostCompany.server";
import type { Database } from "@/integrations/supabase/database.types";

/**
 * يبني أصل الرابط المطلق (البروتوكول + المضيف) لعنوان شركة.
 *
 * Links built here leave the app (email, WhatsApp, a gateway redirect), so they
 * must be absolute and must name this company's own host: a platform-wide base
 * URL would send one company's renters to another company's sign-in page.
 * Local development hosts have no TLS, so they get `http`.
 */
export function companyOrigin(host: string): string {
  const isLocal =
    host === "localhost" || host.endsWith(".localhost") || host.startsWith("localhost:");
  return `${isLocal ? "http" : "https"}://${host}`;
}

/**
 * يقرأ المعرّف المختصر لشركة العميل ويعيد أصل عنوانها التلقائي `<slug>.<root>`.
 *
 * For job handlers that run without a request Host. `db` is a `companyClient`,
 * so RLS limits the read to the client's own company row; a mismatch between
 * `db` and `companyId` finds no row and throws rather than linking elsewhere.
 */
export async function companyOriginById(
  db: SupabaseClient<Database>,
  companyId: string,
): Promise<string> {
  const { data, error } = await db.from("companies").select("slug").eq("id", companyId).single();
  if (error || !data) {
    throw new Error(`Company ${companyId} has no readable address: ${error?.message ?? "no row"}`);
  }
  return companyOrigin(companySubdomainHost(data.slug));
}
