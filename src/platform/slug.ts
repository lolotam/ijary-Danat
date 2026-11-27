import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * قواعد المعرّف المختصر (slug) للشركة: شكله، وحصته من الأسماء المحجوزة
 * والمستخدمة، وأكواد رفضه.
 *
 * The shape is a copy of the database check `companies_slug_format`
 * (migration 254): `^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$`, which is 3 to 32
 * characters. The two must agree — a server that accepted a longer name would
 * let Postgres refuse it with a raw constraint message instead of the clear
 * `SLUG_INVALID` the panel shows.
 */

/** رفض: المعرّف المختصر لا يطابق الشكل المسموح. */
export const SLUG_INVALID = "SLUG_INVALID";

/** رفض: المعرّف المختصر محجوز للمنصة نفسها. */
export const SLUG_RESERVED = "SLUG_RESERVED";

/** رفض: المعرّف المختصر تستخدمه شركة أخرى. */
export const SLUG_TAKEN = "SLUG_TAKEN";

/** رفض: المعرّف المختصر لا يُغيَّر بعد إنشاء الشركة (قيد `tg_guard_company_slug`). */
export const SLUG_IMMUTABLE = "SLUG_IMMUTABLE";

/**
 * الشكل المقبول: حروف صغيرة وأرقام وشرطات، بلا شرطة في أول الاسم ولا آخره.
 *
 * Length follows the database check exactly: one character, one to thirty
 * middle characters, one last character — 3 to 32 in total.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

/**
 * يطابق المعرّف المختصر الشكل الذي تقبله قاعدة البيانات.
 */
function matchesCompanySlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/**
 * يرفض المعرّف المختصر الذي لا يطابق الشكل المسموح برمز `SLUG_INVALID`.
 *
 * The refusal is a bare code because the panel maps it to a translated
 * message; the server keeps one string per reason and never two.
 */
export function assertValidCompanySlug(slug: string): void {
  if (!matchesCompanySlug(slug)) {
    throw new Error(SLUG_INVALID);
  }
}

/**
 * يتأكد أن المعرّف المختصر متاح: ليس محجوزاً للمنصة ولا مستخدماً من شركة أخرى.
 *
 * The database refuses both cases too — a trigger and a unique index — but
 * those refusals arrive as raw constraint text. The two reads here turn them
 * into the codes the panel translates.
 */
export async function assertSlugAvailable(slug: string): Promise<void> {
  const reserved = await supabaseAdmin
    .from("reserved_slugs")
    .select("slug")
    .eq("slug", slug)
    .maybeSingle();

  if (reserved.error) {
    throw new Error(`reserved_slugs lookup failed: ${reserved.error.message}`);
  }
  if (reserved.data) {
    throw new Error(SLUG_RESERVED);
  }

  const taken = await supabaseAdmin.from("companies").select("id").eq("slug", slug).maybeSingle();

  if (taken.error) {
    throw new Error(`companies slug lookup failed: ${taken.error.message}`);
  }
  if (taken.data) {
    throw new Error(SLUG_TAKEN);
  }
}
