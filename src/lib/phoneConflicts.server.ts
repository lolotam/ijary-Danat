import { nationalPhoneDigits } from "@/auth/loginIdentity";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { userConflictMessage } from "@/lib/userConflicts";

/**
 * Validates a mobile number before it is stored on a profile.
 *
 * Server-only: it calls `find_phone_conflicts`, whose EXECUTE is granted to
 * service_role alone because it maps phone numbers onto account names.
 *
 * Two failures are refused here rather than discovered at the login screen:
 *
 * - A number with fewer than 8 digits. Sign-in resolves an identifier on the
 *   last 8 digits, so a shorter value can never match — it would look saved and
 *   silently never work.
 * - A number that collides with another account. Sign-in refuses when more than
 *   one profile matches, so saving a duplicate disables mobile login for both
 *   parties, and the symptom ("invalid credentials") points nowhere near the
 *   cause.
 *
 * Two exclusions are threaded through to `find_phone_conflicts` because the
 * check runs at two different moments. `excludeProfileId` excludes the account
 * being edited (updateAppUser). `excludeTenantId` excludes the tenant an
 * account is being created for or linked to (createAppUser, or updateAppUser
 * moving a tenant's profile) — at creation time the profile does not exist
 * yet, so without this a tenant's own mobile number would be refused as a
 * conflict with itself.
 *
 * Returns the number to store — trimmed, otherwise exactly as typed. It is
 * deliberately not reformatted: `profiles.phone` is free text that people read,
 * and the matching happens over a digits-only projection anyway.
 */
export async function normalisePhoneForSave(
  phone: string | null | undefined,
  excludeProfileId: string | null,
  excludeTenantId: string | null,
): Promise<string | null> {
  const trimmed = (phone ?? "").trim();
  if (!trimmed) return null;

  const digits = nationalPhoneDigits(trimmed);
  if (!digits) {
    throw new Error(
      userConflictMessage(
        { kind: "phone-too-short", value: trimmed },
        "A mobile number needs at least 8 digits — sign-in matches the last 8, so a shorter number can never be used to log in.",
      ),
    );
  }

  const { data, error } = await supabaseAdmin.rpc("find_phone_conflicts", {
    _digits: digits,
    _exclude_profile: excludeProfileId,
    _exclude_tenant: excludeTenantId,
  });
  if (error) throw new Error(`Could not check the mobile number: ${error.message}`);

  const conflicts = (data ?? []) as Array<{ kind: string; id: string; label: string | null }>;
  const conflict = conflicts[0];
  if (!conflict) return trimmed;

  const who = conflict.label ?? conflict.id;
  throw new Error(
    conflict.kind === "tenant"
      ? userConflictMessage(
          { kind: "phone-tenant", value: trimmed, owner: who },
          `This mobile number is already recorded for the tenant "${who}". Sign-in matches the last 8 digits, so reusing it would break mobile login for both once that tenant gets a portal account.`,
        )
      : userConflictMessage(
          { kind: "phone-account", value: trimmed, owner: who },
          `This mobile number is already used by "${who}". Sign-in matches the last 8 digits, so it has to be unique.`,
        ),
  );
}
