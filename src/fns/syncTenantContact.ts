import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Tables } from "@/integrations/supabase/database.types";

/** حقول التواصل المطلوب نسخها من حساب البوابة إلى سجل المستأجر. */
export interface TenantContactPatch {
  email?: string;
  phone?: string;
}

/** نتيجة المزامنة: راية نجاح، وخطأ اختياري يصل إلى المسؤول كتحذير. */
export interface TenantContactSyncResult {
  synced: boolean;
  error?: string;
}

/**
 * ينسخ بريد حساب المستأجر ورقم واتسابه إلى سجل المستأجر، ولا يرمي استثناءً أبدًا.
 *
 * Mirrors a portal account's contact details onto `tenants.email` /
 * `tenants.whatsapp`. It is called from createAppUser and updateAppUser
 * *after* the account write has already landed, which is why it may never
 * throw: failing the call there would strand an account that exists (debate
 * finding 3, decision D10). Every failure — a missing tenant row, a refused
 * update — is returned as `{ synced: false, error }` for the UI to surface as
 * a warning toast while the account itself stays saved.
 *
 * The phone arrives already normalised: both callers ran it through
 * `normalisePhoneForSave` against the exclusions correct for their moment
 * (createAppUser excluding the tenant being linked; updateAppUser excluding
 * the account being edited and its tenant), so the value is the
 * exact trimmed string `profiles.phone` now stores, and this function only
 * trims defensively and writes it verbatim. Re-running the conflict check
 * here is not an option — the signature carries no account id to exclude,
 * and by the time this runs the just-saved profile already matches the
 * number, so the check would flag the account itself and fail every sync.
 *
 * Only fields that are present, non-empty and actually different from the
 * stored values are written, so a save that touched neither detail leaves the
 * tenant row untouched.
 */
export async function syncTenantContact(
  tenantId: string,
  contact: TenantContactPatch,
): Promise<TenantContactSyncResult> {
  try {
    const { data: tenant, error: readError } = await supabaseAdmin
      .from("tenants")
      .select("id, email, whatsapp")
      .eq("id", tenantId)
      .maybeSingle();
    if (readError) return { synced: false, error: readError.message };
    if (!tenant) return { synced: false, error: "Tenant record not found." };

    const updates: Partial<Pick<Tables<"tenants">, "email" | "whatsapp">> = {};

    const email = contact.email?.trim().toLowerCase();
    if (email && email !== (tenant.email ?? "").trim().toLowerCase()) {
      updates.email = email;
    }

    const phone = contact.phone?.trim();
    if (phone && phone !== (tenant.whatsapp ?? "").trim()) updates.whatsapp = phone;

    if (!Object.keys(updates).length) return { synced: true };

    // `.select().maybeSingle()` rather than a bare update: an update that
    // matched no row reports success with no error, and the service role makes
    // RLS an unlikely explanation — a missing row here means the tenant
    // vanished mid-save, which the admin must hear about (debate finding 6).
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("tenants")
      .update(updates)
      .eq("id", tenantId)
      .select("id")
      .maybeSingle();
    if (updateError) return { synced: false, error: updateError.message };
    if (!updated) return { synced: false, error: "Tenant record not found." };
    return { synced: true };
  } catch (error) {
    return {
      synced: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
